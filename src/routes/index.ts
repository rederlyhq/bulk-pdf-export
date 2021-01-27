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
import axios from 'axios';

const writeFile = util.promisify(fs.writeFile);

interface RequestOptions {
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
    }[];
    attachments: string[];
};

/**
 * firstName
 * lastName
 * topicTitle
 * problems: [{number, srcdoc, attachments}]
 */
router.post('/', async (_req, _res, next) => {
    const {firstName, lastName, topic: {name, id}, problems, professorUUID} = _req.body as RequestOptions;
    logger.info(`Got request to export ${firstName}'s topic with ${problems.length} problems.`);
    const filename = `${name}_${lastName}_${firstName}`;
    const prefix =  `exports/${professorUUID}/${id}/`;
    const htmlFilename = `/tmp/${filename}.html`;
    
    // Filename is required for caching to work. You must turn this off in development or restart your dev server.
    const f = pug.compileFile('src/pdf.pug', { filename: 'topic_student_export', cache: true });

    await writeFile(htmlFilename, f({
        firstName, lastName, topicTitle: name, problems
    }), 'utf8');

    logger.info(`Wrote '${htmlFilename}'`);

    const buffer = await PuppetMaster.print(filename);

    // fs.unlink(htmlFilename, () => {
    //     logger.info(`Cleaned up '${htmlFilename}'`);
    // });
    
    if (_.isNil(buffer) || _.isEmpty(buffer)) {
        logger.error(`Failed to print ${filename}`);
        return next(Boom.badImplementation('Failed to print.'));
    }

    logger.debug(`Got PDF data of size: ${buffer.length}`);
    await S3Helper.writeFile(`${prefix}${filename}`, buffer);

    next(httpResponse.Ok(filename, {}));
});

type GetExportArchiveOptions = {
    profUUID: string;
    topicId: number;
}

router.get('/', async (_req, _res, next) => {
    logger.info('Responding with OK first.');
    next(httpResponse.Ok('Ok'));
    const {profUUID, topicId} = _req.query;
    // The `exports` logical folder in S3 is what our frontend can redirect to.
    const prefix = `exports/${profUUID}/${topicId}`;
    logger.debug(`Getting objects from ${prefix}`);

    const res = await S3Helper.getFilesInFolder(`${prefix}/`);
    if (_.isNil(res.Contents) || _.isEmpty(res.Contents)) {
        return next(Boom.preconditionFailed('No files to archive.'));
    }

    logger.debug(`Found ${res.Contents.length} files for archiving.`);

    const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
    });

    // Listen for archiving errors.
    archive.on('error', error => console.log(error));
    archive.on('progress', progress => console.log('Got progress object ' + progress.entries.processed));
    archive.on('warning', warning => console.log(warning));
    archive.on('entry', entry => console.log('Got an entry'));
    archive.on('end', () => console.log('End archive'));
    archive.on('close', () => console.log('Closing archive'));
    archive.on('drain', () => console.log('Draining archive'));

    // Get the stream and upload objects from the AWS SDK.
    const {stream, upload} = S3Helper.uploadFromStream(`${prefix}_file.zip`);

    // Pipe the data from the archive to S3.
    archive.pipe(stream);


    await res.Contents.asyncForEach(async (content) => {
        try {
            const file = await S3Helper.getObject(content);
            if (_.isNil(file) || _.isNil(file.Body)) {
                return null;
            }

            const data = file.Body;

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

    logger.debug('Uploading... zip.');

    try {
        await archive.finalize();
        console.log('Done finalizing');
    } catch (e) {
        console.log('Error finalizing');
        console.error(e);
    }

    logger.debug('Done archiving, now uploading.');

    try {
        const uploadRes = await upload.done();
        logger.info(`Uploaded ${prefix}_file.zip`);

        const result = await axios.put(`http://host.docker.internal:3001/backend-api/courses/topic/${topicId}/endExport`, {
            exportUrl: (uploadRes as _Object).Key
        });

        console.log(result.data);
    } catch (e) {
        console.error(e);
        next(Boom.badRequest('Failed to upload zip.', e));
    }
});

export default router;
