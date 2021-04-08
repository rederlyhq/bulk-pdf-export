import * as express from 'express';
import httpResponse from '../utilities/http-response';
const router = express.Router();
import _ from 'lodash';
import logger from '../utilities/logger';
import { _Object } from '@aws-sdk/client-s3';
import { addPDFToZip, createPDFFromSrcdoc, createZip, finalizeZip, postBackErrorOrResultToBackend } from './logic';
import configurations from '../configurations';
import { cheatingInMemoryStorage, globalTopicSemaphore, PDFPriorityData, PromiseWithStatus } from '../globals';
import { DebugPageInfo, DumpAllInfo, MakePDFRequestOptions } from './interfaces';
import PuppetMaster from '../puppetmaster';
import Boom from 'boom';
import utilities from './utility-route';

router.use('/tmp', express.static(configurations.server.tempDirectory));
// explicitly has to be development, otherwise you don't get this feature
if (configurations.app.isDevelopment) {
    try {
        router.use('/tmp', require('serve-index')(configurations.server.tempDirectory));
    } catch (e) {
        logger.error('Failed to import dev dependency serve-index. This is probably because NODE_ENV is not set for production but dependencies were pruned for prod', e);
    }
}
router.use('/utility', utilities);

// This route generates the PDF from a MakePDFRequestOptions object.
router.post('/', async (req, _res, next) => {
    const {showSolutions} = req.query;
    const body = req.body as MakePDFRequestOptions;

    const addSolutionToFilename = showSolutions === 'true';
    const topic = body.topic.id;
    
    // Respond immediately. The work is done asynchronously below.
    next(httpResponse.Ok('Working on it!'));
    
    const topicStorageProxy = cheatingInMemoryStorage[topic] ?? {
        pdfPromises: [],
        zipObject: createZip(topic, body.professorUUID, addSolutionToFilename),
        professorUUID: body.professorUUID,
        pendingPriorities: [],
        lock: undefined,
    };

    if (topicStorageProxy === undefined) {
        logger.error('TSNH Topic Storage is not defined after just being defined.');
        return;
    }
    
    cheatingInMemoryStorage[topic] = topicStorageProxy;

    // If the topic doesn't have a lock yet, acquire one! Then, wait for that lock before processing.
    if (_.isNil(topicStorageProxy.lock)) {
        logger.info(`Creating a lock for topic ${topic}`);
        topicStorageProxy.lock = globalTopicSemaphore.acquire();
    }

    try {
        await topicStorageProxy.lock;
    } catch (e) {
        logger.error(`[${topic}] Too many topics ${Object.keys(cheatingInMemoryStorage).length} active for ${configurations.app.concurrentTopicsLimit} (${e.message})`);
        // We don't need to push failed promises to the array because all printing attempts will fail at this point.
        return;
    }

    const newPriority: PDFPriorityData = { prio: 0, topicId: topic, profUUID: body.professorUUID, firstName: body.firstName };

    // If this is one of the first N PDFs, give elevated priority.
    if (topicStorageProxy.pdfPromises.length < configurations.app.highPriorityTabsPerTopic) {
        newPriority.prio = 999999;
        logger.debug(`[${topic}] Assigning an initial high priority of ${newPriority.prio} to ${body.firstName}`);
    }

    topicStorageProxy.pendingPriorities.push(newPriority);

    const pdfPromise: PromiseWithStatus<string> = createPDFFromSrcdoc(body, addSolutionToFilename, newPriority);
    pdfPromise.status = 'pending';
    pdfPromise.then(() => pdfPromise.status = 'resolved');
    pdfPromise.catch(() => pdfPromise.status = 'rejected');
    topicStorageProxy.pdfPromises.push(pdfPromise);

    try {
        addPDFToZip(topicStorageProxy.zipObject.archive, pdfPromise, topic, addSolutionToFilename);
    } catch (e) {
        logger.error(`[${topic}] Route failed to add pdf to zip`, e);
    }
});

router.get('/', async (_req, _res, next) => {
    const {profUUID, topicId: topicIdStr, showSolutions} = _req.query;

    if (_.isNil(topicIdStr) || typeof topicIdStr !== 'string') {
        logger.error('Bad topic id. ' + topicIdStr);
        return next(Boom.badRequest('Bad topic id.'));
    }

    if (typeof profUUID !== 'string') {
        logger.error('Bad UUID. ' + profUUID);
        return next(Boom.badRequest('Bad UUID.'));
    }

    let addSolutionToFilename = false;
    if (showSolutions === 'true') {
        addSolutionToFilename = true;
    }

    const topicId = parseInt(topicIdStr, 10);

    // Respond first to not block. This should happen before any async actions.
    logger.info(`Responding to request to zip ${topicId} with OK first.`);
    next(httpResponse.Ok('Ok'));

    
    const topicStorageProxy = cheatingInMemoryStorage[topicId];

    if (topicStorageProxy === undefined) {
        logger.error('Topic Storage is not defined when zip requested.');
        return await postBackErrorOrResultToBackend(topicId);
    }

    // If the topic doesn't have a lock yet, acquire one! Then, wait for that lock before processing.
    if (_.isNil(topicStorageProxy.lock)) {
        logger.error(`Zip called, but the topic ${topicId} hasn't created a request for a lock yet.`)
        return await postBackErrorOrResultToBackend(topicId);
    }

    let release;
    try {
        logger.info(`Acquiring a lock to print topic ${topicId}`);
        [, release] = await topicStorageProxy.lock;
    } catch (e) {
        logger.error('Zip was requested before any PDFs were!', e);
        return await postBackErrorOrResultToBackend(topicId);
    }

    try {
        if (_.isEmpty(topicStorageProxy.pdfPromises)) {
            throw new Error('Zip was requested before any PDFs were!');
        }

        // Wait for all previous PDF generations for this topic to finish.
        await Promise.allSettled(topicStorageProxy.pdfPromises);
    } catch (e) {
        logger.error(`[${topicId}] An error occured waiting for PDF promises to settle.`, e);
        return await postBackErrorOrResultToBackend(topicId);
    }

    try {
        await finalizeZip(topicStorageProxy.zipObject, {profUUID, topicId, addSolutionToFilename}, topicStorageProxy.pdfPromises);
    } catch (zipError) {
        logger.error('Failed to zip from PDFs', zipError);
        try {
            await postBackErrorOrResultToBackend(topicId);
        } catch (postbackError) {
            logger.error('Failed to postback error', postbackError);
        }
    } finally {
        try {
            logger.debug(`${topicId} has finished, releasing lock.`);
            release();
        } catch (e) {
            logger.error(`WTF: The lock for ${topicId} disappeared from under us. ${topicStorageProxy}`, e);
        }
        delete cheatingInMemoryStorage[topicId];
    }
});

const promiseStatusCount = (promises: PromiseWithStatus<unknown>[], status: 'resolved' | 'rejected' | 'pending') => promises.reduce((currentSum, promise) => currentSum + Number(promise.status === status), 0);
router.get('/dumpAll', async (req, _res, next) => {
    const res = _.transform(cheatingInMemoryStorage, (accum, obj, topicId) => {
        if (_.isNil(obj)) {
            logger.warn(`Topic ${topicId} is in the memory store, but is nil.`);
            return accum.push({
                topicId: topicId,
                error: 'Uninitialized in memory.'
            });
        }
        const resolvedCount = promiseStatusCount(obj.pdfPromises, 'resolved');
        const rejectedCount = promiseStatusCount(obj.pdfPromises, 'rejected');
        const pendingCount = promiseStatusCount(obj.pdfPromises, 'pending');
        const pdfCount = obj.pdfPromises.length;

        return accum.push({
            topicId,
            resolvedCount,
            rejectedCount,
            pendingCount,
            pdfCount
        });
    }, <DumpAllInfo[]>[]);

    const metadata = {
        pages: <DebugPageInfo>[],

    };
    metadata.pages = await PuppetMaster.getPagesArray();
    next(httpResponse.Ok('Fetched successfully', {data: res, metadata}));
});

router.get('/:topicId', async (req, _res, next) => {
    const topicId = parseInt(req.params.topicId, 10);
    const obj = cheatingInMemoryStorage[topicId];
    if (obj === undefined) {
        return next(httpResponse.Ok('Fetched successfully', null));
    }
    const resolvedCount = promiseStatusCount(obj.pdfPromises, 'resolved');
    const rejectedCount = promiseStatusCount(obj.pdfPromises, 'rejected');
    const pendingCount = promiseStatusCount(obj.pdfPromises, 'pending');
    const pdfCount = obj.pdfPromises.length;
    next(httpResponse.Ok('Fetched successfully', {
        resolvedCount,
        rejectedCount,
        pendingCount,
        pdfCount
    }));
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
