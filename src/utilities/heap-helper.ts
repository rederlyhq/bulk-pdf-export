import TinyQueue from "tinyqueue";
import logger from "./logger";

export default class HeapHelper<T> {
    constructor(private _queue: TinyQueue<T>, private _comparator: (a: T, b: T) => number) {
        this._queue = new TinyQueue(_queue.data ?? [], _comparator);
    }

    pop = (): T | undefined => this._queue.pop();

    push = (...items: T[]): number => {
        for (const item of items) {
            this._queue.push(item);
        }
        return items.length;
    }

    shift = this.pop;

    unshift = this.push;

    get length(): number {
        return this._queue.length;
    }

    set length(n: number) {
        this._queue.length = n;
        this._queue.data.length = n;
    }

    forEach = (callbackfn: (value: T, index: number, array: T[]) => void): void => {
        this._queue.data.forEach((value, index, array) => {
            callbackfn(value, index, array);
        });
    }

    toString = (): string => JSON.stringify(this._queue.data);

    // This is the only function specific to the Bulk Exporter.
    heapify = () => {
        logger.debug('Heapifying!');
        this._queue = new TinyQueue(this._queue.data, this._comparator);
    }
}
