import { isNull } from 'lodash';
import _ = require('lodash');
import * as puppeteer from 'puppeteer-core';
import logger from './utilities/logger';
import S3Helper from './utilities/s3-helper';

/**
 * An important part of the PDF generation is waiting for the HTML page to finish loading all content.
 * https://github.com/puppeteer/puppeteer/blob/v5.5.0/docs/api.md#browserwaitfortargetpredicate-options
 */

export default class PuppetMaster {
    static browser: Promise<puppeteer.Browser> = puppeteer.launch({
        executablePath: 'google-chrome-stable'
    });

    constructor() {
        if (!PuppetMaster.browser) {
            PuppetMaster.browser = puppeteer.launch({
                executablePath: 'google-chrome-stable'
            });
        }
    }
    
    static async print(filepath: string) {
        const browser = await PuppetMaster.browser;
        if (!browser) return;

        const filepathEnc = encodeURIComponent(filepath);
        const page = await browser.newPage();
        // The Express server statically hosts the tmp files.
        await page.goto(`http://127.0.0.1:3005/export/${filepathEnc}.html`, {waitUntil: ['load', 'networkidle0']});
        const pdf = await page.pdf();
        await page.close();
        return pdf;
    }
}