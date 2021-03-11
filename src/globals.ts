import { ServiceOutputTypes } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import archiver from "archiver";
import { Semaphore, SemaphoreInterface, withTimeout } from "async-mutex";
import { QueueEntry } from "async-mutex";
import TinyQueue from "tinyqueue";
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

export interface PromiseWithStatus<T> extends Promise<T> {
    status?: 'resolved' | 'rejected' | 'pending'
}

// This holds all the promises required to finish before we can zip up the topic.
export const cheatingInMemoryStorage: {
    [topicId: number]: {
        pdfPromises: PromiseWithStatus<string>[];
        pendingPriorities: PDFPriorityData[];
        zipObject: ZipObject;
        lock: Promise<[number, SemaphoreInterface.Releaser]>
    }
} = {}

// This limits how many Topics can be processed simultaneously.
export const globalTopicSemaphore = withTimeout(new Semaphore(configurations.app.concurrentTopicsLimit), configurations.app.topicsLimitTimeout);

// This manages the heap of all pendingPromises from cheatingInMemoryStorage (across all topics).
export const globalHeapManager = new HeapHelper<QueueEntry<PDFPriorityData>>(new TinyQueue(), (a, b) => b.data.prio - a.data.prio);
