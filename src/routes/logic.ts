import _ from 'lodash';
import logger from '../utilities/logger';
import * as pug from 'pug';
import {writeFile, unlink, mkdirp, createReadStream, existsSync, remove } from 'fs-extra';
import PuppetMaster from '../puppetmaster';
import S3Helper from '../utilities/s3-helper';
import archiver from 'archiver';
import { _Object } from '@aws-sdk/client-s3';
import axios, { AxiosResponse } from 'axios';
import configurations from '../configurations';
import CreatePDFError from '../utilities/CreatePDFError';
import path = require('path');
import { PDFPriorityData, ZipObject } from '../globals';
import { MakePDFRequestOptions, GetExportArchiveOptions } from './interfaces';

const tempBaseDirectory = `${configurations.server.tempDirectory}/`;
const topicTempDirectory = (topicId: number) => `${tempBaseDirectory}${topicId}`;
const htmlTempFile = (topicId: number, fileBasename: string) => `${topicTempDirectory(topicId)}/${fileBasename}.html`;
const pdfTempFile = (topicId: number, fileBasename: string) => `${topicTempDirectory(topicId)}/${fileBasename}.pdf`;
const awsTopicKey = (professorUUID: string, topicId: number) => `exports/${professorUUID}/${topicId}/`;
const awsPDFKey = (professorUUID: string, topicId: number, fileBasename: string, addSolutionsToFilename: boolean) => `exports/${professorUUID}/${topicId}/${fileBasename}${addSolutionsToFilename ? '-solutions': ''}.pdf`;
const awsZipKey = (professorUUID: string, topicId: number, addSolutionsToFilename: boolean) => `${awsTopicKey(professorUUID, topicId)}${topicId}_${Date.now()}${addSolutionsToFilename ? '-solutions' : ''}.zip`;

export const createPDFFromSrcdoc = async (body: MakePDFRequestOptions, addSolutionToFilename: boolean, priority: PDFPriorityData) => {
    const {firstName, lastName, topic: {name, id: topicId}, problems, professorUUID} = body;
    logger.info(`Got request to export ${firstName}'s topic with ${problems.length} problems.`);

    const baseFilename = `${name}_${lastName}_${firstName}`;
    const htmlFilepath = htmlTempFile(topicId, baseFilename);

    try {
        // Filename is required for caching to work. You must turn this off in development or restart your dev server.
        const f = pug.compileFile('assets/pug/pdf.pug', { filename: 'topic_student_export', cache: true, debug: false});

        const prettyProblems = _(problems).sortBy(['number']).map(prob => ({
            ...prob,
            effectiveScore: prob.effectiveScore?.toPercentString(),
            legalScore: prob.legalScore?.toPercentString(),
        })).value();

        await mkdirp(path.dirname(htmlFilepath));
        await writeFile(htmlFilepath, f({
            firstName, lastName, topicTitle: name, problems: prettyProblems
        }), 'utf8');

        logger.debug(`Wrote '${htmlFilepath}'`);

        const buffer = await PuppetMaster.safePrint(pdfTempFile(topicId, baseFilename), encodeURIComponent(htmlFilepath.substring(tempBaseDirectory.length)), priority);

        unlink(htmlFilepath)
        .then(() => logger.debug(`Successfully unlinked ${htmlFilepath}`)).catch(logger.error);
        
        if (_.isNil(buffer) || _.isEmpty(buffer)) {
            logger.error(`Failed to print ${baseFilename}`);
            throw new Error(`Failed to print ${baseFilename}, buffer came back empty.`);
        }

        logger.debug(`Got PDF data of size: ${buffer.length}`);
        await S3Helper.writeFile(awsPDFKey(professorUUID, topicId, baseFilename, addSolutionToFilename), buffer);
        return baseFilename;
    } catch (e) {
        throw new CreatePDFError(`Failed to create PDF because '${e.message}'`, baseFilename);
    }
}

export const createZip = (topicId: number, professorUUID: string, addSolutionsToFilename: boolean): ZipObject => {
    const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
    });

    // Listen for archiving errors.
    archive.on('error', error => {logger.error('Archiver error', error); postBackErrorOrResultToBackend(topicId);});
    archive.on('progress', progress => logger.debug(`[${topicId}] ...${progress.entries.processed}/${progress.entries.total}`));
    archive.on('warning', warning => logger.debug('Archiver warning: ' + warning));
    archive.on('end', () => logger.debug('End archive'));
    archive.on('close', () => logger.debug('Closing archive'));
    archive.on('drain', () => logger.debug('Draining archive'));

    const awsKey = awsZipKey(professorUUID, topicId, addSolutionsToFilename);

    const {
        stream,
        upload,
        uploadDonePromise
    } = S3Helper.uploadFromStream(awsKey);

    archive.pipe(stream);

    return {
        archive: archive,
        upload: upload,
        awsKey: awsKey,
        uploadDonePromise: uploadDonePromise
    };
}

export const addPDFToZip = async (archive: archiver.Archiver, pdfPromise: Promise<string | undefined>, topicId: number) => {
    try {
        const baseFilename = await pdfPromise;

        if (_.isNil(baseFilename)) {
            logger.warn(`[${topicId}] Got a rejected promise while zipping.`);
            return;
        }

        const pdfFilepath = pdfTempFile(topicId, baseFilename);
        logger.debug(`[${topicId}] Appended ${pdfFilepath} to zip.`)
        const pdfReadStream = createReadStream(pdfFilepath);
        pdfReadStream.on('error', (error: unknown) => logger.error('Erroring reading pdf', error));
        pdfReadStream.on('close', () => {
            unlink(pdfFilepath)
            .then(() => logger.debug('Deleted pdf after adding to zip'))
            .catch(e => logger.error('Unable to delete pdf after adding to zip', e));    
        });
        archive.append(pdfReadStream, { name: path.basename(pdfFilepath) });
    } catch (e) {
        logger.error('Failed to add pdf to zip', e);
        if (e instanceof CreatePDFError) {
            archive.append(`There was an error creating this student's PDF. Please use the Single Export option to print from your browser.`, { name: `${e.errorFilename}.txt` });
        }
    }
};

export const finalizeZip = async (zipObject: ZipObject, query: GetExportArchiveOptions, pdfPromises: Promise<string | undefined>[]) => {
    const {topicId} = query;

    try {
        await zipObject.archive.finalize();
    } catch (e) {
        logger.error('An error occured finalizing the archive', e);
        return await postBackErrorOrResultToBackend(topicId);
    }

    logger.debug('Done archiving, now uploading.');

    try {
        logger.debug('finalizeZip: Waiting for upload to finish')
        const uploadRes = await zipObject.uploadDonePromise;
        logger.debug('finalizeZip: Upload complete')

        await postBackErrorOrResultToBackend(topicId, (uploadRes as _Object).Key)

        // TODO: Delete old files for the same topic.
    } catch (e) {
        logger.error('Failed to upload to S3 or postback to Backend.', e);
        await postBackErrorOrResultToBackend(topicId);
    }
};

export const postBackErrorOrResultToBackend = async (topicId: number, exportUrl?: string): Promise<AxiosResponse> => {
    const topicTempDirectoryPath = topicTempDirectory(topicId);
    if (existsSync(topicTempDirectoryPath)) {
        remove(topicTempDirectoryPath)
        .then(() => logger.debug('postBackErrorOrResultToBackend: deleted tmp directory'))
        .catch((e) => logger.error(`postBackErrorOrResultToBackend: could not delete temp directory ${topicTempDirectoryPath}`, e));    
    } else {
        logger.warn(`postBackErrorOrResultToBackend: tried to delete temp directory but it did not exist "${topicTempDirectoryPath}"`);
    }

    return await axios.put(`${configurations.backend.url}/backend-api/courses/topic/${topicId}/endExport`, {
        exportUrl
    });
}
