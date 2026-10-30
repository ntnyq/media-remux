/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Subset migrated from patched Mediabunny 1.62.1; see THIRD_PARTY_NOTICES.md at the package root.
import { Bitstream } from '../shared/bitstream';
export function assert(x: unknown): asserts x {
    if (!x) {
        throw new Error('Assertion failed.');
    }
}
/**
 * Represents a clockwise rotation in degrees.
 * @group Miscellaneous
 * @public
 */
export type Rotation = 0 | 90 | 180 | 270;
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const normalizeRotation = (rotation: number) => {
    const mappedRotation = (rotation % 360 + 360) % 360;
    if (mappedRotation === 0 || mappedRotation === 90 || mappedRotation === 180 || mappedRotation === 270) {
        return mappedRotation as Rotation;
    }
    else {
        throw new Error(`Invalid rotation ${rotation}.`);
    }
};
/**
 * Row-major 3x3 affine transformation matrix.
 * @group Miscellaneous
 * @public
 */
export type TransformationMatrix = [
    a: number,
    b: number,
    u: number,
    c: number,
    d: number,
    v: number,
    x: number,
    y: number,
    w: number
];
export const IDENTITY_MATRIX: TransformationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/**
 * Applies a linear transformation (no translation) to a width-by-height frame about its center, with the result
 * sitting in the positive quadrant.
 */
export const centeredTransformationMatrix = (linear: TransformationMatrix, width: number, height: number) => {
    const [a, b, , c, d] = linear;
    // Bounding box of the transformed frame
    const transformedWidth = Math.abs(a) * width + Math.abs(c) * height;
    const transformedHeight = Math.abs(b) * width + Math.abs(d) * height;
    // The transformation happens about the origin (the frame's top-left corner), so we move the center to the
    // origin, transform, then move it back
    return multiplyMatrices(multiplyMatrices(translationMatrix(-width / 2, -height / 2), linear), translationMatrix(transformedWidth / 2, transformedHeight / 2));
};
/**
 * Extracts the rotation from a transformation matrix, assuming the matrix has the form "rotate, then maybe flip
 * horizontally", and snapping to the nearest multiple of 90 degrees.
 */
export const extractRotationFromMatrix = (matrix: TransformationMatrix) => {
    const [a, b] = matrix;
    // (1, 0) projects onto (a, b), so that's all we need. The rotation is applied before flipping though, so we
    // first need to undo the flip to isolate the rotation.
    const radians = Math.atan2(b, matrixIsFlipped(matrix) ? -a : a);
    return normalizeRotation(roundToMultiple(radians * RAD_TO_DEG, 90));
};
/** Whether the transformation matrix flips the frame, i.e. has a negative determinant. */
export const matrixIsFlipped = (matrix: TransformationMatrix) => {
    const [a, b, , c, d] = matrix;
    const det = a * d - b * c;
    return det < 0;
};
export const rotationMatrix = (rotationInDegrees: number): TransformationMatrix => {
    const theta = rotationInDegrees * DEG_TO_RAD;
    const cosTheta = Math.round(Math.cos(theta));
    const sinTheta = Math.round(Math.sin(theta));
    // Points are row vectors, meaning this is the transpose of your typical rotation matrix
    return [
        cosTheta, sinTheta, 0,
        -sinTheta, cosTheta, 0,
        0, 0, 1,
    ];
};
export const translationMatrix = (x: number, y: number): TransformationMatrix => {
    // Points are row vectors, meaning this is the transpose of your typical translation matrix
    return [
        1, 0, 0,
        0, 1, 0,
        x, y, 1,
    ];
};
export const scaleMatrix = (x: number, y: number): TransformationMatrix => {
    return [
        x, 0, 0,
        0, y, 0,
        0, 0, 1,
    ];
};
/** Computes a * b. Since points are row vectors, this applies a first, then b. */
export const multiplyMatrices = (a: TransformationMatrix, b: TransformationMatrix): TransformationMatrix => {
    const result = new Array<number>(9) as TransformationMatrix;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            result[3 * i + j] = a[3 * i]! * b[j]! + a[3 * i + 1]! * b[3 + j]! + a[3 * i + 2]! * b[6 + j]!;
        }
    }
    return result;
};
export const last = <T>(arr: T[]) => {
    return arr && arr[arr.length - 1];
};
export const isU32 = (value: number) => {
    return value >= 0 && value < 2 ** 32;
};
export const isI32 = (value: number) => {
    return value >= -(2 ** 31) && value < 2 ** 31;
};
/** Reads an exponential-Golomb universal code from a Bitstream.  */
export const readExpGolomb = (bitstream: Bitstream) => {
    let leadingZeroBits = 0;
    while (bitstream.readBits(1) === 0 && leadingZeroBits < 32) {
        leadingZeroBits++;
    }
    if (leadingZeroBits >= 32) {
        throw new Error('Invalid exponential-Golomb code.');
    }
    // Not using bit shifts here, since they'd overflow into negative numbers for 31 leading zeros
    const result = 2 ** leadingZeroBits - 1 + bitstream.readBits(leadingZeroBits);
    return result;
};
/** Reads a signed exponential-Golomb universal code from a Bitstream. */
export const readSignedExpGolomb = (bitstream: Bitstream) => {
    const codeNum = readExpGolomb(bitstream);
    // Division instead of bit shifts, since codeNum may exceed the 32-bit signed range
    return codeNum % 2 === 0
        ? -(codeNum / 2)
        : (codeNum + 1) / 2;
};
export const toUint8Array = (source: AllowSharedBufferSource): Uint8Array => {
    if (source.constructor === Uint8Array) { // We want a true Uint8Array, not something that extends it like Buffer
        return source;
    }
    else if (ArrayBuffer.isView(source)) {
        return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    else {
        return new Uint8Array(source);
    }
};
export const toDataView = (source: AllowSharedBufferSource): DataView => {
    if (source.constructor === DataView) {
        return source;
    }
    else if (ArrayBuffer.isView(source)) {
        return new DataView(source.buffer, source.byteOffset, source.byteLength);
    }
    else {
        return new DataView(source);
    }
};
// Include a polyfill for environments that don't have TextEncoder (like AudioWorkletGlobalScope)
export const TextEncoder = typeof globalThis.TextEncoder !== 'undefined'
    ? globalThis.TextEncoder
    : class TextEncoder {
        readonly encoding = 'utf-8';
        encode(input = '') {
            // UTF-8 needs at most 3 bytes per UTF-16 code unit
            const bytes = new Uint8Array(3 * input.length);
            let n = 0;
            for (let i = 0; i < input.length; i++) {
                let c = input.charCodeAt(i);
                if (c < 0x80) {
                    bytes[n++] = c;
                }
                else if (c < 0x800) {
                    bytes[n++] = 0xc0 | (c >> 6);
                    bytes[n++] = 0x80 | (c & 63);
                }
                else if (c < 0xd800 || c > 0xdfff) {
                    bytes[n++] = 0xe0 | (c >> 12);
                    bytes[n++] = 0x80 | ((c >> 6) & 63);
                    bytes[n++] = 0x80 | (c & 63);
                }
                else {
                    const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
                    if (c < 0xdc00 && next >= 0xdc00 && next <= 0xdfff) {
                        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
                        i++;
                        bytes[n++] = 0xf0 | (c >> 18);
                        bytes[n++] = 0x80 | ((c >> 12) & 63);
                        bytes[n++] = 0x80 | ((c >> 6) & 63);
                        bytes[n++] = 0x80 | (c & 63);
                    }
                    else {
                        bytes[n++] = 0xef;
                        bytes[n++] = 0xbf;
                        bytes[n++] = 0xbd;
                    }
                }
            }
            return bytes.slice(0, n);
        }
    };
// Include a polyfill for environments that don't have TextEncoder (like AudioWorkletGlobalScope)
export const TextDecoder = typeof globalThis.TextDecoder !== 'undefined'
    ? globalThis.TextDecoder
    : class TextDecoder {
        readonly encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
        constructor(label = 'utf-8') {
            const normalized = label.trim().toLowerCase();
            if (normalized === 'utf-8' || normalized === 'utf8' || normalized === 'unicode-1-1-utf-8') {
                this.encoding = 'utf-8';
            }
            else if (normalized === 'utf-16le' || normalized === 'utf-16') {
                this.encoding = 'utf-16le';
            }
            else if (normalized === 'utf-16be') {
                this.encoding = 'utf-16be';
            }
            else {
                throw new RangeError(`The encoding label provided ('${label}') is invalid.`);
            }
        }
        decode(input?: AllowSharedBufferSource) {
            const bytes = input ? toUint8Array(input) : new Uint8Array(0);
            const units: number[] = [];
            if (this.encoding === 'utf-8') {
                let i = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
                while (i < bytes.length) {
                    const lead = bytes[i]!;
                    if (lead < 0x80) {
                        units.push(lead);
                        i++;
                        continue;
                    }
                    let continuationCount: number;
                    let codePoint: number;
                    if (lead >= 0xc2 && lead < 0xe0) {
                        continuationCount = 1;
                        codePoint = lead & 0x1f;
                    }
                    else if (lead >= 0xe0 && lead < 0xf0) {
                        continuationCount = 2;
                        codePoint = lead & 0x0f;
                    }
                    else if (lead >= 0xf0 && lead < 0xf5) {
                        continuationCount = 3;
                        codePoint = lead & 0x07;
                    }
                    else {
                        units.push(0xfffd);
                        i++;
                        continue;
                    }
                    let lowerBound = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
                    let upperBound = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
                    let j = 1;
                    for (; j <= continuationCount; j++) {
                        const byte = i + j < bytes.length ? bytes[i + j]! : 0;
                        if (byte < lowerBound || byte > upperBound) {
                            break;
                        }
                        codePoint = (codePoint << 6) | (byte & 0x3f);
                        lowerBound = 0x80;
                        upperBound = 0xbf;
                    }
                    i += j;
                    if (j <= continuationCount) {
                        units.push(0xfffd);
                    }
                    else if (codePoint >= 0x10000) {
                        codePoint -= 0x10000;
                        units.push(0xd800 | (codePoint >> 10), 0xdc00 | (codePoint & 0x3ff));
                    }
                    else {
                        units.push(codePoint);
                    }
                }
            }
            else {
                const littleEndian = this.encoding === 'utf-16le';
                const bomLow = littleEndian ? 0xff : 0xfe;
                const bomHigh = littleEndian ? 0xfe : 0xff;
                let i = bytes.length >= 2 && bytes[0] === bomLow && bytes[1] === bomHigh ? 2 : 0;
                while (i + 1 < bytes.length) {
                    const unit = littleEndian
                        ? bytes[i]! | (bytes[i + 1]! << 8)
                        : (bytes[i]! << 8) | bytes[i + 1]!;
                    i += 2;
                    if (unit >= 0xd800 && unit <= 0xdbff) {
                        const next = i + 1 < bytes.length
                            ? (littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!)
                            : -1;
                        if (next >= 0xdc00 && next <= 0xdfff) {
                            units.push(unit, next);
                            i += 2;
                        }
                        else {
                            units.push(0xfffd);
                        }
                    }
                    else if (unit >= 0xdc00 && unit <= 0xdfff) {
                        units.push(0xfffd);
                    }
                    else {
                        units.push(unit);
                    }
                }
                if (i < bytes.length) {
                    units.push(0xfffd); // Dangling odd byte
                }
            }
            let result = '';
            for (let i = 0; i < units.length; i += 8192) {
                result += String.fromCharCode(...units.slice(i, i + 8192));
            }
            return result;
        }
    };
export const textDecoder = /* #__PURE__ */ new TextDecoder();
export const textEncoder = /* #__PURE__ */ new TextEncoder();
const invertObject = <K extends PropertyKey, V extends PropertyKey>(object: Record<K, V>) => {
    return Object.fromEntries(Object.entries(object).map(([key, value]) => [value, key])) as Record<V, K>;
};
// For the color space mappings, see Rec. ITU-T H.273.
export const COLOR_PRIMARIES_MAP = {
    bt709: 1, // ITU-R BT.709
    bt470bg: 5, // ITU-R BT.470BG
    smpte170m: 6, // ITU-R BT.601 525 - SMPTE 170M
    bt2020: 9, // ITU-R BT.202
    smpte432: 12, // SMPTE EG 432-1
};
export const COLOR_PRIMARIES_MAP_INVERSE = /* #__PURE__ */ invertObject(COLOR_PRIMARIES_MAP);
export const TRANSFER_CHARACTERISTICS_MAP = {
    'bt709': 1, // ITU-R BT.709
    'smpte170m': 6, // SMPTE 170M
    'linear': 8, // Linear transfer characteristics
    'iec61966-2-1': 13, // IEC 61966-2-1
    'pq': 16, // Rec. ITU-R BT.2100-2 perceptual quantization (PQ) system
    'hlg': 18, // Rec. ITU-R BT.2100-2 hybrid loggamma (HLG) system
};
export const TRANSFER_CHARACTERISTICS_MAP_INVERSE = /* #__PURE__ */ invertObject(TRANSFER_CHARACTERISTICS_MAP);
export const MATRIX_COEFFICIENTS_MAP = {
    'rgb': 0, // Identity
    'bt709': 1, // ITU-R BT.709
    'bt470bg': 5, // ITU-R BT.470BG
    'smpte170m': 6, // SMPTE 170M
    'bt2020-ncl': 9, // ITU-R BT.2020-2 (non-constant luminance)
};
export const MATRIX_COEFFICIENTS_MAP_INVERSE = /* #__PURE__ */ invertObject(MATRIX_COEFFICIENTS_MAP);
export type RequiredNonNull<T> = {
    [K in keyof T]-?: NonNullable<T[K]>;
};
export const colorSpaceIsComplete = (colorSpace: VideoColorSpaceInit | undefined): colorSpace is RequiredNonNull<VideoColorSpaceInit> => {
    return (!!colorSpace
        && !!colorSpace.primaries
        && !!colorSpace.transfer
        && !!colorSpace.matrix
        && colorSpace.fullRange !== undefined);
};
export const colorSpaceIsEmpty = (colorSpace: VideoColorSpaceInit | undefined) => {
    return (!colorSpace
        || (colorSpace.primaries == null
            && colorSpace.transfer == null
            && colorSpace.matrix == null
            && colorSpace.fullRange == null));
};
export const EMPTY_COLOR_SPACE: VideoColorSpaceInit = {
    primaries: null,
    transfer: null,
    matrix: null,
    fullRange: null,
};
export const isAllowSharedBufferSource = (x: unknown) => {
    return (x instanceof ArrayBuffer
        || (typeof SharedArrayBuffer !== 'undefined' && x instanceof SharedArrayBuffer)
        || ArrayBuffer.isView(x));
};
export class AsyncMutex {
    currentPromise = Promise.resolve();
    pending = 0;
    async acquire() {
        let resolver: () => void;
        const nextPromise = new Promise<void>((resolve) => {
            let resolved = false;
            resolver = () => {
                if (resolved) {
                    return;
                }
                resolve();
                this.pending--;
                resolved = true;
            };
        });
        const currentPromiseAlias = this.currentPromise;
        this.currentPromise = nextPromise;
        this.pending++;
        await currentPromiseAlias;
        return resolver!;
    }
}
export const HEX_STRING_REGEX = /^[0-9a-fA-F]+$/;
export const bytesToHexString = (bytes: Uint8Array) => {
    return [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
};
export const hexStringToBytes = (hexString: string) => {
    assert(hexString.length % 2 === 0);
    const bytes = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
        bytes[i / 2] = parseInt(hexString.slice(i, i + 2), 16);
    }
    return bytes;
};
export const reverseBitsU32 = (x: number): number => {
    x = ((x >> 1) & 0x55555555) | ((x & 0x55555555) << 1);
    x = ((x >> 2) & 0x33333333) | ((x & 0x33333333) << 2);
    x = ((x >> 4) & 0x0f0f0f0f) | ((x & 0x0f0f0f0f) << 4);
    x = ((x >> 8) & 0x00ff00ff) | ((x & 0x00ff00ff) << 8);
    x = ((x >> 16) & 0x0000ffff) | ((x & 0x0000ffff) << 16);
    return x >>> 0; // Ensure it's treated as an unsigned 32-bit integer
};
/** Returns the largest index i such that val[i] <= key, or -1 if no such index exists. */
export const binarySearchLessOrEqual = <T>(arr: ArrayLike<T>, key: number, valueGetter: (x: T) => number) => {
    let low = 0;
    let high = arr.length - 1;
    let ans = -1;
    while (low <= high) {
        const mid = (low + (high - low + 1) / 2) | 0;
        const midVal = valueGetter(arr[mid]!);
        if (midVal <= key) {
            ans = mid;
            low = mid + 1;
        }
        else {
            high = mid - 1;
        }
    }
    return ans;
};
export const promiseWithResolvers = <T = void>() => {
    let resolve: (value: T) => void;
    let reject: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve: resolve!, reject: reject! };
};
export const removeItem = <T>(arr: T[], item: T) => {
    const index = arr.indexOf(item);
    if (index !== -1) {
        arr.splice(index, 1);
    }
};
export const assertNever = (x: never) => {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    throw new Error(`Unexpected value: ${x}`);
};
export const getUint24 = (view: DataView, byteOffset: number, littleEndian: boolean) => {
    const byte1 = view.getUint8(byteOffset);
    const byte2 = view.getUint8(byteOffset + 1);
    const byte3 = view.getUint8(byteOffset + 2);
    if (littleEndian) {
        return byte1 | (byte2 << 8) | (byte3 << 16);
    }
    else {
        return (byte1 << 16) | (byte2 << 8) | byte3;
    }
};
export const setUint24 = (view: DataView, byteOffset: number, value: number, littleEndian: boolean) => {
    // Ensure the value is within 24-bit unsigned range (0 to 16777215)
    value = value >>> 0; // Convert to unsigned 32-bit
    value = value & 0xFFFFFF; // Mask to 24 bits
    if (littleEndian) {
        view.setUint8(byteOffset, value & 0xFF);
        view.setUint8(byteOffset + 1, (value >>> 8) & 0xFF);
        view.setUint8(byteOffset + 2, (value >>> 16) & 0xFF);
    }
    else {
        view.setUint8(byteOffset, (value >>> 16) & 0xFF);
        view.setUint8(byteOffset + 1, (value >>> 8) & 0xFF);
        view.setUint8(byteOffset + 2, value & 0xFF);
    }
};
export const clamp = (value: number, min: number, max: number) => {
    return Math.max(min, Math.min(max, value));
};
export const UNDETERMINED_LANGUAGE = 'und';
export const roundIfAlmostInteger = (value: number) => {
    const rounded = Math.round(value);
    if (Math.abs(value / rounded - 1) < 10 * Number.EPSILON) {
        return rounded;
    }
    else {
        return value;
    }
};
export const roundToMultiple = (value: number, multiple: number) => {
    return Math.round(value / multiple) * multiple;
};
export const roundToDivisor = (value: number, multiple: number) => {
    return Math.round(value * multiple) / multiple;
};
export const popcount = (value: number) => {
    let count = 0;
    while (value !== 0) {
        value &= value - 1;
        count++;
    }
    return count;
};
const ISO_639_2_REGEX = /^[a-z]{3}$/;
export const isIso639Dash2LanguageCode = (x: string) => {
    return ISO_639_2_REGEX.test(x);
};
// Since the result will be truncated, add a bit of eps to compensate for floating point errors
export const SECOND_TO_MICROSECOND_FACTOR = 1e6 * (1 + Number.EPSILON);
export const computeRationalApproximation = (x: number, maxDenominator: number): Rational => {
    // Handle negative numbers
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    let prevNumerator = 0, prevDenominator = 1;
    let currNumerator = 1, currDenominator = 0;
    // Continued fraction algorithm
    let remainder = x;
    while (true) {
        const integer = Math.floor(remainder);
        // Calculate next convergent
        const nextNumerator = integer * currNumerator + prevNumerator;
        const nextDenominator = integer * currDenominator + prevDenominator;
        if (nextDenominator > maxDenominator) {
            return {
                num: sign * currNumerator,
                den: currDenominator,
            };
        }
        prevNumerator = currNumerator;
        prevDenominator = currDenominator;
        currNumerator = nextNumerator;
        currDenominator = nextDenominator;
        remainder = 1 / (remainder - integer);
        // Guard against precision issues
        if (!isFinite(remainder)) {
            break;
        }
    }
    return {
        num: sign * currNumerator,
        den: currDenominator,
    };
};
let isWebKitCache: boolean | null = null;
export const isWebKit = () => {
    if (isWebKitCache !== null) {
        return isWebKitCache;
    }
    // This even returns true for WebKit-wrapping browsers such as Chrome on iOS
    return isWebKitCache = !!(typeof navigator !== 'undefined'
        && (
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        navigator.vendor?.match(/apple/i)
            // Or, in workers:
            || (/AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent))
            || /\b(iPad|iPhone|iPod)\b/.test(navigator.userAgent)));
};
let isChromiumCache: boolean | null = null;
export const isChromium = () => {
    if (isChromiumCache !== null) {
        return isChromiumCache;
    }
    return isChromiumCache = !!(typeof navigator !== 'undefined'
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        && (navigator.vendor?.includes('Google Inc') || /Chrome/.test(navigator.userAgent)));
};
/**
 * T or a promise that resolves to T.
 * @group Miscellaneous
 * @public
 */
export type MaybePromise<T> = T | Promise<T>;
const NativePromiseConstructor = /* #__PURE__ */ (async () => { })().constructor as PromiseConstructor;
/**
 * Needed to properly deal with custom Promise implementations and because this is closer to how the JS spec does it.
 */
export const isThenable = <T>(value: MaybePromise<T>): value is Promise<T> => {
    if (value instanceof NativePromiseConstructor || value instanceof Promise) {
        return true;
    }
    // Fall back to a crude duck typing check
    return typeof (value as PromiseLike<T> | null | undefined)?.then === 'function';
};
export const closedIntervalsOverlap = (startA: number, endA: number, startB: number, endB: number) => {
    return startA <= endB && startB <= endA;
};
type KeyValuePair<T extends Record<string, unknown>> = {
    [K in keyof T]-?: {
        key: K;
        value: T[K] extends infer R | undefined ? R : T[K];
    };
}[keyof T];
export const keyValueIterator = function* <T extends Record<string, unknown>>(object: T) {
    for (const key in object) {
        const value = object[key];
        if (value === undefined) {
            continue;
        }
        yield { key, value } as KeyValuePair<T>;
    }
};
export const uint8ArraysAreEqual = (a: Uint8Array, b: Uint8Array) => {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
};
export const isNumber = (x: unknown) => {
    return typeof x === 'number' && !Number.isNaN(x);
};
/**
 * A path to a file. File paths can be relative or absolute, and be local paths or full URLs. Paths must be POSIX-like,
 * using `/` as the separator.
 *
 * Examples of valid paths:
 * - `'video.mp4'`
 * - `'path/to/video.mp4'`
 * - `'./video.mp4'`
 * - `'../video.mp4'`
 * - `'/path/to/video.mp4'`
 * - `'https://example.com/video.mp4'`
 * - `'file:///home/user/video.mp4'`
 * - `'video.mp4?key=foo'`
 *
 * @group Miscellaneous
 * @public
 */
export type FilePath = string;
export const arrayCount = <T>(array: T[], predicate: (item: T) => boolean) => {
    let count = 0;
    for (let i = 0; i < array.length; i++) {
        if (predicate(array[i]!)) {
            count++;
        }
    }
    return count;
};
export const arrayArgmin = <T>(array: T[], getValue: (item: T) => number): number => {
    let minIndex = -1;
    let minValue = Infinity;
    for (let i = 0; i < array.length; i++) {
        const value = getValue(array[i]!);
        if (value < minValue) {
            minValue = value;
            minIndex = i;
        }
    }
    return minIndex;
};
/**
 * A rational number; a ratio of two integers.
 * @group Miscellaneous
 * @public
 */
export type Rational = {
    /** The numerator of the rational number. */
    num: number;
    /** The denominator of the rational number. */
    den: number;
};
export const simplifyRational = (rational: Rational): Rational => {
    assert(Number.isInteger(rational.num));
    assert(Number.isInteger(rational.den));
    assert(rational.den !== 0);
    let a = Math.abs(rational.num);
    let b = Math.abs(rational.den);
    // Euclidean algorithm
    while (b !== 0) {
        const t = a % b;
        a = b;
        b = t;
    }
    const gcd = a || 1;
    return {
        num: rational.num / gcd,
        den: rational.den / gcd,
    };
};
export const toArray = <T>(x: T | T[]) => {
    if (Array.isArray(x)) {
        return x;
    }
    else {
        return [x];
    }
};
/**
 * Options for {@link EventEmitter.on}.
 *
 * @group Miscellaneous
 * @public
 */
export type EventListenerOptions = {
    /** If `true`, the listener will be automatically removed after being called once. Defaults to `false`. */
    once?: boolean | undefined;
};
/**
 * A class that manages event listeners and dispatches events to them.
 *
 * @group Miscellaneous
 * @public
 */
export class EventEmitter<TEvents extends Record<string, unknown>> {
    /** @internal */
    _listeners = new Map<keyof TEvents, Set<{
        fn: (data: never) => unknown;
        once: boolean;
    }>>();
    /** Registers a listener for the given event. Returns a function that, when called, removes the listener again. */
    on<K extends keyof TEvents>(event: K, listener: (data: TEvents[K]) => unknown, options?: EventListenerOptions): () => void {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        const entry = { fn: listener as (data: never) => void, once: options?.once ?? false };
        this._listeners.get(event)!.add(entry);
        return () => {
            this._listeners.get(event)?.delete(entry);
        };
    }
    /** @internal */
    _emit<K extends keyof TEvents>(...args: TEvents[K] extends void ? [
        event: K
    ] : [
        event: K,
        data: TEvents[K]
    ]): void {
        const [event, data] = args;
        const listeners = this._listeners.get(event);
        if (!listeners) {
            return;
        }
        for (const entry of listeners) {
            try {
                (entry.fn as (data: unknown) => void)(data);
            }
            catch (error) {
                // Deliberately not routed through Logging here: Logging emits via an EventEmitter, so a throwing
                // log listener would recurse straight back into this handler.
                console.error(error);
            }
            if (entry.once) {
                listeners.delete(entry);
            }
        }
    }
}
export const isRecordStringString = (value: unknown): value is Record<string, string> => {
    return value !== null
        && typeof value === 'object'
        && Object.getPrototypeOf(value) === Object.prototype
        && Object.values(value).every(x => typeof x === 'string');
};
export const polyfillSymbolDispose = () => {
    // https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html
    // @ts-expect-error Readonly
    Symbol.dispose ??= Symbol('Symbol.dispose');
};
