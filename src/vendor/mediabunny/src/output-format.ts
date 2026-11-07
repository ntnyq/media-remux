/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Subset migrated from patched Mediabunny 1.62.1; see THIRD_PARTY_NOTICES.md at the package root.
import { AUDIO_CODECS, type AudioCodec, type MediaCodec, NON_PCM_AUDIO_CODECS, SUBTITLE_CODECS, type SubtitleCodec, VIDEO_CODECS, type VideoCodec } from './codec';
import { IsobmffMuxer } from './isobmff/isobmff-muxer';
import { Muxer } from './muxer';
import { Output, type TrackType } from './output';
import { type MaybePromise, isNumber } from './misc';
/**
 * Specifies an inclusive range of integers.
 * @group Miscellaneous
 * @public
 */
export type InclusiveIntegerRange = {
    /** The integer cannot be less than this. */
    min: number;
    /** The integer cannot be greater than this. */
    max: number;
};
/**
 * Specifies the number of tracks (for each track type and in total) that an output format supports.
 * @group Output formats
 * @public
 */
export type TrackCountLimits = {
    [K in TrackType]: InclusiveIntegerRange;
} & {
    /** Specifies the overall allowed range of track counts for the output format. */
    total: InclusiveIntegerRange;
};
/**
 * Base class representing an output media file format.
 * @group Output formats
 * @public
 */
export abstract class OutputFormat {
    /** @internal */
    abstract _createMuxer(output: Output): Muxer;
    /** @internal */
    abstract get _name(): string;
    /** The file extension used by this output format, beginning with a dot. */
    abstract get fileExtension(): string;
    /** The base MIME type of the output format. */
    abstract get mimeType(): string;
    /** Returns a list of media codecs that this output format can contain. */
    abstract getSupportedCodecs(): MediaCodec[];
    /** Returns the number of tracks that this output format supports. */
    abstract getSupportedTrackCounts(): TrackCountLimits;
    /** Whether this output format supports video rotation and flip metadata. */
    abstract get supportsVideoTransformationMetadata(): boolean;
    /**
     * Whether this output format supports video rotation metadata.
     * @deprecated Use {@link OutputFormat.supportsVideoTransformationMetadata} instead.
     */
    get supportsVideoRotationMetadata() {
        return this.supportsVideoTransformationMetadata;
    }
    /**
     * Whether this output format's tracks store timestamped media data. When `true`, the timestamps of added packets
     * will be respected, allowing things like gaps in media data or non-zero start times. When `false`, the format's
     * media data implicitly starts at zero and follows an implicit sequential timing from there, using the intrinsic
     * durations of the media data.
     */
    abstract get supportsTimestampedMediaData(): boolean;
    /**
     * The degree to which this output format supports writing media data with negative timestamps.
     * - `'full'` - Negative timestamps are fully supported.
     * - `'prefer-non-negative'` - Negative timestamps are technically supported, but their use is discouraged.
     * - `'none'` - Negative timestamps are not supported.
     * - `null` - Not applicable since the container doesn't support timestamped media at all.
     */
    abstract get negativeTimestampSupport(): 'full' | 'prefer-non-negative' | 'none' | null;
    /** Returns a list of video codecs that this output format can contain. */
    getSupportedVideoCodecs(): VideoCodec[] {
        return this.getSupportedCodecs()
            .filter(codec => (VIDEO_CODECS as readonly string[]).includes(codec)) as VideoCodec[];
    }
    /** Returns a list of audio codecs that this output format can contain. */
    getSupportedAudioCodecs(): AudioCodec[] {
        return this.getSupportedCodecs()
            .filter(codec => (AUDIO_CODECS as readonly string[]).includes(codec)) as AudioCodec[];
    }
    /** Returns a list of subtitle codecs that this output format can contain. */
    getSupportedSubtitleCodecs(): SubtitleCodec[] {
        return this.getSupportedCodecs()
            .filter(codec => (SUBTITLE_CODECS as readonly string[]).includes(codec)) as SubtitleCodec[];
    }
    /** @internal */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _codecUnsupportedHint(codec: MediaCodec) {
        return '';
    }
    /** @internal */
    _isFragmentedIsobmff() {
        return false;
    }
}
/** @internal Project patch: fixed-size sample descriptors with disk-backed queues and GOP sorting. */
export type IsobmffStoredSample = {
    timestamp: number;
    decodeTimestamp: number;
    duration: number;
    size: number;
    type: 'key' | 'delta';
    timescaleUnitsToNextSample: number;
    mediaOffset: number;
};
/** @internal Caller owns temporary files and disposal. All reads/writes are bounded pages. */
export type IsobmffSampleStore = {
    append: (trackId: number, sample: Omit<IsobmffStoredSample, 'mediaOffset'>, data: Uint8Array) => MaybePromise<number>;
    get: (trackId: number, id: number) => MaybePromise<IsobmffStoredSample>;
    set: (trackId: number, id: number, sample: IsobmffStoredSample) => MaybePromise<void>;
    sort: (trackId: number, start: number, count: number) => MaybePromise<void>;
    sorted: (trackId: number, index: number) => MaybePromise<number>;
    readMedia: (trackId: number, offset: number, length: number) => MaybePromise<Uint8Array>;
    release: (trackId: number, before: number) => MaybePromise<void>;
};
/** @internal Timing computed from every selected packet before writing moov. */
export type IsobmffTrackTiming = {
    decodeStart: number;
    presentationStart: number;
    presentationEnd: number;
};
/**
 * ISOBMFF-specific output options.
 * @group Output formats
 * @public
 */
export type IsobmffOutputFormatOptions = {
    /**
     * Controls the placement of metadata in the file. Placing metadata at the start of the file is known as "Fast
     * Start", which results in better playback at the cost of more required processing or memory.
     *
     * Use `false` to disable Fast Start, placing the metadata at the end of the file. Fastest and uses the least
     * memory.
     *
     * Use `'in-memory'` to produce a file with Fast Start by keeping all media chunks in memory until the file is
     * finalized. This produces a high-quality and compact output at the cost of a more expensive finalization step and
     * higher memory requirements. Data will be written monotonically (in order) when this option is set.
     *
     * Use `'reserve'` to reserve space at the start of the file into which the metadata will be written later.	This
     * produces a file with Fast Start but requires knowledge about the expected length of the file beforehand. When
     * using this option, you must set the {@link BaseTrackMetadata.maximumPacketCount} field in the track metadata
     * for all tracks.
     *
     * Use `'fragmented'` to place metadata at the start of the file by creating a fragmented file (fMP4). In a
     * fragmented file, chunks of media and their metadata are written to the file in "fragments", eliminating the need
     * to put all metadata in one place. Fragmented files are useful for streaming contexts, as each fragment can be
     * played individually without requiring knowledge of the other fragments. Furthermore, they remain lightweight to
     * create even for very large files, as they don't require all media to be kept in memory. However, fragmented files
     * are not as widely and wholly supported as regular MP4/MOV files. Data will be written monotonically (in order)
     * when this option is set.
     *
     * When this field is not defined, either `false` or `'in-memory'` will be used, automatically determined based on
     * the type of output target used.
     */
    fastStart?: false | 'in-memory' | 'reserve' | 'fragmented' | undefined;
    /**
     * @internal Project patch: append packed 28-byte v1 TFRA records as fragments
     * finish, and read them in bounded pages during finalization. The caller owns
     * store cleanup. Reads occur only after all appends have completed.
     */
    _fragmentIndexStore?: {
        append: (trackId: number, data: Uint8Array) => MaybePromise<void>;
        read: (trackId: number, offset: number, length: number) => MaybePromise<Uint8Array>;
    } | undefined;
    /**
     * @internal Project patch: spool current-fragment media before its moof is
     * known. Reads are at most 64 KiB; reset releases the completed track file.
     * Caller owns cleanup. Incompatible with whole-mdat callbacks.
     */
    _fragmentMediaStore?: {
        append: (trackId: number, data: Uint8Array) => MaybePromise<void>;
        read: (trackId: number, offset: number, length: number) => MaybePromise<Uint8Array>;
        reset: (trackId: number) => MaybePromise<void>;
    } | undefined;
    /** @internal Disk-backed GOP descriptors, sorting and interleave queues. */
    _fragmentSampleStore?: IsobmffSampleStore | undefined;
    /** @internal Complete preflight timing in seconds, keyed by output track ID. */
    _fragmentTrackTimings?: ReadonlyMap<number, IsobmffTrackTiming> | undefined;
    /**
     * When using `fastStart: 'fragmented'`, this field controls the minimum duration of each fragment, in seconds.
     * New fragments will only be created when the current fragment is longer than this value. Defaults to 1 second.
     */
    minimumFragmentDuration?: number | undefined;
    /**
     * The metadata format to use for writing metadata tags.
     *
     * - `'auto'` (default): Behaves like `'mdir'` for MP4 and like `'udta'` for QuickTime, matching FFmpeg's default
     * behavior.
     * - `'mdir'`: Write tags into `moov/udta/meta` using the 'mdir' handler format.
     * - `'mdta'`: Write tags into `moov/udta/meta` using the 'mdta' handler format, equivalent to FFmpeg's
     * `use_metadata_tags` flag. This allows for custom keys of arbitrary length.
     * - `'udta'`: Write tags directly into `moov/udta`.
     */
    metadataFormat?: 'auto' | 'mdir' | 'mdta' | 'udta' | undefined;
    /**
     * Will be called once the ftyp (File Type) box of the output file has been written.
     *
     * @param data - The raw bytes.
     * @param position - The byte offset of the data in the file.
     */
    onFtyp?: ((data: Uint8Array, position: number) => unknown) | undefined;
    /**
     * Will be called once the moov (Movie) box of the output file has been written.
     *
     * @param data - The raw bytes.
     * @param position - The byte offset of the data in the file.
     */
    onMoov?: ((data: Uint8Array, position: number) => unknown) | undefined;
    /**
     * Will be called for each finalized mdat (Media Data) box of the output file. Usage of this callback is not
     * recommended when not using `fastStart: 'fragmented'`, as there will be one monolithic mdat box which might
     * require large amounts of memory.
     *
     * @param data - The raw bytes.
     * @param position - The byte offset of the data in the file.
     */
    onMdat?: ((data: Uint8Array, position: number) => unknown) | undefined;
    /**
     * Will be called for each finalized moof (Movie Fragment) box of the output file.
     *
     * @param data - The raw bytes.
     * @param position - The byte offset of the data in the file.
     * @param timestamp - The start timestamp of the fragment in seconds.
     */
    onMoof?: ((data: Uint8Array, position: number, timestamp: number) => unknown) | undefined;
};
/**
 * Format representing files compatible with the ISO base media file format (ISOBMFF), like MP4 or MOV files.
 * @group Output formats
 * @public
 */
export abstract class IsobmffOutputFormat extends OutputFormat {
    /** @internal */
    _options: IsobmffOutputFormatOptions;
    /** Internal constructor. */
    constructor(options: IsobmffOutputFormatOptions = {}) {
        if (!options || typeof options !== 'object') {
            throw new TypeError('options must be an object.');
        }
        if (options.fastStart !== undefined
            && ![false, 'in-memory', 'reserve', 'fragmented'].includes(options.fastStart)) {
            throw new TypeError('options.fastStart, when provided, must be false, \'in-memory\', \'reserve\', or \'fragmented\'.');
        }
        if (options.minimumFragmentDuration !== undefined
            && (!isNumber(options.minimumFragmentDuration) || options.minimumFragmentDuration < 0)) {
            throw new TypeError('options.minimumFragmentDuration, when provided, must be a non-negative number.');
        }
        if (options._fragmentIndexStore !== undefined && (options.fastStart !== 'fragmented' || !options._fragmentIndexStore
            || typeof options._fragmentIndexStore.append !== 'function'
            || typeof options._fragmentIndexStore.read !== 'function')) {
            throw new TypeError('_fragmentIndexStore requires fragmented output and append/read functions.');
        }
        if (options._fragmentMediaStore !== undefined && (options.fastStart !== 'fragmented' || !options._fragmentMediaStore
            || typeof options._fragmentMediaStore.append !== 'function'
            || typeof options._fragmentMediaStore.read !== 'function'
            || typeof options._fragmentMediaStore.reset !== 'function'
            || options.onMdat !== undefined)) {
            throw new TypeError('_fragmentMediaStore requires fragmented output, append/read/reset functions and no onMdat.');
        }
        if (options._fragmentSampleStore !== undefined && (options.fastStart !== 'fragmented' || !options._fragmentIndexStore
            || options.onMoof !== undefined || options.onMdat !== undefined
            || !options._fragmentSampleStore
            || [options._fragmentSampleStore.append, options._fragmentSampleStore.get, options._fragmentSampleStore.set,
                options._fragmentSampleStore.sort, options._fragmentSampleStore.sorted,
                options._fragmentSampleStore.readMedia, options._fragmentSampleStore.release]
                .some(method => typeof method !== 'function'))) {
            throw new TypeError('_fragmentSampleStore requires fragmented output, an index store, its storage methods and no whole-fragment callbacks.');
        }
        if (options._fragmentTrackTimings !== undefined && (!options._fragmentSampleStore
            || !(options._fragmentTrackTimings instanceof Map)
            || [...options._fragmentTrackTimings].some(([id, timing]) => !Number.isInteger(id) || id < 1
                || !timing || !Number.isFinite(timing.decodeStart) || timing.decodeStart > 0
                || !Number.isFinite(timing.presentationStart) || timing.presentationStart < 0
                || !Number.isFinite(timing.presentationEnd) || timing.presentationEnd < timing.presentationStart))) {
            throw new TypeError('_fragmentTrackTimings requires a sample store and finite decode/presentation timing.');
        }
        if (options.onFtyp !== undefined && typeof options.onFtyp !== 'function') {
            throw new TypeError('options.onFtyp, when provided, must be a function.');
        }
        if (options.onMoov !== undefined && typeof options.onMoov !== 'function') {
            throw new TypeError('options.onMoov, when provided, must be a function.');
        }
        if (options.onMdat !== undefined && typeof options.onMdat !== 'function') {
            throw new TypeError('options.onMdat, when provided, must be a function.');
        }
        if (options.onMoof !== undefined && typeof options.onMoof !== 'function') {
            throw new TypeError('options.onMoof, when provided, must be a function.');
        }
        if (options.metadataFormat !== undefined
            && !['mdir', 'mdta', 'udta', 'auto'].includes(options.metadataFormat)) {
            throw new TypeError('options.metadataFormat, when provided, must be either \'auto\', \'mdir\', \'mdta\', or \'udta\'.');
        }
        super();
        this._options = options;
    }
    getSupportedTrackCounts(): TrackCountLimits {
        const max = 2 ** 32 - 1; // Have fun reaching this one
        return {
            video: { min: 0, max },
            audio: { min: 0, max },
            subtitle: { min: 0, max },
            total: { min: 0, max },
        };
    }
    get supportsVideoTransformationMetadata() {
        return true;
    }
    get supportsTimestampedMediaData() {
        return true;
    }
    get negativeTimestampSupport() {
        return 'full' as const;
    }
    /** @internal */
    _createMuxer(output: Output) {
        return new IsobmffMuxer(output, this);
    }
    /** @internal */
    override _isFragmentedIsobmff(): boolean {
        return this._options.fastStart === 'fragmented';
    }
}
/**
 * MPEG-4 Part 14 (MP4) file format. Supports most codecs.
 * @group Output formats
 * @public
 */
export class Mp4OutputFormat extends IsobmffOutputFormat {
    /** Creates a new {@link Mp4OutputFormat} configured with the specified `options`. */
    constructor(options?: IsobmffOutputFormatOptions) {
        super(options);
    }
    /** @internal */
    get _name() {
        return 'MP4';
    }
    get fileExtension() {
        return '.mp4';
    }
    get mimeType() {
        return 'video/mp4';
    }
    getSupportedCodecs(): MediaCodec[] {
        return [
            ...VIDEO_CODECS,
            ...NON_PCM_AUDIO_CODECS,
            // These are supported via ISO/IEC 23003-5:
            'pcm-s16',
            'pcm-s16be',
            'pcm-s24',
            'pcm-s24be',
            'pcm-s32',
            'pcm-s32be',
            'pcm-f32',
            'pcm-f32be',
            'pcm-f64',
            'pcm-f64be',
            ...SUBTITLE_CODECS,
        ];
    }
    /** @internal */
    override _codecUnsupportedHint(codec: MediaCodec) {
        if (new MovOutputFormat().getSupportedCodecs().includes(codec)) {
            return ' Switching to MOV will grant support for this codec.';
        }
        return '';
    }
}
/**
 * CMAF-specific output options.
 * @group Output formats
 * @public
 */
export type CmafOutputFormatOptions = Omit<IsobmffOutputFormatOptions, 'fastStart' | '_fragmentIndexStore' | '_fragmentMediaStore' | '_fragmentSampleStore' | '_fragmentTrackTimings'> & {
    /**
     * Controls the minimum duration of each fragment, in seconds. New fragments will only be created when the current
     * fragment is longer than this value. Defaults to `Infinity`, meaning the file will contain only one fragment.
     */
    minimumFragmentDuration?: number | undefined;
};
/**
 * Creates a single Common Media Application Format (CMAF) segment. An init segment will be written to the
 * {@link Target} specified in {@link OutputOptions.initTarget}. Supports most codecs.
 * @group Output formats
 * @public
 */
export class CmafOutputFormat extends IsobmffOutputFormat {
    /** Creates a new {@link CmafOutputFormat} configured with the specified `options`. */
    constructor(options?: CmafOutputFormatOptions) {
        super(options);
    }
    /** @internal */
    get _name() {
        return 'CMAF';
    }
    get fileExtension() {
        return '.m4s';
    }
    get mimeType() {
        return 'video/mp4';
    }
    getSupportedCodecs(): MediaCodec[] {
        return [
            ...VIDEO_CODECS,
            ...NON_PCM_AUDIO_CODECS,
            // These are supported via ISO/IEC 23003-5:
            'pcm-s16',
            'pcm-s16be',
            'pcm-s24',
            'pcm-s24be',
            'pcm-s32',
            'pcm-s32be',
            'pcm-f32',
            'pcm-f32be',
            'pcm-f64',
            'pcm-f64be',
            ...SUBTITLE_CODECS,
        ];
    }
}
/**
 * QuickTime File Format (QTFF), often called MOV. Supports all video and audio codecs, but not subtitle codecs.
 * @group Output formats
 * @public
 */
export class MovOutputFormat extends IsobmffOutputFormat {
    /** Creates a new {@link MovOutputFormat} configured with the specified `options`. */
    constructor(options?: IsobmffOutputFormatOptions) {
        super(options);
    }
    /** @internal */
    get _name() {
        return 'MOV';
    }
    get fileExtension() {
        return '.mov';
    }
    get mimeType() {
        return 'video/quicktime';
    }
    getSupportedCodecs(): MediaCodec[] {
        return [
            ...VIDEO_CODECS,
            ...AUDIO_CODECS,
        ];
    }
    /** @internal */
    override _codecUnsupportedHint(codec: MediaCodec) {
        if (new Mp4OutputFormat().getSupportedCodecs().includes(codec)) {
            return ' Switching to MP4 will grant support for this codec.';
        }
        return '';
    }
}
