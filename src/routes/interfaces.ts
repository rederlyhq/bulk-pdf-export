export interface MakePDFRequestOptions {
    firstName: string;
    lastName: string;
    topic: {
        name: string;
        id: number;
    };
    professorUUID: string;
    problems: {
        number: number;
        srcdoc: string;
        attachments: {url: string; name: string; time: Date}[];
        effectiveScore?: number;
        partialCreditBestScore?: number;
        startTime?: Date;
        submissionTime?: Date;
        weight: number;
    }[];
};

export interface GetExportArchiveOptions {
    profUUID: string;
    topicId: number;
    addSolutionToFilename: boolean;
}

export interface DebugPageInfo {
    [index: number]: {
        url: string;
        metrics: number;
    }
}

export type DumpAllInfo = {
    topicId: number | string;
    error: string;
} | {
    topicId: number | string;
    resolvedCount: number;
    rejectedCount: number;
    pendingCount: number;
    pdfCount: number;
}
