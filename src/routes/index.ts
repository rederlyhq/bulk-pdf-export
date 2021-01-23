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

const writeFile = util.promisify(fs.writeFile);

interface RequestOptions {
    firstName: string;
    lastName: string;
    topic: {
        name: string;
        id: number;
    }
    professorUUID: String;
    problems: {
        number: number, 
        srcdoc: string
    }[]
};

/**
 * firstName
 * lastName
 * topicTitle
 * problems: [{number, srcdoc, attachments}]
 */
router.post('/', async (_req, _res, next) => {
    const {firstName, lastName, topic: {name, id}, problems, professorUUID} = _req.body as RequestOptions;
    const filename = `${name}_${lastName}_${firstName}`;
    const prefix =  `${professorUUID}/${id}/`;
    const htmlFilename = `/tmp/${filename}.html`;
    
    // Filename is required for caching to work. You must turn this off in development or restart your dev server.
    const f = pug.compileFile('src/pdf.pug', { filename: 'topic_student_export', cache: true });

    await writeFile(htmlFilename, f({
        firstName, lastName, name, problems
    }), 'utf8');

    logger.info(`Wrote '${htmlFilename}'`);

    const buffer = await PuppetMaster.print(filename);

    fs.unlink(htmlFilename, () => {
        logger.info(`Cleaned up '${htmlFilename}'`);
    });
    
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
    const {profUUID, topicId} = _req.query;
    const prefix = `${profUUID}/${topicId}`;
    logger.debug(`Getting objects fromm ${prefix}`);

    const res = await S3Helper.getFilesInFolder(`${prefix}/`);
    if (_.isNil(res.Contents) || _.isEmpty(res.Contents)) {
        return next(Boom.preconditionFailed('No files to archive.'));
    }

    logger.debug(`Found ${res.Contents.length} files for archiving.`);

    const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
    });

    // Listen for archiving errors.
    archive.on('error', logger.error);

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

    logger.debug('Finalizing upload as zip.');

    await archive.finalize();

    try {
        const uploadRes = await upload.done();
        logger.info(`Uploaded ${prefix}_file.zip`);
        next(httpResponse.Ok('Ok', {zippedURL: (uploadRes as _Object).Key}));
    } catch (e) {
        console.error(e);
        next(Boom.badRequest('Failed to upload zip.', e));
    }

});

export default router;
