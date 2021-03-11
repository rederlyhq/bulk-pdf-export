// TODO might make sense to move this to a module so all micro services can use it
import axios, { AxiosError, AxiosResponse } from 'axios';
import { Request, Response, NextFunction, Handler } from 'express';
import httpResponse from '../utilities/http-response';
import logger from '../utilities/logger';
import * as crypto from 'crypto';
import Boom from 'boom';

// https://www.reddit.com/r/typescript/comments/f91zlt/how_do_i_check_that_a_caught_error_matches_a/
export function isAxiosError(error: any): error is AxiosError {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return (error as AxiosError).isAxiosError !== undefined;
}

// The response of the status handler, as well as the axios response from status calls
interface StatusResponse {
    version: string | null;
    dependencies: DependencyObject[];
    percentUp: number;
}

// This is the promise response before it gets tot he end where it adds extra info
interface CheckAccessibleRequestResponse {
    response: unknown;
    succeeded: boolean;
}

// Extra info added after the axios response
interface DependencyObject extends CheckAccessibleRequestResponse {
    urlMD5?: string;
    name: string;
}

// This is a hook to let you check the status of local services like efs and puppeteer
interface CustomCheckOptions {
    call: () => DependencyObject | Promise<DependencyObject>;
}

// Options for the call that hits a health or status endpoint
interface CheckAccessibleOptions {
    name: string;
    url: string;
    crawl: boolean;
}


const checkAccessible = ({ name, url, crawl }: CheckAccessibleOptions): Promise<DependencyObject> => {
    return axios.get(url, {
        params: {
            crawl: crawl
        }
    })
        // We don't know what this response might be, we only try to crawl in but null coalesce out
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((resp: AxiosResponse<any>): CheckAccessibleRequestResponse => {
            const data = (resp.data?.data ?? resp.data) || 'ACCESSIBLE';
            return {
                response: data,
                succeeded: true,
            };
        })
        .catch((e): CheckAccessibleRequestResponse => {
            logger.error(`Failed to get ${name} status`, e);
            let result;
            if (isAxiosError(e)) {
                result = e.response?.data?.data ?? e.response?.data;
            }
            result = result || e?.message || 'INACCESSIBLE';
            return {
                response: result,
                succeeded: false,
            };
        })
        .then((result: CheckAccessibleRequestResponse): DependencyObject => {
            return {
                ...result,
                urlMD5: crypto.createHash('md5').update(url).digest('hex'),
                name: name,
            };
        });
};

// We don't know the type at this point and we need to access it's members
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hasPercentUp = (value: any): value is { percentUp: number } => (
    typeof value === 'object' &&
    'percentUp' in value &&
    typeof value.percentUp === 'number'
);

interface StatusHandlerOptions {
    versionPromise?: Promise<string | null>;
    statusAccessibleOptions?: CheckAccessibleOptions[];
    healthAccessibleOptions?: CheckAccessibleOptions[];
    customChecks?: CustomCheckOptions[];
}

let alreadyCrawling = false;
export const statusHandler = ({
    versionPromise = Promise.resolve(null),
    statusAccessibleOptions = [],
    healthAccessibleOptions = [],
    customChecks = []
}: StatusHandlerOptions): Handler => async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const crawling = req.query.crawl === 'true';
    try {
        let statusPromises: Promise<DependencyObject>[] = [];
        let healthPromises: Promise<DependencyObject>[] = [];
        if (crawling) {
            if (alreadyCrawling) {
                next(Boom.tooManyRequests('Cannot crawl while already crawling'));
                return;
            }
            alreadyCrawling = true;
            statusPromises = statusAccessibleOptions.map(statusAccessibleOption => checkAccessible(statusAccessibleOption));
            healthPromises = healthAccessibleOptions.map(healthAccessibleOption => checkAccessible(healthAccessibleOption));
        }

        const version = await versionPromise;
        const responseData: StatusResponse = {
            version: version,
            dependencies: [],
            percentUp: 0
        };

        const customPromises = customChecks.map(customCheck => customCheck.call());

        const statusResults = await Promise.all(statusPromises);
        const healthResults = await Promise.all(healthPromises);
        const customResults = await Promise.all(customPromises);
        const allResults = [...statusResults, ...healthResults, ...customResults];

        let upCount = 0;
        upCount = statusResults.reduce((currentSum, dependency) => {
            if (!dependency.succeeded) {
                return currentSum;
            }

            // these are status calls so this should alway pass
            if (hasPercentUp(dependency.response)) {
                return currentSum + dependency.response.percentUp;
            } else {
                logger.warn('Status call gave back a non status response');
            }

            return currentSum + 1;
        }, upCount);

        upCount = [...healthResults, ...customResults].reduce((currentSum, dependency) => {
            if (!dependency.succeeded) {
                return currentSum;
            }

            return currentSum + 1;
        }, upCount);

        responseData.percentUp = (upCount + 1) / (allResults.length + 1);

        allResults.forEach(result => responseData.dependencies.push(result));

        next(httpResponse.Ok('Fetched successfully', responseData));
    } catch (e) {
        next(e);
    } finally {
        if (crawling) {
            alreadyCrawling = false;
        }
    }
};
