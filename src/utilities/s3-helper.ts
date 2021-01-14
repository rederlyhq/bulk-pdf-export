import {S3Client, PutObjectCommand} from '@aws-sdk/client-s3';
import { config } from 'dotenv/types';
import configurations from '../configurations';

export default class S3Helper {
    static s3 = new S3Client({
        region: configurations.aws.awsRegion,
        credentials: {
            accessKeyId: configurations.aws.awsAccessKeyId,
            secretAccessKey: configurations.aws.awsSecretKey,
        }
    });

    static async writeFile(filename: string, body: Buffer) {
        const data = await S3Helper.s3.send(new PutObjectCommand({
            Bucket: configurations.aws.bucket,
            Key: `${filename}.pdf`,
            Body: body,
        }));
    }
}