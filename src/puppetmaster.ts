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
        await page.goto(`http://127.0.0.1:3005/export/${filepathEnc}.html`, {waitUntil: ['load', 'networkidle0'], timeout: 120000});
        const mathJaxPromise = page.evaluate(()=>{
            return new Promise<void>((resolve, reject) => {
                // @ts-ignore
                window.MathJax.Hub.Register.StartupHook("End",function () {
                    resolve();
                });
            })
        })

        // Wait for Mathjax to load, timing out after 5 seconds.
        await Promise.race([mathJaxPromise, page.waitForTimeout(5000)])

        // Wait for 3 seconds after network events are done to give time for any extra renderings.
        await page.waitForTimeout(3000);
        const pdf = await page.pdf({
            displayHeaderFooter: true,
            // This currently does not work with our docker build because of https://github.com/puppeteer/puppeteer/issues/5663
            // headerTemplate: '<div style="font-family: Tahoma, Verdana, Segoe, sans-serif; font-size: 6px; padding-left:10px; background-color: red; color:black;"><span class="pageNumber"></span> of <span class="totalPages"></span> Exported by Rederly, Inc.</div>',
            footerTemplate: '<span style="font-family: Tahoma, Verdana, Segoe, sans-serif; font-size: 6px; padding-left:10px; background-color: red; color:black;">Exported by Rederly, Inc.</span>',
            margin: {
                // top: '30px',
                bottom: '30px',
            },
        });
        await page.close();
        return pdf;
    }
}