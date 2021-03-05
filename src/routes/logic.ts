import _ = require('lodash');
import logger from '../utilities/logger';
import * as pug from 'pug';
import * as fs from 'fs';
import * as util from 'util';
import PuppetMaster from '../puppetmaster';
import S3Helper from '../utilities/s3-helper';
import * as archiver from 'archiver';
import { _Object } from '@aws-sdk/client-s3';
import axios, { AxiosResponse } from 'axios';
import configurations from '../configurations';
import { GetExportArchiveOptions, MakePDFRequestOptions, ZipObject } from '.';
import CreatePDFError from '../utilities/CreatePDFError';

const writeFile = util.promisify(fs.writeFile);

export const createPDFFromSrcdoc = async (body: MakePDFRequestOptions) => {
    const {firstName, lastName, topic: {name, id}, problems, professorUUID} = body;
    logger.info(`Got request to export ${firstName}'s topic with ${problems.length} problems.`);

    const filename = `${name}_${lastName}_${firstName}`;
    const prefix =  `exports/${professorUUID}/${id}/`;
    const htmlFilename = `/tmp/${filename}.html`;

    try {
        // Filename is required for caching to work. You must turn this off in development or restart your dev server.
        const f = pug.compileFile('assets/pug/pdf.pug', { filename: 'topic_student_export', cache: true, debug: false});

        const prettyProblems = _(problems).sortBy(['number']).map(prob => ({
            ...prob,
            effectiveScore: prob.effectiveScore?.toPercentString(),
            legalScore: prob.legalScore?.toPercentString(),
        })).value();

        await writeFile(htmlFilename, f({
            firstName, lastName, topicTitle: name, problems: prettyProblems
        }), 'utf8');

        logger.debug(`Wrote '${htmlFilename}'`);

        const buffer = await PuppetMaster.safePrint(filename);

        fs.promises.unlink(htmlFilename).then(() => logger.debug(`Successfully unlinked ${htmlFilename}`)).catch(logger.error);
        
        if (_.isNil(buffer) || _.isEmpty(buffer)) {
            logger.error(`Failed to print ${filename}`);
            return;
        }

        logger.debug(`Got PDF data of size: ${buffer.length}`);
        await S3Helper.writeFile(`${prefix}${filename}`, buffer);
        return filename;
    } catch (e) {
        throw new CreatePDFError(`Failed to create PDF because '${e.message}'`, filename);
    }
}

export const createZip = (topicId: number): {
    archive: archiver.Archiver;
    filename: string;
} => {

    const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
    });

    // Listen for archiving errors.
    archive.on('error', error => {logger.error('Archiver error', error); postBackErrorOrResultToBackend(topicId);});
    archive.on('progress', progress => logger.debug(`...${progress.entries.processed}/${progress.entries.total}`));
    archive.on('warning', warning => logger.debug('Archiver warning: ' + warning));
    archive.on('end', () => logger.debug('End archive'));
    archive.on('close', () => logger.debug('Closing archive'));
    archive.on('drain', () => logger.debug('Draining archive'));

    // Pipe the data from the archive to S3.
    const zipFilename = `/tmp/${topicId}_${Date.now()}.zip`;

    logger.debug(`Creating ${zipFilename}`)
    const output = fs.createWriteStream(zipFilename);
    archive.pipe(output);
    return {
        archive: archive,
        filename: zipFilename
    };
}

export const addPDFToZip = async (archive: archiver.Archiver, pdfPromise: Promise<string | undefined>) => {
    try {
        const pdfFilename = await pdfPromise;
        const pdfFilenameWithExtension = `${pdfFilename}.pdf`;
        const pdfFilepath = `/tmp/${pdfFilename}.pdf`;

        if (_.isNil(pdfFilename)) {
            logger.warn('Got a rejected promise while zipping.');
            return;
        }

        logger.debug(`Appended ${pdfFilepath} to zip.`)
        const pdfReadStream = fs.createReadStream(pdfFilepath);
        pdfReadStream.on('error', (error) => logger.error('Erroring reading pdf', error));
        pdfReadStream.on('close', () => {
            fs.promises.unlink(pdfFilepath)
            .then(() => logger.debug('Deleted pdf after adding to zip'))
            .catch(e => logger.error('Unable to delete pdf after adding to zip', e));    
        });
        archive.append(pdfReadStream, { name: pdfFilenameWithExtension });
    } catch (e) {
        logger.error('Failed to add pdf to zip', e);
        if (e instanceof CreatePDFError) {
            archive.append(`There was an error creating this student's PDF. Please use the Single Export option to print from your browser.`, { name: `${e.errorFilename}.txt` });
        }
    }
};

export const finalizeZip = async (zipObject: ZipObject, query: GetExportArchiveOptions, pdfPromises: Promise<string | undefined>[]) => {
    const {profUUID, topicId, addSolutionToFilename} = query;
    // The `exports` logical folder in S3 is what our frontend can redirect to.
    const prefix = `exports/${profUUID}/${topicId}`;

    try {
        await zipObject.archive.finalize();
    } catch (e) {
        logger.error('An error occured finalizing the archive', e);
        return await postBackErrorOrResultToBackend(topicId);
    }

    logger.debug('Done archiving, now uploading.');

    try {
        const newFilename = `${prefix}_${Date.now()}${addSolutionToFilename ? '-solutions' : ''}.zip`;
        const uploadRes = await S3Helper.uploadFromStream(zipObject.filename, newFilename);
        logger.info(`Uploaded ${newFilename}`);

        await postBackErrorOrResultToBackend(topicId, (uploadRes as _Object).Key)

        // TODO: Delete old files for the same topic.
    } catch (e) {
        logger.error('Failed to upload to S3 or postback to Backend.', e);
        await postBackErrorOrResultToBackend(topicId);
    } finally {
        await pdfPromises.asyncForEach(async (pdfPromise) => {
            const pdfFilename = await pdfPromise;
            if (_.isNil(pdfFilename)) {
                logger.warn('Got a rejected promise while zipping.');
                return;
            }

            const pdfPath = `/tmp/${pdfFilename}.pdf`;

            if (fs.existsSync(pdfPath)) {
                fs.promises.unlink(pdfPath)
                .then(() => logger.debug(`Cleaned up /tmp/${pdfFilename}.pdf`))
                .catch(e => logger.error('Failed to delete pdf file', e));
            }
        });

        fs.promises.unlink(zipObject.filename)
        .then(() => logger.debug(`Cleaned up ${zipObject.filename}`))
        .catch(e => logger.error('Failed to delete zip file', e));
    }
};

export const postBackErrorOrResultToBackend = async (topicId: number, exportUrl?: string): Promise<AxiosResponse> => {
    return await axios.put(`${configurations.backend.url}/backend-api/courses/topic/${topicId}/endExport`, {
        exportUrl
    });
}
