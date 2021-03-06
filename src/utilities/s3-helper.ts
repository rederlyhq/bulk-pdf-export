import {S3Client, PutObjectCommand, S3, _Object} from '@aws-sdk/client-s3';
import stream = require('stream');
import configurations from '../configurations';
import logger from './logger';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'fs';

export default class S3Helper {
    static awsConfigurationObject = {
        region: configurations.aws.awsRegion,
        credentials: {
            accessKeyId: configurations.aws.awsAccessKeyId,
            secretAccessKey: configurations.aws.awsSecretKey,
        }
    }
    static s3 = new S3({ ...S3Helper.awsConfigurationObject })

    static s3client = new S3Client({ ...S3Helper.awsConfigurationObject });

    // AWS filenames are full "logical paths" from the bucket.
    static async writeFile(awsFilename: string, body: string | Buffer | Uint8Array | ReadableStream<any> | Blob) {
        return await S3Helper.s3client.send(new PutObjectCommand({
            Bucket: configurations.aws.bucket,
            Key: awsFilename,
            Body: body,
        }));
    }

    // This is used to upload a Zip file from a stream.
    static uploadFile(localFilename: string, awsFilename: string) {
        return new Upload({
            client: S3Helper.s3,
            params: {
                Bucket: configurations.aws.bucket,
                Key: awsFilename,
                Body: createReadStream(localFilename),
            },
        }).done();
      }

    // This is used to upload a Zip file from a stream.
    static uploadFromStream(awsFilename: string) {
        const pass = new stream.PassThrough();
        const upload = new Upload({
            client: S3Helper.s3,
            leavePartsOnError: true,
            params: {
                Bucket: configurations.aws.bucket,
                Key: awsFilename,
                Body: pass,
            },
        });

        upload.on('httpUploadProgress', (progress) => logger.debug(`uploadFromStream: progress`, progress));
        pass.on('error', (err) => logger.error('uploadFromStream: Error piping data to aws', err));
        pass.on('close', () => logger.debug('uploadFromStream: Piping to aws stream closed'));
        
        const uploadDonePromise = upload.done();
        const startTime = new Date();
        uploadDonePromise.then(() => {
            const duration = new Date().getTime() - startTime.getTime();
            logger.info(`uploadFromStream: uploaded to aws in ${duration} milliseconds`)
        });

        return {stream: pass, upload: upload, uploadDonePromise: uploadDonePromise};
    }

    static async getFilesInFolder(folderPath: string) {
        const files = await S3Helper.s3.listObjects({
            Bucket: configurations.aws.bucket,
            Prefix: folderPath,
        });

        return files;
    }

    static async getObject(content: _Object) {
        logger.debug(`Pulling ${content.Key} from AWS.`);
        try {
            return await S3Helper.s3.getObject({
                Bucket: configurations.aws.bucket,
                Key: content.Key,
            });
        } catch (e) {
            console.log(content);
            logger.error(e);
        }
    }

    static async getAllObjects(contents: _Object[]) {
        const promises = contents.map(async ({Key}) => (
            S3Helper.s3.getObject({
                Bucket: configurations.aws.bucket,
                Key: Key,
            })
        ))

        return Promise.all(promises);
    }
}