import * as express from 'express';
import httpResponse from '../utilities/http-response';
const router = express.Router();
import _ from 'lodash';
import logger from '../utilities/logger';
import { _Object } from '@aws-sdk/client-s3';
import { addPDFToZip, createPDFFromSrcdoc, createZip, finalizeZip, postBackErrorOrResultToBackend } from './logic';
import configurations from '../configurations';
import { cheatingInMemoryStorage, globalTopicSemaphore, PDFPriorityData } from '../globals';
import { MakePDFRequestOptions } from './interfaces';

// This route generates the PDF from a MakePDFRequestOptions object.
router.post('/', async (req, _res, next) => {
    const {showSolutions} = req.query;
    const body = req.body as MakePDFRequestOptions;

    const addSolutionToFilename = showSolutions === 'true';
    const topic = body.topic.id;
    
    // Respond immediately. The work is done asynchronously below.
    next(httpResponse.Ok('Working on it!'));
    
    cheatingInMemoryStorage[topic] = cheatingInMemoryStorage[topic] ?? {
        pdfPromises: [],
        zipObject: createZip(topic, body.professorUUID, addSolutionToFilename),
        professorUUID: body.professorUUID,
        pendingPriorities: [],
        lock: undefined,
    };

    // If the topic doesn't have a lock yet, acquire one! Then, wait for that lock before processing.
    if (_.isNil(cheatingInMemoryStorage[topic].lock) || _.isEmpty(cheatingInMemoryStorage[topic].lock)) {
        cheatingInMemoryStorage[topic].lock = globalTopicSemaphore.acquire();
    }
    await cheatingInMemoryStorage[topic].lock;


    const newPriority: PDFPriorityData = { prio: 0, topicId: topic, profUUID: body.professorUUID, firstName: body.firstName };

    // If this is one of the first N PDFs, give elevated priority.
    if (cheatingInMemoryStorage[topic].pdfPromises.length < configurations.app.highPriorityTabsPerTopic) {
        newPriority.prio = 99;
    }

    cheatingInMemoryStorage[topic].pendingPriorities.push(newPriority);

    const pdfPromise = createPDFFromSrcdoc(body, addSolutionToFilename, newPriority);
    cheatingInMemoryStorage[topic].pdfPromises.push(pdfPromise);

    try {
        addPDFToZip(cheatingInMemoryStorage[topic].zipObject.archive, pdfPromise, topic);
    } catch (e) {
        logger.error('Route failed to add pdf to zip', e);
    }
});

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
    logger.info(`Responding to request to zip ${topicId} with OK first.`);
    next(httpResponse.Ok('Ok'));

    try {
        // Wait for all previous PDF generations for this topic to finish.
        await Promise.allSettled(cheatingInMemoryStorage[topicId].pdfPromises);
    } catch (e) {
        logger.error('Zip was requested before any PDFs were!', e);
    }

    try {
        await finalizeZip(cheatingInMemoryStorage[topicId].zipObject, {profUUID, topicId, addSolutionToFilename}, cheatingInMemoryStorage[topicId].pdfPromises);
    } catch (zipError) {
        logger.error('Failed to zip from PDFs', zipError);
        try {
            await postBackErrorOrResultToBackend(topicId);
        } catch (postbackError) {
            logger.error('Failed to postback error', postbackError);
        }
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
            logger.warn(`Failed to gracefully update Topic ${topicId}`, e);
        }
    });

    await Promise.all(proms);

    logger.info('Gracefully exited due to signal.');
    process.exit(0);
});

export default router;
