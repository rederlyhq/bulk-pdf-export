# The instructions for the first stage
FROM node:lts-buster as builder
WORKDIR /app
# install app dependencies
COPY package.json ./
COPY package-lock.json ./
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true
RUN npm install --silent

# Seems like this would be a problem if you already locally had node modules
COPY . ./

ARG REDERLY_PACKAGER_PRUNE_DEPENDENCIES=true

# Builds and creates the package, does not create an archive
RUN REDERLY_PACKAGER_ARCHIVE=false REDERLY_PACKAGER_PRUNE_DEPENDENCIES=$REDERLY_PACKAGER_PRUNE_DEPENDENCIES npm run build:package

# https://github.com/puppeteer/puppeteer/blob/main/docs/troubleshooting.md#running-puppeteer-in-docker
FROM node:lts-buster

# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chromium that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y wget gnupg --no-install-recommends \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_PRODUCT chrome

# Start Xvfb
RUN Xvfb :99 -ac -screen 0 1280x720x16 -nolisten tcp &
ENV DISPLAY :99

WORKDIR /app

ENV PATH /app/node_modules/.bin:$PATH

RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app

# Run everything after as non-privileged user.
USER pptruser

EXPOSE 3005

COPY --from=builder /app/build /app
COPY --from=builder /app/.env /app/

CMD ["node", "--trace-warnings", "ts-built/app-scripts/index.js"]