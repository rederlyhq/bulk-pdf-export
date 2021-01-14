import * as express from 'express';
import httpResponse from '../utilities/http-response';
const router = express.Router();
import _ = require('lodash');
import logger from '../utilities/logger';
import * as pug from 'pug';
import * as fs from 'fs';
import * as util from 'util';
import Server from '../puppetmaster';

const writeFile = util.promisify(fs.writeFile);
const f = _.once(pug.compileFile)('src/pdf.pug');

/**
 * firstName
 * lastName
 * topicTitle
 * problems: [{number, srcdoc, attachments}]
 */
router.post('/', async (_req, _res, next) => {
    const {firstName, lastName, topicTitle, problems} = _req.body as {firstName: String, lastName: String, topicTitle: String, problems: {number: number, srcdoc: string}[]};
    const filename = `${topicTitle}_${lastName}_${firstName}`;
    
    await writeFile(`/tmp/${filename}.html`, f({
        firstName, lastName, topicTitle, problems
    }), 'utf8');

    await Server.print(filename);

    next(httpResponse.Ok('Test', {}));
});


export default router;
