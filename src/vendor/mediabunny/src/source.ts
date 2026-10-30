/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Subset migrated from patched Mediabunny 1.62.1; see THIRD_PARTY_NOTICES.md at the package root.
import { assert, binarySearchLessOrEqual, clamp, closedIntervalsOverlap, type FilePath, isNumber, isThenable, isWebKit, type MaybePromise, promiseWithResolvers, toDataView, EventEmitter } from './misc';
import { InputDisposedError } from './input';
import { polyfillSymbolDispose } from './misc';
polyfillSymbolDispose();
export type ReadResult = {
    bytes: Uint8Array;
    view: DataView;
    /** The offset of the bytes in the file. */
    offset: number;
};
export const DEFAULT_MIN_READ_POSITION = 0;
export const DEFAULT_MAX_READ_POSITION = Infinity;
/**
 * The events emitted by a {@link Source}, with each key being an event name and its value being the event data.
 * @group Input sources
 * @public
 */
export type SourceEvents = {
    /** Emitted each time data is retrieved from the source. */
    read: {
        /** The start of the retrieved range, inclusive. */
        start: number;
        /** The end of the retrieved range, exclusive. */
        end: number;
    };
};
/**
 * The source base class, representing a resource from which bytes can be read.
 * @group Input sources
 * @public
 */
export abstract class Source extends EventEmitter<SourceEvents> {
    /** @internal */
    abstract _getFileSize(): number | null | undefined;
    /** @internal */
    abstract _read(start: number, end: number, minReadPosition: number, maxReadPosition: number): MaybePromise<ReadResult | null>;
    /** @internal */
    abstract _dispose(): void;
    /** @internal */
    _disposed = false;
    /** @internal */
    _refCount = 0;
    /**
     * Used internally to mark if a source stems from an HLS reading operation. Used to suppress certain warnings.
     * @internal
     */
    _usedForHls = false;
    /**
     * FinalizationRegistry for rogue refs to this source that didn't get freed. It lives on the Source itself so that
     * in case the Source transitively points back to itself and forms a cycle (for example through a custom
     * CustomSource callback) that we're not leaking memory.
     * @internal
     */
    _refFinalizationRegistry: FinalizationRegistry<Source> | null = null;
    /** @internal */
    private _sizePromise: Promise<number | null> | null = null;
    constructor() {
        super();
        if (typeof FinalizationRegistry !== 'undefined') {
            this._refFinalizationRegistry = new FinalizationRegistry((source) => {
                source._decrementRefCount();
            });
        }
    }
    /**
     * Resolves with the total size of the file in bytes. This function is memoized, meaning only the first call
     * will retrieve the size.
     *
     * Returns null if the source is unsized.
     */
    async getSizeOrNull() {
        if (this._disposed) {
            throw new InputDisposedError();
        }
        return this._sizePromise ??= (async () => {
            let size = this._getFileSize();
            if (size !== undefined) {
                return size;
            }
            await this._read(0, 1, DEFAULT_MIN_READ_POSITION, DEFAULT_MAX_READ_POSITION);
            size = this._getFileSize();
            assert(size !== undefined);
            return size;
        })();
    }
    /**
     * Resolves with the total size of the file in bytes. This function is memoized, meaning only the first call
     * will retrieve the size.
     *
     * Throws an error if the source is unsized.
     */
    async getSize() {
        if (this._disposed) {
            throw new InputDisposedError();
        }
        const result = await this.getSizeOrNull();
        if (result === null) {
            throw new Error('Cannot determine the size of an unsized source.');
        }
        return result;
    }
    /**
     * Returns a new {@link RangedSource} that maps data onto this source using the given offset and length. If a length
     * is not provided, the ranged source spans until the end of this source's data.
     *
     * Useful for reading files that are embedded within larger files.
     */
    slice(offset: number, length?: number) {
        if (!Number.isInteger(offset) || offset < 0) {
            throw new TypeError('offset must be a non-negative integer.');
        }
        if (length !== undefined && (!Number.isInteger(length) || length < 0)) {
            throw new TypeError('length, when provided, must be a non-negative integer.');
        }
        return new RangedSource(this, offset, length);
    }
    /**
     * Called each time data is retrieved from the source. Will be called with the retrieved range (end exclusive).
     *
     * @deprecated Use `source.on('read', ({ start, end }) => ...)` instead.
     */
    onread: ((start: number, end: number) => unknown) | null = null;
    /** @internal */
    _dispatchRead(start: number, end: number) {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        this.onread?.(start, end);
        this._emit('read', { start, end });
    }
    /**
     * Creates a new `SourceRef` pointing to this source. You are expected to call `.free()` on said `SourceRef` when
     * you're done with it.
     */
    ref() {
        return new SourceRef(this);
    }
    /** @internal */
    _incrementRefCount() {
        this._refCount++;
    }
    /** @internal */
    _decrementRefCount() {
        this._refCount--;
        if (this._refCount === 0) {
            this._dispose();
            this._disposed = true;
        }
    }
}
/**
 * A reference to a {@link Source}, used to manage a source's lifecycle. Creating a `SourceRef` via {@link Source.ref}
 * increases that source's internal reference count. As long as a source has a non-zero reference count, it is assumed
 * to still be in use. Once all references are freed via {@link SourceRef.free}, the source gets disposed.
 *
 * @group Input sources
 * @public
 */
export class SourceRef<S extends Source = Source> implements Disposable {
    /** @internal */
    private _source: S | null;
    /** @internal */
    private _freed = false;
    /** @internal */
    constructor(source: S) {
        if (source._disposed) {
            throw new Error('Cannot ref a disposed source.');
        }
        source._incrementRefCount();
        source._refFinalizationRegistry?.register(this, source, this);
        this._source = source;
    }
    /** The {@link Source} this ref references. Accessing this field throws an error after having freed the ref. */
    get source() {
        if (!this._source) {
            throw new Error('Can\'t get source; ref has already been freed.');
        }
        return this._source;
    }
    /** Whether or not this reference has been freed via {@link SourceRef.free}. */
    get freed() {
        return this._freed;
    }
    /**
     * Frees the ref, decrementing the source's internal reference count. If the source's internal reference count
     * reaches zero, it gets disposed. To catch bugs, this method throws if the ref is already freed.
     */
    free() {
        if (this._freed) {
            throw new Error('Illegal operation: double free on SourceRef.');
        }
        const source = this.source;
        assert(source._refCount > 0);
        source._decrementRefCount();
        source._refFinalizationRegistry?.unregister(this);
        this._freed = true;
        this._source = null;
    }
    /**
     * Calls {@link SourceRef.free}.
     */
    [Symbol.dispose]() {
        if (!this.freed) {
            this.free();
        }
    }
}
/**
 * A source which can create new sources from file paths. Required for multi-file inputs such as HLS playlists.
 * @public
 * @group Input sources
 */
export abstract class PathedSource extends Source {
    public rootPath: FilePath;
    public readonly requestHandler: (request: SourceRequest) => MaybePromise<Source | SourceRef>;
    constructor(
    /**
     * The path that points to the root file; the entry file of the media.
     *
     * This path may be modified by the source to indicate a redirect: an updated path to perform new requests
     * relative to.
     */
    rootPath: FilePath, 
    /** The callback that is called for each requested file; must return a {@link Source} or {@link SourceRef}. */
    requestHandler: (request: SourceRequest) => MaybePromise<Source | SourceRef>) {
        if (typeof rootPath !== 'string') {
            throw new TypeError('rootPath must be a string.');
        }
        if (typeof requestHandler !== 'function') {
            throw new TypeError('requestHandler must be a function.');
        }
        super();
        this.rootPath = rootPath;
        this.requestHandler = requestHandler;
    }
    /** @internal */
    _resolveRequest(request: SourceRequest): MaybePromise<SourceRef> {
        const result = this.requestHandler(request);
        const handle = (result: Source | SourceRef) => {
            if (!(result instanceof Source || result instanceof SourceRef)) {
                throw new TypeError('requestHandler must return or resolve to a Source or SourceRef.');
            }
            const ref = result instanceof Source
                ? result.ref()
                : result;
            ref.source._usedForHls ||= this._usedForHls;
            return ref;
        };
        if (isThenable(result)) {
            return result.then(handle);
        }
        else {
            return handle(result);
        }
    }
}
/**
 * A request for a {@link Source} at the given path.
 * @group Input sources
 * @public
 */
export type SourceRequest = {
    /** The requested file path. */
    path: FilePath;
    /** Whether the requested file is the root file. */
    isRoot: boolean;
};
export const sourceRequestsAreEqual = (a: SourceRequest, b: SourceRequest) => {
    return a.path === b.path;
};
/**
 * Options for {@link BlobSource}.
 * @group Input sources
 * @public
 */
export type BlobSourceOptions = {
    /** The maximum number of bytes the cache is allowed to hold in memory. Defaults to 8 MiB. */
    maxCacheSize?: number | undefined;
    /**
     * Defaults to `true`. When `true`, Mediabunny will acquire a `ReadableStream` reader internally to efficiently read
     * data from the blob. Since this can lead to errors in some (very) rare cases due to browser bugs, you can set this
     * field to `false` to try a slower but more stable reading method.
     */
    useStreamReader?: boolean | undefined;
    /** Handles errors that occur while no read is pending. By default, these become unhandled rejections. */
    handleUnhandledError?: ((error: unknown) => unknown) | undefined;
};
const blobReaderRegistry = typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry<ReadableStreamDefaultReader<Uint8Array>>((reader) => {
        // Browsers don't GC readers that aren't "done", which creates indefinite memory leaks,
        // see https://github.com/Vanilagy/mediabunny/issues/144#issuecomment-5465467062. So, we need to do it instead.
        void reader.cancel().catch(() => { });
    })
    : null;
/**
 * A source backed by a [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob). Since a
 * [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File) is also a `Blob`, this is the source to use when
 * reading files off the disk.
 * @group Input sources
 * @public
 */
export class BlobSource extends Source {
    /** @internal */
    _blob: Blob;
    /** @internal */
    _options: BlobSourceOptions;
    /** @internal */
    _orchestrator: ReadOrchestrator;
    /** @internal */
    _readers = new WeakMap<ReadWorker, ReadableStreamDefaultReader<Uint8Array> | null>();
    /**
     * Creates a new {@link BlobSource} backed by the specified
     * [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob).
     */
    constructor(blob: Blob, options: BlobSourceOptions = {}) {
        if (!(blob instanceof Blob)) {
            throw new TypeError('blob must be a Blob.');
        }
        if (!options || typeof options !== 'object') {
            throw new TypeError('options must be an object.');
        }
        if (options.maxCacheSize !== undefined
            && (!isNumber(options.maxCacheSize) || options.maxCacheSize < 0)) {
            throw new TypeError('options.maxCacheSize, when provided, must be a non-negative number.');
        }
        if (options.useStreamReader !== undefined && typeof options.useStreamReader !== 'boolean') {
            throw new TypeError('options.useStreamReader, when provided, must be a boolean.');
        }
        if (options.handleUnhandledError !== undefined && typeof options.handleUnhandledError !== 'function') {
            throw new TypeError('options.handleUnhandledError, when provided, must be a function.');
        }
        super();
        this._blob = blob;
        this._options = options;
        this._orchestrator = new ReadOrchestrator({
            maxCacheSize: options.maxCacheSize ?? (8 * 2 ** 20 /* 8 MiB */),
            maxWorkerCount: 4,
            runWorker: this._runWorker.bind(this),
            onIdleWorkerRemoved: (worker) => {
                const reader = this._readers.get(worker);
                if (reader) {
                    this._readers.delete(worker);
                    blobReaderRegistry?.unregister(worker);
                    // If we don't do this, memory leaks indefinitely
                    void reader.cancel().catch(() => { });
                }
            },
            prefetchProfile: PREFETCH_PROFILES.fileSystem,
            handleUnhandledError: options.handleUnhandledError,
        });
        this._orchestrator.fileSize = blob.size;
    }
    /** @internal */
    _getFileSize(): number {
        return this._orchestrator.fileSize!; // Faster than blob.size
    }
    /** @internal */
    _read(start: number, end: number, minReadPosition: number, maxReadPosition: number): MaybePromise<ReadResult | null> {
        return this._orchestrator.read(start, end, minReadPosition, maxReadPosition);
    }
    /** @internal */
    private async _runWorker(worker: ReadWorker) {
        assert(worker.strictTarget);
        let reader = this._readers.get(worker);
        if (reader === undefined) {
            // https://github.com/Vanilagy/mediabunny/issues/184
            // WebKit has critical bugs with blob.stream():
            // - WebKitBlobResource error 1 when streaming large files
            // - Memory buildup and reload loops on iOS (network process crashes)
            // - ReadableStream stalls under backpressure (especially video)
            // Affects Safari and all iOS browsers (Chrome, Firefox, etc.).
            // Use arrayBuffer() fallback for WebKit browsers.
            if ('stream' in this._blob && !isWebKit()
                && this._options.useStreamReader !== false) {
                // Get a reader of the blob starting at the required offset, and then keep it around
                const slice = this._blob.slice(worker.currentPos);
                reader = slice.stream().getReader();
                blobReaderRegistry?.register(worker, reader, worker);
            }
            else {
                // We'll need to use more primitive ways
                reader = null;
            }
            this._readers.set(worker, reader);
        }
        while (worker.currentPos < worker.targetPos && !worker.aborted) {
            if (reader) {
                const { done, value } = await reader.read();
                if (done) {
                    this._orchestrator.onWorkerFinished(worker);
                    throw new Error('Blob reader stopped unexpectedly before all requested data was read.');
                }
                if (worker.aborted) {
                    break;
                }
                this._dispatchRead(worker.currentPos, worker.currentPos + value.length);
                this._orchestrator.supplyWorkerData(worker, value);
            }
            else {
                const data = await this._blob.slice(worker.currentPos, worker.targetPos).arrayBuffer();
                if (worker.aborted) {
                    break;
                }
                this._dispatchRead(worker.currentPos, worker.currentPos + data.byteLength);
                this._orchestrator.supplyWorkerData(worker, new Uint8Array(data));
            }
        }
        this._orchestrator.signalWorkerStoppedRunning(worker);
        if (worker.aborted) {
            // MDN: "Calling this method signals a loss of interest in the stream by a consumer."
            await reader?.cancel().catch(() => { });
        }
    }
    /** @internal */
    _dispose() {
        this._orchestrator.dispose();
    }
}
const URL_SOURCE_MIN_LOAD_AMOUNT = 0.5 * 2 ** 20;
type PrefetchProfile = (start: number, end: number, workers: ReadWorker[]) => {
    start: number;
    end: number;
};
const PREFETCH_PROFILES = {
    none: (start, end) => ({ start, end }),
    fileSystem: (start, end) => {
        const padding = 2 ** 16;
        start = Math.floor((start - padding) / padding) * padding;
        end = Math.ceil((end + padding) / padding) * padding;
        return { start, end };
    },
    network: (start, end, workers) => {
        // Add a slight bit of start padding because backwards reading is painful
        const paddingStart = 2 ** 16;
        start = Math.max(0, Math.floor((start - paddingStart) / paddingStart) * paddingStart);
        // Remote resources have extreme latency (relatively speaking), so the benefit from intelligent
        // prefetching is great. The network prefetch strategy is as follows: When we notice
        // successive reads to a worker's read region, we prefetch more data at the end of that region,
        // growing exponentially (up to a cap). This performs well for real-world use cases: Either we read a
        // small part of the file once and then never need it again, in which case the requested about of data
        // is small. Or, we're repeatedly doing a sequential access pattern (common in media files), in which
        // case we can become more and more confident to prefetch more and more data.
        for (const worker of workers) {
            const maxExtensionAmount = 8 * 2 ** 20; // 8 MiB
            // When the read region cross the threshold point, we trigger a prefetch. This point is typically
            // in the middle of the worker's read region, or a fixed offset from the end if the region has grown
            // really large.
            const thresholdPoint = Math.max((worker.startPos + worker.targetPos) / 2, worker.targetPos - maxExtensionAmount);
            if (closedIntervalsOverlap(start, end, thresholdPoint, worker.targetPos)) {
                const size = worker.targetPos - worker.startPos;
                // If we extend by maxExtensionAmount
                const a = Math.ceil((size + 1) / maxExtensionAmount) * maxExtensionAmount;
                // If we extend to the next power of 2
                const b = 2 ** Math.ceil(Math.log2(size + 1));
                const extent = Math.min(b, a);
                end = Math.max(end, worker.startPos + extent);
            }
        }
        end = Math.max(end, start + URL_SOURCE_MIN_LOAD_AMOUNT);
        return {
            start,
            end,
        };
    },
} satisfies Record<string, PrefetchProfile>;
type PendingSlice = {
    start: number;
    bytes: Uint8Array;
    holes: Hole[];
    resolve: (bytes: Uint8Array | null) => void;
    reject: (error: unknown) => void;
};
type Hole = {
    start: number;
    end: number;
};
type CacheEntry = {
    start: number;
    end: number;
    bytes: Uint8Array;
    view: DataView;
    age: number;
};
type ReadWorker = {
    startPos: number;
    currentPos: number;
    targetPos: number;
    /** The target is considered _strict_ when it is an error for the worker to terminate before reaching the target. */
    strictTarget: boolean;
    running: boolean;
    aborted: boolean;
    pendingSlices: PendingSlice[];
    age: number;
};
/**
 * Godclass for orchestrating complex, cached read operations. The reading model is as follows: Any reading task is
 * delegated to a *worker*, which is a sequential reader positioned somewhere along the file. All workers run in
 * parallel and can be stopped and resumed in their forward movement. When read requests come in, this orchestrator will
 * first try to satisfy the request with only the cached data. If this isn't possible, workers are spun up for all
 * missing parts (or existing workers are repurposed), and these workers will then fill the holes in the data as they
 * march along the file.
 */
class ReadOrchestrator {
    fileSize: number | null = null;
    nextAge = 0; // Used for multiple things
    workers: ReadWorker[] = [];
    cache: CacheEntry[] = [];
    currentCacheSize = 0;
    disposed = false;
    queuedReads: {
        hole: Hole;
        strictTarget: boolean;
        pendingSlices: PendingSlice[];
        age: number;
    }[] = [];
    public options: {
        maxCacheSize: number;
        runWorker: (worker: ReadWorker) => Promise<void>;
        prefetchProfile: PrefetchProfile;
        maxWorkerCount: number;
        onIdleWorkerRemoved?: ((worker: ReadWorker) => void) | undefined;
        handleUnhandledError?: ((error: unknown) => unknown) | undefined;
    };
    constructor(options: {
        maxCacheSize: number;
        runWorker: (worker: ReadWorker) => Promise<void>;
        prefetchProfile: PrefetchProfile;
        maxWorkerCount: number;
        onIdleWorkerRemoved?: ((worker: ReadWorker) => void) | undefined;
        handleUnhandledError?: ((error: unknown) => unknown) | undefined;
    }) {
        this.options = options;
    }
    read(innerStart: number, innerEnd: number, minReadPosition: number, maxReadPosition: number): MaybePromise<ReadResult | null> {
        assert(!this.disposed);
        const prefetchRange = this.options.prefetchProfile(innerStart, innerEnd, this.workers);
        const outerStart = Math.max(prefetchRange.start, minReadPosition);
        const outerEnd = Math.min(prefetchRange.end, this.fileSize ?? Infinity, maxReadPosition);
        assert(outerStart <= innerStart && innerEnd <= outerEnd);
        let result: MaybePromise<ReadResult | null> | null = null;
        const innerCacheStartIndex = binarySearchLessOrEqual(this.cache, innerStart, x => x.start);
        const innerStartEntry = innerCacheStartIndex !== -1 ? this.cache[innerCacheStartIndex] : null;
        // See if the read request can be satisfied by a single cache entry
        if (innerStartEntry && innerStartEntry.start <= innerStart && innerEnd <= innerStartEntry.end) {
            innerStartEntry.age = this.nextAge++;
            result = {
                bytes: innerStartEntry.bytes,
                view: innerStartEntry.view,
                offset: innerStartEntry.start,
            };
            // Can't return yet though, still need to check if the prefetch range might lie outside the cached area
        }
        const outerCacheStartIndex = binarySearchLessOrEqual(this.cache, outerStart, x => x.start);
        const bytes = result ? null : new Uint8Array(innerEnd - innerStart);
        let contiguousBytesWriteEnd = 0; // Used to track if the cache is able to completely cover the bytes
        let lastEnd = outerStart;
        // The "holes" in the cache (the parts we need to load)
        const outerHoles: Hole[] = [];
        // Loop over the cache and build up the list of holes
        if (outerCacheStartIndex !== -1) {
            for (let i = outerCacheStartIndex; i < this.cache.length; i++) {
                const entry = this.cache[i]!;
                if (entry.start >= outerEnd) {
                    break;
                }
                if (entry.end <= outerStart) {
                    continue;
                }
                const cappedOuterStart = Math.max(outerStart, entry.start);
                const cappedOuterEnd = Math.min(outerEnd, entry.end);
                assert(cappedOuterStart <= cappedOuterEnd);
                if (lastEnd < cappedOuterStart) {
                    outerHoles.push({ start: lastEnd, end: cappedOuterStart });
                }
                lastEnd = cappedOuterEnd;
                if (bytes) {
                    const cappedInnerStart = Math.max(innerStart, entry.start);
                    const cappedInnerEnd = Math.min(innerEnd, entry.end);
                    if (cappedInnerStart < cappedInnerEnd) {
                        const relativeOffset = cappedInnerStart - innerStart;
                        // Fill the relevant section of the bytes with the cached data
                        bytes.set(entry.bytes.subarray(cappedInnerStart - entry.start, cappedInnerEnd - entry.start), relativeOffset);
                        if (relativeOffset === contiguousBytesWriteEnd) {
                            contiguousBytesWriteEnd = cappedInnerEnd - innerStart;
                        }
                    }
                }
                entry.age = this.nextAge++;
            }
            if (lastEnd < outerEnd) {
                outerHoles.push({ start: lastEnd, end: outerEnd });
            }
        }
        else {
            outerHoles.push({ start: outerStart, end: outerEnd });
        }
        if (bytes && contiguousBytesWriteEnd >= bytes.length) {
            // Multiple cache entries were able to completely cover the requested bytes!
            result = {
                bytes,
                view: toDataView(bytes),
                offset: innerStart,
            };
        }
        if (outerHoles.length === 0) {
            assert(result);
            return result;
        }
        // We need to read more data, so now we're in async land
        const { promise, resolve, reject } = promiseWithResolvers<Uint8Array | null>();
        const innerHoles: typeof outerHoles = [];
        for (const outerHole of outerHoles) {
            const cappedStart = Math.max(innerStart, outerHole.start);
            const cappedEnd = Math.min(innerEnd, outerHole.end);
            if (cappedStart === outerHole.start && cappedEnd === outerHole.end) {
                innerHoles.push(outerHole); // Can reuse without allocating a new object
            }
            else if (cappedStart < cappedEnd) {
                innerHoles.push({ start: cappedStart, end: cappedEnd });
            }
        }
        const pendingSlice: PendingSlice | null = bytes && {
            start: innerStart,
            bytes,
            holes: innerHoles,
            resolve,
            reject,
        };
        // Fire off workers to take care of patching the holes
        outer: for (const outerHole of outerHoles) {
            for (const worker of this.workers) {
                const addedToWorker = this.checkHoleAgainstWorker(worker, outerHole, pendingSlice ? [pendingSlice] : []);
                if (addedToWorker) {
                    this.checkQueuedReadsAgainstWorker(worker);
                    continue outer;
                }
            }
            // We need to spawn a new worker
            const strictTarget = outerHole.end < outerEnd || this.fileSize !== null;
            const newWorker = this.createWorker(outerHole.start, outerHole.end, strictTarget);
            if (newWorker) {
                if (pendingSlice) {
                    newWorker.pendingSlices = [pendingSlice];
                }
                this.runWorker(newWorker);
            }
            else {
                // Max worker count has been reached, let's queue a read for later
                let index = binarySearchLessOrEqual(this.queuedReads, outerHole.start, x => x.hole.start);
                let entry = index !== -1
                    ? this.queuedReads[index]!
                    : null;
                if (entry && outerHole.start <= entry.hole.end) {
                    entry.hole.end = Math.max(entry.hole.end, outerHole.end);
                    entry.strictTarget &&= strictTarget;
                    if (pendingSlice) {
                        entry.pendingSlices.push(pendingSlice);
                    }
                }
                else {
                    index++;
                    entry = {
                        hole: {
                            // Clone the hole because it might be mutated later
                            start: outerHole.start,
                            end: outerHole.end,
                        },
                        strictTarget,
                        pendingSlices: pendingSlice ? [pendingSlice] : [],
                        age: this.nextAge++,
                    };
                    this.queuedReads.splice(index, 0, entry);
                }
                // Merge with any subsequent entries that overlap
                while (index + 1 < this.queuedReads.length) {
                    const nextEntry = this.queuedReads[index + 1]!;
                    if (nextEntry.hole.start > entry.hole.end) {
                        break;
                    }
                    entry.hole.end = Math.max(entry.hole.end, nextEntry.hole.end);
                    entry.pendingSlices.push(...nextEntry.pendingSlices);
                    entry.strictTarget &&= nextEntry.strictTarget;
                    entry.age = Math.min(entry.age, nextEntry.age);
                    this.queuedReads.splice(index + 1, 1);
                }
            }
        }
        if (!result) {
            assert(bytes);
            result = promise.then(bytes => bytes && ({
                bytes,
                view: toDataView(bytes),
                offset: innerStart,
            } satisfies ReadResult));
        }
        else {
            // The requested region was satisfied by the cache, but the entire prefetch region was not
            promise.catch((error) => {
                if (this.disposed) {
                    return; // Swallow the error
                }
                // Nobody's awaiting this result but an errored read is still notable
                if (this.options.handleUnhandledError) {
                    this.options.handleUnhandledError(error);
                }
                else {
                    throw error;
                }
            });
        }
        return result;
    }
    checkHoleAgainstWorker(worker: ReadWorker, hole: Hole, pendingSlices: PendingSlice[]) {
        // A small tolerance in the case that the requested region is *just* after the target position of an
        // existing worker. In that case, it's probably more efficient to repurpose that worker than to spawn
        // another one so close to it
        const gapTolerance = 2 ** 17;
        // This check also implies worker.currentPos <= hole.start, a critical condition
        if (closedIntervalsOverlap(hole.start - gapTolerance, hole.start, worker.currentPos, worker.targetPos)) {
            worker.targetPos = Math.max(worker.targetPos, hole.end); // Update the worker's target position
            for (let i = 0; i < pendingSlices.length; i++) {
                const pendingSlice = pendingSlices[i]!;
                if (!worker.pendingSlices.includes(pendingSlice)) {
                    worker.pendingSlices.push(pendingSlice);
                }
            }
            if (!worker.running) {
                // Kick it off if it's idle
                this.runWorker(worker);
            }
            return true;
        }
        return false;
    }
    checkQueuedReadsAgainstWorker(worker: ReadWorker) {
        let wasTrueOnce = false;
        for (let i = 0; i < this.queuedReads.length; i++) {
            const queuedRead = this.queuedReads[i]!;
            const result = this.checkHoleAgainstWorker(worker, queuedRead.hole, queuedRead.pendingSlices);
            if (result) {
                this.queuedReads.splice(i, 1);
                i--;
                wasTrueOnce = true;
            }
            else if (wasTrueOnce) {
                // We can stop since the holes are sorted
                break;
            }
        }
    }
    createWorker(startPos: number, targetPos: number, strictTarget: boolean) {
        if (this.workers.length >= this.options.maxWorkerCount) {
            let oldestWorker: ReadWorker | null = null;
            let oldestIndex: number | null = null;
            for (let i = 0; i < this.workers.length; i++) {
                const worker = this.workers[i]!;
                if (!worker.running
                    && worker.pendingSlices.length === 0
                    && (!oldestWorker || worker.age < oldestWorker.age)) {
                    oldestIndex = i;
                    oldestWorker = worker;
                }
            }
            if (oldestWorker) {
                // LRU eviction
                assert(oldestIndex !== null);
                assert(oldestWorker.pendingSlices.length === 0);
                this.workers.splice(oldestIndex, 1);
                this.options.onIdleWorkerRemoved?.(oldestWorker);
            }
            else {
                return null; // All workers are still running, we can't create a new one
            }
        }
        const worker: ReadWorker = {
            startPos,
            currentPos: startPos,
            targetPos,
            strictTarget,
            running: false,
            // Due to async shenanigans, it can happen that workers are started after disposal. In this case, instead of
            // simply not creating the worker, we allow it to run but immediately label it as aborted, so it can then
            // shut itself down.
            aborted: this.disposed,
            pendingSlices: [],
            age: this.nextAge++,
        };
        this.workers.push(worker);
        return worker;
    }
    runWorker(worker: ReadWorker) {
        assert(!worker.running);
        assert(worker.currentPos < worker.targetPos);
        worker.running = true;
        worker.age = this.nextAge++;
        void this.options.runWorker(worker)
            .catch((error) => {
            worker.running = false;
            if (worker.pendingSlices.length > 0) {
                worker.pendingSlices.forEach(x => x.reject(error)); // Make sure to propagate any errors
                worker.pendingSlices.length = 0;
            }
            else if (!worker.aborted && !this.disposed) {
                if (this.options.handleUnhandledError) {
                    this.options.handleUnhandledError(error);
                }
                else {
                    throw error; // So it doesn't get swallowed
                }
            }
        })
            .finally(() => {
            if (worker.running) {
                // Rare, but can happen with multiple concurrent reads. In this case, don't do anything.
                return;
            }
            if (this.queuedReads.length > 0) {
                let oldestIndex = 0;
                for (let i = 1; i < this.queuedReads.length; i++) {
                    const queuedRead = this.queuedReads[i]!;
                    if (queuedRead.age < this.queuedReads[oldestIndex]!.age) {
                        oldestIndex = i;
                    }
                }
                const queuedRead = this.queuedReads[oldestIndex]!;
                const newWorker = this.createWorker(queuedRead.hole.start, queuedRead.hole.end, queuedRead.strictTarget);
                if (!newWorker) {
                    // In high-contention cases, it could be that we've already reached max worker count, so in this
                    // case we don't do anything.
                    return;
                }
                this.queuedReads.splice(oldestIndex, 1);
                newWorker.pendingSlices = queuedRead.pendingSlices;
                this.runWorker(newWorker);
            }
        });
    }
    /** Called by a worker when it has read some data. */
    supplyWorkerData(worker: ReadWorker, bytes: Uint8Array) {
        assert(!worker.aborted);
        const start = worker.currentPos;
        const end = start + bytes.length;
        this.insertIntoCache({
            start,
            end,
            bytes,
            view: toDataView(bytes),
            age: this.nextAge++,
        });
        worker.currentPos += bytes.length;
        if (worker.currentPos > worker.targetPos) {
            // In case it overshoots
            worker.targetPos = worker.currentPos;
            this.checkQueuedReadsAgainstWorker(worker);
        }
        // Now, let's see if we can use the read bytes to fill any pending slice
        for (let i = 0; i < worker.pendingSlices.length; i++) {
            const pendingSlice = worker.pendingSlices[i]!;
            const clampedStart = Math.max(start, pendingSlice.start);
            const clampedEnd = Math.min(end, pendingSlice.start + pendingSlice.bytes.length);
            if (clampedStart < clampedEnd) {
                pendingSlice.bytes.set(bytes.subarray(clampedStart - start, clampedEnd - start), clampedStart - pendingSlice.start);
            }
            for (let j = 0; j < pendingSlice.holes.length; j++) {
                // The hole is intentionally not modified here if the read section starts somewhere in the middle of
                // the hole. We don't need to do "hole splitting", since the workers are spawned *by* the holes,
                // meaning there's always a worker which will consume the hole left to right.
                const hole = pendingSlice.holes[j]!;
                if (start <= hole.start && end > hole.start) {
                    hole.start = end;
                }
                if (hole.end <= hole.start) {
                    pendingSlice.holes.splice(j, 1);
                    j--;
                }
            }
            if (pendingSlice.holes.length === 0) {
                // The slice has been fulfilled, everything has been read. Let's resolve the promise
                pendingSlice.resolve(pendingSlice.bytes);
                worker.pendingSlices.splice(i, 1);
                i--;
            }
        }
        // Remove other idle workers if we "ate" into their territory
        for (let i = 0; i < this.workers.length; i++) {
            const otherWorker = this.workers[i]!;
            if (worker === otherWorker || otherWorker.running) {
                continue;
            }
            if (closedIntervalsOverlap(start, end, otherWorker.currentPos, otherWorker.targetPos)) {
                this.workers.splice(i, 1);
                this.options.onIdleWorkerRemoved?.(otherWorker);
                i--;
            }
        }
    }
    supplyFileSize(size: number) {
        assert(this.fileSize === null);
        this.fileSize = size;
        // Trim the workers with this new information
        for (const worker of this.workers) {
            worker.targetPos = Math.min(worker.targetPos, size);
            worker.strictTarget = true;
            for (let i = 0; i < worker.pendingSlices.length; i++) {
                const pendingSlice = worker.pendingSlices[i]!;
                for (const hole of pendingSlice.holes) {
                    if (hole.end > size) {
                        // Can't satisfy this slice anymore
                        pendingSlice.resolve(null);
                        worker.pendingSlices.splice(i, 1);
                        i--;
                        break;
                    }
                }
            }
        }
        // Trim the queued reads as well
        for (let i = 0; i < this.queuedReads.length; i++) {
            const queuedRead = this.queuedReads[i]!;
            if (queuedRead.hole.start >= size) {
                // Entirely out of bounds
                for (const slice of queuedRead.pendingSlices)
                    slice.resolve(null);
                this.queuedReads.splice(i, 1);
                i--;
            }
            else if (queuedRead.hole.end > size) {
                // Partially out of bounds
                queuedRead.hole.end = size;
                queuedRead.strictTarget = true;
                for (let j = 0; j < queuedRead.pendingSlices.length; j++) {
                    const slice = queuedRead.pendingSlices[j]!;
                    // If the slice itself is out of bounds, resolve it
                    if (slice.start >= size) {
                        slice.resolve(null);
                        queuedRead.pendingSlices.splice(j, 1);
                        j--;
                    }
                }
            }
        }
    }
    signalWorkerStoppedRunning(worker: ReadWorker) {
        worker.running = false;
        if (!worker.aborted) {
            // When a worker stops running, that means it has hit its targetPos. It might still have pendingSlices
            // assigned, but this is because those pending slices cover data that other workers are assigned to fill.
            // Since targetPos has been reached, we can confidently say that this worker has completed its share of work
            // on the pending slices and must no longer care about them.
            worker.pendingSlices.length = 0;
        }
    }
    /** Called when a worker reaches the end of the underlying data and must be cleaned up. */
    onWorkerFinished(worker: ReadWorker) {
        const index = this.workers.indexOf(worker);
        assert(index !== -1);
        worker.running = false;
        this.workers.splice(index, 1);
        this.options.onIdleWorkerRemoved?.(worker);
        if (this.fileSize === null) {
            // We can now deduce the file size!
            this.supplyFileSize(worker.currentPos);
        }
        for (const pendingSlice of worker.pendingSlices) {
            pendingSlice.resolve(null);
        }
    }
    insertIntoCache(entry: CacheEntry) {
        if (this.options.maxCacheSize === 0) {
            return; // No caching
        }
        let insertionIndex = binarySearchLessOrEqual(this.cache, entry.start, x => x.start) + 1;
        if (insertionIndex > 0) {
            const previous = this.cache[insertionIndex - 1]!;
            if (previous.end >= entry.end) {
                // Previous entry swallows the one to be inserted; we don't need to do anything
                return;
            }
            if (previous.end > entry.start) {
                // Partial overlap with the previous entry, let's join
                const joined = new Uint8Array(entry.end - previous.start);
                joined.set(previous.bytes, 0);
                joined.set(entry.bytes, entry.start - previous.start);
                this.currentCacheSize += entry.end - previous.end;
                previous.bytes = joined;
                previous.view = toDataView(joined);
                previous.end = entry.end;
                // Do the rest of the logic with the previous entry instead
                insertionIndex--;
                entry = previous;
            }
            else {
                this.cache.splice(insertionIndex, 0, entry);
                this.currentCacheSize += entry.bytes.length;
            }
        }
        else {
            this.cache.splice(insertionIndex, 0, entry);
            this.currentCacheSize += entry.bytes.length;
        }
        for (let i = insertionIndex + 1; i < this.cache.length; i++) {
            const next = this.cache[i]!;
            if (entry.end <= next.start) {
                // Even if they touch, we don't wanna merge them, no need
                break;
            }
            if (entry.end >= next.end) {
                // The inserted entry completely swallows the next entry
                this.cache.splice(i, 1);
                this.currentCacheSize -= next.bytes.length;
                i--;
                continue;
            }
            // Partial overlap, let's join
            const joined = new Uint8Array(next.end - entry.start);
            joined.set(entry.bytes, 0);
            joined.set(next.bytes, next.start - entry.start);
            this.currentCacheSize -= entry.end - next.start; // Subtract the overlap
            entry.bytes = joined;
            entry.view = toDataView(joined);
            entry.end = next.end;
            this.cache.splice(i, 1);
            break; // After the join case, we're done: the next entry cannot possibly overlap with the inserted one.
        }
        // LRU eviction of cache entries
        while (this.currentCacheSize > this.options.maxCacheSize) {
            let oldestIndex = 0;
            let oldestEntry = this.cache[0]!;
            for (let i = 1; i < this.cache.length; i++) {
                const entry = this.cache[i]!;
                if (entry.age < oldestEntry.age) {
                    oldestIndex = i;
                    oldestEntry = entry;
                }
            }
            if (this.currentCacheSize - oldestEntry.bytes.length <= this.options.maxCacheSize) {
                // Don't evict if it would shrink the cache below the max size
                break;
            }
            this.cache.splice(oldestIndex, 1);
            this.currentCacheSize -= oldestEntry.bytes.length;
        }
    }
    dispose() {
        for (const worker of this.workers) {
            for (const slice of worker.pendingSlices) {
                slice.reject(new InputDisposedError());
            }
            worker.pendingSlices.length = 0;
            worker.aborted = true;
            if (!worker.running) {
                // Running workers clean up after themselves when they notice the abort
                this.options.onIdleWorkerRemoved?.(worker);
            }
        }
        for (const queuedRead of this.queuedReads) {
            for (const slice of queuedRead.pendingSlices) {
                slice.reject(new InputDisposedError());
            }
        }
        this.workers.length = 0;
        this.cache.length = 0;
        this.queuedReads.length = 0;
        this.disposed = true;
    }
}
/**
 * A source that covers a range (offset + length) of another source. Useful for reading files that are embedded within
 * larger files.
 *
 * @group Input sources
 * @public
 */
export class RangedSource extends Source {
    /** @internal */
    _baseSource: Source;
    /** @internal */
    _ref: SourceRef | null = null;
    /** @internal */
    _offset: number;
    /** @internal */
    _length: number | null;
    /** @internal */
    constructor(baseSource: Source, offset: number, length?: number) {
        super();
        if (baseSource._disposed) {
            throw new Error('Cannot create a slice of a disposed source.');
        }
        this._baseSource = baseSource;
        this._offset = offset;
        this._length = length ?? null;
    }
    /** @internal */
    override _getFileSize(): number | null | undefined {
        const baseSize = this._baseSource._getFileSize();
        if (baseSize === undefined) {
            return this._length !== null
                ? this._length
                : undefined;
        }
        if (baseSize === null) {
            if (this._length !== null) {
                return this._length;
            }
            else {
                return null;
            }
        }
        return clamp(baseSize - this._offset, 0, this._length ?? Infinity);
    }
    /** @internal */
    override _read(start: number, end: number, minReadPosition: number, maxReadPosition: number): MaybePromise<ReadResult | null> {
        if (this._length !== null && end > this._length) {
            return null;
        }
        const result = this._baseSource._read(this._offset + start, this._offset + end, this._offset + minReadPosition, this._offset + maxReadPosition);
        const processResult = (result: ReadResult | null) => {
            if (!result) {
                return null;
            }
            result.offset -= this._offset;
            return result;
        };
        if (isThenable(result)) {
            return result.then(processResult);
        }
        else {
            return processResult(result);
        }
    }
    /** @internal */
    override _dispose(): void {
        this._ref?.free();
    }
    override ref() {
        this._ref ??= this._baseSource.ref();
        return super.ref();
    }
}
