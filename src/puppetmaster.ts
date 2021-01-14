import { isNull } from 'lodash';
import _ = require('lodash');
import * as puppeteer from 'puppeteer-core';
import logger from './utilities/logger';

/**
 * An important part of the PDF generation is waiting for the HTML page to finish loading all content.
 * https://github.com/puppeteer/puppeteer/blob/v5.5.0/docs/api.md#browserwaitfortargetpredicate-options
 */

export default class Server {
    static browser: Promise<puppeteer.Browser> = puppeteer.launch({executablePath: 'google-chrome-stable'});

    constructor() {
        if (!Server.browser) {
            Server.browser = puppeteer.launch({executablePath: 'google-chrome-stable'});
        }
    }
    
    static async print(filepath: string) {
        const browser = await Server.browser;
        if (!browser) return;

        const page = await browser.newPage();
        await page.goto(`file:///tmp/${filepath}.html`, {waitUntil: ['load', 'networkidle0']});
        const pdf = await page.pdf({path: `/tmp/${filepath}.pdf`});
        logger.debug(`Got PDF data of size: ${pdf.length}`);
        // TODO: Pass buffer to S3
        await page.close();
    }
}