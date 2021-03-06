import { ServiceOutputTypes } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import archiver from "archiver";
import { Semaphore, SemaphoreInterface } from "async-mutex";
import configurations from "./configurations";
import HeapHelper from "./utilities/heap-helper";

export interface PDFPriorityData {
    prio: number;
    topicId: number;
    profUUID: string;
    // Debug
    firstName: string;
}

export interface ZipObject {
    archive: archiver.Archiver;
    awsKey: string;
    upload: Upload;
    uploadDonePromise: Promise<ServiceOutputTypes>;
}

// This holds all the promises required to finish before we can zip up the topic.
export const cheatingInMemoryStorage: {
    [topicId: number]: {
        pdfPromises: Promise<string | undefined>[];
        pendingPriorities: PDFPriorityData[];
        zipObject: ZipObject;
        lock: Promise<[number, SemaphoreInterface.Releaser]>
    }
} = {}

// This limits how many Topics can be processed simultaneously.
export const globalTopicSemaphore = new Semaphore(configurations.app.concurrentTopicsLimit);

// This manages the heap of all pendingPromises from cheatingInMemoryStorage (across all topics).
export const globalHeapManager = new HeapHelper();
