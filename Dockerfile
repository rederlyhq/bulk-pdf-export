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
    && apt-get install -y fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 fonts-liberation  libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3  libxkbcommon0 libxrandr2  xdg-utils libu2f-udev  libvulkan1  \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ARG CHROME_VERSION="88.0.4324.182-1"
RUN wget --no-verbose -O /tmp/chrome.deb https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb \
  && apt install -y /tmp/chrome.deb \
  && rm /tmp/chrome.deb

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