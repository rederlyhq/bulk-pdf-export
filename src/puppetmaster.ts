import { Semaphore, withTimeout } from 'async-mutex';
import _ = require('lodash');
import * as puppeteer from 'puppeteer-core';
import configurations from './configurations';
import logger from './utilities/logger';
import { performance } from 'perf_hooks';
import path = require('path');

/**
 * An important part of the PDF generation is waiting for the HTML page to finish loading all content.
 * https://github.com/puppeteer/puppeteer/blob/v5.5.0/docs/api.md#browserwaitfortargetpredicate-options
 */

export default class PuppetMaster {
    static semaphore = withTimeout(new Semaphore(configurations.app.concurrentPuppeteerTabs), 600000);

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

    static async safePrint(pdfFilePath: string, urlPath: string) {
        const perf_wait = performance.now();
        const [value, release] = await PuppetMaster.semaphore.acquire();
        const perf_work = performance.now();
        logger.debug(`Semaphore acquired with ${value}`);
        try {
            return await PuppetMaster.print(pdfFilePath, urlPath);
        } catch(e) {
            throw e;
        } finally {
            release();
            const perf_done = performance.now();
            logger.info(`Released semaphore. Total time: ${((perf_done - perf_wait) / 1000).toFixed(1)} seconds / Printing time: ${((perf_done - perf_work) / 1000).toFixed(1)}`);
        }
    }
    
    static async print(pdfFilePath: string, urlPath: string) {
        const browser = await PuppetMaster.browser;
        if (!browser) throw new Error('No browser instance available.');

        logger.debug('Creating a new page on the browser.');
        const page = await browser.newPage();

        logger.debug('Attaching console listeners.');
        page
            .on('console', message => {
                if (message.type() === 'error' || message.type() === 'warning') {
                    logger.error(`${message.type().substr(0, 3).toUpperCase()} ${message.text()}`);
                }
            })
            .on('pageerror', ({ message }) => logger.error(message))
            // .on('response', response => logger.debug(`${response.status()} ${response.url()}`))
            .on('requestfailed', request => logger.error(`${request.failure()?.errorText} ${request.url()}`))

        logger.debug(`Navigating to ${urlPath}.html`);
        // The Express server statically hosts the tmp files.
        await page.goto(`http://127.0.0.1:${configurations.server.port}/export/${urlPath}`, {waitUntil: ['load', 'networkidle0'], timeout: configurations.puppeteer.navigationTimeout});
        
        logger.debug('Injecting MathJax Promises.');
        const resourcePromise = page.evaluate(()=>{
            const iframes = document.getElementsByTagName('iframe');

            const resourcePromises = [];

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

                resourcePromises.push(new Promise<void>((resolveSingleHasLoaded) => {
                    if (!iframe.contentWindow.MathJax || !iframe.contentWindow.MathJax.Hub) return resolveSingleHasLoaded();
                    iframe.contentWindow.MathJax.Hub.Register.StartupHook("End", function () {
                        resolveSingleHasLoaded();
                    });
                }));
            }

            const heics = document.getElementsByClassName('heic');

            // @ts-ignore - HTMLCollections are iterable in modern Chrome/Firefox.
            for (let heic of heics) {
                resourcePromises.push(new Promise<void>((resolveSingleHasLoaded) => {
                    if (heic.src && heic.src.startsWith('blob:')) {
                        console.warn('HEIC: already loaded!')
                        resolveSingleHasLoaded();
                    } else {
                        heic.addEventListener('heicDone', ()=>{
                            console.warn('HEIC: EVENT finished!');
                            resolveSingleHasLoaded();
                        });
                    }
                }));
            }

            return Promise.all(resourcePromises);
        });

        logger.debug('Waiting for Resources (Mathjax, HEIC).');
        // Wait for Mathjax to load, timing out after 10 seconds.
        await Promise.race([resourcePromise, page.waitForTimeout(configurations.puppeteer.resourceTimeout)])

        logger.debug('Waiting for extra time.');
        // Wait for 3 seconds after network events are done to give time for any extra renderings.
        await page.waitForTimeout(configurations.puppeteer.extraTimeout);

        logger.debug('Waiting to make a PDF.');
        const pdf = await page.pdf({
            path: pdfFilePath,
            displayHeaderFooter: true,
            // This currently does not work with our docker build because of https://github.com/puppeteer/puppeteer/issues/5663
            // headerTemplate: '<div style="font-family: Tahoma, Verdana, Segoe, sans-serif; font-size: 6px; padding-left:10px; background-color: red; color:black;"><span class="pageNumber"></span> of <span class="totalPages"></span> Exported by Rederly, Inc.</div>',
            footerTemplate: '<span style="font-family: Tahoma, Verdana, Segoe, sans-serif; font-size: 6px; padding-left:10px; background-color: red; color:black;">Exported by Rederly, Inc.</span>',
            margin: {
                // top: '30px',
                bottom: '30px',
            },
        });

        logger.debug('Closing the tab.');
        await page.close();

        logger.debug('Returning the PDF');
        return pdf;
    }
}