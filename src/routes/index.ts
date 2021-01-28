import * as express from 'express';
import httpResponse from '../utilities/http-response';
const router = express.Router();
import _ = require('lodash');
import logger from '../utilities/logger';
import { _Object } from '@aws-sdk/client-s3';
import { createPDFFromSrcdoc, createZipFromPdfs } from './logic';

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
        attachments: {url: string; name: string}[];
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

    // Respond once the promise to finish is created, then finish.
    next(httpResponse.Ok('Working on it!'));

});

export interface GetExportArchiveOptions {
    profUUID: string;
    topicId: number;
}

router.get('/', async (_req, _res, next) => {
    const {profUUID, topicId: topicIdStr} = _req.query;

    if (_.isNil(topicIdStr) || typeof topicIdStr !== 'string') {
        logger.error('Bad topic id. ' + topicIdStr);
        return;
    }

    if (typeof profUUID !== 'string') {
        logger.error('Bad UUID. ' + profUUID);
        return;
    }

    const topicId = parseInt(topicIdStr, 10);

    // Respond first to not block. This should happen before any async actions.
    logger.info('Responding with OK first.');
    next(httpResponse.Ok('Ok'));

    // Wait for all previous PDF generations for this topic to finish.
    await Promise.allSettled(cheatingInMemoryStorage[topicId]);

    try {
        await createZipFromPdfs({profUUID, topicId});
    } catch (e) {
        // TODO: Postback error to backend
        logger.error(e);
    } finally {
        delete cheatingInMemoryStorage[topicId];
    }
});

export default router;
