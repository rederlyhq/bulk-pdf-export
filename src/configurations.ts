import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
import * as _ from 'lodash';
import * as crypto from 'crypto';
dotenv.config();
dotenvExpand(dotenv.config({ path: './prisma/.env' }));
import { LoggingLevelType, LOGGING_LEVEL } from './utilities/logger-logging-levels';

let logs: Array<string> | null = [];
const generateLog = (key: string, value: string | undefined, defaultValue: unknown): string => `Configuration for [${key}] not recognized with value [${value}] using default value [${defaultValue}]`;

const fromBooleanField = (value: string | undefined | null): boolean | null => {
    switch (value?.toLowerCase()) {
        case 'true':
            return true;
        case 'false':
            return false;
        default:
            return null;
    }
};

function readBooleanValue(key: string, defaultValue: boolean): boolean;
function readBooleanValue(key: string, defaultValue?: boolean | null | undefined): boolean | null;
function readBooleanValue(key: string, defaultValue?: boolean | null | undefined): boolean | null {
    const rawValue = process.env[key];
    const value = fromBooleanField(rawValue);
    if (_.isNil(value)) {
        logs?.push(generateLog(key, rawValue, defaultValue));
        return defaultValue ?? null;
    }
    return value;
}

function readStringValue(key: string, defaultValue: string): string;
function readStringValue(key: string, defaultValue?: string | null | undefined): string | null;
function readStringValue(key: string, defaultValue?: string | null | undefined): string | null {
    const rawValue = process.env[key];
    const value = rawValue;
    if (_.isNil(value)) {
        logs?.push(generateLog(key, value, defaultValue));
        return defaultValue ?? null;
    }
    return value;
}

const fromIntValue = (value: string | undefined | null): number | null => {
    if (_.isNil(value)) {
        return null;
    }
    
    const result = parseInt(value, 10);
    if (isNaN(result)) {
        return null;
    }
    return result;
};

function readIntValue(key: string, defaultValue: number): number;
function readIntValue(key: string, defaultValue?: number | null | undefined): number | null;
function readIntValue(key: string, defaultValue?: number | null | undefined): number | null {
    const rawValue = process.env[key];
    const value = fromIntValue(rawValue);
    if (_.isNil(value)) {
        logs?.push(generateLog(key, rawValue, defaultValue));
        return defaultValue ?? null;
    }
    return value;
}

// Developer check, would be cool to have a preprocessor strip this code out
if (process.env.NODE_ENV !== 'production') {
    Object.keys(LOGGING_LEVEL).forEach((loggingLevelKey: string) => {
        if (loggingLevelKey !== loggingLevelKey.toUpperCase()) {
            throw new Error('Logging levels constant should be all upper case');
        }
    });
}

const getLoggingLevel = (key: string, defaultValue: LoggingLevelType | null): LoggingLevelType | null => {
    let rawValue = process.env[key];
    // Not set
    if (_.isUndefined(rawValue)) {
        logs?.push(generateLog(key, rawValue, defaultValue));
        return defaultValue;
    }

    // Explicit not set
    if (rawValue === 'null') {
        return null;
    }

    // upper case for case insensitive search (should be validation above to make sure all keys are uppercased)
    rawValue = rawValue.toUpperCase();
    if (Object.keys(LOGGING_LEVEL).indexOf(rawValue) < 0) {
        logs?.push(generateLog(key, rawValue, defaultValue));
        return defaultValue;
    }

    return LOGGING_LEVEL[rawValue as keyof typeof LOGGING_LEVEL];
};

const loggingLevel = getLoggingLevel('LOGGING_LEVEL', LOGGING_LEVEL.DEBUG);
const loggingLevelForFile = getLoggingLevel('LOGGING_LEVEL_FOR_FILE', loggingLevel);
const loggingLevelForConsole = getLoggingLevel('LOGGING_LEVEL_FOR_CONSOLE', loggingLevel);

const nodeEnv = readStringValue('NODE_ENV', 'development');
// needs to be read ahead of of time to be used in configurations
const isProduction = nodeEnv === 'production';

const rederlyURL = readStringValue('REDERLY_URL', 'http://localhost:3002');
const configurations = {
    app: {
        nodeEnv: nodeEnv,
        isProduction: isProduction,
        logMissingConfigurations: readBooleanValue('LOG_MISSING_CONFIGURATIONS', true),
        failOnMissingConfigurations: readBooleanValue('FAIL_ON_MISSING_CONFIGURATIONS', isProduction),
        concurrentPuppeteerTabs: readIntValue('CONCURRENT_PUPPETEER_TABS', 5),
        configSalt: readStringValue('CONFIG_SALT', ''),
        rederlyURL: rederlyURL,
        attachmentsBaseURL: readStringValue('ATTACHMENTS_BASE_URL', rederlyURL),
    },
    server: {
        port: readStringValue('SERVER_PORT', '3005'),
        basePath: readStringValue('SERVER_BASE_PATH', '/export'),
        logInvalidlyPrefixedRequests: readBooleanValue('SERVER_LOG_INVALIDLY_PREFIXED_REQUESTS', true),
        blockInvalidlyPrefixedRequests: readBooleanValue('SERVER_BLOCK_INVALIDLY_PREFIXED_REQUESTS', true),
        logAccess: readBooleanValue('SERVER_LOG_ACCESS', true),
        logAccessSlowRequestThreshold: readIntValue('SERVER_LOG_ACCESS_SLOW_REQUEST_THRESHOLD', 30000),
        requestTimeout: readIntValue('SERVER_REQUEST_TIMEOUT', 150000),
        // limiter: {
        //     windowLength: readIntValue('SERVER_LIMITER_WINDOW_LENGTH', 60000),
        //     maxRequests: readIntValue('SERVER_LIMITER_MAX_REQUESTS', 100),
        // },
    },
    logging: {
        loggingLevel,
        loggingLevelForFile,
        loggingLevelForConsole,
        urlInMeta: readBooleanValue('LOGGING_URL_IN_META', false),
        metaInLogs: readBooleanValue('LOGGING_META_IN_LOGS', false),
        logJson: readBooleanValue('LOGGING_LOG_JSON', isProduction),
    },
    aws: {
        bucket: readStringValue('AWS_BUCKET_NAME', 'rederly-exports-dev'),
        awsAccessKeyId: readStringValue('AWS_ACCESS_KEY', ''),
        awsSecretKey: readStringValue('AWS_SECRET_KEY', ''),
        awsRegion: readStringValue('AWS_REGION', 'us-east-2'),
    },
    backend: {
        url: readStringValue('BACKEND_URL', rederlyURL),
    },
    renderer: {
        url: readStringValue('RENDERER_URL', rederlyURL),
    },
    puppeteer: {
        navigationTimeout: readIntValue('NAVIGATION_TIMEOUT', 300000),
        resourceTimeout: readIntValue('RESOURCE_TIMEOUT', 30000),
        extraTimeout: readIntValue('EXTRA_TIMEOUT', 5000),
    },
    loadPromise: new Promise<void>((resolve, reject) => {
        // Avoid cyclic dependency by deferring the logging until after all the imports are done
        setTimeout(() => {
            // Can't use require statement in callback
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const logger = require('./utilities/logger').default;
            // THIS IS FOR DEBUGGING, DO NOT COMMIT UNCOMMENTED
            // logger.info(JSON.stringify(configurations, null, 2));

            if (_.isNil(logs)) {
                logger.error('configuration logs nil before reading');
            } else if (configurations.app.logMissingConfigurations) {
                logs.forEach((log: string) => {
                    logger.warn(log);
                });
            }

            // Log count defaults to 1 so it fails on null which has already been logged
            if (configurations.app.failOnMissingConfigurations && (logs?.length ?? 1 > 0)) {
                return reject(new Error(`Missing configurations:\n${logs?.join('\n') ?? 'Logs are null'}`));
            } else {
                resolve();
            }
            // After we log the warnings we can drop the logs, figured it would cause cleanup
            logs = null;
        }, 0);
    }),
    hash: '',
};

configurations.loadPromise
.then(() => {
    configurations.hash = crypto.createHash('sha256').update(JSON.stringify(configurations)).digest('hex');
})
.catch(() => null);

export default configurations;
