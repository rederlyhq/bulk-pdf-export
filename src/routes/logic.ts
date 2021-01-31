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

    // Filename is required for caching to work. You must turn this off in development or restart your dev server.
    const f = pug.compileFile('src/pdf.pug', { filename: 'topic_student_export', cache: false});

    await writeFile(htmlFilename, f({
        firstName, lastName, topicTitle: name, problems: _.sortBy(problems, ['number']),
    }), 'utf8');

    logger.info(`Wrote '${htmlFilename}'`);

    const buffer = await PuppetMaster.safePrint(filename);

    // fs.unlink(htmlFilename, () => {
    //     logger.info(`Cleaned up '${htmlFilename}'`);
    // });
    
    if (_.isNil(buffer) || _.isEmpty(buffer)) {
        logger.error(`Failed to print ${filename}`);
        return;
    }

    logger.debug(`Got PDF data of size: ${buffer.length}`);
    await S3Helper.writeFile(`${prefix}${filename}`, buffer);

    return htmlFilename;
}

export const createZipFromPdfs = async (query: GetExportArchiveOptions) => {
    const {profUUID, topicId} = query;

    // The `exports` logical folder in S3 is what our frontend can redirect to.
    const prefix = `exports/${profUUID}/${topicId}`;
    logger.debug(`Getting objects from ${prefix}`);

    const res = await S3Helper.getFilesInFolder(`${prefix}/`);
    if (_.isNil(res.Contents) || _.isEmpty(res.Contents)) {
        return await postBackErrorOrResultToBackend(topicId);
    }

    logger.debug(`Found ${res.Contents.length} files for archiving.`);

    const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
    });

    // Listen for archiving errors.
    archive.on('error', error => {logger.debug(error); postBackErrorOrResultToBackend(topicId);});
    archive.on('progress', progress => logger.debug(`...${progress.entries.processed}/${progress.entries.total}`));
    archive.on('warning', warning => logger.debug(warning));
    archive.on('end', () => logger.debug('End archive'));
    archive.on('close', () => logger.debug('Closing archive'));
    archive.on('drain', () => logger.debug('Draining archive'));

    // Pipe the data from the archive to S3.
    const output = fs.createWriteStream('/tmp/example.zip');
    archive.pipe(output);
    // archive.pipe(stream);

    let len = 0;
    // TODO: Since we're waiting for each PDF to be created, we could save them to disk and avoid fetching them over
    // the network.
    await res.Contents.asyncForEach(async (content) => {
        try {
            const file = await S3Helper.getObject(content);
            if (_.isNil(file) || _.isNil(file.Body)) {
                return null;
            }

            const data = file.Body;

            len += content.Size ?? 0;

            if (_.isNil(content.Key)) {
                logger.error('Tried to zip a file that was unnamed.');
                return;
            }

            const filename = path.basename(content.Key);

            if (data instanceof Readable) {
                archive.append(data, {
                    name: filename,
                });
            } else {
                logger.error('The AWS Library returned a data object that we expected to be Readable, but isn\'t.');
                return;
            }
        } catch (e) {
            logger.error(e);
            return;
        }
    });

    logger.debug(`Attempting to zip up ${len} bytes`);

    try {
        await archive.finalize();
    } catch (e) {
        logger.error('An error occured finalizing the archive', e);
        return await postBackErrorOrResultToBackend(topicId);
    }

    logger.debug('Done archiving, now uploading.');

    try {
        const uploadRes = await S3Helper.uploadFromStream(`${prefix}_file.zip`);
        logger.info(`Uploaded ${prefix}_file.zip`);

        await postBackErrorOrResultToBackend(topicId, (uploadRes as _Object).Key)
    } catch (e) {
        logger.error('Failed to upload to S3 or postback to Backend.', e);
        await postBackErrorOrResultToBackend(topicId);
    }
}

export const postBackErrorOrResultToBackend = async (topicId: number, exportUrl?: string): Promise<AxiosResponse> => {
    return await axios.put(`${configurations.backend.url}/backend-api/courses/topic/${topicId}/endExport`, {
        exportUrl
    });
}
