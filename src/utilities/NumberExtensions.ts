declare global {
    interface Number {
        toPercentString(): string;
    }    
}

/**
 * Meant for numbers between 0 and 1 (but doesn't have to be)
 * Multiplies by 100 and goes to 1 decimal place
 */
Number.prototype.toPercentString = function (): string {
    // Number vs number discrepancy
    return `${(this as number * 100).toFixed(1)}%`;
};

export {};
