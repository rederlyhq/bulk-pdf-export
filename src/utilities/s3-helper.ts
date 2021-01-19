import {S3Client, PutObjectCommand, S3, _Object} from '@aws-sdk/client-s3';
import { config } from 'dotenv/types';
import stream = require('stream');
import configurations from '../configurations';
import logger from './logger';
import { Upload } from '@aws-sdk/lib-storage';

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
            Key: `${awsFilename}.pdf`,
            Body: body,
        }));
    }

    // This is used to upload a Zip file from a stream.
    static uploadFromStream(awsFilename: string) {
        var pass = new stream.PassThrough();

        const upload = new Upload({
            client: S3Helper.s3,
            params: {
                Bucket: configurations.aws.bucket,
                Key: awsFilename,
                Body: pass,
            }
        })
      
        return {stream: pass, upload: upload};
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