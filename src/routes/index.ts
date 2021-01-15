import * as express from 'express';
import httpResponse from '../utilities/http-response';
const router = express.Router();
import _ = require('lodash');
import logger from '../utilities/logger';
import * as pug from 'pug';
import * as fs from 'fs';
import * as util from 'util';
import Server from '../puppetmaster';
import { truncate } from 'lodash';

const writeFile = util.promisify(fs.writeFile);

interface RequestOptions {
    firstName: string;
    lastName: string;
    topicTitle: string;
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
    const {firstName, lastName, topicTitle, problems} = _req.body as RequestOptions;
    const filename = `${topicTitle}_${lastName}_${firstName}`;
    
    // Filename is required for caching to work. You must turn this off in development or restart your dev server.
    const f = pug.compileFile('src/pdf.pug', { filename: 'topic_student_export', cache: true });

    await writeFile(`/tmp/${filename}.html`, f({
        firstName, lastName, topicTitle, problems
    }), 'utf8');

    logger.info(`Wrote '/tmp/${filename}.html'`);

    const awsRes = await Server.print(filename);
    console.log(awsRes);

    next(httpResponse.Ok(filename, {}));
});


export default router;
