import configurations from "../configurations";

// Templates for temp directory structure
export const tempBaseDirectory = `${configurations.server.tempDirectory}/`;
export const topicTempDirectory = (topicId: number) => `${tempBaseDirectory}${topicId}`;
export const htmlTempFile = (topicId: number, fileBasename: string) => `${topicTempDirectory(topicId)}/${fileBasename}.html`;
export const pdfTempFile = (topicId: number, fileBasename: string, addSolutionsToFilename: boolean) => `${topicTempDirectory(topicId)}/${fileBasename}${addSolutionsToFilename ? '-solutions' : ''}.pdf`;

// Templates for aws key structure
export const awsTopicKey = (professorUUID: string, topicId: number) => `exports/${professorUUID}/${topicId}/`;
export const awsPDFKey = (professorUUID: string, topicId: number, fileBasename: string, addSolutionsToFilename: boolean) => `exports/${professorUUID}/${topicId}/${fileBasename}${addSolutionsToFilename ? '-solutions': ''}.pdf`;
export const awsZipKey = (professorUUID: string, topicId: number, addSolutionsToFilename: boolean) => `${awsTopicKey(professorUUID, topicId)}${topicId}_${Date.now()}${addSolutionsToFilename ? '-solutions' : ''}.zip`;
