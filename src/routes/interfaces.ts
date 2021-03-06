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
        legalScore?: number;
    }[];
};

export interface GetExportArchiveOptions {
    profUUID: string;
    topicId: number;
    addSolutionToFilename: boolean;
}