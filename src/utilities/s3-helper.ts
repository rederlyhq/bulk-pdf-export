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

    // AWS filenames are full "logical paths" from the bucket.
    static async writeFile(awsFilename: string, body: Buffer) {
        return await S3Helper.s3.send(new PutObjectCommand({
            Bucket: configurations.aws.bucket,
            Key: `${awsFilename}.pdf`,
            Body: body,
        }));
    }
}