This is a Rederly microservice that exports PDFs. It is built off of [Atlassian's Docker-Chromium-Xvfb](https://github.com/atlassian/docker-chromium-xvfb) recipe and the npm package [html5-to-pdf](https://github.com/peterdemartini/html5-to-pdf).

Future Improvements:
* [This issue](https://github.com/peterdemartini/html5-to-pdf/issues/52) notes that multiple Puppeteer starts are needed when creating multiple parallel PDFs. The author suggests a library change to have a reusable puppeteer instance, which would a huge optimization.
* [html5-to-pdf](https://github.com/peterdemartini/html5-to-pdf) has built-in support for two templating engines. Rederly uses [pug](https://github.com/pugjs/pug) and could patch in support for it to the library.