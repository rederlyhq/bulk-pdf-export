// TODO move common middleware to module so it can be shared with rederly backend

import * as express from 'express';
import { Request, Response, NextFunction } from 'express';
import * as nodeUrl from 'url';
import * as Boom from 'boom';
import * as morgan from 'morgan';
import * as _ from 'lodash';
import { createProxyMiddleware } from 'http-proxy-middleware';

import logger from './utilities/logger';
import configurations from './configurations';
import router from './routes';
import './utilities/array-extension';
import './utilities/NumberExtensions';
import './utilities/global-error-handlers';
import utilities from './routes/utility-route';

const { server } = configurations;

const app = express();

const apiProxy = createProxyMiddleware('/webwork2_files/**', {
    target: configurations.renderer.url ?? undefined,
    changeOrigin: true,
    // logLevel: 'debug',
    // onError: console.log,
    // onProxyReq: console.log
});

interface ErrorResponse {
    statusCode: number;
    status: string;
    rederlyReference: string;
    error?: unknown;
    errorMessage?: string;
}

app.use(morgan((tokens, req, res) => {
    const responseTime = parseInt(tokens['response-time'](req, res) ?? '', 10);
    const shouldWarn = !_.isNumber(responseTime) || responseTime > server.logAccessSlowRequestThreshold;
    const message = [
        tokens.method(req, res),
        tokens.url(req, res),
        tokens.status(req, res),
        tokens.res(req, res, 'content-length'), '-',
        responseTime, 'ms'
    ].join(' ');

    return JSON.stringify({
        shouldWarn: shouldWarn,
        responseTime: responseTime,
        message: message
    });
}, {
    stream: {
        write: (message): void => {
            const obj = JSON.parse(message);
            const output = obj.message;
            if (obj.shouldWarn) {
                logger.warn(`Slow request: Access log: ${output}`);
            } else if (configurations.server.logAccess) {
                logger.info(`Access log: ${output}`);
            }
        }
    }
}));

const generatePathRegex = (pathRegex: string): RegExp => new RegExp(`^${server.basePath}${pathRegex}$`);
const baseUrlRegex = generatePathRegex('.*');

// If these configurations aren't used there is no need to bog down the middlewares
// if (server.logInvalidlyPrefixedRequests || server.blockInvalidlyPrefixedRequests) {
//     app.use((req: Request, _res: Response, next: NextFunction) => {
//         const { path: reqPath } = req;
        
//         const isInvalid = baseUrlRegex.test(reqPath) === false;

//         if (server.logInvalidlyPrefixedRequests && isInvalid) {
//             // logger.warn(`A request came in that did not match the baseURL; This could be sign of an intrusion attempt! ${reqPath}`);
//         }
    
//         if (server.blockInvalidlyPrefixedRequests && isInvalid) {
//             req.socket.end();
//         } else {
//             next();
//         }
//     });
// }

const apiTimeout = server.requestTimeout;
app.use((req, res, next) => {
    const timeoutHandler = (): void => {
        const url = nodeUrl.format({
            protocol: req.protocol,
            host: req.get('host'),
            pathname: req.originalUrl
        });
        logger.error(`Request timed out ${url}`);
        next(Boom.clientTimeout());
    };

    // Set the timeout for all HTTP requests
    req.setTimeout(apiTimeout, timeoutHandler);
    // Set the server response timeout for all HTTP requests
    res.setTimeout(apiTimeout, timeoutHandler);
    next();
});

app.use(apiProxy);

app.use(express.urlencoded({ limit: '50mb' }));

app.use(express.json({ limit: '50mb' }));

app.use('/export', express.static('/tmp'))

app.use(server.basePath, router);
app.use('/utility', utilities);

// General Handler
// next is a required parameter, without having it requests result in a response of object
// TODO: err is Boom | Error | any, the any is errors that we have to define
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
app.use((obj: any, _req: Request, res: Response, _next: NextFunction) => {
    if (obj.output) {
        // Handle boom error
        return res.status(obj.output.statusCode).json({
            data: obj.data,
            ...obj.output.payload
        });
    }
    else if (obj.statusCode) {
        // Our responses (mimic format)
        return res.status(obj.statusCode).json(obj);
    } else {
        // Unhandled error
        const rederlyReference = `rederly-library-browser-reference-${new Date().getTime()}-${Math.floor(Math.random() * 1000000)}`;
        if (obj instanceof Error) {
            logger.error(`${rederlyReference} - ${obj.stack}`);
        } else {
            logger.error(`${rederlyReference} - Unrecognized parameter sent to next ${obj}`);
        }
        const data: ErrorResponse = {
            statusCode: 500,
            status: 'Internal Server Error',
            rederlyReference
        };

        if (!configurations.app.isProduction) {
            data.error = obj;
            data.errorMessage = obj?.message;
        }

        return res.status(data.statusCode).json(data);
    }
});

export const listen = (): Promise<null> => {
    return new Promise<null>((resolve) => {
        app.listen(server.port, () => {
            logger.info(`Server started up and listening on port: ${server.port}`);
            resolve(null);
        });
    });
};
