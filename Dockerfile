FROM node:lts-buster

RUN apt-get update && apt-get install -y curl xvfb

# Start Xvfb
RUN Xvfb :99 -ac -screen 0 1280x720x16 -nolisten tcp &

WORKDIR /app

ENV PATH /app/node_modules/.bin:$PATH

COPY package.json ./
COPY package-lock.json ./

RUN npm install --silent

