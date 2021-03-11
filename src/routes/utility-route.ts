import { Request, Response, NextFunction } from 'express';
const router = require('express').Router();
import httpResponse from '../utilities/http-response';
import _ from 'lodash';
import { readFile } from 'fs';
import * as path from 'path';
import logger from '../utilities/logger';
import configurations from '../configurations';
import axios, { AxiosError, AxiosResponse } from 'axios';
const packageJSONPath = '../../package.json';
import * as crypto from 'crypto';
import PuppetMaster from '../puppetmaster';

// https://www.reddit.com/r/typescript/comments/f91zlt/how_do_i_check_that_a_caught_error_matches_a/
export function isAxiosError(error: any): error is AxiosError {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return (error as AxiosError).isAxiosError !== undefined;
}

/**
 * Get the version number at startup, however you'll have to await the result in the callback
 * This should only be called once (same as if it was imported) and awaiting the promise will actually give you the result
 * On error returns null so that the api is indicating that it wasn't just missed but couldn't be retrieved (undefined just doesn't return the key)
 * Can't use import here because the rootDir is jailed to src (which makes sense)
 */
const versionPromise = new Promise<string | null>((resolve, reject) => {
    readFile(path.join(__dirname, packageJSONPath), (err: Error | null, data: Buffer) => {
        if (err) {
            reject(err);
        } else {
            try {
                // returns version string
                resolve(JSON.parse(data.toString()).version);
            } catch (e) {
                reject(e);
            }
        }
    });
})
.catch((err: Error) => {
    logger.error(err);
    return null;
});

router.use('/version',
// No validation
// No authentication
async (_req: Request, _res: Response, next: NextFunction) => {
    try {
        const version = await versionPromise;
        next(httpResponse.Ok(null, {
            packageJson: version
        }));
    } catch (e) {
        next(e);
    }
});


interface StatusResponse {
    version: string | null;
    dependencies: {[key: string]: DependencyObject};
    percentUp: number;
}

// const isStatusResponse = (value: any): value is StatusResponse => {
//     return typeof value === 'object' &&
//     ('version' in value &&
//     'dependencies' in value &&
//     (typeof value.version === 'string' || value.version === null)&&
//     Array.isArray(value.dependencies) &&
//     !value.dependencies.some((d: unknown) => !isDependencyObject(d)); // Check that all elements in the array are dependency objects
// }

interface DependencyObject {
    response: unknown;
    urlMD5?: string;
    status: string;
}

const isDependencyObject = (value: any): value is DependencyObject => {
    return typeof value === 'object' &&
    'response' in value &&
    ('status' in value && (value.status === 'success' || value.status === 'failed')) &&
    'urlMD5' in value &&
    typeof value.urlMD5 === 'string';
}

interface CheckAccessibleOptions {
    name: string;
    url: string;
    responseData: StatusResponse;
    crawl: boolean;
}

const checkAccessible = ({name, url, responseData, crawl}: CheckAccessibleOptions) => {
    return axios.get(url, {
        params: {
            crawl: crawl
        }
    })
    .then((resp: AxiosResponse<any>) => {
        const data = (resp.data?.data ?? resp.data) || 'ACCESSIBLE';
        return {
            response: data,
            status: 'success',
        };
    })
    .catch((e) => {
        logger.error(`Failed to get ${name} status`, e);
        let result;
        if (isAxiosError(e)) {
            result = e.response?.data?.data ?? e.response?.data;
        }
        result || e?.message || 'INACCESSIBLE';
        return {
            response: result,
            status: 'failed',
        }
    })
    .then((result: any) => {
        responseData.dependencies[name] = {
            ...result,
            urlMD5: crypto.createHash('md5').update(url).digest("hex"),
        }
    });
};

router.use('/status',
// No validation
// No authentication
async (req: Request, _res: Response, next: NextFunction) => {
    try {
        const version = await versionPromise;
        const responseData: StatusResponse = {
            version: version,
            dependencies: {},
            percentUp: 0
        }
        const promises = [];
        if (req.query.crawl === 'true') {
            promises.push(checkAccessible({
                name: 'backend',
                url: `${configurations.backend.url}/backend-api/utility/status`,
                responseData: responseData,
                crawl: false
            }));
            // TODO change to status when available
            promises.push(checkAccessible({
                name: 'renderer',
                url: `${configurations.renderer.url}/version.txt`,
                responseData: responseData,
                crawl: true
            }));
            promises.push(checkAccessible({
                name: 'attachments',
                url: `${configurations.app.attachmentsBaseURL}/work/index.txt`,
                responseData: responseData,
                crawl: true
            }));
        }

        const puppeteerIsConnected = (await PuppetMaster.browser).isConnected()
        responseData.dependencies['puppeteer'] = {
            status: puppeteerIsConnected ? 'success' : 'failure',
            response: puppeteerIsConnected,
        }
        // TODO should we check puppetteer here?
        await Promise.all(promises);

        // let percentUp = 1;
        // Object.values(responseData.dependencies).reduce((currentSum, dependency) => isStatusResponse(dependency.response) , 0);
        const dependencyPercentSum = Object.values(responseData.dependencies).reduce((currentSum, dependency) => {
            if (dependency.status === 'failed') {
                return currentSum;
            }

            if (typeof dependency.response === 'object' &&
            'percentUp' in (dependency.response as any) &&
            typeof (dependency.response as any).percentUp === 'number') {
                return currentSum + (dependency.response as any).percentUp;
            }

            return currentSum + 1;
        }, 0);
        const percentUp = (dependencyPercentSum + 1) / (Object.values(responseData.dependencies).length + 1);
        responseData.percentUp = percentUp;

        next(httpResponse.Ok('Fetched successfully', responseData));
    } catch (e) {
        next(e);
    }
});

router.use('/secret-to-everyone',
// No validation
(_req: Request, _res: Response, next: NextFunction) => {
    next(httpResponse.Ok(null, configurations.hash));
});

router.get('/health', (req: Request, res: Response, next: NextFunction) => {
    next(httpResponse.Ok('Health Ok'));
});

export default router;