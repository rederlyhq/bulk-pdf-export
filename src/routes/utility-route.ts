import { Request, Response, NextFunction } from 'express';
const router = require('express').Router();
import httpResponse from '../utilities/http-response';
import * as _ from 'lodash';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../utilities/logger';
import configurations from '../configurations';
const packageJSONPath = '../../package.json';

/**
 * Get the version number at startup, however you'll have to await the result in the callback
 * This should only be called once (same as if it was imported) and awaiting the promise will actually give you the result
 * On error returns null so that the api is indicating that it wasn't just missed but couldn't be retrieved (undefined just doesn't return the key)
 * Can't use import here because the rootDir is jailed to src (which makes sense)
 */
const versionPromise = new Promise<string | null>((resolve, reject) => {
    fs.readFile(path.join(__dirname, packageJSONPath), (err: Error | null, data: Buffer) => {
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

router.use('/secret-to-everyone',
// No validation
(_req: Request, _res: Response, next: NextFunction) => {
    next(httpResponse.Ok(null, configurations.hash));
});

router.get('/health', (req: Request, res: Response, next: NextFunction) => {
    next(httpResponse.Ok('Health Ok'));
});

export default router;