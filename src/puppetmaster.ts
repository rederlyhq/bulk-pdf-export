import { Semaphore, withTimeout } from 'async-mutex';
import { isNull } from 'lodash';
import _ = require('lodash');
import * as puppeteer from 'puppeteer-core';
import configurations from './configurations';
import logger from './utilities/logger';
import S3Helper from './utilities/s3-helper';
import { performance } from 'perf_hooks';

/**
 * An important part of the PDF generation is waiting for the HTML page to finish loading all content.
 * https://github.com/puppeteer/puppeteer/blob/v5.5.0/docs/api.md#browserwaitfortargetpredicate-options
 */

export default class PuppetMaster {
    static semaphore = withTimeout(new Semaphore(configurations.app.concurrentPuppeteerTabs), 3600000);

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

    static async safePrint(filepath: string) {
        const perf_wait = performance.now();
        const [value, release] = await PuppetMaster.semaphore.acquire();
        const perf_work = performance.now();
        logger.debug(`Semaphore acquired with ${value}`);
        try {
            return await PuppetMaster.print(filepath);
        } catch(e) {
            throw e;
        } finally {
            release();
            const perf_done = performance.now();
            logger.info(`Released semaphore. Total time: ${((perf_done - perf_wait) / 1000).toFixed(1)} seconds / Printing time: ${((perf_done - perf_work) / 1000).toFixed(1)}`);
        }
    }
    
    static async print(filepath: string) {
        const browser = await PuppetMaster.browser;
        if (!browser) return;

        const filepathEnc = encodeURIComponent(filepath);
        const page = await browser.newPage();

        // The Express server statically hosts the tmp files.
        await page.goto(`http://127.0.0.1:${configurations.server.port}/export/${filepathEnc}.html`, {waitUntil: ['load', 'networkidle0'], timeout: 120000});
        const mathJaxPromise = page.evaluate(()=>{
            const iframes = document.getElementsByTagName('iframe');

            const mathJaxPromises = [];

            // @ts-ignore - HTMLCollections are iterable in modern Chrome/Firefox.
            for (let iframe of iframes) {
                // We may want a more specific selector than 'internal'.
                var showSolution = iframe.contentDocument.getElementsByClassName('internal');
                for (let solution of showSolution) {
                    solution.click();
                }


                var expandables = iframe.contentDocument.getElementsByClassName('canopen');
                for (let expandable of expandables) {
                    expandable.click();
                }

                mathJaxPromises.push(new Promise<void>((resolveSingleHasLoaded, reject2) => {
                    if (!iframe.contentWindow.MathJax || !iframe.contentWindow.MathJax.Hub) return;
                    iframe.contentWindow.MathJax.Hub.Register.StartupHook("End", function () {
                        resolveSingleHasLoaded();
                    });
                }));
            }

            return Promise.all(mathJaxPromises);
        });

        // Wait for Mathjax to load, timing out after 10 seconds.
        await Promise.race([mathJaxPromise, page.waitForTimeout(10000)])

        // Wait for 3 seconds after network events are done to give time for any extra renderings.
        await page.waitForTimeout(3000);
        const pdf = await page.pdf({
            path: `/tmp/${filepath}.pdf`,
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