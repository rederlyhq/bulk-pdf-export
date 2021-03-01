export default class CreatePDFError extends Error {
    public errorFilename: string;
    constructor(message: string, errorFilename: string) {
        super(message);
        this.errorFilename = errorFilename;
    }
}
