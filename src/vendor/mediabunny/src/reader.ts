/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Subset migrated from patched Mediabunny 1.62.1; see THIRD_PARTY_NOTICES.md at the package root.
import { InputDisposedError } from './input';
import { assert, clamp, getUint24, isThenable, type MaybePromise, toDataView } from './misc';
import { DEFAULT_MAX_READ_POSITION, DEFAULT_MIN_READ_POSITION, Source } from './source';
export class Reader {
    public source: Source;
    constructor(source: Source) {
        this.source = source;
    }
    get fileSize(): number | null {
        const size = this.source._getFileSize();
        if (size === undefined) {
            throw new Error('Reading file size too early; read required first.');
        }
        return size;
    }
    get fileSizeNonStrict() {
        return this.source._getFileSize() ?? null;
    }
    requestSlice(start: number, length: number): MaybePromise<FileSlice | null> {
        if (this.source._disposed) {
            throw new InputDisposedError();
        }
        if (start < 0) {
            return null;
        }
        if (this.fileSizeNonStrict !== null && start + length > this.fileSizeNonStrict) {
            return null;
        }
        if (length === 0) {
            const buffer = new Uint8Array(0);
            return new FileSlice(buffer, toDataView(buffer), 0, start, start);
        }
        const end = start + length;
        const result = this.source._read(start, end, DEFAULT_MIN_READ_POSITION, DEFAULT_MAX_READ_POSITION);
        if (isThenable(result)) {
            return result.then((x) => {
                if (!x) {
                    return null;
                }
                return new FileSlice(x.bytes, x.view, x.offset, start, end);
            });
        }
        else {
            if (!result) {
                return null;
            }
            return new FileSlice(result.bytes, result.view, result.offset, start, end);
        }
    }
    requestSliceRange(start: number, minLength: number, maxLength: number): MaybePromise<FileSlice | null> {
        if (this.source._disposed) {
            throw new InputDisposedError();
        }
        if (start < 0) {
            return null;
        }
        if (this.fileSizeNonStrict !== null) {
            return this.requestSlice(start, clamp(this.fileSizeNonStrict - start, minLength, maxLength));
        }
        else {
            const promisedAttempt = this.requestSlice(start, maxLength);
            const handleAttempt = (attempt: FileSlice | null) => {
                if (attempt) {
                    return attempt;
                }
                // The slice couldn't fit, meaning we must know the file size now
                assert(this.fileSizeNonStrict !== null);
                return this.requestSlice(start, clamp(this.fileSizeNonStrict - start, minLength, maxLength));
            };
            if (isThenable(promisedAttempt)) {
                return promisedAttempt.then(handleAttempt);
            }
            else {
                return handleAttempt(promisedAttempt);
            }
        }
    }
    requestEntireFile(): MaybePromise<FileSlice | null> {
        if (this.fileSizeNonStrict !== null) {
            return this.requestSlice(0, this.fileSizeNonStrict);
        }
        const CHUNK_SIZE = 1024;
        return (async () => {
            const chunks: Uint8Array[] = [];
            let currentSize = 0;
            while (true) {
                if (chunks.length === 1 && this.fileSizeNonStrict !== null) {
                    // It only took one read to get to know the whole file size
                    return this.requestSlice(0, this.fileSizeNonStrict);
                }
                let slice = this.requestSliceRange(currentSize, 0, CHUNK_SIZE);
                if (isThenable(slice))
                    slice = await slice;
                if (!slice || slice.length === 0) {
                    break;
                }
                const chunk = readBytes(slice, slice.length);
                chunks.push(chunk);
                currentSize += slice.length;
            }
            const joined = new Uint8Array(currentSize);
            let offset = 0;
            for (const chunk of chunks) {
                joined.set(chunk, offset);
                offset += chunk.length;
            }
            return new FileSlice(joined, toDataView(joined), 0, 0, currentSize);
        })();
    }
}
export class FileSlice {
    /** The current position in the backing buffer. Do not modify directly, prefer `.skip()` instead. */
    bufferPos: number;
    public readonly bytes: Uint8Array;
    public readonly view: DataView;
    private readonly offset: number;
    public readonly start: number;
    public readonly end: number;
    constructor(
    /** The underlying bytes backing this slice. Avoid using this directly and prefer reader functions instead. */
    bytes: Uint8Array, 
    /** A view into the bytes backing this slice. Avoid using this directly and prefer reader functions instead. */
    view: DataView, 
    /** The offset in "file bytes" at which `bytes` begins in the file. */
    offset: number, 
    /** The offset in "file bytes" where this slice begins. */
    start: number, 
    /** The offset in "file bytes" where this slice ends (exclusive). */
    end: number) {
        this.bytes = bytes;
        this.view = view;
        this.offset = offset;
        this.start = start;
        this.end = end;
        this.bufferPos = start - offset;
    }
    static tempFromBytes(bytes: Uint8Array) {
        return new FileSlice(bytes, toDataView(bytes), 0, 0, bytes.length);
    }
    get length() {
        return this.end - this.start;
    }
    get filePos() {
        return this.offset + this.bufferPos;
    }
    set filePos(value: number) {
        this.bufferPos = value - this.offset;
    }
    /** The number of bytes left from the current pos to the end of the slice. */
    get remainingLength() {
        return Math.max(this.end - this.filePos, 0);
    }
    skip(byteCount: number) {
        this.bufferPos += byteCount;
    }
    /** Creates a new subslice of this slice whose byte range must be contained within this slice. */
    slice(filePos: number, length = this.end - filePos) {
        if (filePos < this.start || filePos + length > this.end) {
            throw new RangeError('Slicing outside of original slice.');
        }
        return new FileSlice(this.bytes, this.view, this.offset, filePos, filePos + length);
    }
}
const checkIsInRange = (slice: FileSlice, bytesToRead: number) => {
    if (bytesToRead < 0 || slice.filePos < slice.start || slice.filePos + bytesToRead > slice.end) {
        throw new RangeError(`Tried reading [${slice.filePos}, ${slice.filePos + bytesToRead}), but slice is`
            + ` [${slice.start}, ${slice.end}). This is likely an internal error, please report it alongside the file`
            + ` that caused it.`);
    }
};
export const readBytes = (slice: FileSlice, length: number) => {
    checkIsInRange(slice, length);
    const bytes = slice.bytes.subarray(slice.bufferPos, slice.bufferPos + length);
    slice.bufferPos += length;
    return bytes;
};
export const readU8 = (slice: FileSlice) => {
    checkIsInRange(slice, 1);
    return slice.view.getUint8(slice.bufferPos++);
};
export const readU16Be = (slice: FileSlice) => {
    checkIsInRange(slice, 2);
    const value = slice.view.getUint16(slice.bufferPos, false);
    slice.bufferPos += 2;
    return value;
};
export const readU24Be = (slice: FileSlice) => {
    checkIsInRange(slice, 3);
    const value = getUint24(slice.view, slice.bufferPos, false);
    slice.bufferPos += 3;
    return value;
};
export const readI16Be = (slice: FileSlice) => {
    checkIsInRange(slice, 2);
    const value = slice.view.getInt16(slice.bufferPos, false);
    slice.bufferPos += 2;
    return value;
};
export const readU32Be = (slice: FileSlice) => {
    checkIsInRange(slice, 4);
    const value = slice.view.getUint32(slice.bufferPos, false);
    slice.bufferPos += 4;
    return value;
};
export const readI32Be = (slice: FileSlice) => {
    checkIsInRange(slice, 4);
    const value = slice.view.getInt32(slice.bufferPos, false);
    slice.bufferPos += 4;
    return value;
};
export const readU64Be = (slice: FileSlice) => {
    const high = readU32Be(slice);
    const low = readU32Be(slice);
    return high * 0x100000000 + low;
};
export const readI64Be = (slice: FileSlice) => {
    const high = readI32Be(slice);
    const low = readU32Be(slice);
    return high * 0x100000000 + low;
};
export const readF64Be = (slice: FileSlice) => {
    checkIsInRange(slice, 8);
    const value = slice.view.getFloat64(slice.bufferPos, false);
    slice.bufferPos += 8;
    return value;
};
export const readAscii = (slice: FileSlice, length: number) => {
    checkIsInRange(slice, length);
    let str = '';
    for (let i = 0; i < length; i++) {
        str += String.fromCharCode(slice.bytes[slice.bufferPos++]!);
    }
    return str;
};
