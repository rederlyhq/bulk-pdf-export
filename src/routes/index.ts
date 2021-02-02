import * as express from 'express';
import httpResponse from '../utilities/http-response';
const router = express.Router();
import _ = require('lodash');
import logger from '../utilities/logger';
import { _Object } from '@aws-sdk/client-s3';
import { createPDFFromSrcdoc, createZipFromPdfs, postBackErrorOrResultToBackend } from './logic';

export interface MakePDFRequestOptions {
    firstName: string;
    lastName: string;
    topic: {
        name: string;
        id: number;
    };
    professorUUID: string;
    problems: {
        number: number;
        srcdoc: string;
        attachments: {url: string; name: string; time: Date}[];
        effectiveScore?: number;
        legalScore?: number;
    }[];
};

// This holds all the promises required to finish before we can zip up the topic.
const cheatingInMemoryStorage: {
    [topicId: number]: Promise<string | undefined>[]
} = {}

/**
 * firstName
 * lastName
 * topicTitle
 * problems: [{number, srcdoc, attachments}]
 */
router.post('/', async (_req, _res, next) => {
    const body = _req.body as MakePDFRequestOptions;
    const topic = body.topic.id;
    
    cheatingInMemoryStorage[topic] = cheatingInMemoryStorage[topic] ? 
        [...cheatingInMemoryStorage[topic], createPDFFromSrcdoc(body)] : 
        [createPDFFromSrcdoc(body)];

    // Respond once the promise to finish is created. The work is done asynchronously above.
    next(httpResponse.Ok('Working on it!'));
});

export interface GetExportArchiveOptions {
    profUUID: string;
    topicId: number;
    addSolutionToFilename: boolean;
}

router.get('/', async (_req, _res, next) => {
    const {profUUID, topicId: topicIdStr, showSolutions} = _req.query;

    if (_.isNil(topicIdStr) || typeof topicIdStr !== 'string') {
        logger.error('Bad topic id. ' + topicIdStr);
        return;
    }

    if (typeof profUUID !== 'string') {
        logger.error('Bad UUID. ' + profUUID);
        return;
    }

    let addSolutionToFilename = false;
    if (showSolutions === 'true') {
        addSolutionToFilename = true;
    }

    const topicId = parseInt(topicIdStr, 10);

    // Respond first to not block. This should happen before any async actions.
    logger.info('Responding with OK first.');
    next(httpResponse.Ok('Ok'));

    try {
        // Wait for all previous PDF generations for this topic to finish.
        await Promise.allSettled(cheatingInMemoryStorage[topicId]);
    } catch (e) {
        logger.error('Zip was requested before any PDFs were!');
    }

    try {
        await createZipFromPdfs({profUUID, topicId, addSolutionToFilename}, cheatingInMemoryStorage[topicId]);
    } catch (e) {
        await postBackErrorOrResultToBackend(topicId);
        logger.error(e);
    } finally {
        delete cheatingInMemoryStorage[topicId];
    }
});

process.on('SIGTERM', async () => {
    logger.warn('Cleaning up by updating backend! If you force kill, the backend will have bad data.');
    // Cleanup and let the backend know we failed.
    const proms = _.keys(cheatingInMemoryStorage).map(async (topicId) => {
        logger.info(`Gracefully posted error for ${topicId}.`);
        try {
            await postBackErrorOrResultToBackend(parseInt(topicId, 10));
        } catch (e) {
            logger.warn(`Failed to gracefully update Topic ${topicId}`);
        }
    });

    await Promise.all(proms);

    logger.info('Gracefully exited due to signal.');
    process.exit(0);
})

export default router;
