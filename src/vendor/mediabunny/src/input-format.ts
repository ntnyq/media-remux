/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Subset migrated from patched Mediabunny 1.62.1; see THIRD_PARTY_NOTICES.md at the package root.
import { Demuxer } from './demuxer';
import { Input } from './input';
import { IsobmffDemuxer } from './isobmff/isobmff-demuxer';
import type { PsshBox } from './isobmff/isobmff-misc';
import { readAscii, readU32Be, readU64Be } from './reader';
import { isThenable, type MaybePromise } from './misc';
/**
 * Base class representing an input media file format.
 * @group Input formats
 * @public
 */
export abstract class InputFormat {
    /** @internal */
    abstract _canReadInput(input: Input): Promise<boolean>;
    /** @internal */
    abstract _createDemuxer(input: Input): Demuxer;
    /** Returns the name of the input format. */
    abstract get name(): string;
    /** Returns the typical base MIME type of the input format. */
    abstract get mimeType(): string;
    /**
     * Whether this input format's tracks store timestamped media data. When `true`, the timestamps of read packets
     * come from the file, allowing things like gaps in media data or non-zero start times. When `false`, the format's
     * media data implicitly starts at zero and follows an implicit sequential timing from there, using the intrinsic
     * durations of the media data.
     */
    abstract get supportsTimestampedMediaData(): boolean;
    /**
     * Provided for tree-shakable checking.
     * @internal
     */
    _isIsobmff = false;
}
/**
 * Format representing files compatible with the ISO base media file format (ISOBMFF), like MP4 or MOV files.
 *
 * This format can make use of {@link InputOptions.initInput}. When the file contents are fragmented but no track
 * initialization info is provided (no `moov` atom), then it must be provided via `initInput`.
 *
 * @group Input formats
 * @public
 */
export abstract class IsobmffInputFormat extends InputFormat {
    /** @internal */
    protected async _getMajorBrand(input: Input) {
        let slice = input._reader.requestSlice(0, 12);
        if (isThenable(slice))
            slice = await slice;
        if (!slice)
            return null;
        slice.skip(4);
        const fourCc = readAscii(slice, 4);
        if (fourCc !== 'ftyp'
            && fourCc !== 'styp' // Segment
        ) {
            return null;
        }
        return readAscii(slice, 4);
    }
    /** @internal */
    _createDemuxer(input: Input) {
        return new IsobmffDemuxer(input);
    }
    get supportsTimestampedMediaData() {
        return true;
    }
    /** @internal */
    override _isIsobmff = true;
}
/**
 * MPEG-4 Part 14 (MP4) file format.
 *
 * Do not instantiate this class; use the {@link MP4} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class Mp4InputFormat extends IsobmffInputFormat {
    /** @internal */
    async _canReadInput(input: Input) {
        const majorBrand = await this._getMajorBrand(input);
        if (majorBrand !== null) {
            return majorBrand !== 'qt  ';
        }
        let pos = 0;
        for (let iter = 0; iter < 10; iter++) { // Bounded loop
            let slice = input._reader.requestSlice(pos, 8);
            if (isThenable(slice))
                slice = await slice;
            if (!slice)
                return false;
            let size = readU32Be(slice);
            let headerSize = 8;
            if (size === 1) {
                let sizeExtensionSlice = input._reader.requestSlice(pos + 8, 8);
                if (isThenable(sizeExtensionSlice))
                    sizeExtensionSlice = await sizeExtensionSlice;
                if (!sizeExtensionSlice)
                    return false;
                size = readU64Be(sizeExtensionSlice);
                headerSize = 16;
            }
            if (size < headerSize) {
                return false; // Hardly a box is it
            }
            const fourCc = readAscii(slice, 4);
            if (fourCc === 'moof' || fourCc === 'sidx') { // Seen in HLS for example
                return true;
            }
            else if (fourCc === 'emsg' || fourCc === 'prft' || fourCc === 'free') {
                // These are boxes that can appear before the first moof in DASH Media Segments. They're a strong signal
                // that this is indeed an fMP4 segment, but just to be sure, let's walk the box structure to make sure
                // it stays sane.
                pos += size;
            }
            else {
                return false;
            }
        }
        return false;
    }
    get name() {
        return 'MP4';
    }
    get mimeType() {
        return 'video/mp4';
    }
}
/**
 * MP4 input format singleton.
 * @group Input formats
 * @public
 */
export const MP4 = /* #__PURE__ */ new Mp4InputFormat();
/**
 * Additional per-format configuration.
 * @group Input formats
 * @public
 */
export type InputFormatOptions = {
    /** ISOBMFF-specific configuration. */
    isobmff?: IsobmffInputFormatOptions | undefined;
    /** HLS-specific configuration. */
    hls?: HlsInputFormatOptions | undefined;
};
/**
 * Additional ISOBMFF input configuration.
 * @group Input formats
 * @public
 */
export type IsobmffInputFormatOptions = {
    /**
     * A callback that gets invoked for each key ID required for sample content decryption. The key ID is provided as a
     * 32-character lowercase hexadecimal string.
     *
     * Must return or resolve to a 32-character hexadecimal string or a 16-byte `Uint8Array`.
     */
    resolveKeyId?: ((options: {
        /** The key ID that is to be resolved to a key. This is a 32-character lowercase hexadecimal string. */
        keyId: string;
        /**
         * Protection System Specific Header (pssh) boxes that apply to this key ID. Can be used to obtain a
         * description key from a DRM license server.
         */
        psshBoxes: PsshBox[];
    }) => MaybePromise<Uint8Array | string>) | undefined;
    /** @internal */
    _suppressPsshParsing?: boolean | undefined;
};
/**
 * Additional HLS input configuration.
 * @group Input formats
 * @public
 */
export type HlsInputFormatOptions = {
    /**
     * Whether, in the presence of `#EXT-X-PROGRAM-DATE-TIME` tags, to offset track and packet timestamps to be relative
     * to the Unix epoch.
     *
     * Defaults to `true`, meaning packet timestamps map directly to wall-clock time. This guarantees AV sync across
     * multiple tracks, even with gaps present.
     *
     * When you don't want this mapping, you can set this value to `false`. In addition to timestamps not being Unix
     * timestamps anymore, any gaps in the playlist are also naturally removed. When `false`, you can still access the
     * wall-clock Unix timestamps via {@link InputTrack.getUnixTimeForTimestamp}.
     */
    offsetTimestampsByDateTime?: boolean | undefined;
};
export const validateInputFormatOptions = (options: InputFormatOptions, prefix: string) => {
    if (!options || typeof options !== 'object') {
        throw new TypeError(`${prefix}, when provided, must be an object.`);
    }
    if (options.isobmff !== undefined) {
        if (!options.isobmff || typeof options.isobmff !== 'object') {
            throw new TypeError(`${prefix}.isobmff, when provided, must be an object.`);
        }
        if (options.isobmff.resolveKeyId !== undefined && typeof options.isobmff.resolveKeyId !== 'function') {
            throw new TypeError(`${prefix}.isobmff.resolveKeyId, when provided, must be a function.`);
        }
    }
    if (options.hls !== undefined) {
        if (!options.hls || typeof options.hls !== 'object') {
            throw new TypeError(`${prefix}.hls, when provided, must be an object.`);
        }
        if (options.hls.offsetTimestampsByDateTime !== undefined
            && typeof options.hls.offsetTimestampsByDateTime !== 'boolean') {
            throw new TypeError(`${prefix}.hls.offsetTimestampsByDateTime, when provided, must be a boolean.`);
        }
    }
};
