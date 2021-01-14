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

/**
 * firstName
 * lastName
 * topicTitle
 * problems: [{number, srcdoc, attachments}]
 */
router.post('/', async (_req, _res, next) => {
    const {firstName, lastName, topicTitle, problems} = _req.body as {firstName: String, lastName: String, topicTitle: String, problems: {number: number, srcdoc: string}[]};
    const filename = `${topicTitle}_${lastName}_${firstName}`;
    
    // problems.forEach(x => console.log(x.srcdoc));

    const f = pug.compileFile('src/pdf.pug', { filename: 'topic_student_export', cache: true, debug: true });

    await writeFile(`/tmp/${filename}.html`, f({
        firstName, lastName, topicTitle, problems
    }), 'utf8');

    console.log(`Wrote /tmp/${filename}.html`);

    // await Server.print(filename);

    next(httpResponse.Ok('Test', {}));
});


export default router;
