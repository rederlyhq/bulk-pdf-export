import * as express from 'express';
import httpResponse from '../utilities/http-response';
const router = express.Router();
import _ = require('lodash');
import logger from '../utilities/logger';
import * as pug from 'pug';
import * as fs from 'fs';
import * as util from 'util';
import PuppetMaster from '../puppetmaster';
import { truncate } from 'lodash';
import S3Helper from '../utilities/s3-helper';
import Boom = require('boom');
import * as archiver from 'archiver';
import { Readable } from 'stream';
import path = require('path');
import { ReplicationRuleAndOperator, _Object } from '@aws-sdk/client-s3';
import axios, { AxiosResponse } from 'axios';
import configurations from '../configurations';
import { GetExportArchiveOptions, MakePDFRequestOptions } from '.';

const writeFile = util.promisify(fs.writeFile);

export const createPDFFromSrcdoc = async (body: MakePDFRequestOptions) => {
    const {firstName, lastName, topic: {name, id}, problems, professorUUID} = body;
    logger.info(`Got request to export ${firstName}'s topic with ${problems.length} problems.`);

    const filename = `${name}_${lastName}_${firstName}`;
    const prefix =  `exports/${professorUUID}/${id}/`;
    const htmlFilename = `/tmp/${filename}.html`;
    const pdfFilename = `/tmp/${filename}.pdf`;

    // Filename is required for caching to work. You must turn this off in development or restart your dev server.
    const f = pug.compileFile('src/pdf.pug', { filename: 'topic_student_export', cache: true});

    const prettyProblems = _(problems).sortBy(['number']).map(prob => ({
        ...prob,
        effectiveScore: prob.effectiveScore?.toPercentString(),
        legalScore: prob.legalScore?.toPercentString(),
    })).value();

    await writeFile(htmlFilename, f({
        firstName, lastName, topicTitle: name, problems: prettyProblems,
    }), 'utf8');

    logger.debug(`Wrote '${htmlFilename}'`);

    const buffer = await PuppetMaster.safePrint(filename);

    fs.unlink(htmlFilename, () => {
        logger.debug(`Cleaned up '${htmlFilename}'`);
    });
    
    if (_.isNil(buffer) || _.isEmpty(buffer)) {
        logger.error(`Failed to print ${filename}`);
        return;
    }

    logger.debug(`Got PDF data of size: ${buffer.length}`);
    await S3Helper.writeFile(`${prefix}${filename}`, buffer);

    return filename;
}

export const createZipFromPdfs = async (query: GetExportArchiveOptions, pdfPromises: Promise<string | undefined>[]) => {
    const {profUUID, topicId, addSolutionToFilename} = query;

    // The `exports` logical folder in S3 is what our frontend can redirect to.
    const prefix = `exports/${profUUID}/${topicId}`;

    const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
    });

    // Listen for archiving errors.
    archive.on('error', error => {logger.error('Archiver error' + error); postBackErrorOrResultToBackend(topicId);});
    archive.on('progress', progress => logger.debug(`...${progress.entries.processed}/${progress.entries.total}`));
    archive.on('warning', warning => logger.debug('Archiver warning: ' + warning));
    archive.on('end', () => logger.debug('End archive'));
    archive.on('close', () => logger.debug('Closing archive'));
    archive.on('drain', () => logger.debug('Draining archive'));

    // Pipe the data from the archive to S3.
    const zipFilename = `/tmp/${topicId}_${Date.now()}.zip`;

    logger.debug(`Creating /tmp/${topicId}_${Date.now()}.zip`)
    const output = fs.createWriteStream(zipFilename);
    archive.pipe(output);

    await pdfPromises.asyncForEach(async (pdfPromise) => {
        const pdfFilename = await pdfPromise;
        if (_.isNil(pdfFilename)) {
            logger.warn('Got a rejected promise while zipping.');
            return;
        }

        logger.debug(`Appended /tmp/${pdfFilename}.pdf to zip.`)
        archive.file(`/tmp/${pdfFilename}.pdf`, { name: `${pdfFilename}.pdf` });
    });

    try {
        await archive.finalize();
    } catch (e) {
        logger.error('An error occured finalizing the archive', e);
        return await postBackErrorOrResultToBackend(topicId);
    }

    logger.debug('Done archiving, now uploading.');

    try {
        const newFilename = `${prefix}_${Date.now()}${addSolutionToFilename ? '-solutions' : ''}.zip`;
        const uploadRes = await S3Helper.uploadFromStream(zipFilename, newFilename);
        logger.info(`Uploaded ${newFilename}`);

        await postBackErrorOrResultToBackend(topicId, (uploadRes as _Object).Key)

        // TODO: Delete old files for the same topic.
    } catch (e) {
        logger.error('Failed to upload to S3 or postback to Backend.', e);
        await postBackErrorOrResultToBackend(topicId);
    }

    await pdfPromises.asyncForEach(async (pdfPromise) => {
        const pdfFilename = await pdfPromise;
        if (_.isNil(pdfFilename)) {
            logger.warn('Got a rejected promise while zipping.');
            return;
        }

        fs.unlink(`/tmp/${pdfFilename}.pdf`, () => logger.debug(`Cleaned up /tmp/${pdfFilename}.pdf`));
    });

    // Cleaning up Zip file.
    fs.unlink(zipFilename, () => logger.debug(`Cleaned up ${zipFilename}`));
}

export const postBackErrorOrResultToBackend = async (topicId: number, exportUrl?: string): Promise<AxiosResponse> => {
    return await axios.put(`${configurations.backend.url}/backend-api/courses/topic/${topicId}/endExport`, {
        exportUrl
    });
}
