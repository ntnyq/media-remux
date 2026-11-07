/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Subset migrated from patched Mediabunny 1.62.1; see THIRD_PARTY_NOTICES.md at the package root.
import { type TrackType } from '../output';
import { parseAacAudioSpecificConfig } from '../../shared/aac-misc';
import { type AacCodecInfo, type AudioCodec, DTS_FOURCCS, type DtsFourCc, extractAudioCodecString, extractColorSpace, extractVideoCodecString, type MediaCodec, OPUS_SAMPLE_RATE, parsePcmCodec, PCM_AUDIO_CODECS, type PcmAudioCodec, PRORES_FOURCCS, type ProresFourCc, type VideoCodec } from '../codec';
import { type Av1CodecInfo, av1CodecInfoHasColorInfo, type AvcDecoderConfigurationRecord, extractAv1CodecInfoFromPacket, extractProresCodecInfoFromPacket, extractVp9CodecInfoFromPacket, FlacBlockType, type HevcDecoderConfigurationRecord, type ProresCodecInfo, type Vp9CodecInfo, vp9CodecInfoHasColorInfo, parseEac3Config, getEac3SampleRate, getEac3ChannelCount, extractDtsFourCcFromPacket, parseDtsSpecificBox, DTS_SPECIFIC_BOX_SIZE, AC3_ACMOD_CHANNEL_COUNTS, extractAvcDecoderConfigurationRecord, extractHevcDecoderConfigurationRecord, deserializeAvcDecoderConfigurationRecord, deserializeHevcDecoderConfigurationRecord, HevcNalUnitType, parseAvcSps, parseHevcSps } from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input, InputDisposedError } from '../input';
import { type InputAudioTrackBacking, type InputTrackBacking, type InputVideoTrackBacking } from '../input-track';
import { type PacketRetrievalOptions } from '../media-sink';
import { assert, binarySearchLessOrEqual, bytesToHexString, COLOR_PRIMARIES_MAP_INVERSE, IDENTITY_MATRIX, isIso639Dash2LanguageCode, isThenable, MATRIX_COEFFICIENTS_MAP_INVERSE, multiplyMatrices, type Rational, textDecoder, type TransformationMatrix, TRANSFER_CHARACTERISTICS_MAP_INVERSE, UNDETERMINED_LANGUAGE, toDataView, roundIfAlmostInteger, hexStringToBytes, HEX_STRING_REGEX, EMPTY_COLOR_SPACE, colorSpaceIsComplete, simplifyRational } from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { buildIsobmffMimeType, parsePsshBoxContents, psshBoxesAreEqual, type PsshBox } from './isobmff-misc';
import { MAX_BOX_HEADER_SIZE, MIN_BOX_HEADER_SIZE, readBoxHeader, readDataBox, readFixed_16_16, readFixed_2_30, readEsDescriptor, readMetadataStringShort } from './isobmff-reader';
import { FileSlice, readBytes, readF64Be, readI16Be, readI32Be, readI64Be, Reader, readU16Be, readU24Be, readU32Be, readU64Be, readU8, readAscii } from '../reader';
import { DEFAULT_TRACK_DISPOSITION, type MetadataTags, RichImageData, type TrackDisposition } from '../metadata';
import { AC3_SAMPLE_RATES } from '../../shared/ac3-misc';
import { Bitstream } from '../../shared/bitstream';
import { Aes128CbcContext } from '../aes';
import { Logging } from '../logging';
type InternalTrack = {
    id: number;
    demuxer: IsobmffDemuxer;
    trackBacking: InputTrackBacking | null;
    disposition: TrackDisposition;
    timescale: number;
    durationInMovieTimescale: number;
    durationInMediaTimescale: number;
    matrix: TransformationMatrix;
    internalCodecId: string | null;
    name: string | null;
    languageCode: string;
    sampleTableByteOffset: number | null; // null when the track's sample table is another file (ominous ik 👀)
    sampleTable: SampleTable | null;
    fragmentLookupTable: FragmentLookupTable | null;
    currentFragmentState: FragmentTrackState | null;
    /** Bounded seek hints; evicted ranges are scanned again when needed. */
    fragmentDecodeCache: Map<number, {
        afterMoofOffset: number;
        endDecodeTimestamp: number;
    }>;
    fragmentPositionCache: {
        moofOffset: number;
        startTimestamp: number;
        endTimestamp: number;
        lastAccess: number;
    }[];
    /** The segment durations of all edit list entries leading up to the main one (from which the offset is taken.) */
    editListPreviousSegmentDurations: number;
    /** The media time offset of the main edit list entry (with media time !== -1) */
    editListOffset: number;
    /**
     * Original media edit: mediaTime uses track units, segmentDuration uses movie units.
     * Zero duration is open-ended.
     */
    editListMediaEdit: { mediaTime: number; segmentDuration: number } | null;
    /** Set when the track's samples are encrypted using a supported scheme (cenc/cens/cbcs), parsed from sinf/tenc. */
    encryptionInfo: TrackEncryptionInfo | null;
    /** For non-fragmented encrypted tracks: parsed saiz+saio from stbl; aux info is fetched lazily on first use. */
    encryptionAuxInfo: SampleEncryptionAuxInfo | null;
    frmaCodecString: string | null;
    /** In bits per second, from the btrt box if present. */
    maxBitrate: number | null;
    avgBitrate: number | null;
} & ({
    info: null;
} | {
    info: {
        type: 'video';
        width: number;
        height: number;
        squarePixelWidth: number;
        squarePixelHeight: number;
        /** Exact sample aspect ratio, independent of rounded square-pixel dimensions. */
        pixelAspectRatio: Rational;
        hasPixelAspectRatioBox: boolean;
        codec: VideoCodec | null;
        codecDescription: Uint8Array | null;
        colorSpace: VideoColorSpaceInit;
        avcType: 1 | 3 | null;
        avcCodecInfo: AvcDecoderConfigurationRecord | null;
        hevcCodecInfo: HevcDecoderConfigurationRecord | null;
        vp9CodecInfo: Vp9CodecInfo | null;
        av1CodecInfo: Av1CodecInfo | null;
        proresCodecInfo: ProresCodecInfo | null;
        proresFormat: ProresFourCc | null;
    };
} | {
    info: {
        type: 'audio';
        numberOfChannels: number;
        sampleRate: number;
        codec: AudioCodec | null;
        codecDescription: Uint8Array | null;
        aacCodecInfo: AacCodecInfo | null;
        dtsFormat: DtsFourCc | null;
        pcmLittleEndian: boolean;
        pcmSampleSize: number | null;
    };
});
type InternalVideoTrack = InternalTrack & {
    info: {
        type: 'video';
    };
};
type InternalAudioTrack = InternalTrack & {
    info: {
        type: 'audio';
    };
};
type FragmentTrackDefaults = {
    trackId: number;
    defaultSampleDescriptionIndex: number;
    defaultSampleDuration: number;
    defaultSampleSize: number;
    defaultSampleFlags: number;
};
type FragmentLookupTableEntry = {
    timestamp: number;
    moofOffset: number;
    trunNumber: number; // 1-indexed
    sampleNumber: number; // 1-indexed
};
type FragmentTrackState = {
    baseDataOffset: number;
    sampleDescriptionIndex: number | null;
    defaultSampleDuration: number | null;
    defaultSampleSize: number | null;
    defaultSampleFlags: number | null;
    startTimestamp: number | null;
    encryptionAuxInfo: SampleEncryptionAuxInfo | null;
};
type FragmentTrackData = {
    track: InternalTrack;
    // Kept as state for the presence of multiple trun boxes
    currentTimestamp: number;
    currentOffset: number;
    startTimestamp: number;
    endTimestamp: number;
    firstKeyFrameTimestamp: number | null;
    samples: FragmentSampleTable;
    startTimestampIsFinal: boolean;
    encryptionAuxInfo: SampleEncryptionAuxInfo | null;
};
type FragmentTrackSample = {
    presentationTimestamp: number;
    duration: number;
    byteOffset: number;
    byteSize: number;
    isKeyFrame: boolean;
    encryption: SampleEncryptionInfo | null;
};
type Fragment = {
    moofOffset: number;
    moofSize: number;
    implicitBaseDataOffset: number;
    trackData: Map<InternalTrack['id'], FragmentTrackData>;
    psshBoxes: PsshBox[];
};
type FragmentSummary = {
    moofSize: number;
    trackIds: Set<number>; // The tracks with samples in the fragment
};
type TrackEncryptionInfo = {
    scheme: 'cenc' | 'cens' | 'cbcs';
    defaultKid: string | null;
    defaultIsProtected: boolean | null;
    defaultPerSampleIvSize: number | null;
    defaultConstantIv: Uint8Array | null;
    defaultCryptByteBlock: number | null;
    defaultSkipByteBlock: number | null;
};
type SampleEncryptionInfo = {
    iv: Uint8Array;
    subsamples: {
        clearLen: number;
        protectedLen: number;
    }[] | null;
};
/**
 * Holds parsed saiz+saio state. The encryption info itself lives at a file offset and is fetched lazily.
 * For fragmented files this state is per-traf; for non-fragmented files it's per-track (on stbl).
 */
type SampleEncryptionAuxInfo = {
    defaultSampleInfoSize: number;
    sampleSizes: Uint8Array | null;
    sampleSizesOffset?: number | undefined;
    sampleCount: number;
    offset: number | null; // Absolute file offset of the first sample's aux info
    resolved: SampleEncryptionInfo[] | null;
};
// Anything beyond this is malicious
const MAX_BOX_NESTING_DEPTH = 64;
const MOVIE_LEAF_BOXES = new Set(['mdia', 'minf', 'dinf', 'mfra', 'edts', 'sinf', 'schi', 'mvhd', 'trak', 'tkhd', 'elst', 'mdhd', 'hdlr', 'stbl', 'stsd', 'frma', 'schm', 'tenc', 'avcC', 'hvcC', 'vpcC', 'av1C', 'colr', 'pasp', 'btrt', 'wave', 'esds', 'enda', 'pcmC', 'dOps', 'dfLa', 'dac3', 'dec3', 'ddts', 'stts', 'ctts', 'stsz', 'stz2', 'stss', 'stsc', 'stco', 'co64', 'mvex', 'mehd', 'trex', 'tfra', 'moof', 'traf', 'pssh', 'tfhd', 'tfdt', 'trun', 'saiz', 'saio', 'senc', 'udta', 'meta', 'keys', 'ilst']);
const MAX_FRAGMENT_CACHE_ENTRIES = 128;
const FRAGMENT_INDEX_PAGE_SIZE = 16 * 1024;
const MAX_FRAGMENT_INDEX_PAGES = 4;
export class IsobmffDemuxer extends Demuxer {
    reader: Reader;
    moovEnd: number | null = null;
    boxParserQueue: Promise<unknown> = Promise.resolve();
    sampleTablePromises = new WeakMap<InternalTrack, Promise<SampleTable>>();
    currentTrack: InternalTrack | null = null;
    private ignoredFragmentTrack: {
        state: FragmentTrackState;
        samples: FragmentSampleTable | null;
        time: number;
        offset: number;
    } | null = null;
    tracks: InternalTrack[] = [];
    idToTrack = new Map<number, InternalTrack>();
    metadataPromise: Promise<void> | null = null;
    movieTimescale = -1;
    movieDurationInTimescale = -1;
    movieMatrix = IDENTITY_MATRIX;
    isQuickTime = false;
    metadataTags: MetadataTags = {};
    currentMetadataKeys: Map<number, string> | null = null;
    isFragmented = false;
    fragmentTrackDefaults = new Map<number, FragmentTrackDefaults>();
    psshBoxes: PsshBox[] = [];
    currentFragment: Fragment | null = null;
    isReadingTraf = false;
    private trafStart = 0;
    private trafEnd = 0;
    /**
     * Caches the last fragment that was read. Based on the assumption that there will be multiple reads to the
     * same fragment in quick succession.
     */
    lastReadFragment: Fragment | null = null;
    fragmentCacheAccess = 0;
    fragmentSummaries = new Map<number, FragmentSummary>(); // At most 128 entries, keyed by moof offset
    decryptionKeyCache = new Map<string, Promise<Uint8Array>>();
    boxNestingDepth = 0;
    constructor(input: Input) {
        super(input);
        this.reader = input._reader;
    }
    override async getTrackBackings() {
        await this.readMetadata();
        return this.tracks.map(track => track.trackBacking!);
    }
    override async getMimeType() {
        await this.readMetadata();
        const backings = await this.getTrackBackings();
        const codecStrings = await Promise.all(backings.map(x => x.getDecoderConfig().then(c => c?.codec ?? null)));
        return buildIsobmffMimeType({
            isQuickTime: this.isQuickTime,
            hasVideo: this.tracks.some(x => x.info?.type === 'video'),
            hasAudio: this.tracks.some(x => x.info?.type === 'audio'),
            codecStrings: codecStrings.filter(Boolean) as string[],
        });
    }
    async getMetadataTags() {
        await this.readMetadata();
        return this.metadataTags;
    }
    /**
     * Reads a bounded top-level header, rejecting truncation instead of treating it as EOF.
     *
     * @param startPos - Absolute byte offset of the box header.
     * @returns The parsed header and its slice, or null at the physical end of the file.
     */
    async readTopLevelBox(startPos: number) {
        if (!Number.isSafeInteger(startPos) || startPos < 0) {
            throw new RangeError('Unsafe top-level box offset.');
        }
        const slice = await this.reader.requestSliceRange(startPos, MIN_BOX_HEADER_SIZE, MAX_BOX_HEADER_SIZE);
        const fileEnd = this.reader.fileSizeNonStrict;
        if (!slice) {
            if (fileEnd !== null && startPos !== fileEnd) {
                throw new RangeError('Truncated top-level box header.');
            }
            return null;
        }
        const boxInfo = readBoxHeader(slice, fileEnd);
        if (!boxInfo) {
            throw new RangeError('Invalid top-level box header.');
        }
        const end = startPos + boxInfo.totalSize;
        if (!Number.isSafeInteger(boxInfo.totalSize) || !Number.isSafeInteger(end)
            || (fileEnd !== null && end > fileEnd)) {
            throw new RangeError('Top-level box extends beyond the input or has an unsafe size.');
        }
        return { slice, boxInfo };
    }
    readMetadata() {
        return this.metadataPromise ??= (async () => {
            let currentPos = 0;
            let lookForMfraBox = false;
            let foundMovieBoxes = false;
            while (true) {
                const header = await this.readTopLevelBox(currentPos);
                if (!header)
                    break;
                const startPos = currentPos;
                const { slice, boxInfo } = header;
                if ((boxInfo.name === 'ftyp' || boxInfo.name === 'styp') && slice.remainingLength >= 4) {
                    const majorBrand = readAscii(slice, 4);
                    this.isQuickTime = majorBrand === 'qt  ';
                }
                else if (boxInfo.name === 'moov') {
                    // Keep file offsets, not the full moov buffer, for lazy sample-table reads.
                    this.moovEnd = startPos + boxInfo.totalSize;
                    if (!Number.isSafeInteger(this.moovEnd)
                        || (this.reader.fileSize !== null && this.moovEnd > this.reader.fileSize)) {
                        throw new RangeError('Invalid moov box extent.');
                    }
                    const range = new FileSlice(new Uint8Array(0), new DataView(new ArrayBuffer(0)), 0, slice.filePos, this.moovEnd);
                    await this.withBoxParser(() => this.readContiguousBoxes(range, true));
                    if (this.movieTimescale === -1) {
                        throw new Error('Invalid moov box: missing mvhd box.');
                    }
                    for (const track of this.tracks) {
                        // Modify the edit list offset based on the previous segment durations. They are in different
                        // timescales, so we first convert to seconds and then into the track timescale.
                        const previousSegmentDurationsInSeconds = track.editListPreviousSegmentDurations / this.movieTimescale;
                        track.editListOffset -= Math.round(previousSegmentDurationsInSeconds * track.timescale);
                    }
                    lookForMfraBox = this.isFragmented
                        && this.reader.fileSize !== null
                        && this.reader.fileSize > startPos + boxInfo.totalSize; // There's more after the moov box
                    foundMovieBoxes = true;
                    break;
                }
                else if (boxInfo.name === 'moof') {
                    if (!this.input._initInput) {
                        throw new Error('"moof" box encountered with no "moov" box present; this file is likely a Segment as'
                            + ' described in ISO/IEC 14496-12 Section 8.16. A separate init file that contains a "moov"'
                            + ' box is required to read this file, please provide it using InputOptions.initInput.');
                    }
                    await this.copyMetadataFromInitInput(this.input._initInput);
                    lookForMfraBox = false; // No point in doing it for segment files
                    foundMovieBoxes = true;
                    break;
                }
                currentPos = startPos + boxInfo.totalSize;
            }
            if (!foundMovieBoxes && this.input._initInput) {
                // A segment file is allowed to hold zero fragments, in which case there's no moof box to key off of.
                // It's still a perfectly valid segment, so let's take the tracks from the init input.
                await this.copyMetadataFromInitInput(this.input._initInput);
            }
            if (lookForMfraBox) {
                assert(this.reader.fileSize !== null);
                // The last 4 bytes may contain the size of the mfra box at the end of the file
                let lastWordSlice = this.reader.requestSlice(this.reader.fileSize - 4, 4);
                if (isThenable(lastWordSlice))
                    lastWordSlice = await lastWordSlice;
                assert(lastWordSlice);
                const lastWord = readU32Be(lastWordSlice);
                const potentialMfraPos = this.reader.fileSize - lastWord;
                if (potentialMfraPos >= 0 && potentialMfraPos <= this.reader.fileSize - MAX_BOX_HEADER_SIZE) {
                    let mfraHeaderSlice = this.reader.requestSliceRange(potentialMfraPos, MIN_BOX_HEADER_SIZE, MAX_BOX_HEADER_SIZE);
                    if (isThenable(mfraHeaderSlice))
                        mfraHeaderSlice = await mfraHeaderSlice;
                    if (mfraHeaderSlice) {
                        const boxInfo = readBoxHeader(mfraHeaderSlice);
                        if (boxInfo && boxInfo.name === 'mfra') {
                            const end = potentialMfraPos + boxInfo.totalSize;
                            if (!Number.isSafeInteger(end) || end !== this.reader.fileSize) {
                                throw new RangeError('Invalid mfra box extent.');
                            }
                            const range = new FileSlice(new Uint8Array(0), new DataView(new ArrayBuffer(0)), 0, mfraHeaderSlice.filePos, end);
                            await this.withBoxParser(() => this.readContiguousBoxes(range, true));
                        }
                    }
                }
            }
        })();
    }
    private async copyMetadataFromInitInput(initInput: Input) {
        const initDemuxer = (await initInput._getDemuxer()) as IsobmffDemuxer;
        if (initDemuxer.constructor !== IsobmffDemuxer) {
            throw new Error('Init input must match the input\'s format.');
        }
        await initDemuxer.readMetadata();
        this.movieTimescale = initDemuxer.movieTimescale;
        this.movieDurationInTimescale = initDemuxer.movieDurationInTimescale;
        this.movieMatrix = initDemuxer.movieMatrix;
        this.metadataTags = initDemuxer.metadataTags;
        this.isFragmented = true;
        this.fragmentTrackDefaults = initDemuxer.fragmentTrackDefaults;
        this.psshBoxes = initDemuxer.psshBoxes;
        // Create tracks from the init input's tracks
        for (const foreignTrack of initDemuxer.tracks) {
            const track: InternalTrack = {
                id: foreignTrack.id,
                demuxer: this,
                trackBacking: null,
                disposition: foreignTrack.disposition,
                timescale: foreignTrack.timescale,
                durationInMediaTimescale: foreignTrack.durationInMediaTimescale,
                durationInMovieTimescale: foreignTrack.durationInMovieTimescale,
                matrix: foreignTrack.matrix ?? null,
                internalCodecId: foreignTrack.internalCodecId,
                name: foreignTrack.name,
                languageCode: foreignTrack.languageCode,
                sampleTableByteOffset: null,
                sampleTable: null,
                fragmentLookupTable: null,
                currentFragmentState: null,
                fragmentPositionCache: [],
                fragmentDecodeCache: new Map(),
                editListPreviousSegmentDurations: foreignTrack.editListPreviousSegmentDurations,
                editListOffset: foreignTrack.editListOffset,
                editListMediaEdit: foreignTrack.editListMediaEdit,
                encryptionInfo: foreignTrack.encryptionInfo,
                encryptionAuxInfo: null,
                frmaCodecString: null,
                maxBitrate: foreignTrack.maxBitrate,
                avgBitrate: foreignTrack.avgBitrate,
                info: foreignTrack.info,
            };
            if (foreignTrack.trackBacking) {
                assert(track.info);
                if (track.info.type === 'video' && track.info.width !== -1) {
                    const videoTrack = track as InternalVideoTrack;
                    track.trackBacking = new IsobmffVideoTrackBacking(videoTrack);
                    this.tracks.push(track);
                    this.idToTrack.set(track.id, track);
                }
                else if (track.info.type === 'audio' && track.info.numberOfChannels !== -1) {
                    const audioTrack = track as InternalAudioTrack;
                    track.trackBacking = new IsobmffAudioTrackBacking(audioTrack);
                    this.tracks.push(track);
                    this.idToTrack.set(track.id, track);
                }
            }
            else {
                // The track didn't have enough info to warrant a backing
            }
        }
    }
    withBoxParser<T>(parse: () => Promise<T>): Promise<T> {
        // Traversal uses shared currentTrack/currentFragment state. Serialize async reads.
        const result = this.boxParserQueue.then(parse);
        this.boxParserQueue = result.catch(() => { });
        return result;
    }
    getSampleTableForTrack(internalTrack: InternalTrack): Promise<SampleTable> {
        const pending = this.sampleTablePromises.get(internalTrack);
        if (pending)
            return pending;
        const result = this.withBoxParser(() => this.readSampleTableForTrack(internalTrack)).catch((error) => {
            internalTrack.sampleTable = null;
            this.sampleTablePromises.delete(internalTrack);
            throw error;
        });
        this.sampleTablePromises.set(internalTrack, result);
        return result;
    }
    async readSampleTableForTrack(internalTrack: InternalTrack) {
        if (internalTrack.sampleTable) {
            return internalTrack.sampleTable;
        }
        const pcmFrameSize = internalTrack.info?.type === 'audio'
            && internalTrack.info.codec && (PCM_AUDIO_CODECS as readonly string[]).includes(internalTrack.info.codec)
            ? parsePcmCodec(internalTrack.info.codec as PcmAudioCodec).sampleSize * internalTrack.info.numberOfChannels
            : null;
        const sampleTable = new SampleTable(this.reader, pcmFrameSize);
        internalTrack.sampleTable = sampleTable;
        if (internalTrack.sampleTableByteOffset === null) {
            // There's no sample table to read, it's in another file (happens with segments)
            return sampleTable;
        }
        assert(this.moovEnd !== null);
        const stblContainerSlice = new FileSlice(new Uint8Array(0), new DataView(new ArrayBuffer(0)), 0, internalTrack.sampleTableByteOffset, this.moovEnd);
        this.currentTrack = internalTrack;
        try {
            await this.traverseBox(stblContainerSlice, true);
        }
        catch (error) {
            internalTrack.sampleTable = null;
            throw error;
        }
        finally {
            this.currentTrack = null;
        }
        await sampleTable.initialize();
        return sampleTable;
    }
    readFragment(startPos: number): Promise<Fragment | null> {
        // Parsing, timestamp recovery and cache publication share the parser lock.
        return this.withBoxParser(async () => {
            if (this.lastReadFragment?.moofOffset === startPos)
                return this.lastReadFragment;
            this.lastReadFragment = null;
            try {
                const fragment = await this.parseFragment(startPos);
                if (!fragment)
                    return null;
                for (const trackData of fragment.trackData.values()) {
                    if (!trackData.startTimestampIsFinal) {
                        const indexedOffset = await this.getFragmentTimestampOffset(fragment, trackData);
                        const offset = indexedOffset ?? await this.getDecodeTimeBefore(trackData.track, startPos);
                        offsetFragmentTrackDataByTimestamp(trackData, offset);
                        trackData.startTimestampIsFinal = true;
                    }
                    this.rememberFragmentTrack(fragment, trackData);
                    trackData.samples.aux = trackData.encryptionAuxInfo;
                }
                this.lastReadFragment = fragment;
                return fragment;
            }
            catch (error) {
                this.lastReadFragment = null;
                throw error;
            }
        });
    }
    private async parseFragment(startPos: number): Promise<Fragment | null> {
        const header = await this.readTopLevelBox(startPos);
        if (!header)
            return null;
        const box = header.boxInfo;
        if (box.name !== 'moof')
            throw new RangeError('Expected a moof box.');
        const end = startPos + box.totalSize;
        const slice = new FileSlice(new Uint8Array(0), new DataView(new ArrayBuffer(0)), 0, startPos, end);
        await this.traverseBox(slice, true);
        const fragment = this.lastReadFragment;
        this.lastReadFragment = null;
        assert(fragment && fragment.moofOffset === startPos);
        this.fragmentSummaries.delete(startPos);
        this.fragmentSummaries.set(startPos, { moofSize: fragment.moofSize,
            trackIds: new Set(fragment.trackData.keys()) });
        while (this.fragmentSummaries.size > MAX_FRAGMENT_CACHE_ENTRIES) {
            this.fragmentSummaries.delete(this.fragmentSummaries.keys().next().value!);
        }
        return fragment;
    }
    private async getFragmentTimestampOffset(fragment: Fragment, data: FragmentTrackData) {
        const entry = await data.track.fragmentLookupTable?.findOffset(fragment.moofOffset);
        if (!entry || entry.trunNumber < 1 || entry.sampleNumber < 1)
            return null;
        const index = await data.samples.referenceIndex(entry.trunNumber, entry.sampleNumber);
        return index < 0 ? null : entry.timestamp - (await data.samples.raw(index)).presentationTimestamp;
    }
    private rememberFragmentTrack(fragment: Fragment, data: FragmentTrackData) {
        const track = data.track;
        track.fragmentDecodeCache.delete(fragment.moofOffset);
        track.fragmentDecodeCache.set(fragment.moofOffset, {
            afterMoofOffset: fragment.moofOffset + fragment.moofSize,
            endDecodeTimestamp: data.currentTimestamp,
        });
        while (track.fragmentDecodeCache.size > MAX_FRAGMENT_CACHE_ENTRIES) {
            track.fragmentDecodeCache.delete(track.fragmentDecodeCache.keys().next().value!);
        }
        const cache = track.fragmentPositionCache;
        const existing = cache.find(entry => entry.moofOffset === fragment.moofOffset);
        if (existing) {
            existing.lastAccess = ++this.fragmentCacheAccess;
            return;
        }
        const index = binarySearchLessOrEqual(cache, data.startTimestamp, x => x.startTimestamp);
        if ((!cache[index] || cache[index]!.moofOffset < fragment.moofOffset)
            && (!cache[index + 1] || cache[index + 1]!.moofOffset > fragment.moofOffset)) {
            cache.splice(index + 1, 0, { moofOffset: fragment.moofOffset,
                startTimestamp: data.startTimestamp, endTimestamp: data.endTimestamp,
                lastAccess: ++this.fragmentCacheAccess });
            if (cache.length > MAX_FRAGMENT_CACHE_ENTRIES) {
                let oldest = 0;
                for (let i = 1; i < cache.length; i++) {
                    if (cache[i]!.lastAccess < cache[oldest]!.lastAccess)
                        oldest = i;
                }
                cache.splice(oldest, 1);
            }
        }
    }
    private async getDecodeTimeBefore(track: InternalTrack, targetOffset: number) {
        let position = this.moovEnd ?? 0;
        // A hybrid file's first fragment follows its ordinary sample table.
        // This runs under the parser lock, so initialize directly, not via its queue.
        const sampleTable = await this.readSampleTableForTrack(track);
        let timestamp = sampleTable.decodeDuration;
        let anchorOffset = -1;
        for (const [offset, anchor] of track.fragmentDecodeCache) {
            if (offset < targetOffset && offset > anchorOffset) {
                anchorOffset = offset;
                position = anchor.afterMoofOffset;
                timestamp = anchor.endDecodeTimestamp;
            }
        }
        const anchor = track.fragmentDecodeCache.get(anchorOffset);
        if (anchor) {
            track.fragmentDecodeCache.delete(anchorOffset);
            track.fragmentDecodeCache.set(anchorOffset, anchor);
        }
        // Missing tfdt needs a contiguous cumulative decode time, not the PTS end
        // of whichever cached fragment happens to precede the target. Rebuild from
        // a retained anchor or the file start when that range was evicted.
        while (position < targetOffset) {
            const header = await this.readTopLevelBox(position);
            if (!header)
                throw new RangeError('Truncated fragment timeline.');
            const box = header.boxInfo;
            if (position + box.totalSize > targetOffset)
                throw new RangeError('Invalid fragment timeline.');
            if (box.name === 'moof') {
                const fragment = await this.parseFragment(position);
                if (!fragment)
                    throw new RangeError('Truncated fragment timeline.');
                const data = fragment.trackData.get(track.id);
                if (data) {
                    if (!data.startTimestampIsFinal) {
                        const indexedOffset = await this.getFragmentTimestampOffset(fragment, data);
                        offsetFragmentTrackDataByTimestamp(data, indexedOffset ?? timestamp);
                        data.startTimestampIsFinal = true;
                    }
                    timestamp = data.currentTimestamp;
                    this.rememberFragmentTrack(fragment, data);
                }
            }
            position += box.totalSize;
        }
        return timestamp;
    }
    async readMovieSlice(start: number, end: number, maxLength = 64 * 1024) {
        const length = Math.min(maxLength, end - start);
        if (length <= 0)
            throw new RangeError('Truncated movie box payload.');
        const slice = await this.reader.requestSlice(start, length);
        if (!slice)
            throw new RangeError('Truncated movie box payload.');
        return slice;
    }
    async readContiguousBoxes(slice: FileSlice, fromFile = false) {
        if (this.boxNestingDepth === MAX_BOX_NESTING_DEPTH) {
            throw new Error('Invalid file: boxes are nested too deeply.');
        }
        const startIndex = slice.filePos;
        this.boxNestingDepth++;
        try {
            while (slice.filePos - startIndex <= slice.length - MIN_BOX_HEADER_SIZE) {
                const foundBox = await this.traverseBox(slice, fromFile);
                if (!foundBox) {
                    break;
                }
            }
        }
        finally {
            this.boxNestingDepth--;
        }
    }
    // eslint-disable-next-line @stylistic/generator-star-spacing
    *iterateContiguousBoxes(slice: FileSlice) {
        const startIndex = slice.filePos;
        while (slice.filePos - startIndex <= slice.length - MIN_BOX_HEADER_SIZE) {
            const startPos = slice.filePos;
            const boxInfo = readBoxHeader(slice);
            if (!boxInfo) {
                break;
            }
            yield { boxInfo, slice };
            slice.filePos = startPos + boxInfo.totalSize;
        }
    }
    async traverseBox(slice: FileSlice, fromFile = false): Promise<boolean> {
        const containerSlice = slice;
        const startPos = slice.filePos;
        let headerSlice = slice;
        if (fromFile) {
            const header = await this.reader.requestSliceRange(startPos, MIN_BOX_HEADER_SIZE, Math.min(MAX_BOX_HEADER_SIZE, slice.end - startPos));
            if (!header)
                throw new RangeError('Truncated movie box header.');
            headerSlice = header;
        }
        const boxInfo = readBoxHeader(headerSlice, this.reader.fileSizeNonStrict);
        if (!boxInfo)
            throw new RangeError('Invalid movie box header.');
        const contentStartPos = headerSlice.filePos;
        const boxEndPos = startPos + boxInfo.totalSize;
        if (!Number.isSafeInteger(boxEndPos) || boxEndPos > containerSlice.end) {
            throw new RangeError('Movie box extends beyond its container.');
        }
        if (fromFile) {
            const containers = ['mdia', 'minf', 'dinf', 'mfra', 'edts', 'sinf', 'schi', 'trak', 'stbl', 'mvex', 'moof', 'traf'];
            const tables = ['stts', 'ctts', 'stsz', 'stz2', 'stss', 'stsc', 'stco', 'co64'];
            if (containers.includes(boxInfo.name)) {
                slice.filePos = contentStartPos;
            }
            else if (boxInfo.name === 'tfra') {
                const table = await FragmentLookupTable.read(this.reader, contentStartPos, boxEndPos);
                const track = this.idToTrack.get(table.trackId);
                if (track) {
                    if (track.fragmentLookupTable)
                        throw new RangeError('Duplicate tfra track index.');
                    track.fragmentLookupTable = table;
                }
                containerSlice.filePos = boxEndPos;
                return true;
            }
            else if (tables.includes(boxInfo.name)) {
                if (this.currentTrack?.sampleTable) {
                    await this.currentTrack.sampleTable.addBox(boxInfo.name, contentStartPos, boxEndPos);
                }
                containerSlice.filePos = boxEndPos;
                return true;
            }
            else if (MOVIE_LEAF_BOXES.has(boxInfo.name)) {
                slice = await this.readMovieSlice(contentStartPos, boxEndPos, this.currentFragment ? ({ tfhd: 32, tfdt: 12, trun: 16, saiz: 17, saio: 24, senc: 8 }[boxInfo.name] ?? boxInfo.contentSize) : boxInfo.contentSize);
                fromFile = false; // Nested codec/metadata boxes are already buffered.
            }
            else {
                containerSlice.filePos = boxEndPos;
                return true; // Unknown/free boxes do not need a payload read.
            }
        }
        switch (boxInfo.name) {
            case 'mdia':
            case 'minf':
            case 'dinf':
            case 'mfra':
            case 'edts':
            case 'sinf':
            case 'schi':
                {
                    await this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize), fromFile);
                }
                ;
                break;
            case 'mvhd':
                {
                    const version = readU8(slice);
                    slice.skip(3); // Flags
                    if (version === 1) {
                        slice.skip(8 + 8);
                        this.movieTimescale = readU32Be(slice);
                        this.movieDurationInTimescale = readU64Be(slice);
                    }
                    else {
                        slice.skip(4 + 4);
                        this.movieTimescale = readU32Be(slice);
                        this.movieDurationInTimescale = readU32Be(slice);
                    }
                    if (this.movieTimescale === 0) {
                        throw new Error('Invalid mvhd box: timescale must not be 0.');
                    }
                    slice.skip(4 + 2 + 2 + 2 * 4); // Rate, volume, reserved
                    this.movieMatrix = readMatrix(slice);
                }
                ;
                break;
            case 'trak':
                {
                    if (this.currentFragment || this.currentTrack) {
                        break; // Misplaced
                    }
                    const track = {
                        id: -1,
                        demuxer: this,
                        trackBacking: null,
                        disposition: {
                            ...DEFAULT_TRACK_DISPOSITION,
                            primary: false,
                        },
                        info: null,
                        timescale: -1,
                        durationInMovieTimescale: -1,
                        durationInMediaTimescale: -1,
                        matrix: IDENTITY_MATRIX ?? null,
                        internalCodecId: null,
                        name: null,
                        languageCode: UNDETERMINED_LANGUAGE,
                        sampleTableByteOffset: -1,
                        sampleTable: null,
                        fragmentLookupTable: null,
                        currentFragmentState: null,
                        fragmentPositionCache: [],
                        fragmentDecodeCache: new Map(),
                        editListPreviousSegmentDurations: 0,
                        editListOffset: 0,
                        editListMediaEdit: null,
                        encryptionInfo: null,
                        encryptionAuxInfo: null,
                        frmaCodecString: null,
                        maxBitrate: null,
                        avgBitrate: null,
                    } satisfies InternalTrack as InternalTrack;
                    this.currentTrack = track;
                    await this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize), fromFile);
                    if (track.id !== -1
                        && track.timescale !== -1
                        && track.info !== null
                        && track.sampleTableByteOffset !== -1) {
                        if (track.info.type === 'video' && track.info.width !== -1) {
                            const videoTrack = track as InternalVideoTrack;
                            track.trackBacking = new IsobmffVideoTrackBacking(videoTrack);
                            this.tracks.push(track);
                            this.idToTrack.set(track.id, track);
                        }
                        else if (track.info.type === 'audio' && track.info.numberOfChannels !== -1) {
                            const audioTrack = track as InternalAudioTrack;
                            track.trackBacking = new IsobmffAudioTrackBacking(audioTrack);
                            this.tracks.push(track);
                            this.idToTrack.set(track.id, track);
                        }
                    }
                    this.currentTrack = null;
                }
                ;
                break;
            case 'tkhd':
                {
                    const track = this.currentTrack;
                    if (!track || this.currentFragment) {
                        break;
                    }
                    const version = readU8(slice);
                    const flags = readU24Be(slice);
                    // Spec says disabled tracks are to be treated like they don't exist, but in practice, they are treated
                    // more like non-default tracks.
                    const trackEnabled = !!(flags & 0x1);
                    track.disposition.default = trackEnabled;
                    // Skip over creation & modification time to reach the track ID
                    if (version === 0) {
                        slice.skip(8);
                        track.id = readU32Be(slice);
                        slice.skip(4);
                        track.durationInMovieTimescale = readU32Be(slice);
                    }
                    else if (version === 1) {
                        slice.skip(16);
                        track.id = readU32Be(slice);
                        slice.skip(4);
                        track.durationInMovieTimescale = readU64Be(slice);
                    }
                    else {
                        throw new Error(`Incorrect track header version ${version}.`);
                    }
                    slice.skip(2 * 4 + 2 + 2 + 2 + 2);
                    const trackMatrix = readMatrix(slice);
                    // The track matrix maps into movie space, and the movie matrix then maps into the final output space
                    track.matrix = multiplyMatrices(trackMatrix, this.movieMatrix);
                }
                ;
                break;
            case 'elst':
                {
                    const track = this.currentTrack;
                    if (!track) {
                        break;
                    }
                    const version = readU8(slice);
                    slice.skip(3); // Flags
                    let relevantEntryFound = false;
                    let previousSegmentDurations = 0;
                    const entryCount = readU32Be(slice);
                    for (let i = 0; i < entryCount; i++) {
                        const segmentDuration = version === 1
                            ? readU64Be(slice)
                            : readU32Be(slice);
                        const mediaTime = version === 1
                            ? readI64Be(slice)
                            : readI32Be(slice);
                        const mediaRate = readFixed_16_16(slice);
                        if (relevantEntryFound) {
                            throw new Error('Unsupported MP4 edit list: multiple edits after the first media edit.');
                        }
                        if (mediaTime === -1) {
                            previousSegmentDurations += segmentDuration;
                            continue;
                        }
                        if (mediaRate !== 1) {
                            throw new Error('Unsupported MP4 edit list entry: media rate must be 1.');
                        }
                        track.editListPreviousSegmentDurations = previousSegmentDurations;
                        track.editListOffset = mediaTime;
                        track.editListMediaEdit = { mediaTime, segmentDuration };
                        relevantEntryFound = true;
                    }
                    if (entryCount > 0 && !relevantEntryFound) {
                        throw new Error('Unsupported MP4 edit list: no media edit.');
                    }
                }
                ;
                break;
            case 'mdhd':
                {
                    const track = this.currentTrack;
                    if (!track) {
                        break;
                    }
                    const version = readU8(slice);
                    slice.skip(3); // Flags
                    if (version === 0) {
                        slice.skip(8);
                        track.timescale = readU32Be(slice);
                        track.durationInMediaTimescale = readU32Be(slice);
                    }
                    else if (version === 1) {
                        slice.skip(16);
                        track.timescale = readU32Be(slice);
                        track.durationInMediaTimescale = readU64Be(slice);
                    }
                    if (track.timescale === 0) {
                        throw new Error('Invalid mdhd box: timescale must not be 0.');
                    }
                    let language = readU16Be(slice);
                    if (language > 0) {
                        track.languageCode = '';
                        for (let i = 0; i < 3; i++) {
                            track.languageCode = String.fromCharCode(0x60 + (language & 0b11111)) + track.languageCode;
                            language >>= 5;
                        }
                        if (!isIso639Dash2LanguageCode(track.languageCode)) {
                            // Sometimes the bytes are garbage
                            track.languageCode = UNDETERMINED_LANGUAGE;
                        }
                    }
                }
                ;
                break;
            case 'hdlr':
                {
                    const track = this.currentTrack;
                    if (!track) {
                        break;
                    }
                    slice.skip(8); // Version + flags + pre-defined
                    const handlerType = readAscii(slice, 4);
                    if (handlerType === 'vide') {
                        track.info = {
                            type: 'video',
                            width: -1,
                            height: -1,
                            squarePixelWidth: -1,
                            squarePixelHeight: -1,
                            pixelAspectRatio: { num: 1, den: 1 },
                            hasPixelAspectRatioBox: false,
                            codec: null,
                            codecDescription: null,
                            colorSpace: { ...EMPTY_COLOR_SPACE },
                            avcType: null,
                            avcCodecInfo: null,
                            hevcCodecInfo: null,
                            vp9CodecInfo: null,
                            av1CodecInfo: null,
                            proresCodecInfo: null,
                            proresFormat: null,
                        };
                    }
                    else if (handlerType === 'soun') {
                        track.info = {
                            type: 'audio',
                            numberOfChannels: -1,
                            sampleRate: -1,
                            codec: null,
                            codecDescription: null,
                            aacCodecInfo: null,
                            dtsFormat: null,
                            pcmLittleEndian: false,
                            pcmSampleSize: null,
                        };
                    }
                }
                ;
                break;
            case 'stbl':
                {
                    const track = this.currentTrack;
                    if (!track) {
                        break;
                    }
                    track.sampleTableByteOffset = startPos;
                    await this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize), fromFile);
                }
                ;
                break;
            case 'stsd':
                {
                    const track = this.currentTrack;
                    if (!track) {
                        break;
                    }
                    if (track.info === null || track.sampleTable) {
                        break;
                    }
                    const stsdVersion = readU8(slice);
                    slice.skip(3); // Flags
                    const entries = readU32Be(slice);
                    // A remux track has one decoder configuration for its whole lifetime.
                    if (entries > 1) {
                        throw new Error('Multiple MP4 sample descriptions are unsupported.');
                    }
                    for (let i = 0; i < entries; i++) {
                        const sampleBoxStartPos = slice.filePos;
                        const sampleBoxInfo = readBoxHeader(slice);
                        if (!sampleBoxInfo) {
                            break;
                        }
                        track.internalCodecId = sampleBoxInfo.name;
                        const lowercaseBoxName = sampleBoxInfo.name.toLowerCase();
                        if (track.info.type === 'video') {
                            slice.skip(6 * 1 + 2 + 2 + 2 + 3 * 4);
                            track.info.width = readU16Be(slice);
                            track.info.height = readU16Be(slice);
                            track.info.squarePixelWidth = track.info.width;
                            track.info.squarePixelHeight = track.info.height;
                            slice.skip(4 + 4 + 4 + 2 + 32 + 2 + 2);
                            track.frmaCodecString = null;
                            await this.readContiguousBoxes(slice.slice(slice.filePos, (sampleBoxStartPos + sampleBoxInfo.totalSize) - slice.filePos));
                            const codecName = lowercaseBoxName === 'encv'
                                ? track.frmaCodecString
                                : lowercaseBoxName;
                            track.frmaCodecString = null;
                            if (codecName === 'avc1' || codecName === 'avc3') {
                                track.info.codec = 'avc';
                                track.info.avcType = codecName === 'avc1' ? 1 : 3;
                            }
                            else if (codecName === 'hvc1' || codecName === 'hev1') {
                                track.info.codec = 'hevc';
                            }
                            else if (codecName === 'vp08') {
                                track.info.codec = 'vp8';
                            }
                            else if (codecName === 'vp09') {
                                track.info.codec = 'vp9';
                            }
                            else if (codecName === 'av01') {
                                track.info.codec = 'av1';
                            }
                            else if ((PRORES_FOURCCS as readonly string[]).includes(lowercaseBoxName)) {
                                track.info.codec = 'prores';
                                track.info.proresFormat = lowercaseBoxName as ProresFourCc;
                            }
                            else if (codecName === null) {
                                Logging._warn(`Unknown encrypted video codec due to missing frma box.`);
                            }
                            else {
                                Logging._warn(`Unsupported video codec (sample entry type '${sampleBoxInfo.name}').`);
                            }
                        }
                        else {
                            slice.skip(6 * 1 + 2);
                            const version = readU16Be(slice);
                            slice.skip(3 * 2);
                            let channelCount = readU16Be(slice);
                            let sampleSize = readU16Be(slice);
                            slice.skip(2 * 2);
                            // Can't use fixed16_16 as that's signed
                            let sampleRate = readU32Be(slice) / 0x10000;
                            let lpcmFlags: number | null = null;
                            if (stsdVersion === 0 && version > 0) {
                                // Additional QuickTime fields
                                if (version === 1) {
                                    slice.skip(4);
                                    sampleSize = 8 * readU32Be(slice);
                                    slice.skip(2 * 4);
                                }
                                else if (version === 2) {
                                    slice.skip(4);
                                    sampleRate = readF64Be(slice);
                                    channelCount = readU32Be(slice);
                                    slice.skip(4); // Always 0x7f000000
                                    sampleSize = readU32Be(slice);
                                    lpcmFlags = readU32Be(slice);
                                    slice.skip(2 * 4);
                                }
                            }
                            track.info.numberOfChannels = channelCount;
                            track.info.sampleRate = sampleRate;
                            track.frmaCodecString = null;
                            await this.readContiguousBoxes(slice.slice(slice.filePos, (sampleBoxStartPos + sampleBoxInfo.totalSize) - slice.filePos));
                            const codecName = lowercaseBoxName === 'enca'
                                ? track.frmaCodecString
                                : lowercaseBoxName;
                            track.frmaCodecString = null;
                            // developer.apple.com/documentation/quicktime-file-format/sound_sample_descriptions/
                            if (codecName === 'mp4a') {
                                // The codec is set by the esds box
                            }
                            else if (codecName === 'opus') {
                                track.info.codec = 'opus';
                                track.info.sampleRate = OPUS_SAMPLE_RATE; // Always the same
                            }
                            else if (codecName === 'flac') {
                                track.info.codec = 'flac';
                            }
                            else if (codecName === 'ulaw') {
                                track.info.codec = 'ulaw';
                            }
                            else if (codecName === 'alaw') {
                                track.info.codec = 'alaw';
                            }
                            else if (codecName === 'ac-3') {
                                track.info.codec = 'ac3';
                            }
                            else if (codecName === 'ec-3') {
                                track.info.codec = 'eac3';
                            }
                            else if ((DTS_FOURCCS as readonly string[]).includes(codecName!)) {
                                track.info.codec = 'dts';
                                track.info.dtsFormat = codecName as DtsFourCc;
                            }
                            else if (codecName === 'twos') {
                                if (sampleSize === 8) {
                                    track.info.codec = 'pcm-s8';
                                }
                                else if (sampleSize === 16) {
                                    track.info.codec = track.info.pcmLittleEndian ? 'pcm-s16' : 'pcm-s16be';
                                }
                                else {
                                    Logging._warn(`Unsupported sample size ${sampleSize} for codec 'twos'.`);
                                    track.info.codec = null;
                                }
                            }
                            else if (codecName === 'sowt') {
                                if (sampleSize === 8) {
                                    track.info.codec = 'pcm-s8';
                                }
                                else if (sampleSize === 16) {
                                    track.info.codec = 'pcm-s16';
                                }
                                else {
                                    Logging._warn(`Unsupported sample size ${sampleSize} for codec 'sowt'.`);
                                    track.info.codec = null;
                                }
                            }
                            else if (codecName === 'raw ') {
                                track.info.codec = 'pcm-u8';
                            }
                            else if (codecName === 'in24') {
                                track.info.codec = track.info.pcmLittleEndian ? 'pcm-s24' : 'pcm-s24be';
                            }
                            else if (codecName === 'in32') {
                                track.info.codec = track.info.pcmLittleEndian ? 'pcm-s32' : 'pcm-s32be';
                            }
                            else if (codecName === 'fl32') {
                                track.info.codec = track.info.pcmLittleEndian ? 'pcm-f32' : 'pcm-f32be';
                            }
                            else if (codecName === 'fl64') {
                                track.info.codec = track.info.pcmLittleEndian ? 'pcm-f64' : 'pcm-f64be';
                            }
                            else if (codecName === 'ipcm') {
                                const pcmSampleSize = track.info.pcmSampleSize;
                                if (track.info.pcmLittleEndian) {
                                    if (pcmSampleSize === 16) {
                                        track.info.codec = 'pcm-s16';
                                    }
                                    else if (pcmSampleSize === 24) {
                                        track.info.codec = 'pcm-s24';
                                    }
                                    else if (pcmSampleSize === 32) {
                                        track.info.codec = 'pcm-s32';
                                    }
                                    else {
                                        Logging._warn(`Invalid ipcm sample size ${pcmSampleSize}.`);
                                        track.info.codec = null;
                                    }
                                }
                                else {
                                    if (pcmSampleSize === 16) {
                                        track.info.codec = 'pcm-s16be';
                                    }
                                    else if (pcmSampleSize === 24) {
                                        track.info.codec = 'pcm-s24be';
                                    }
                                    else if (pcmSampleSize === 32) {
                                        track.info.codec = 'pcm-s32be';
                                    }
                                    else {
                                        Logging._warn(`Invalid ipcm sample size ${pcmSampleSize}.`);
                                        track.info.codec = null;
                                    }
                                }
                            }
                            else if (codecName === 'fpcm') {
                                const pcmSampleSize = track.info.pcmSampleSize;
                                if (track.info.pcmLittleEndian) {
                                    if (pcmSampleSize === 32) {
                                        track.info.codec = 'pcm-f32';
                                    }
                                    else if (pcmSampleSize === 64) {
                                        track.info.codec = 'pcm-f64';
                                    }
                                    else {
                                        Logging._warn(`Invalid fpcm sample size ${pcmSampleSize}.`);
                                        track.info.codec = null;
                                    }
                                }
                                else {
                                    if (pcmSampleSize === 32) {
                                        track.info.codec = 'pcm-f32be';
                                    }
                                    else if (pcmSampleSize === 64) {
                                        track.info.codec = 'pcm-f64be';
                                    }
                                    else {
                                        Logging._warn(`Invalid fpcm sample size ${pcmSampleSize}.`);
                                        track.info.codec = null;
                                    }
                                }
                            }
                            else if (codecName === 'lpcm' && lpcmFlags !== null) {
                                const bytesPerSample = (sampleSize + 7) >> 3;
                                const isFloat = Boolean(lpcmFlags & 1);
                                const isBigEndian = Boolean(lpcmFlags & 2);
                                const sFlags = lpcmFlags & 4 ? -1 : 0; // I guess it means "signed flags" or something?
                                if (sampleSize > 0 && sampleSize <= 64) {
                                    if (isFloat) {
                                        if (sampleSize === 32) {
                                            track.info.codec = isBigEndian ? 'pcm-f32be' : 'pcm-f32';
                                        }
                                    }
                                    else {
                                        if (sFlags & (1 << (bytesPerSample - 1))) {
                                            if (bytesPerSample === 1) {
                                                track.info.codec = 'pcm-s8';
                                            }
                                            else if (bytesPerSample === 2) {
                                                track.info.codec = isBigEndian ? 'pcm-s16be' : 'pcm-s16';
                                            }
                                            else if (bytesPerSample === 3) {
                                                track.info.codec = isBigEndian ? 'pcm-s24be' : 'pcm-s24';
                                            }
                                            else if (bytesPerSample === 4) {
                                                track.info.codec = isBigEndian ? 'pcm-s32be' : 'pcm-s32';
                                            }
                                        }
                                        else {
                                            if (bytesPerSample === 1) {
                                                track.info.codec = 'pcm-u8';
                                            }
                                        }
                                    }
                                }
                                if (track.info.codec === null) {
                                    Logging._warn('Unsupported PCM format.');
                                }
                            }
                            else if (codecName === null) {
                                Logging._warn(`Unknown encrypted audio codec due to missing frma box.`);
                            }
                            else {
                                Logging._warn(`Unsupported audio codec (sample entry type '${sampleBoxInfo.name}').`);
                            }
                        }
                        slice.filePos = sampleBoxStartPos + sampleBoxInfo.totalSize;
                    }
                }
                ;
                break;
            case 'frma':
                {
                    const track = this.currentTrack;
                    if (!track) {
                        break;
                    }
                    const format = readAscii(slice, 4);
                    const lowercase = format.toLowerCase();
                    // Tells us what codec the encrypted track actually uses
                    track.frmaCodecString = lowercase;
                }
                ;
                break;
            case 'schm':
                {
                    const track = this.currentTrack;
                    if (!track) {
                        break;
                    }
                    slice.skip(4); // Version + flags
                    const schemeType = readAscii(slice, 4);
                    if (schemeType === 'cenc' || schemeType === 'cens' || schemeType === 'cbcs') {
                        track.encryptionInfo = {
                            scheme: schemeType,
                            defaultKid: null,
                            defaultIsProtected: null,
                            defaultPerSampleIvSize: null,
                            defaultConstantIv: null,
                            defaultCryptByteBlock: null,
                            defaultSkipByteBlock: null,
                        };
                    }
                    else {
                        Logging._warn(`Unsupported encryption scheme '${schemeType}'.`);
                    }
                }
                ;
                break;
            case 'tenc':
                {
                    const track = this.currentTrack;
                    if (!track || !track.encryptionInfo) {
                        break;
                    }
                    const version = readU8(slice);
                    slice.skip(3); // Flags
                    slice.skip(1); // Reserved
                    const patternByte = readU8(slice);
                    if (version > 0) {
                        track.encryptionInfo.defaultCryptByteBlock = patternByte >> 4;
                        track.encryptionInfo.defaultSkipByteBlock = patternByte & 0xf;
                    }
                    else {
                        track.encryptionInfo.defaultCryptByteBlock = 0;
                        track.encryptionInfo.defaultSkipByteBlock = 0;
                    }
                    track.encryptionInfo.defaultIsProtected = readU8(slice) !== 0;
                    track.encryptionInfo.defaultPerSampleIvSize = readU8(slice);
                    track.encryptionInfo.defaultKid = bytesToHexString(readBytes(slice, 16));
                    if (track.encryptionInfo.defaultPerSampleIvSize > 16) {
                        throw new Error('Invalid tenc box: IV size must not exceed 16 bytes.');
                    }
                    if (track.encryptionInfo.defaultIsProtected && track.encryptionInfo.defaultPerSampleIvSize === 0) {
                        const constantIvSize = readU8(slice);
                        if (constantIvSize > 16) {
                            throw new Error('Invalid tenc box: IV size must not exceed 16 bytes.');
                        }
                        const constantIv = new Uint8Array(16);
                        constantIv.set(readBytes(slice, constantIvSize), 0);
                        track.encryptionInfo.defaultConstantIv = constantIv;
                    }
                }
                ;
                break;
            case 'avcC':
                {
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'video') {
                        break;
                    }
                    if (boxInfo.contentSize === 0) {
                        // avcC box is empty, let's treat this like an Annex B stream
                        break;
                    }
                    track.info.codecDescription = readBytes(slice, boxInfo.contentSize);
                    const sps = deserializeAvcDecoderConfigurationRecord(track.info.codecDescription)
                        ?.sequenceParameterSets[0];
                    const spsInfo = sps && parseAvcSps(sps);
                    if (spsInfo && !track.info.hasPixelAspectRatioBox) {
                        applyPixelAspectRatio(track, spsInfo.pixelAspectRatio);
                    }
                }
                ;
                break;
            case 'hvcC':
                {
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'video') {
                        break;
                    }
                    if (boxInfo.contentSize === 0) {
                        // hvcC box is empty, let's treat this like an Annex B stream
                        break;
                    }
                    track.info.codecDescription = readBytes(slice, boxInfo.contentSize);
                    const sps = deserializeHevcDecoderConfigurationRecord(track.info.codecDescription)
                        ?.arrays.find(x => x.nalUnitType === HevcNalUnitType.SPS_NUT)?.nalUnits[0];
                    const spsInfo = sps && parseHevcSps(sps);
                    if (spsInfo && !track.info.hasPixelAspectRatioBox) {
                        applyPixelAspectRatio(track, spsInfo.pixelAspectRatio);
                    }
                }
                ;
                break;
            case 'vpcC':
                {
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'video') {
                        break;
                    }
                    slice.skip(4); // Version + flags
                    const profile = readU8(slice);
                    const level = readU8(slice);
                    const thirdByte = readU8(slice);
                    const bitDepth = thirdByte >> 4;
                    const chromaSubsampling = (thirdByte >> 1) & 0b111;
                    const videoFullRangeFlag = thirdByte & 1;
                    const colourPrimaries = readU8(slice);
                    const transferCharacteristics = readU8(slice);
                    const matrixCoefficients = readU8(slice);
                    track.info.vp9CodecInfo = {
                        profile,
                        level,
                        bitDepth,
                        chromaSubsampling,
                        videoFullRangeFlag,
                        colourPrimaries,
                        transferCharacteristics,
                        matrixCoefficients,
                    };
                }
                ;
                break;
            case 'av1C':
                {
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'video') {
                        break;
                    }
                    slice.skip(1); // Marker + version
                    const secondByte = readU8(slice);
                    const profile = secondByte >> 5;
                    const level = secondByte & 0b11111;
                    const thirdByte = readU8(slice);
                    const tier = thirdByte >> 7;
                    const highBitDepth = (thirdByte >> 6) & 1;
                    const twelveBit = (thirdByte >> 5) & 1;
                    const monochrome = (thirdByte >> 4) & 1;
                    const chromaSubsamplingX = (thirdByte >> 3) & 1;
                    const chromaSubsamplingY = (thirdByte >> 2) & 1;
                    const chromaSamplePosition = thirdByte & 0b11;
                    // Logic from https://aomediacodec.github.io/av1-spec/av1-spec.pdf
                    const bitDepth = profile === 2 && highBitDepth ? (twelveBit ? 12 : 10) : (highBitDepth ? 10 : 8);
                    slice.skip(1); // Reserved bits + initial presentation delay
                    // Parse config OBUs if there are any
                    const configObus = readBytes(slice, boxInfo.contentSize - 4);
                    const configObuInfo = extractAv1CodecInfoFromPacket(configObus);
                    track.info.av1CodecInfo = {
                        profile,
                        level,
                        tier,
                        bitDepth,
                        monochrome,
                        chromaSubsamplingX,
                        chromaSubsamplingY,
                        chromaSamplePosition,
                        videoFullRangeFlag: configObuInfo?.videoFullRangeFlag ?? 0,
                        colourPrimaries: configObuInfo?.colourPrimaries ?? 2,
                        transferCharacteristics: configObuInfo?.transferCharacteristics ?? 2,
                        matrixCoefficients: configObuInfo?.matrixCoefficients ?? 2,
                    };
                }
                ;
                break;
            case 'colr':
                {
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'video') {
                        break;
                    }
                    const colourType = readAscii(slice, 4);
                    if (colourType !== 'nclx' && colourType !== 'nclc') {
                        break;
                    }
                    const colourPrimaries = readU16Be(slice);
                    const transferCharacteristics = readU16Be(slice);
                    const matrixCoefficients = readU16Be(slice);
                    let fullRange: boolean | undefined = undefined;
                    if (colourType === 'nclx') {
                        fullRange = Boolean(readU8(slice) & 0x80);
                    }
                    track.info.colorSpace = {
                        primaries: COLOR_PRIMARIES_MAP_INVERSE[colourPrimaries] ?? null,
                        transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[transferCharacteristics] ?? null,
                        matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[matrixCoefficients] ?? null,
                        fullRange,
                    } as VideoColorSpaceInit;
                }
                ;
                break;
            case 'pasp':
                {
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'video') {
                        break;
                    }
                    const num = readU32Be(slice);
                    const den = readU32Be(slice);
                    // https://github.com/Vanilagy/mediabunny/issues/362
                    if (num > 0 && den > 0) {
                        // Explicit container signaling wins regardless of box order.
                        track.info.hasPixelAspectRatioBox = true;
                        applyPixelAspectRatio(track, { num, den });
                    }
                }
                ;
                break;
            case 'btrt':
                {
                    const track = this.currentTrack;
                    if (!track) {
                        break;
                    }
                    slice.skip(4); // Buffer size
                    const maxBitrate = readU32Be(slice);
                    const avgBitrate = readU32Be(slice);
                    track.maxBitrate = maxBitrate > 0 ? maxBitrate : null;
                    track.avgBitrate = avgBitrate > 0 ? avgBitrate : null;
                }
                ;
                break;
            case 'wave':
                {
                    await this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize), fromFile);
                }
                ;
                break;
            case 'esds':
                {
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'audio') {
                        break;
                    }
                    slice.skip(4); // Version + flags
                    const { objectTypeIndication, decoderSpecificInfo } = readEsDescriptor(slice);
                    if (objectTypeIndication === 0x40 || objectTypeIndication === 0x67) {
                        track.info.codec = 'aac';
                        track.info.aacCodecInfo = {
                            isMpeg2: objectTypeIndication === 0x67,
                            objectType: null,
                        };
                    }
                    else if (objectTypeIndication === 0x69 || objectTypeIndication === 0x6b) {
                        track.info.codec = 'mp3';
                    }
                    else if (objectTypeIndication === 0xdd) {
                        track.info.codec = 'vorbis'; // "nonstandard, gpac uses it" - FFmpeg
                    }
                    else if (objectTypeIndication === 0xa9) {
                        track.info.codec = 'dts';
                    }
                    else {
                        Logging._warn(`Unsupported audio codec (objectTypeIndication ${objectTypeIndication}) - discarding track.`);
                    }
                    if (decoderSpecificInfo) {
                        track.info.codecDescription = decoderSpecificInfo;
                        if (track.info.codec === 'aac') {
                            // Let's try to deduce more accurate values directly from the AudioSpecificConfig:
                            const audioSpecificConfig = parseAacAudioSpecificConfig(track.info.codecDescription);
                            if (audioSpecificConfig.outputNumberOfChannels !== null) {
                                track.info.numberOfChannels = audioSpecificConfig.outputNumberOfChannels;
                            }
                            if (audioSpecificConfig.outputSampleRate !== null) {
                                track.info.sampleRate = audioSpecificConfig.outputSampleRate;
                            }
                        }
                    }
                }
                ;
                break;
            case 'enda':
                {
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'audio') {
                        break;
                    }
                    track.info.pcmLittleEndian = !!(readU16Be(slice) & 0xff); // 0xff is from FFmpeg
                }
                ;
                break;
            case 'pcmC':
                {
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'audio') {
                        break;
                    }
                    slice.skip(1 + 3); // Version + flags
                    // ISO/IEC 23003-5
                    const formatFlags = readU8(slice);
                    track.info.pcmLittleEndian = Boolean(formatFlags & 0x01);
                    track.info.pcmSampleSize = readU8(slice);
                }
                ;
                break;
            case 'dOps':
                { // Used for Opus audio
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'audio') {
                        break;
                    }
                    slice.skip(1); // Version
                    // https://www.opus-codec.org/docs/opus_in_isobmff.html
                    const outputChannelCount = readU8(slice);
                    const preSkip = readU16Be(slice);
                    const inputSampleRate = readU32Be(slice);
                    const outputGain = readI16Be(slice);
                    const channelMappingFamily = readU8(slice);
                    let channelMappingTable: Uint8Array;
                    if (channelMappingFamily !== 0) {
                        channelMappingTable = readBytes(slice, 2 + outputChannelCount);
                    }
                    else {
                        channelMappingTable = new Uint8Array(0);
                    }
                    // https://datatracker.ietf.org/doc/html/draft-ietf-codec-oggopus-06
                    const description = new Uint8Array(8 + 1 + 1 + 2 + 4 + 2 + 1 + channelMappingTable.byteLength);
                    const view = new DataView(description.buffer);
                    view.setUint32(0, 0x4f707573, false); // 'Opus'
                    view.setUint32(4, 0x48656164, false); // 'Head'
                    view.setUint8(8, 1); // Version
                    view.setUint8(9, outputChannelCount);
                    view.setUint16(10, preSkip, true);
                    view.setUint32(12, inputSampleRate, true);
                    view.setInt16(16, outputGain, true);
                    view.setUint8(18, channelMappingFamily);
                    description.set(channelMappingTable, 19);
                    track.info.codecDescription = description;
                    track.info.numberOfChannels = outputChannelCount;
                    // Don't copy the input sample rate, irrelevant, and output sample rate is fixed
                }
                ;
                break;
            case 'dfLa':
                { // Used for FLAC audio
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'audio') {
                        break;
                    }
                    slice.skip(4); // Version + flags
                    // https://datatracker.ietf.org/doc/rfc9639/
                    const BLOCK_TYPE_MASK = 0x7f;
                    const LAST_METADATA_BLOCK_FLAG_MASK = 0x80;
                    const startPos = slice.filePos;
                    while (slice.filePos < boxEndPos) {
                        const flagAndType = readU8(slice);
                        const metadataBlockLength = readU24Be(slice);
                        const type = flagAndType & BLOCK_TYPE_MASK;
                        // It's a STREAMINFO block; let's extract the actual sample rate and channel count
                        if (type === FlacBlockType.STREAMINFO) {
                            slice.skip(10);
                            // Extract sample rate and channel count
                            const word = readU32Be(slice);
                            const sampleRate = word >>> 12;
                            const numberOfChannels = ((word >> 9) & 0b111) + 1;
                            track.info.sampleRate = sampleRate;
                            track.info.numberOfChannels = numberOfChannels;
                            slice.skip(20);
                        }
                        else {
                            // Simply skip ahead to the next block
                            slice.skip(metadataBlockLength);
                        }
                        if (flagAndType & LAST_METADATA_BLOCK_FLAG_MASK) {
                            break;
                        }
                    }
                    const endPos = slice.filePos;
                    slice.filePos = startPos;
                    const bytes = readBytes(slice, endPos - startPos);
                    const description = new Uint8Array(4 + bytes.byteLength);
                    const view = new DataView(description.buffer);
                    view.setUint32(0, 0x664c6143, false); // 'fLaC'
                    description.set(bytes, 4);
                    // Set the codec description to be 'fLaC' + all metadata blocks
                    track.info.codecDescription = description;
                }
                ;
                break;
            case 'dac3':
                { // AC3SpecificBox
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'audio') {
                        break;
                    }
                    const bytes = readBytes(slice, 3);
                    const bitstream = new Bitstream(bytes);
                    const fscod = bitstream.readBits(2);
                    bitstream.skipBits(5 + 3); // Skip bsid and bsmod
                    const acmod = bitstream.readBits(3);
                    const lfeon = bitstream.readBits(1);
                    if (fscod < 3) {
                        track.info.sampleRate = AC3_SAMPLE_RATES[fscod]!;
                    }
                    track.info.numberOfChannels = AC3_ACMOD_CHANNEL_COUNTS[acmod]! + lfeon;
                }
                ;
                break;
            case 'dec3':
                { // EC3SpecificBox
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'audio') {
                        break;
                    }
                    const bytes = readBytes(slice, boxInfo.contentSize);
                    const config = parseEac3Config(bytes);
                    if (!config) {
                        Logging._warn('Invalid dec3 box contents, ignoring.');
                        break;
                    }
                    const sampleRate = getEac3SampleRate(config);
                    if (sampleRate !== null) {
                        track.info.sampleRate = sampleRate;
                    }
                    track.info.numberOfChannels = getEac3ChannelCount(config);
                }
                ;
                break;
            case 'ddts':
                { // DTSSpecificBox
                    const track = this.currentTrack;
                    if (!track || track.info?.type !== 'audio') {
                        break;
                    }
                    const bytes = readBytes(slice, Math.min(boxInfo.contentSize, DTS_SPECIFIC_BOX_SIZE));
                    const config = parseDtsSpecificBox(bytes);
                    if (!config) {
                        Logging._warn('Invalid ddts box contents, ignoring.');
                        break;
                    }
                    track.info.sampleRate = config.sampleRate;
                    if (config.numberOfChannels !== null) {
                        track.info.numberOfChannels = config.numberOfChannels;
                    }
                }
                ;
                break;
            case 'mvex':
                {
                    this.isFragmented = true;
                    await this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize), fromFile);
                }
                ;
                break;
            case 'mehd':
                {
                    const version = readU8(slice);
                    slice.skip(3); // Flags
                    const fragmentDuration = version === 1 ? readU64Be(slice) : readU32Be(slice);
                    this.movieDurationInTimescale = fragmentDuration;
                }
                ;
                break;
            case 'trex':
                {
                    slice.skip(4); // Version + flags
                    const trackId = readU32Be(slice);
                    const defaultSampleDescriptionIndex = readU32Be(slice);
                    const defaultSampleDuration = readU32Be(slice);
                    const defaultSampleSize = readU32Be(slice);
                    const defaultSampleFlags = readU32Be(slice);
                    // We store these separately rather than in the tracks since the tracks may not exist yet
                    this.fragmentTrackDefaults.set(trackId, {
                        trackId,
                        defaultSampleDescriptionIndex,
                        defaultSampleDuration,
                        defaultSampleSize,
                        defaultSampleFlags,
                    });
                }
                ;
                break;
            case 'moof':
                {
                    if (this.currentFragment) {
                        break; // Nested moof boxes make no sense
                    }
                    this.currentFragment = {
                        moofOffset: startPos,
                        moofSize: boxInfo.totalSize,
                        implicitBaseDataOffset: startPos,
                        trackData: new Map(),
                        psshBoxes: [],
                    };
                    try {
                        await this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize), fromFile);
                        this.lastReadFragment = this.currentFragment;
                    }
                    finally {
                        this.currentFragment = null;
                        this.currentTrack = null;
                    }
                }
                ;
                break;
            case 'traf':
                {
                    if (!this.currentFragment || this.isReadingTraf) {
                        break;
                    }
                    this.isReadingTraf = true;
                    this.ignoredFragmentTrack = null;
                    this.trafStart = contentStartPos;
                    this.trafEnd = boxEndPos;
                    try {
                        await this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize), fromFile);
                    }
                    finally {
                        this.isReadingTraf = false;
                        this.ignoredFragmentTrack = null;
                    }
                    // It is possible that there is no current track, for example when we don't care about the track
                    // referenced in the track fragment header.
                    if (this.currentTrack) {
                        const trackData = this.currentFragment.trackData.get(this.currentTrack.id);
                        cond: if (trackData) {
                            if (trackData.samples.length === 0) {
                                // Don't associate the fragment with the track if it has no samples, this simplifies
                                // other code
                                this.currentFragment.trackData.delete(this.currentTrack.id);
                                break cond;
                            }
                            trackData.startTimestamp = trackData.samples.startTimestamp;
                            trackData.endTimestamp = trackData.samples.endTimestamp;
                            trackData.firstKeyFrameTimestamp = trackData.samples.firstKeyFrameTimestamp;
                            const { currentFragmentState } = this.currentTrack;
                            assert(currentFragmentState);
                            if (currentFragmentState.startTimestamp !== null) {
                                offsetFragmentTrackDataByTimestamp(trackData, currentFragmentState.startTimestamp);
                                trackData.startTimestampIsFinal = true;
                            }
                            // Transfer saiz+saio locations; sample retrieval resolves them on demand.
                            // Inline senc takes priority inside the paged table.
                            if (currentFragmentState.encryptionAuxInfo) {
                                trackData.encryptionAuxInfo = currentFragmentState.encryptionAuxInfo;
                            }
                        }
                        this.currentTrack.currentFragmentState = null;
                        this.currentTrack = null;
                    }
                }
                ;
                break;
            case 'pssh':
                {
                    if (this.input._formatOptions.isobmff?._suppressPsshParsing) {
                        break;
                    }
                    const psshBox = parsePsshBoxContents(readBytes(slice, boxInfo.contentSize));
                    if (this.currentFragment) {
                        this.currentFragment.psshBoxes.push(psshBox);
                    }
                    else if (!this.currentTrack) {
                        this.psshBoxes.push(psshBox);
                    }
                }
                ;
                break;
            case 'tfhd':
                {
                    // Only the first tfhd of a traf counts; anywhere else, there'd be no traf to finish the track data
                    if (!this.currentFragment || !this.isReadingTraf || this.currentTrack || this.ignoredFragmentTrack) {
                        break;
                    }
                    slice.skip(1); // Version
                    const flags = readU24Be(slice);
                    const baseDataOffsetPresent = Boolean(flags & 0x000001);
                    const sampleDescriptionIndexPresent = Boolean(flags & 0x000002);
                    const defaultSampleDurationPresent = Boolean(flags & 0x000008);
                    const defaultSampleSizePresent = Boolean(flags & 0x000010);
                    const defaultSampleFlagsPresent = Boolean(flags & 0x000020);
                    const durationIsEmpty = Boolean(flags & 0x010000);
                    const defaultBaseIsMoof = Boolean(flags & 0x020000);
                    const trackId = readU32Be(slice);
                    const track = this.idToTrack.get(trackId);
                    if (this.currentFragment.trackData.has(trackId)) {
                        throw new Error(`Unsupported MP4 fragment: multiple traf boxes for track ${trackId} in the same moof.`);
                    }
                    const defaults = this.fragmentTrackDefaults.get(trackId);
                    this.currentTrack = track ?? null;
                    const state: FragmentTrackState = {
                        baseDataOffset: this.currentFragment.implicitBaseDataOffset,
                        sampleDescriptionIndex: defaults?.defaultSampleDescriptionIndex ?? null,
                        defaultSampleDuration: defaults?.defaultSampleDuration ?? null,
                        defaultSampleSize: defaults?.defaultSampleSize ?? null,
                        defaultSampleFlags: defaults?.defaultSampleFlags ?? null,
                        startTimestamp: null,
                        encryptionAuxInfo: null,
                    };
                    if (baseDataOffsetPresent) {
                        state.baseDataOffset = readU64Be(slice);
                    }
                    else if (defaultBaseIsMoof) {
                        state.baseDataOffset = this.currentFragment.moofOffset;
                    }
                    if (sampleDescriptionIndexPresent) {
                        state.sampleDescriptionIndex = readU32Be(slice);
                    }
                    if (defaultSampleDurationPresent) {
                        state.defaultSampleDuration = readU32Be(slice);
                    }
                    if (defaultSampleSizePresent) {
                        state.defaultSampleSize = readU32Be(slice);
                    }
                    if (defaultSampleFlagsPresent) {
                        state.defaultSampleFlags = readU32Be(slice);
                    }
                    if (durationIsEmpty) {
                        state.defaultSampleDuration = 0;
                    }
                    if (track)
                        track.currentFragmentState = state;
                    else
                        this.ignoredFragmentTrack = { state, samples: null, time: 0, offset: state.baseDataOffset };
                }
                ;
                break;
            case 'tfdt':
                {
                    const track = this.currentTrack;
                    if (!track?.currentFragmentState) {
                        break;
                    }
                    const version = readU8(slice);
                    slice.skip(3); // Flags
                    const baseMediaDecodeTime = version === 0 ? readU32Be(slice) : readU64Be(slice);
                    track.currentFragmentState.startTimestamp = baseMediaDecodeTime;
                }
                ;
                break;
            case 'trun':
                {
                    const ignored = this.ignoredFragmentTrack;
                    if (ignored && this.currentFragment) {
                        // Unsupported tracks still determine the implicit base of the next traf.
                        // Reuse the bounded table scanner; no ignored payload is loaded or exposed.
                        ignored.samples ??= new FragmentSampleTable(this.reader, null, this.trafStart,
                            this.trafEnd, ignored.state.baseDataOffset, ignored.state);
                        const result = await ignored.samples.addRun(startPos, ignored.time, ignored.offset);
                        ignored.time = result.time;
                        ignored.offset = result.offset;
                        this.currentFragment.implicitBaseDataOffset = result.offset;
                        break;
                    }
                    const track = this.currentTrack;
                    if (!track?.currentFragmentState || !this.currentFragment)
                        break;
                    let data = this.currentFragment.trackData.get(track.id);
                    if (!data) {
                        data = { track, currentTimestamp: 0, currentOffset: track.currentFragmentState.baseDataOffset,
                            startTimestamp: 0, endTimestamp: 0, firstKeyFrameTimestamp: null,
                            samples: new FragmentSampleTable(this.reader, track, this.trafStart, this.trafEnd, track.currentFragmentState.baseDataOffset, { ...track.currentFragmentState }),
                            startTimestampIsFinal: false, encryptionAuxInfo: null };
                        this.currentFragment.trackData.set(track.id, data);
                    }
                    const result = await data.samples.addRun(startPos, data.currentTimestamp, data.currentOffset);
                    data.currentTimestamp = result.time;
                    data.currentOffset = result.offset;
                    this.currentFragment.implicitBaseDataOffset = result.offset;
                }
                ;
                break;
            case 'saiz':
                {
                    // Sample Auxiliary Information Sizes - per-sample sizes of (typically) the encryption aux info.
                    const track = this.currentTrack;
                    if (!track || !track.encryptionInfo) {
                        break;
                    }
                    slice.skip(1); // Version
                    const flags = readU24Be(slice);
                    if (flags & 0x01) {
                        const auxInfoType = readAscii(slice, 4);
                        const auxInfoTypeParam = readU32Be(slice);
                        if (auxInfoType !== track.encryptionInfo.scheme || auxInfoTypeParam !== 0) {
                            // Not the encryption aux info
                            break;
                        }
                    }
                    const defaultSampleInfoSize = readU8(slice);
                    const sampleCount = readU32Be(slice);
                    let sampleSizes: Uint8Array | null = null;
                    let sampleSizesOffset: number | undefined;
                    if (defaultSampleInfoSize === 0 && sampleCount > 0) {
                        if (sampleCount > boxEndPos - slice.filePos)
                            throw new RangeError('Truncated saiz samples.');
                        if (this.currentFragment)
                            sampleSizesOffset = slice.filePos;
                        else
                            sampleSizes = readBytes(slice, sampleCount);
                    }
                    const aux = getOrCreateEncryptionAuxInfo(track);
                    aux.defaultSampleInfoSize = defaultSampleInfoSize;
                    aux.sampleSizes = sampleSizes;
                    aux.sampleSizesOffset = sampleSizesOffset;
                    aux.sampleCount = sampleCount;
                }
                ;
                break;
            case 'saio':
                {
                    // Sample Auxiliary Information Offsets - file offset(s) where the aux info lives.
                    const track = this.currentTrack;
                    if (!track || !track.encryptionInfo) {
                        break;
                    }
                    const version = readU8(slice);
                    const flags = readU24Be(slice);
                    if (flags & 0x01) {
                        const auxInfoType = readAscii(slice, 4);
                        const auxInfoTypeParam = readU32Be(slice);
                        if (auxInfoType !== track.encryptionInfo.scheme || auxInfoTypeParam !== 0) {
                            break;
                        }
                    }
                    const entryCount = readU32Be(slice);
                    if (entryCount === 0) {
                        break;
                    }
                    if (entryCount > 1) {
                        Logging._warn('Multiple saio entries are not supported; using the first offset only.');
                    }
                    let offset = version === 0 ? readU32Be(slice) : Number(readU64Be(slice));
                    // Per ISO/IEC 23001-7: when saio is inside a moof, offsets are relative to the start of the moof box.
                    if (this.currentFragment) {
                        offset += this.currentFragment.moofOffset;
                    }
                    const aux = getOrCreateEncryptionAuxInfo(track);
                    aux.offset = offset;
                }
                ;
                break;
            case 'senc':
                {
                    // Per-sample encryption info inside a 'traf'. Holds per-sample IV and optional subsample breakdown
                    // for CENC-protected samples
                    const track = this.currentTrack;
                    if (!track || !track.encryptionInfo) {
                        break;
                    }
                    const trackData = this.currentFragment?.trackData.get(track.id);
                    if (!trackData) {
                        break;
                    }
                    slice.skip(1); // Version
                    const flags = readU24Be(slice);
                    const useSubsamples = Boolean(flags & 0x000002);
                    const sampleCount = readU32Be(slice);
                    const ivSize = track.encryptionInfo.defaultPerSampleIvSize;
                    if (ivSize === null) {
                        throw new Error('Invalid file: encrypted track is missing its tenc box.');
                    }
                    trackData.samples.setSenc(slice.filePos, boxEndPos, sampleCount, useSubsamples);
                }
                ;
                break;
            // Metadata section
            // https://exiftool.org/TagNames/QuickTime.html
            // https://mp4workshop.com/about
            case 'udta':
                { // Contains either movie metadata or track metadata
                    const iterator = this.iterateContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
                    for (const { boxInfo, slice } of iterator) {
                        if (boxInfo.name !== 'meta' && !this.currentTrack) {
                            const startPos = slice.filePos;
                            this.metadataTags.raw ??= {};
                            if (boxInfo.name[0] === '©') {
                                // https://mp4workshop.com/about
                                // Box name starting with © indicates "international text"
                                this.metadataTags.raw[boxInfo.name] ??= readMetadataStringShort(slice);
                            }
                            else {
                                this.metadataTags.raw[boxInfo.name] ??= readBytes(slice, boxInfo.contentSize);
                            }
                            slice.filePos = startPos;
                        }
                        switch (boxInfo.name) {
                            case 'meta':
                                {
                                    slice.skip(-boxInfo.headerSize);
                                    await this.traverseBox(slice);
                                }
                                ;
                                break;
                            case '©nam':
                            case 'name':
                                {
                                    if (this.currentTrack) {
                                        this.currentTrack.name = textDecoder.decode(readBytes(slice, boxInfo.contentSize));
                                    }
                                    else {
                                        this.metadataTags.title ??= readMetadataStringShort(slice);
                                    }
                                }
                                ;
                                break;
                            case '©des':
                                {
                                    if (!this.currentTrack) {
                                        this.metadataTags.description ??= readMetadataStringShort(slice);
                                    }
                                }
                                ;
                                break;
                            case '©ART':
                                {
                                    if (!this.currentTrack) {
                                        this.metadataTags.artist ??= readMetadataStringShort(slice);
                                    }
                                }
                                ;
                                break;
                            case '©alb':
                                {
                                    if (!this.currentTrack) {
                                        this.metadataTags.album ??= readMetadataStringShort(slice);
                                    }
                                }
                                ;
                                break;
                            case 'albr':
                                {
                                    if (!this.currentTrack) {
                                        this.metadataTags.albumArtist ??= readMetadataStringShort(slice);
                                    }
                                }
                                ;
                                break;
                            case '©gen':
                                {
                                    if (!this.currentTrack) {
                                        this.metadataTags.genre ??= readMetadataStringShort(slice);
                                    }
                                }
                                ;
                                break;
                            case '©day':
                                {
                                    if (!this.currentTrack) {
                                        const date = new Date(readMetadataStringShort(slice));
                                        if (!Number.isNaN(date.getTime())) {
                                            this.metadataTags.date ??= date;
                                        }
                                    }
                                }
                                ;
                                break;
                            case '©cmt':
                                {
                                    if (!this.currentTrack) {
                                        this.metadataTags.comment ??= readMetadataStringShort(slice);
                                    }
                                }
                                ;
                                break;
                            case '©lyr':
                                {
                                    if (!this.currentTrack) {
                                        this.metadataTags.lyrics ??= readMetadataStringShort(slice);
                                    }
                                }
                                ;
                                break;
                        }
                    }
                }
                ;
                break;
            case 'meta':
                {
                    if (this.currentTrack) {
                        break; // Only care about movie-level metadata for now
                    }
                    // The 'meta' box comes in two flavors, one with flags/version and one without. To know which is which,
                    // let's read the next 4 bytes, which are either the version or the size of the first subbox.
                    const word = readU32Be(slice);
                    const isQuickTime = word !== 0;
                    this.currentMetadataKeys = new Map();
                    if (isQuickTime) {
                        await this.readContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize), fromFile);
                    }
                    else {
                        await this.readContiguousBoxes(slice.slice(contentStartPos + 4, boxInfo.contentSize - 4), fromFile);
                    }
                    this.currentMetadataKeys = null;
                }
                ;
                break;
            case 'keys':
                {
                    if (!this.currentMetadataKeys) {
                        break;
                    }
                    slice.skip(4); // Version + flags
                    const entryCount = readU32Be(slice);
                    for (let i = 0; i < entryCount; i++) {
                        const keySize = readU32Be(slice);
                        if (keySize < 8) {
                            throw new Error('Invalid keys box: key size must be at least 8.');
                        }
                        slice.skip(4); // Key namespace
                        const keyName = textDecoder.decode(readBytes(slice, keySize - 8));
                        this.currentMetadataKeys.set(i + 1, keyName);
                    }
                }
                ;
                break;
            case 'ilst':
                {
                    if (!this.currentMetadataKeys) {
                        break;
                    }
                    const iterator = this.iterateContiguousBoxes(slice.slice(contentStartPos, boxInfo.contentSize));
                    for (const { boxInfo, slice } of iterator) {
                        let metadataKey = boxInfo.name;
                        // Interpret the box name as a u32be
                        const nameAsNumber = (metadataKey.charCodeAt(0) << 24)
                            + (metadataKey.charCodeAt(1) << 16)
                            + (metadataKey.charCodeAt(2) << 8)
                            + metadataKey.charCodeAt(3);
                        if (this.currentMetadataKeys.has(nameAsNumber)) {
                            // An entry exists for this number
                            metadataKey = this.currentMetadataKeys.get(nameAsNumber)!;
                        }
                        const data = readDataBox(slice);
                        this.metadataTags.raw ??= {};
                        this.metadataTags.raw[metadataKey] ??= data;
                        switch (metadataKey) {
                            case '©nam':
                            case 'titl':
                            case 'com.apple.quicktime.title':
                            case 'title':
                                {
                                    if (typeof data === 'string') {
                                        this.metadataTags.title ??= data;
                                    }
                                }
                                ;
                                break;
                            case '©des':
                            case 'desc':
                            case 'dscp':
                            case 'com.apple.quicktime.description':
                            case 'description':
                                {
                                    if (typeof data === 'string') {
                                        this.metadataTags.description ??= data;
                                    }
                                }
                                ;
                                break;
                            case '©ART':
                            case 'com.apple.quicktime.artist':
                            case 'artist':
                                {
                                    if (typeof data === 'string') {
                                        this.metadataTags.artist ??= data;
                                    }
                                }
                                ;
                                break;
                            case '©alb':
                            case 'albm':
                            case 'com.apple.quicktime.album':
                            case 'album':
                                {
                                    if (typeof data === 'string') {
                                        this.metadataTags.album ??= data;
                                    }
                                }
                                ;
                                break;
                            case 'aART':
                            case 'album_artist':
                                {
                                    if (typeof data === 'string') {
                                        this.metadataTags.albumArtist ??= data;
                                    }
                                }
                                ;
                                break;
                            case '©cmt':
                            case 'com.apple.quicktime.comment':
                            case 'comment':
                                {
                                    if (typeof data === 'string') {
                                        this.metadataTags.comment ??= data;
                                    }
                                }
                                ;
                                break;
                            case '©gen':
                            case 'gnre':
                            case 'com.apple.quicktime.genre':
                            case 'genre':
                                {
                                    if (typeof data === 'string') {
                                        this.metadataTags.genre ??= data;
                                    }
                                }
                                ;
                                break;
                            case '©lyr':
                            case 'lyrics':
                                {
                                    if (typeof data === 'string') {
                                        this.metadataTags.lyrics ??= data;
                                    }
                                }
                                ;
                                break;
                            case '©day':
                            case 'rldt':
                            case 'com.apple.quicktime.creationdate':
                            case 'date':
                                {
                                    if (typeof data === 'string') {
                                        const date = new Date(data);
                                        if (!Number.isNaN(date.getTime())) {
                                            this.metadataTags.date ??= date;
                                        }
                                    }
                                }
                                ;
                                break;
                            case 'tmpo':
                                {
                                    if (data instanceof Uint8Array && data.length >= 2) {
                                        const bpm = toDataView(data).getInt16(0, false);
                                        if (bpm > 0) {
                                            this.metadataTags.beatsPerMinute ??= bpm;
                                        }
                                    }
                                }
                                ;
                                break;
                            case 'covr':
                            case 'com.apple.quicktime.artwork':
                                {
                                    if (data instanceof RichImageData) {
                                        this.metadataTags.images ??= [];
                                        this.metadataTags.images.push({
                                            data: data.data,
                                            kind: 'coverFront',
                                            mimeType: data.mimeType,
                                        });
                                    }
                                    else if (data instanceof Uint8Array) {
                                        this.metadataTags.images ??= [];
                                        this.metadataTags.images.push({
                                            data,
                                            kind: 'coverFront',
                                            mimeType: 'image/*',
                                        });
                                    }
                                }
                                ;
                                break;
                            case 'track':
                                {
                                    if (typeof data === 'string') {
                                        const parts = data.split('/');
                                        const trackNum = Number.parseInt(parts[0]!, 10);
                                        const tracksTotal = parts[1] && Number.parseInt(parts[1], 10);
                                        if (Number.isInteger(trackNum) && trackNum > 0) {
                                            this.metadataTags.trackNumber ??= trackNum;
                                        }
                                        if (tracksTotal && Number.isInteger(tracksTotal) && tracksTotal > 0) {
                                            this.metadataTags.tracksTotal ??= tracksTotal;
                                        }
                                    }
                                }
                                ;
                                break;
                            case 'trkn':
                                {
                                    if (data instanceof Uint8Array && data.length >= 6) {
                                        const view = toDataView(data);
                                        const trackNumber = view.getUint16(2, false);
                                        const tracksTotal = view.getUint16(4, false);
                                        if (trackNumber > 0) {
                                            this.metadataTags.trackNumber ??= trackNumber;
                                        }
                                        if (tracksTotal > 0) {
                                            this.metadataTags.tracksTotal ??= tracksTotal;
                                        }
                                    }
                                }
                                ;
                                break;
                            case 'disc':
                            case 'disk':
                                {
                                    if (data instanceof Uint8Array && data.length >= 6) {
                                        const view = toDataView(data);
                                        const discNumber = view.getUint16(2, false);
                                        const discNumberMax = view.getUint16(4, false);
                                        if (discNumber > 0) {
                                            this.metadataTags.discNumber ??= discNumber;
                                        }
                                        if (discNumberMax > 0) {
                                            this.metadataTags.discsTotal ??= discNumberMax;
                                        }
                                    }
                                }
                                ;
                                break;
                        }
                    }
                }
                ;
                break;
        }
        containerSlice.filePos = boxEndPos;
        return true;
    }
}
abstract class IsobmffTrackBacking implements InputTrackBacking {
    packetToSampleIndex = new WeakMap<EncodedPacket, number>();
    packetToFragmentLocation = new WeakMap<EncodedPacket, {
        fragment: Fragment;
        sampleIndex: number;
    }>();
    public internalTrack: InternalTrack;
    constructor(internalTrack: InternalTrack) {
        this.internalTrack = internalTrack;
    }
    abstract getType(): TrackType;
    abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;
    getId() {
        return this.internalTrack.id;
    }
    getNumber() {
        const demuxer = this.internalTrack.demuxer;
        const trackType = this.internalTrack.trackBacking!.getType();
        let number = 0;
        for (const track of demuxer.tracks) {
            if (track.trackBacking!.getType() === trackType) {
                number++;
            }
            if (track === this.internalTrack) {
                break;
            }
        }
        return number;
    }
    getCodec(): MediaCodec | null {
        throw new Error('Not implemented on base class.');
    }
    getInternalCodecId() {
        return this.internalTrack.internalCodecId;
    }
    getName() {
        return this.internalTrack.name;
    }
    getLanguageCode() {
        return this.internalTrack.languageCode;
    }
    getTimeResolution() {
        return this.internalTrack.timescale;
    }
    isRelativeToUnixEpoch() {
        return false;
    }
    getUnixTimeForTimestamp() {
        return null;
    }
    getDisposition() {
        return this.internalTrack.disposition;
    }
    getPairingMask() {
        return 1n;
    }
    getBitrate() {
        return this.internalTrack.maxBitrate;
    }
    getAverageBitrate() {
        return this.internalTrack.avgBitrate;
    }
    async getDurationFromMetadata() {
        const track = this.internalTrack;
        if (track.durationInMediaTimescale <= 0) {
            // The duration is often zero for fragmented files for example; return `null` to signal that the duration
            // must be computed instead.
            return null;
        }
        assert(track.trackBacking);
        const firstPacket = await track.trackBacking.getFirstPacket({ metadataOnly: true });
        return (firstPacket?.timestamp ?? 0) + track.durationInMediaTimescale / track.timescale;
    }
    async getLiveRefreshInterval() {
        return null;
    }
    async getFirstPacket(options: PacketRetrievalOptions) {
        const regularPacket = await this.fetchPacketForSampleIndex(0, options);
        if (regularPacket || !this.internalTrack.demuxer.isFragmented) {
            // If there's a non-fragmented packet, always prefer that
            return regularPacket;
        }
        return this.performFragmentedLookup(null, async (fragment) => {
            const trackData = fragment.trackData.get(this.internalTrack.id);
            if (trackData) {
                return {
                    sampleIndex: 0,
                    correctSampleFound: true,
                };
            }
            return {
                sampleIndex: -1,
                correctSampleFound: false,
            };
        }, -Infinity, // Use -Infinity as a search timestamp to avoid using the lookup entries
        Infinity, options);
    }
    private mapTimestampIntoTimescale(timestamp: number) {
        // Do a little rounding to catch cases where the result is very close to an integer. If it is, it's likely
        // that the number was originally an integer divided by the timescale. For stability, it's best
        // to return the integer in this case.
        return roundIfAlmostInteger(timestamp * this.internalTrack.timescale) + this.internalTrack.editListOffset;
    }
    async getPacket(timestamp: number, options: PacketRetrievalOptions) {
        const timestampInTimescale = this.mapTimestampIntoTimescale(timestamp);
        const sampleTable = await this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
        const sampleIndex = await sampleTable.getSampleIndexForTimestamp(timestampInTimescale);
        const regularPacket = await this.fetchPacketForSampleIndex(sampleIndex, options);
        if (!this.internalTrack.demuxer.isFragmented) {
            return regularPacket;
        }
        const fragmentedPacket = await this.performFragmentedLookup(null, async (fragment) => {
            const trackData = fragment.trackData.get(this.internalTrack.id);
            if (!trackData) {
                return { sampleIndex: -1, correctSampleFound: false };
            }
            const sampleIndex = await trackData.samples.find(timestampInTimescale);
            const correctSampleFound = sampleIndex !== -1 && timestampInTimescale < trackData.endTimestamp;
            return { sampleIndex, correctSampleFound };
        }, timestampInTimescale, timestampInTimescale, options);
        return regularPacket && (!fragmentedPacket || regularPacket.timestamp > fragmentedPacket.timestamp)
            ? regularPacket : fragmentedPacket;
    }
    async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
        const regularSampleIndex = this.packetToSampleIndex.get(packet);
        if (regularSampleIndex !== undefined) {
            const next = await this.fetchPacketForSampleIndex(regularSampleIndex + 1, options);
            if (next || !this.internalTrack.demuxer.isFragmented)
                return next;
        }
        const locationInFragment = this.packetToFragmentLocation.get(packet);
        if (regularSampleIndex === undefined && locationInFragment === undefined) {
            throw new Error('Packet was not created from this track.');
        }
        return this.performFragmentedLookup(locationInFragment?.fragment ?? null, async (fragment) => {
            if (locationInFragment && fragment === locationInFragment.fragment) {
                const trackData = fragment.trackData.get(this.internalTrack.id)!;
                if (locationInFragment.sampleIndex + 1 < trackData.samples.length) {
                    // We can simply take the next sample in the fragment
                    return {
                        sampleIndex: locationInFragment.sampleIndex + 1,
                        correctSampleFound: true,
                    };
                }
            }
            else {
                const trackData = fragment.trackData.get(this.internalTrack.id);
                if (trackData) {
                    return {
                        sampleIndex: 0,
                        correctSampleFound: true,
                    };
                }
            }
            return {
                sampleIndex: -1,
                correctSampleFound: false,
            };
        }, -Infinity, // Use -Infinity as a search timestamp to avoid using the lookup entries
        Infinity, options);
    }
    async getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
        const timestampInTimescale = this.mapTimestampIntoTimescale(timestamp);
        const sampleTable = await this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
        const sampleIndex = await sampleTable.getSampleIndexForTimestamp(timestampInTimescale, true);
        const regularPacket = await this.fetchPacketForSampleIndex(sampleIndex, options);
        if (!this.internalTrack.demuxer.isFragmented) {
            return regularPacket;
        }
        const fragmentedPacket = await this.performFragmentedLookup(null, async (fragment) => {
            const trackData = fragment.trackData.get(this.internalTrack.id);
            if (!trackData) {
                return { sampleIndex: -1, correctSampleFound: false };
            }
            const sampleIndex = await trackData.samples.find(timestampInTimescale, true);
            const correctSampleFound = sampleIndex !== -1 && timestampInTimescale < trackData.endTimestamp;
            return { sampleIndex, correctSampleFound };
        }, timestampInTimescale, timestampInTimescale, options);
        return regularPacket && (!fragmentedPacket || regularPacket.timestamp > fragmentedPacket.timestamp)
            ? regularPacket : fragmentedPacket;
    }
    async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
        const regularSampleIndex = this.packetToSampleIndex.get(packet);
        if (regularSampleIndex !== undefined) {
            const sampleTable = await this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
            const nextKeyFrameSampleIndex = await sampleTable.getNextKeyframeIndex(regularSampleIndex);
            const next = await this.fetchPacketForSampleIndex(nextKeyFrameSampleIndex, options);
            if (next || !this.internalTrack.demuxer.isFragmented)
                return next;
        }
        const locationInFragment = this.packetToFragmentLocation.get(packet);
        if (regularSampleIndex === undefined && locationInFragment === undefined) {
            throw new Error('Packet was not created from this track.');
        }
        return this.performFragmentedLookup(locationInFragment?.fragment ?? null, async (fragment) => {
            if (locationInFragment && fragment === locationInFragment.fragment) {
                const trackData = fragment.trackData.get(this.internalTrack.id)!;
                const sampleIndex = await trackData.samples.nextKey(locationInFragment.sampleIndex);
                if (sampleIndex !== -1)
                    return { sampleIndex, correctSampleFound: true };
            }
            else {
                const trackData = fragment.trackData.get(this.internalTrack.id);
                if (trackData && trackData.firstKeyFrameTimestamp !== null) {
                    const keyFrameIndex = await trackData.samples.nextKey(-1);
                    assert(keyFrameIndex !== -1); // There must be one
                    return {
                        sampleIndex: keyFrameIndex,
                        correctSampleFound: true,
                    };
                }
            }
            return {
                sampleIndex: -1,
                correctSampleFound: false,
            };
        }, -Infinity, // Use -Infinity as a search timestamp to avoid using the lookup entries
        Infinity, options);
    }
    /**
     * Validates payload extents during metadata inspection without reading encoded bytes.
     */
    private validateSampleRange(offset: number, size: number) {
        const end = offset + size;
        const fileSize = this.internalTrack.demuxer.reader.fileSizeNonStrict;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0
            || !Number.isSafeInteger(end) || (fileSize !== null && end > fileSize)) {
            throw new RangeError('MP4 sample payload extends beyond the input.');
        }
    }
    /**
     * Rejects video prefix and tail edits lost when copying every encoded sample.
     * Use the original media time so leading empty edits and their rounded offsets
     * do not affect this comparison. Movie-unit rounding permits the edit list's
     * normal timescale quantization while still rejecting partial-sample cuts.
     */
    private validateEditListRange(presentationTimestamp: number, duration: number) {
        const track = this.internalTrack;
        const edit = track.editListMediaEdit;
        if (!edit) {
            return;
        }
        if (track.info?.type === 'video' && presentationTimestamp < edit.mediaTime
            && presentationTimestamp + duration <= edit.mediaTime) {
            throw new Error('Unsupported MP4 edit list: media edit trims video sample presentation.');
        }
        if (edit.segmentDuration === 0) {
            return;
        }
        const endInMovieTimescale = Math.round(
            (presentationTimestamp + duration - edit.mediaTime) / track.timescale * track.demuxer.movieTimescale,
        );
        if (endInMovieTimescale > edit.segmentDuration) {
            throw new Error('Unsupported MP4 edit list: media edit trims sample presentation.');
        }
    }
    private async fetchPacketForSampleIndex(sampleIndex: number, options: PacketRetrievalOptions) {
        if (sampleIndex === -1) {
            return null;
        }
        const sampleTable = await this.internalTrack.demuxer.getSampleTableForTrack(this.internalTrack);
        const sampleInfo = await sampleTable.getSampleInfo(sampleIndex);
        if (!sampleInfo) {
            return null;
        }
        this.validateSampleRange(sampleInfo.sampleOffset, sampleInfo.sampleSize);
        this.validateEditListRange(sampleInfo.presentationTimestamp, sampleInfo.duration);
        let data: Uint8Array;
        if (options.metadataOnly) {
            data = PLACEHOLDER_DATA;
        }
        else {
            let slice = this.internalTrack.demuxer.reader.requestSlice(sampleInfo.sampleOffset, sampleInfo.sampleSize);
            if (isThenable(slice))
                slice = await slice;
            if (!slice) {
                throw new RangeError('Truncated MP4 sample payload.');
            }
            data = readBytes(slice, sampleInfo.sampleSize);
            if (this.internalTrack.encryptionInfo) {
                let sampleEncryption: SampleEncryptionInfo | null = null;
                if (this.internalTrack.encryptionAuxInfo) {
                    const entries = await resolveEncryptionAuxInfo(this.internalTrack.demuxer.reader, this.internalTrack.encryptionInfo, this.internalTrack.encryptionAuxInfo);
                    if (sampleIndex < entries.length) {
                        sampleEncryption = entries[sampleIndex]!;
                    }
                }
                sampleEncryption ??= getDefaultSampleEncryption(this.internalTrack.encryptionInfo);
                if (sampleEncryption) {
                    data = await decryptSample(this.internalTrack, sampleEncryption, data, null);
                }
            }
        }
        const timestamp = (sampleInfo.presentationTimestamp - this.internalTrack.editListOffset)
            / this.internalTrack.timescale;
        const duration = sampleInfo.duration / this.internalTrack.timescale;
        const packet = new EncodedPacket(data, sampleInfo.isKeyFrame ? 'key' : 'delta', timestamp, duration, sampleIndex, sampleInfo.sampleSize,
            { decodeDuration: sampleInfo.decodeDuration / this.internalTrack.timescale });
        this.packetToSampleIndex.set(packet, sampleIndex);
        return packet;
    }
    private async fetchPacketInFragment(fragment: Fragment, sampleIndex: number, options: PacketRetrievalOptions) {
        if (sampleIndex === -1) {
            return null;
        }
        const trackData = fragment.trackData.get(this.internalTrack.id)!;
        const fragmentSample = await trackData.samples.get(sampleIndex, !options.metadataOnly);
        assert(fragmentSample);
        this.validateSampleRange(fragmentSample.byteOffset, fragmentSample.byteSize);
        this.validateEditListRange(fragmentSample.presentationTimestamp, fragmentSample.duration);
        let data: Uint8Array;
        if (options.metadataOnly) {
            data = PLACEHOLDER_DATA;
        }
        else {
            let slice = this.internalTrack.demuxer.reader.requestSlice(fragmentSample.byteOffset, fragmentSample.byteSize);
            if (isThenable(slice))
                slice = await slice;
            if (!slice) {
                throw new RangeError('Truncated MP4 sample payload.');
            }
            data = readBytes(slice, fragmentSample.byteSize);
            if (this.internalTrack.encryptionInfo) {
                const sampleEncryption = fragmentSample.encryption
                    ?? getDefaultSampleEncryption(this.internalTrack.encryptionInfo);
                if (sampleEncryption) {
                    data = await decryptSample(this.internalTrack, sampleEncryption, data, fragment);
                }
            }
        }
        const timestamp = (fragmentSample.presentationTimestamp - this.internalTrack.editListOffset)
            / this.internalTrack.timescale;
        const duration = fragmentSample.duration / this.internalTrack.timescale;
        const packet = new EncodedPacket(data, fragmentSample.isKeyFrame ? 'key' : 'delta', timestamp, duration, fragment.moofOffset + sampleIndex, fragmentSample.byteSize,
            { decodeDuration: fragmentSample.decodeDuration / this.internalTrack.timescale });
        this.packetToFragmentLocation.set(packet, { fragment, sampleIndex });
        return packet;
    }
    /** Looks for a packet in the fragments while trying to load as few fragments as possible to retrieve it. */
    private async performFragmentedLookup(
    // The fragment where we start looking
    startFragment: Fragment | null, 
    // This function returns the best-matching sample in a given fragment
    getMatchInFragment: (fragment: Fragment) => Promise<{
        sampleIndex: number;
        correctSampleFound: boolean;
    }>, 
    // The timestamp with which we can search the lookup table
    searchTimestamp: number, 
    // The timestamp for which we know the correct sample will not come after it
    latestTimestamp: number, options: PacketRetrievalOptions, 
    // The position for which we know the correct sample will not come after it
    stopPos = Infinity, 
    // How many times we've retried due to a faulty lookup table entry
    lookupRetryCount = 0): Promise<EncodedPacket | null> {
        const demuxer = this.internalTrack.demuxer;
        let currentFragment: Fragment | null = null;
        let bestFragment: Fragment | null = null;
        let bestSampleIndex = -1;
        if (startFragment) {
            const { sampleIndex, correctSampleFound } = await getMatchInFragment(startFragment);
            if (correctSampleFound) {
                return this.fetchPacketInFragment(startFragment, sampleIndex, options);
            }
            if (sampleIndex !== -1) {
                bestFragment = startFragment;
                bestSampleIndex = sampleIndex;
            }
        }
        // Search for a lookup entry; this way, we won't need to start searching from the start of the file
        // but can jump right into the correct fragment (or at least nearby).
        const lookup = await this.internalTrack.fragmentLookupTable?.findTimestamp(searchTimestamp);
        const lookupEntryIndex = lookup?.index ?? -1;
        const lookupEntry = lookup?.entry ?? null;
        const positionCacheIndex = binarySearchLessOrEqual(this.internalTrack.fragmentPositionCache, searchTimestamp, x => x.startTimestamp);
        const positionCacheEntry = positionCacheIndex !== -1
            ? this.internalTrack.fragmentPositionCache[positionCacheIndex]!
            : null;
        if (positionCacheEntry)
            positionCacheEntry.lastAccess = ++demuxer.fragmentCacheAccess;
        const lookupEntryPosition = Math.max(lookupEntry?.moofOffset ?? 0, positionCacheEntry?.moofOffset ?? 0) || null;
        const previousPositionTimestamps = this.internalTrack.fragmentPositionCache.map(entry => entry.startTimestamp);
        const lookupTableWins = !!lookupEntry && lookupEntry.moofOffset >= (positionCacheEntry?.moofOffset ?? 0);
        let currentPos: number;
        if (!startFragment) {
            currentPos = lookupEntryPosition ?? 0;
        }
        else {
            if (lookupEntryPosition === null || startFragment.moofOffset >= lookupEntryPosition) {
                currentPos = startFragment.moofOffset + startFragment.moofSize;
                currentFragment = startFragment;
            }
            else {
                // Use the lookup entry
                currentPos = lookupEntryPosition;
            }
        }
        const scanStartPos = currentFragment ? currentFragment.moofOffset : currentPos;
        while (currentPos < stopPos) {
            if (currentFragment) {
                const trackData = currentFragment.trackData.get(this.internalTrack.id);
                if (trackData && trackData.startTimestamp > latestTimestamp) {
                    // We're already past the upper bound, no need to keep searching
                    break;
                }
                currentFragment = null; // So we don't process it again next iteration
            }
            const summary = demuxer.fragmentSummaries.get(currentPos);
            if (summary) {
                demuxer.fragmentSummaries.delete(currentPos);
                demuxer.fragmentSummaries.set(currentPos, summary);
            }
            if (summary && !summary.trackIds.has(this.internalTrack.id)) {
                // We've read this fragment before and know it has nothing for this track, so let's not read it again
                currentPos += summary.moofSize;
                continue;
            }
            // Load the header
            const header = await demuxer.readTopLevelBox(currentPos);
            if (!header)
                break;
            const boxStartPos = currentPos;
            const boxInfo = header.boxInfo;
            if (boxInfo.name === 'moof') {
                currentFragment = await demuxer.readFragment(boxStartPos);
                if (!currentFragment) {
                    break;
                }
                const { sampleIndex, correctSampleFound } = await getMatchInFragment(currentFragment);
                if (correctSampleFound) {
                    return this.fetchPacketInFragment(currentFragment, sampleIndex, options);
                }
                if (sampleIndex !== -1) {
                    bestFragment = currentFragment;
                    bestSampleIndex = sampleIndex;
                }
            }
            currentPos = boxStartPos + boxInfo.totalSize;
        }
        // Handle unsatisfactory lookup table entries or position cache entries
        if (lookupEntryPosition !== null && (!bestFragment || bestFragment.moofOffset < lookupEntryPosition)) {
            // We found a lookup entry but no fragment from there on that satisfied the match. In this case, let's
            // search again but using a previous entry of the kind we started from. Each time this happens, we double
            // the backwards step to perform better (and have more sequential reads) if it takes us a long time to find
            // the media.
            const step = Math.min(2 ** lookupRetryCount, Number.MAX_SAFE_INTEGER);
            const previousEntryTimestamp = lookupTableWins
                ? (await this.internalTrack.fragmentLookupTable?.at(lookupEntryIndex - step))?.timestamp
                : previousPositionTimestamps[positionCacheIndex - step];
            const newSearchTimestamp = previousEntryTimestamp ?? -Infinity;
            return this.performFragmentedLookup(null, getMatchInFragment, newSearchTimestamp, latestTimestamp, options, scanStartPos, // So we don't read the same fragments again
            lookupRetryCount + 1);
        }
        if (bestFragment) {
            // If we finished looping but didn't find a perfect match, still return the best match we found
            return this.fetchPacketInFragment(bestFragment, bestSampleIndex, options);
        }
        return null;
    }
}
class IsobmffVideoTrackBacking extends IsobmffTrackBacking implements InputVideoTrackBacking {
    declare internalTrack: InternalVideoTrack;
    decoderConfigPromise: Promise<VideoDecoderConfig> | null = null;
    constructor(internalTrack: InternalVideoTrack) {
        super(internalTrack);
    }
    getType() {
        return 'video' as const;
    }
    override getCodec(): VideoCodec | null {
        return this.internalTrack.info.codec;
    }
    getCodedWidth() {
        return this.internalTrack.info.width;
    }
    getCodedHeight() {
        return this.internalTrack.info.height;
    }
    getSquarePixelWidth() {
        return this.internalTrack.info.squarePixelWidth;
    }
    getSquarePixelHeight() {
        return this.internalTrack.info.squarePixelHeight;
    }
    getTransformationMatrix(): TransformationMatrix {
        return [...this.internalTrack.matrix];
    }
    async getColorSpace(): Promise<VideoColorSpaceInit> {
        const decoderConfig = await this.getDecoderConfig();
        if (!decoderConfig) {
            return this.internalTrack.info.colorSpace;
        }
        return {
            primaries: decoderConfig.colorSpace?.primaries ?? null,
            transfer: decoderConfig.colorSpace?.transfer ?? null,
            matrix: decoderConfig.colorSpace?.matrix ?? null,
            fullRange: decoderConfig.colorSpace?.fullRange ?? null,
        };
    }
    async canBeTransparent() {
        return this.internalTrack.info.codec === 'prores' && (this.internalTrack.info.proresFormat === 'ap4h'
            || this.internalTrack.info.proresFormat === 'ap4x');
    }
    async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
        if (!this.internalTrack.info.codec) {
            return null;
        }
        return this.decoderConfigPromise ??= (async (): Promise<VideoDecoderConfig> => {
            if (this.internalTrack.info.codec === 'avc' && !this.internalTrack.info.codecDescription) {
                const firstPacket = await this.getFirstPacket({});
                this.internalTrack.info.avcCodecInfo
                    = firstPacket && extractAvcDecoderConfigurationRecord(firstPacket.data);
            }
            else if (this.internalTrack.info.codec === 'hevc' && !this.internalTrack.info.codecDescription) {
                const firstPacket = await this.getFirstPacket({});
                this.internalTrack.info.hevcCodecInfo
                    = firstPacket && extractHevcDecoderConfigurationRecord(firstPacket.data);
            }
            else if (this.internalTrack.info.codec === 'vp9'
                && (!this.internalTrack.info.vp9CodecInfo
                    // The codec info extracted from vpcC may claim the color space is "undefined"
                    || !vp9CodecInfoHasColorInfo(this.internalTrack.info.vp9CodecInfo))) {
                const firstPacket = await this.getFirstPacket({});
                const packetInfo = firstPacket && extractVp9CodecInfoFromPacket(firstPacket.data);
                if (packetInfo) {
                    this.internalTrack.info.vp9CodecInfo = {
                        ...(this.internalTrack.info.vp9CodecInfo ?? packetInfo),
                        videoFullRangeFlag: packetInfo.videoFullRangeFlag,
                        colourPrimaries: packetInfo.colourPrimaries,
                        transferCharacteristics: packetInfo.transferCharacteristics,
                        matrixCoefficients: packetInfo.matrixCoefficients,
                    };
                }
            }
            else if (this.internalTrack.info.codec === 'av1'
                && (!this.internalTrack.info.av1CodecInfo
                    // The codec info extracted from av1C may not contain color space information
                    || !av1CodecInfoHasColorInfo(this.internalTrack.info.av1CodecInfo))) {
                const firstPacket = await this.getFirstPacket({});
                const packetInfo = firstPacket && extractAv1CodecInfoFromPacket(firstPacket.data);
                if (packetInfo) {
                    this.internalTrack.info.av1CodecInfo = packetInfo;
                }
            }
            else if (this.internalTrack.info.codec === 'prores' && !this.internalTrack.info.proresCodecInfo) {
                const firstPacket = await this.getFirstPacket({});
                this.internalTrack.info.proresCodecInfo
                    = firstPacket && extractProresCodecInfoFromPacket(firstPacket.data);
            }
            if (!colorSpaceIsComplete(this.internalTrack.info.colorSpace)) {
                const colorSpace = extractColorSpace(this.internalTrack.info);
                // Fill the missing values
                this.internalTrack.info.colorSpace.primaries ??= colorSpace.primaries ?? null;
                this.internalTrack.info.colorSpace.transfer ??= colorSpace.transfer ?? null;
                this.internalTrack.info.colorSpace.matrix ??= colorSpace.matrix ?? null;
                this.internalTrack.info.colorSpace.fullRange ??= colorSpace.fullRange ?? null;
            }
            const config: VideoDecoderConfig = {
                codec: extractVideoCodecString(this.internalTrack.info),
                codedWidth: this.internalTrack.info.width,
                codedHeight: this.internalTrack.info.height,
                ...(this.internalTrack.info.codecDescription ? { description: this.internalTrack.info.codecDescription } : {}),
                colorSpace: this.internalTrack.info.colorSpace,
            };
            const { width, height, pixelAspectRatio } = this.internalTrack.info;
            if (pixelAspectRatio.num !== pixelAspectRatio.den) {
                // WebCodecs display dimensions express a ratio, so retain exact
                // integer factors instead of deriving them from rounded pixels.
                const displayAspectRatio = simplifyRational({
                    num: width * pixelAspectRatio.num,
                    den: height * pixelAspectRatio.den,
                });
                config.displayAspectWidth = displayAspectRatio.num;
                config.displayAspectHeight = displayAspectRatio.den;
            }
            return config;
        })();
    }
}
class IsobmffAudioTrackBacking extends IsobmffTrackBacking implements InputAudioTrackBacking {
    declare internalTrack: InternalAudioTrack;
    decoderConfigPromise: Promise<AudioDecoderConfig> | null = null;
    constructor(internalTrack: InternalAudioTrack) {
        super(internalTrack);
    }
    getType() {
        return 'audio' as const;
    }
    override getCodec(): AudioCodec | null {
        return this.internalTrack.info.codec;
    }
    getNumberOfChannels() {
        return this.internalTrack.info.numberOfChannels;
    }
    getSampleRate() {
        return this.internalTrack.info.sampleRate;
    }
    async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
        if (!this.internalTrack.info.codec) {
            return null;
        }
        return this.decoderConfigPromise ??= (async (): Promise<AudioDecoderConfig> => {
            if (this.internalTrack.info.codec === 'dts' && !this.internalTrack.info.dtsFormat) {
                // Gotta check the packet to determine the DTS variant
                const firstPacket = await this.getFirstPacket({});
                this.internalTrack.info.dtsFormat = firstPacket && extractDtsFourCcFromPacket(firstPacket.data);
            }
            return {
                codec: extractAudioCodecString(this.internalTrack.info),
                numberOfChannels: this.internalTrack.info.numberOfChannels,
                sampleRate: this.internalTrack.info.sampleRate,
                ...(this.internalTrack.info.codecDescription ? { description: this.internalTrack.info.codecDescription } : {}),
            };
        })();
    }
}
const offsetFragmentTrackDataByTimestamp = (trackData: FragmentTrackData, timestamp: number) => {
    trackData.startTimestamp += timestamp;
    trackData.endTimestamp += timestamp;
    trackData.currentTimestamp += timestamp;
    trackData.samples.timestampOffset += timestamp;
    if (trackData.firstKeyFrameTimestamp !== null)
        trackData.firstKeyFrameTimestamp += timestamp;
    if (![trackData.startTimestamp, trackData.endTimestamp, trackData.currentTimestamp].every(Number.isSafeInteger)) {
        throw new RangeError('Unsafe fragment timeline.');
    }
};
const readMatrix = (slice: FileSlice): TransformationMatrix => {
    return [
        readFixed_16_16(slice),
        readFixed_16_16(slice),
        readFixed_2_30(slice),
        readFixed_16_16(slice),
        readFixed_16_16(slice),
        readFixed_2_30(slice),
        readFixed_16_16(slice),
        readFixed_16_16(slice),
        readFixed_2_30(slice),
    ];
};
const applyPixelAspectRatio = (track: InternalTrack, pixelAspectRatio: Rational) => {
    const info = track.info!;
    if (info.type !== 'video') {
        return;
    }
    const { num, den } = pixelAspectRatio;
    if (!(num > 0 && den > 0)) {
        return;
    }
    info.pixelAspectRatio = simplifyRational(pixelAspectRatio);
    info.squarePixelWidth = info.width;
    info.squarePixelHeight = info.height;
    if (num > den) {
        info.squarePixelWidth = Math.round(info.width * num / den);
        info.squarePixelHeight = info.height;
    }
    else {
        info.squarePixelWidth = info.width;
        info.squarePixelHeight = Math.round(info.height * den / num);
    }
};
const getOrCreateEncryptionAuxInfo = (track: InternalTrack) => {
    if (track.currentFragmentState) {
        return track.currentFragmentState.encryptionAuxInfo ??= {
            defaultSampleInfoSize: 0,
            sampleSizes: null,
            sampleCount: 0,
            offset: null,
            resolved: null,
        };
    }
    else {
        return track.encryptionAuxInfo ??= {
            defaultSampleInfoSize: 0,
            sampleSizes: null,
            sampleCount: 0,
            offset: null,
            resolved: null,
        };
    }
};
const resolveEncryptionAuxInfo = async (reader: Reader, encryptionInfo: TrackEncryptionInfo, aux: SampleEncryptionAuxInfo) => {
    if (aux.resolved) {
        return aux.resolved;
    }
    if (aux.offset === null || aux.sampleCount === 0) {
        throw new Error('Incomplete saiz/saio info; cannot resolve encryption data.');
    }
    let totalSize = 0;
    if (aux.defaultSampleInfoSize > 0) {
        totalSize = aux.defaultSampleInfoSize * aux.sampleCount;
    }
    else {
        assert(aux.sampleSizes);
        for (let i = 0; i < aux.sampleCount; i++) {
            totalSize += aux.sampleSizes[i]!;
        }
    }
    let slice = reader.requestSlice(aux.offset, totalSize);
    if (isThenable(slice))
        slice = await slice;
    if (!slice) {
        throw new Error('Failed to read auxiliary encryption info.');
    }
    const ivSize = encryptionInfo.defaultPerSampleIvSize;
    if (ivSize === null) {
        throw new Error('Invalid file: encrypted track is missing its tenc box.');
    }
    // Each aux entry has the same byte layout as a senc entry: IV (of size ivSize, or the constant IV from tenc
    // when ivSize is 0), then optionally subsample count + [clearLen, protectedLen] pairs. Subsamples are present
    // iff the entry is larger than the IV.
    const entries: SampleEncryptionInfo[] = [];
    for (let i = 0; i < aux.sampleCount; i++) {
        const entrySize = aux.defaultSampleInfoSize > 0
            ? aux.defaultSampleInfoSize
            : aux.sampleSizes![i]!;
        const iv = new Uint8Array(16);
        if (ivSize > 0) {
            iv.set(readBytes(slice, ivSize), 0);
        }
        else if (encryptionInfo.defaultConstantIv) {
            iv.set(encryptionInfo.defaultConstantIv, 0);
        }
        else {
            throw new Error('Invalid file: encrypted sample has no IV.');
        }
        let subsamples: {
            clearLen: number;
            protectedLen: number;
        }[] | null = null;
        if (entrySize > ivSize) {
            const subsampleCount = readU16Be(slice);
            subsamples = [];
            for (let j = 0; j < subsampleCount; j++) {
                const clearLen = readU16Be(slice);
                const protectedLen = readU32Be(slice);
                subsamples.push({ clearLen, protectedLen });
            }
        }
        entries.push({ iv, subsamples });
    }
    aux.resolved = entries;
    return entries;
};
const getDefaultSampleEncryption = (encryptionInfo: TrackEncryptionInfo): SampleEncryptionInfo | null => {
    if (!encryptionInfo.defaultConstantIv) {
        return null;
    }
    return {
        iv: encryptionInfo.defaultConstantIv,
        subsamples: null,
    };
};
const decryptSample = async (track: InternalTrack, sampleEncryption: SampleEncryptionInfo, data: Uint8Array, fragment: Fragment | null): Promise<Uint8Array> => {
    assert(track.encryptionInfo);
    const encryptionInfo = track.encryptionInfo;
    if (encryptionInfo.defaultKid === null) {
        throw new Error('Invalid file: encrypted track is missing its tenc box.');
    }
    const keyId = encryptionInfo.defaultKid;
    let keyBytes: Uint8Array;
    const cacheEntry = track.demuxer.decryptionKeyCache.get(keyId);
    if (cacheEntry) {
        keyBytes = await cacheEntry;
    }
    else {
        if (!track.demuxer.input._formatOptions.isobmff?.resolveKeyId) {
            throw new Error('Encrypted media samples encountered. To decrypt them, please provide a callback for'
                + ' InputOptions.formatOptions.isobmff.resolveKeyId.');
        }
        const promise = (async () => {
            let psshBoxes = track.demuxer.psshBoxes;
            if (fragment) {
                psshBoxes = [
                    ...psshBoxes,
                    ...fragment.psshBoxes,
                ].filter(x => x.keyIds === null || x.keyIds.includes(keyId));
                // Filter out duplicates
                for (let i = 0; i < psshBoxes.length - 1; i++) {
                    for (let j = i + 1; j < psshBoxes.length; j++) {
                        if (psshBoxesAreEqual(psshBoxes[i]!, psshBoxes[j]!)) {
                            psshBoxes.splice(j, 1);
                            j--;
                        }
                    }
                }
            }
            const keyResult = await track.demuxer.input._formatOptions.isobmff!.resolveKeyId!({ keyId, psshBoxes });
            if (!((typeof keyResult === 'string' && keyResult.length === 32 && HEX_STRING_REGEX.test(keyResult))
                || (keyResult instanceof Uint8Array && keyResult.byteLength === 16))) {
                throw new TypeError('resolveKeyId must return a 32-character hex string or a 16-byte Uint8Array containing the'
                    + ' decryption key.');
            }
            return keyResult instanceof Uint8Array
                ? keyResult
                : hexStringToBytes(keyResult);
        })();
        track.demuxer.decryptionKeyCache.set(keyId, promise);
        keyBytes = await promise;
    }
    if (encryptionInfo.scheme === 'cenc' || encryptionInfo.scheme === 'cens') {
        return decryptCtr(keyBytes, encryptionInfo, sampleEncryption, data);
    }
    else {
        return decryptCbcs(keyBytes, encryptionInfo, sampleEncryption, data);
    }
};
const decryptCtr = async (key: Uint8Array, encryptionInfo: TrackEncryptionInfo, sampleEncryption: SampleEncryptionInfo, data: Uint8Array) => {
    const counter = new Uint8Array(16);
    counter.set(sampleEncryption.iv, 0);
    const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-CTR' }, false, ['decrypt']);
    const cryptApply = async (input: Uint8Array) => {
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 64 }, cryptoKey, input as BufferSource);
        return new Uint8Array(plaintext);
    };
    if (!sampleEncryption.subsamples) {
        // Whole sample is protected, no pattern
        return cryptApply(data);
    }
    assert(encryptionInfo.defaultCryptByteBlock !== null && encryptionInfo.defaultSkipByteBlock !== null);
    const cryptRanges = collectCryptRanges(sampleEncryption.subsamples, encryptionInfo.defaultCryptByteBlock, encryptionInfo.defaultSkipByteBlock, data.length);
    // Concatenate all crypt ranges into a single buffer so the continuous CTR counter behavior is preserved
    let totalCryptLen = 0;
    for (const range of cryptRanges) {
        for (const seg of range.perSubsample) {
            totalCryptLen += seg.length;
        }
    }
    const cryptBuffer = new Uint8Array(totalCryptLen);
    let writePos = 0;
    for (const range of cryptRanges) {
        for (const seg of range.perSubsample) {
            cryptBuffer.set(data.subarray(seg.offset, seg.offset + seg.length), writePos);
            writePos += seg.length;
        }
    }
    const plain = await cryptApply(cryptBuffer);
    // Now let's build the output
    const output = new Uint8Array(data);
    let readPos = 0;
    for (const range of cryptRanges) {
        for (const seg of range.perSubsample) {
            output.set(plain.subarray(readPos, readPos + seg.length), seg.offset);
            readPos += seg.length;
        }
    }
    return output;
};
const decryptCbcs = (key: Uint8Array, encryptionInfo: TrackEncryptionInfo, sampleEncryption: SampleEncryptionInfo, data: Uint8Array) => {
    const ctx = new Aes128CbcContext();
    ctx.init({ key, iv: sampleEncryption.iv });
    const cryptByteBlock = encryptionInfo.defaultCryptByteBlock;
    const skipByteBlock = encryptionInfo.defaultSkipByteBlock;
    assert(cryptByteBlock !== null && skipByteBlock !== null);
    if (!sampleEncryption.subsamples) {
        // Whole-sample encryption: straightforward CBC over floor(size / 16) blocks, any trailing bytes stay clear
        const output = new Uint8Array(data);
        const numBlocks = Math.floor(data.length / 16);
        for (let b = 0; b < numBlocks; b++) {
            const off = b * 16;
            ctx.in.set(data.subarray(off, off + 16));
            ctx.decrypt();
            output.set(ctx.out, off);
        }
        return output;
    }
    if (cryptByteBlock === 0 && skipByteBlock === 0) {
        throw new Error('cbcs with subsamples requires pattern encryption.');
    }
    const output = new Uint8Array(data);
    // Pattern decryption: IV is reset at the start of each subsample. Within a subsample, the CBC chain continues
    // across skipped blocks (the IV after a crypt group carries over to the next crypt group's first block).
    const cryptRanges = collectCryptRanges(sampleEncryption.subsamples, cryptByteBlock, skipByteBlock, data.length);
    const ivView = new DataView(sampleEncryption.iv.buffer, sampleEncryption.iv.byteOffset, 16);
    for (const range of cryptRanges) {
        // Reset IV per subsample
        ctx.iv[0] = ivView.getUint32(0, false);
        ctx.iv[1] = ivView.getUint32(4, false);
        ctx.iv[2] = ivView.getUint32(8, false);
        ctx.iv[3] = ivView.getUint32(12, false);
        for (const seg of range.perSubsample) {
            // Decrypt length / 16 blocks at this offset
            const numBlocks = seg.length / 16;
            for (let b = 0; b < numBlocks; b++) {
                const offset = seg.offset + b * 16;
                ctx.in.set(data.subarray(offset, offset + 16));
                ctx.decrypt();
                output.set(ctx.out, offset);
            }
        }
    }
    return output;
};
const collectCryptRanges = (subsamples: {
    clearLen: number;
    protectedLen: number;
}[], cryptByteBlock: number, skipByteBlock: number, dataLength: number) => {
    const ranges: {
        perSubsample: {
            offset: number;
            length: number;
        }[];
    }[] = [];
    const hasPattern = cryptByteBlock !== 0 || skipByteBlock !== 0;
    let cursor = 0;
    for (const subsample of subsamples) {
        if (cursor + subsample.clearLen + subsample.protectedLen > dataLength) {
            throw new Error('Invalid encryption info: subsamples exceed the sample size.');
        }
        cursor += subsample.clearLen;
        const perSubsample: {
            offset: number;
            length: number;
        }[] = [];
        if (!hasPattern) {
            if (subsample.protectedLen > 0) {
                perSubsample.push({ offset: cursor, length: subsample.protectedLen });
            }
            cursor += subsample.protectedLen;
        }
        else {
            let remaining = subsample.protectedLen;
            let pos = cursor;
            while (remaining > 0) {
                if (remaining < 16 * cryptByteBlock) {
                    break; // Partial final crypt group stays clear
                }
                const cryptBytes = 16 * cryptByteBlock;
                perSubsample.push({ offset: pos, length: cryptBytes });
                pos += cryptBytes;
                remaining -= cryptBytes;
                const skipBytes = Math.min(16 * skipByteBlock, remaining);
                pos += skipBytes;
                remaining -= skipBytes;
            }
            cursor += subsample.protectedLen;
        }
        ranges.push({ perSubsample });
    }
    return ranges;
};
type SampleTableBox = {
    name: string;
    start: number;
    count: number;
    bits: number;
    constant: number;
    signed: boolean;
};
type SampleTableRun = {
    entry: number;
    start: number;
    count: number;
    time: number;
    value: number;
    chunk: number;
};
type SampleTableRuns = {
    box: SampleTableBox;
    checkpoints: SampleTableRun[];
    window: SampleTableRun[];
    total: number;
    duration: number;
};
/**
 * Regular MP4 indexes stay on the source. Only eight copied 16 KiB pages and at
 * most 128 prefix checkpoints and 256 decoded runs per run-length table are
 * retained per track. The small run window keeps sequential lookahead cheap.
 * Checkpoints are built by a streaming pass, not one record per sample/page.
 * Larger files trade additional random-seek I/O for a fixed retained index.
 */
type FragmentRun = {
    start: number;
    end: number;
    entries: number;
    count: number;
    rowSize: number;
    flags: number;
    version: number;
    firstFlags: number | null;
    dataOffset: number | null;
    number: number;
    sampleStart: number;
};
type FragmentCursor = {
    index: number;
    run: FragmentRun;
    entry: number;
    time: number;
    offset: number;
};
type FragmentRaw = FragmentTrackSample & {
    index: number;
    decodeTimestamp: number;
    next: FragmentCursor;
};
type FragmentBucket = {
    cursor: FragmentCursor;
    count: number;
    min: number;
    max: number;
};
/**
 * One fragment's trun tables stay on the source. Four copied 16 KiB pages,
 * 128 adaptive block summaries and bounded raw/duration windows replace full
 * sample, run-count and presentation-sorted arrays. Reordered lookup may rescan
 * blocks; monotonic presentation order keeps sequential duration lookups cheap.
 */
class FragmentSampleTable {
    length = 0;
    runCount = 0;
    timestampOffset = 0;
    startTimestamp = Infinity;
    endTimestamp = 0;
    firstKeyFrameTimestamp: number | null = null;
    private maxPresentation = -Infinity;
    private lastMaxDuration = 0;
    private monotonic = true;
    private previousPresentation = -Infinity;
    private stride = 256;
    private buckets: FragmentBucket[] = [];
    private pages = new Map<number, DataView>();
    private rawCache = new Map<number, FragmentRaw>();
    private durationCache = new Map<number, number>();
    private cursor: FragmentCursor | null = null;
    private smallTimes = new Map<number, {
        last: number;
        next: number | null;
    }>();
    private manyTimes = false;
    private senc: {
        start: number;
        end: number;
        count: number;
        subsamples: boolean;
    } | null = null;
    private encryptionCheckpoints: {
        index: number;
        offset: number;
    }[] | null = null;
    aux: SampleEncryptionAuxInfo | null = null;
    private pending: Promise<unknown> = Promise.resolve();
    private reader: Reader;
    private track: InternalTrack | null;
    private start: number;
    private end: number;
    private base: number;
    private defaults: FragmentTrackState;
    constructor(reader: Reader, track: InternalTrack | null, start: number, end: number, base: number, defaults: FragmentTrackState) {
        this.reader = reader;
        this.track = track;
        this.start = start;
        this.end = end;
        this.base = base;
        this.defaults = defaults;
    }
    private run<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(async () => {
            if (this.reader.source._disposed)
                throw new InputDisposedError();
            return operation();
        });
        this.pending = result.catch(() => { });
        return result;
    }
    private async page(position: number) {
        if (this.reader.source._disposed)
            throw new InputDisposedError();
        const start = Math.floor(position / (16 * 1024)) * (16 * 1024);
        let view = this.pages.get(start);
        if (!view || position - start >= view.byteLength) {
            const limit = this.reader.fileSize ?? (position < this.end ? this.end : position + 1);
            const length = Math.min(16 * 1024, limit - start);
            if (!Number.isSafeInteger(position) || position < 0 || length <= position - start)
                throw new RangeError('Invalid fragment metadata offset.');
            const slice = await this.reader.requestSlice(start, length);
            if (this.reader.source._disposed)
                throw new InputDisposedError();
            if (!slice)
                throw new RangeError('Truncated fragment metadata page.');
            // Buffer.slice is a view. Always copy into an independent typed array.
            view = toDataView(new Uint8Array(readBytes(slice, length)));
        }
        this.pages.delete(start);
        this.pages.set(start, view);
        while (this.pages.size > 4)
            this.pages.delete(this.pages.keys().next().value!);
        return { view, offset: position - start };
    }
    private async byte(position: number) {
        const { view, offset } = await this.page(position);
        return view.getUint8(offset);
    }
    private async word(position: number, signed = false) {
        const { view, offset } = await this.page(position);
        if (offset + 4 <= view.byteLength)
            return signed ? view.getInt32(offset) : view.getUint32(offset);
        let value = 0;
        for (let i = 0; i < 4; i++)
            value = value * 256 + (await this.byte(position + i));
        return signed && value >= 2 ** 31 ? value - 2 ** 32 : value;
    }
    private async short(position: number) {
        return (await this.byte(position)) * 256 + (await this.byte(position + 1));
    }
    private async header(position: number, number: number, sampleStart: number): Promise<FragmentRun> {
        const slice = await this.reader.requestSliceRange(position, 8, Math.min(16, this.end - position));
        if (!slice)
            throw new RangeError('Truncated fragment run header.');
        const box = readBoxHeader(slice);
        if (!box || box.name !== 'trun')
            throw new RangeError('Expected a trun box.');
        const end = position + box.totalSize;
        if (!Number.isSafeInteger(end) || end > this.end || box.contentSize < 8)
            throw new RangeError('Invalid trun extent.');
        const content = slice.filePos;
        const versionFlags = await this.word(content);
        const version = versionFlags >>> 24;
        if (version > 1)
            throw new RangeError('Unsupported trun version.');
        const flags = versionFlags & 0xffffff;
        const count = await this.word(content + 4);
        let entries = content + 8;
        let dataOffset: number | null = null, firstFlags: number | null = null;
        if (flags & 1) {
            if (entries + 4 > end)
                throw new RangeError('Truncated trun offset.');
            dataOffset = await this.word(entries, true);
            entries += 4;
        }
        if (flags & 4) {
            if (entries + 4 > end)
                throw new RangeError('Truncated trun flags.');
            firstFlags = await this.word(entries);
            entries += 4;
        }
        const rowSize = 4 * (+!!(flags & 0x100) + +!!(flags & 0x200) + +!!(flags & 0x400) + +!!(flags & 0x800));
        if (count > Math.floor((end - entries) / (rowSize || 1)) && rowSize)
            throw new RangeError('Truncated trun samples.');
        if (count
            && ((!(flags & 0x100) && this.defaults.defaultSampleDuration === null)
                || (!(flags & 0x200) && this.defaults.defaultSampleSize === null)
                || (!(flags & 0x400) && this.defaults.defaultSampleFlags === null))) {
            throw new RangeError('Invalid trun box: sample values are missing and there are no defaults.');
        }
        return { start: position, end, entries, count, rowSize, flags, version, firstFlags, dataOffset, number, sampleStart };
    }
    private async nextRun(run: FragmentRun) {
        let position = run.end;
        while (position + 8 <= this.end) {
            const slice = await this.reader.requestSliceRange(position, 8, Math.min(16, this.end - position));
            if (!slice)
                throw new RangeError('Truncated traf header.');
            const box = readBoxHeader(slice);
            if (!box || !Number.isSafeInteger(position + box.totalSize) || position + box.totalSize > this.end)
                throw new RangeError('Invalid traf child extent.');
            if (box.name === 'trun')
                return this.header(position, run.number + 1, run.sampleStart + run.count);
            position += box.totalSize;
        }
        return null;
    }
    private async decode(cursor: FragmentCursor): Promise<FragmentRaw> {
        let { run, entry, time, offset } = cursor;
        while (entry >= run.count) {
            const next = await this.nextRun(run);
            if (!next)
                throw new RangeError('Missing fragment sample run.');
            run = next;
            entry = 0;
            if (run.dataOffset !== null)
                offset = this.base + run.dataOffset;
        }
        let duration = this.defaults.defaultSampleDuration!, size = this.defaults.defaultSampleSize!, flags = this.defaults.defaultSampleFlags!, composition = 0;
        if (run.rowSize) {
            let position = run.entries + entry * run.rowSize;
            const page = await this.page(position);
            let field = page.offset;
            const fits = field + run.rowSize <= page.view.byteLength;
            const read = async (signed = false) => {
                const value = fits
                    ? signed
                        ? page.view.getInt32(field)
                        : page.view.getUint32(field)
                    : await this.word(position, signed);
                field += 4;
                position += 4;
                return value;
            };
            if (run.flags & 0x100)
                duration = await read();
            if (run.flags & 0x200)
                size = await read();
            if (run.flags & 0x400)
                flags = await read();
            if (run.flags & 0x800)
                composition = await read(run.version === 1);
        }
        if (entry === 0 && run.firstFlags !== null)
            flags = run.firstFlags;
        if (!Number.isSafeInteger(time + duration)
            || !Number.isSafeInteger(time + composition)
            || !Number.isSafeInteger(offset)
            || offset < 0
            || !Number.isSafeInteger(offset + size))
            throw new RangeError('Unsafe fragment sample timestamp or offset.');
        return {
            index: cursor.index,
            decodeTimestamp: time,
            presentationTimestamp: time + composition,
            duration,
            byteOffset: offset,
            byteSize: size,
            isKeyFrame: !(flags & 0x10000),
            encryption: null,
            next: { index: cursor.index + 1, run, entry: entry + 1, time: time + duration, offset: offset + size },
        };
    }
    private bucket(cursor: FragmentCursor) {
        let bucket = this.buckets[this.buckets.length - 1];
        if (!bucket || bucket.count === this.stride) {
            if (this.buckets.length === 128) {
                const merged: FragmentBucket[] = [];
                for (let i = 0; i < this.buckets.length; i += 2) {
                    const left = this.buckets[i]!, right = this.buckets[i + 1]!;
                    merged.push({
                        cursor: left.cursor,
                        count: left.count + right.count,
                        min: Math.min(left.min, right.min),
                        max: Math.max(left.max, right.max),
                    });
                }
                this.buckets = merged;
                this.stride *= 2;
            }
            bucket = { cursor: { ...cursor }, count: 0, min: Infinity, max: -Infinity };
            this.buckets.push(bucket);
        }
        return bucket;
    }
    private rememberTime(timestamp: number, index: number) {
        if (this.manyTimes)
            return;
        this.smallTimes.set(timestamp, { last: index, next: null });
        if (this.smallTimes.size > 256) {
            this.smallTimes.clear();
            this.manyTimes = true;
        }
    }
    async addRun(position: number, time: number, offset: number) {
        const run = await this.header(position, this.runCount + 1, this.length);
        this.runCount++;
        if (run.dataOffset !== null)
            offset = this.base + run.dataOffset;
        let cursor: FragmentCursor = { index: this.length, run, entry: 0, time, offset };
        for (let i = 0; i < run.count;) {
            const bucket = this.bucket(cursor);
            // Default-only runs, including very large zero-duration runs, can be
            // summarized arithmetically without iterating one time per sample.
            if (run.rowSize === 0) {
                const length = Math.min(run.count - i, this.stride - bucket.count);
                const duration = this.defaults.defaultSampleDuration!;
                const size = this.defaults.defaultSampleSize!;
                const endTime = cursor.time + length * duration;
                const endOffset = cursor.offset + length * size;
                if (!Number.isSafeInteger(endTime) || !Number.isSafeInteger(endOffset) || cursor.offset < 0)
                    throw new RangeError('Unsafe fragment default totals.');
                const lastTime = cursor.time + (length - 1) * duration;
                bucket.min = Math.min(bucket.min, cursor.time);
                bucket.max = Math.max(bucket.max, lastTime);
                bucket.count += length;
                this.monotonic &&= cursor.time >= this.previousPresentation;
                this.previousPresentation = lastTime;
                this.startTimestamp = Math.min(this.startTimestamp, cursor.time);
                if (lastTime >= this.maxPresentation) {
                    this.maxPresentation = lastTime;
                    this.lastMaxDuration = duration;
                }
                const firstFlags = i === 0 && run.firstFlags !== null ? run.firstFlags : this.defaults.defaultSampleFlags!;
                const firstKey = !(firstFlags & 0x10000)
                    ? cursor.time
                    : length > 1 && !(this.defaults.defaultSampleFlags! & 0x10000)
                        ? cursor.time + duration
                        : null;
                if (firstKey !== null)
                    this.firstKeyFrameTimestamp = Math.min(this.firstKeyFrameTimestamp ?? Infinity, firstKey);
                if (duration === 0)
                    this.rememberTime(cursor.time, cursor.index + length - 1);
                else if (length <= 256 && !this.manyTimes)
                    for (let at = 0; at < length; at++)
                        this.rememberTime(cursor.time + at * duration, cursor.index + at);
                else {
                    this.manyTimes = true;
                    this.smallTimes.clear();
                }
                cursor = {
                    ...cursor,
                    index: cursor.index + length,
                    entry: cursor.entry + length,
                    time: endTime,
                    offset: endOffset,
                };
                i += length;
            }
            else {
                const sample = await this.decode(cursor);
                bucket.min = Math.min(bucket.min, sample.presentationTimestamp);
                bucket.max = Math.max(bucket.max, sample.presentationTimestamp);
                bucket.count++;
                this.monotonic &&= sample.presentationTimestamp >= this.previousPresentation;
                this.previousPresentation = sample.presentationTimestamp;
                this.startTimestamp = Math.min(this.startTimestamp, sample.presentationTimestamp);
                if (sample.presentationTimestamp >= this.maxPresentation) {
                    this.maxPresentation = sample.presentationTimestamp;
                    this.lastMaxDuration = sample.duration;
                }
                if (sample.isKeyFrame)
                    this.firstKeyFrameTimestamp = Math.min(this.firstKeyFrameTimestamp ?? Infinity, sample.presentationTimestamp);
                this.rememberTime(sample.presentationTimestamp, sample.index);
                cursor = sample.next;
                i++;
            }
        }
        this.length += run.count;
        if (!Number.isSafeInteger(this.length))
            throw new RangeError('Unsafe fragment sample count.');
        this.endTimestamp = this.maxPresentation + this.lastMaxDuration;
        if (this.length && !Number.isSafeInteger(this.endTimestamp))
            throw new RangeError('Unsafe fragment end timestamp.');
        return { time: cursor.time, offset: cursor.offset };
    }
    private async readRaw(index: number): Promise<FragmentRaw> {
        if (this.reader.source._disposed)
            throw new InputDisposedError();
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.length)
            throw new RangeError('Invalid fragment sample index.');
        const existing = this.rawCache.get(index);
        if (existing) {
            this.rawCache.delete(index);
            this.rawCache.set(index, existing);
            return existing;
        }
        let bucket = this.buckets[0]!;
        for (const entry of this.buckets) {
            if (entry.cursor.index > index)
                break;
            bucket = entry;
        }
        let cursor = bucket.cursor;
        if (this.cursor && this.cursor.index >= cursor.index && this.cursor.index <= index)
            cursor = this.cursor;
        for (const raw of this.rawCache.values())
            if (raw.next.index >= cursor.index && raw.next.index <= index)
                cursor = raw.next;
        let sample: FragmentRaw;
        do {
            // Jump within each default-only run, including after a run transition.
            if (!cursor.run.rowSize && cursor.entry < cursor.run.count) {
                const count = Math.min(index - cursor.index, cursor.run.count - cursor.entry - 1);
                cursor = {
                    ...cursor,
                    index: cursor.index + count,
                    entry: cursor.entry + count,
                    time: cursor.time + count * this.defaults.defaultSampleDuration!,
                    offset: cursor.offset + count * this.defaults.defaultSampleSize!,
                };
            }
            sample = await this.decode(cursor);
            cursor = sample.next;
        } while (sample.index < index);
        this.cursor = cursor;
        this.rawCache.set(index, sample);
        while (this.rawCache.size > 256)
            this.rawCache.delete(this.rawCache.keys().next().value!);
        return sample;
    }
    raw(index: number) {
        return this.run(() => this.readRaw(index));
    }
    referenceIndex(runNumber: number, sampleNumber: number) {
        return this.run(async () => {
            let run = this.buckets.find(bucket => bucket.cursor.run.number === runNumber)?.cursor.run;
            if (!run) {
                let position = this.start, number = 0, start = 0;
                while (position + 8 <= this.end) {
                    const slice = await this.reader.requestSliceRange(position, 8, Math.min(16, this.end - position));
                    if (!slice)
                        throw new RangeError('Truncated traf reference.');
                    const box = readBoxHeader(slice);
                    if (!box || position + box.totalSize > this.end)
                        throw new RangeError('Invalid traf reference.');
                    if (box.name === 'trun') {
                        const current = await this.header(position, ++number, start);
                        if (number === runNumber) {
                            run = current;
                            break;
                        }
                        start += current.count;
                    }
                    position += box.totalSize;
                }
            }
            return run && sampleNumber >= 1 && sampleNumber <= run.count ? run.sampleStart + sampleNumber - 1 : -1;
        });
    }
    private async scanBucket(bucket: FragmentBucket, visit: (sample: FragmentRaw) => void, targets: number[]) {
        let cursor = bucket.cursor;
        for (let i = 0; i < bucket.count;) {
            const sample = await this.decode(cursor);
            const run = sample.next.run, entry = sample.next.entry - 1;
            if (run.rowSize) {
                visit(sample);
                cursor = sample.next;
                i++;
                continue;
            }
            // A default-only span is an arithmetic sequence. Its endpoints and
            // neighbors of each search timestamp are sufficient for lookup and
            // presentation-duration calculation, even for billions of samples.
            const count = Math.min(bucket.count - i, run.count - entry);
            const duration = this.defaults.defaultSampleDuration!, size = this.defaults.defaultSampleSize!;
            const candidates = new Set([0, count - 1]);
            if (duration)
                for (const target of targets) {
                    const at = Math.floor((target - sample.presentationTimestamp) / duration);
                    for (const offset of [at, at + 1])
                        if (offset >= 0 && offset < count)
                            candidates.add(offset);
                }
            for (const offset of candidates)
                visit(offset === 0
                    ? sample
                    : await this.decode({
                        index: sample.index + offset,
                        run,
                        entry: entry + offset,
                        time: sample.decodeTimestamp + offset * duration,
                        offset: sample.byteOffset + offset * size,
                    }));
            cursor = {
                index: sample.index + count,
                run,
                entry: entry + count,
                time: sample.decodeTimestamp + count * duration,
                offset: sample.byteOffset + count * size,
            };
            i += count;
        }
    }
    find(timestamp: number, keyOnly = false) {
        return this.run(async () => {
            const target = timestamp - this.timestampOffset;
            let best = -1, time = -Infinity;
            if (this.monotonic) {
                let left = 0, right = this.length;
                while (left < right) {
                    const mid = Math.floor((left + right) / 2);
                    if ((await this.readRaw(mid)).presentationTimestamp <= target)
                        left = mid + 1;
                    else
                        right = mid;
                }
                if (!keyOnly)
                    return left - 1;
                for (let at = left - 1; at >= 0; at--) {
                    const raw = await this.readRaw(at);
                    if (raw.isKeyFrame)
                        return at;
                    if (!raw.next.run.rowSize && this.defaults.defaultSampleFlags! & 0x10000) {
                        at = raw.next.run.sampleStart + 1;
                        if (raw.index === raw.next.run.sampleStart)
                            at--;
                    }
                }
                return -1;
            }
            for (const bucket of this.buckets) {
                if (bucket.min > target || bucket.max < time)
                    continue;
                await this.scanBucket(bucket, sample => {
                    if ((!keyOnly || sample.isKeyFrame)
                        && sample.presentationTimestamp <= target
                        && (sample.presentationTimestamp > time
                            || (sample.presentationTimestamp === time && sample.index > best))) {
                        best = sample.index;
                        time = sample.presentationTimestamp;
                    }
                }, [target]);
            }
            return best;
        });
    }
    nextKey(index: number) {
        return this.run(async () => {
            for (let at = index + 1; at < this.length; at++) {
                const sample = await this.readRaw(at);
                if (sample.isKeyFrame)
                    return at;
                if (!sample.next.run.rowSize && this.defaults.defaultSampleFlags! & 0x10000) {
                    at = sample.next.run.sampleStart + sample.next.run.count - 1;
                }
            }
            return -1;
        });
    }
    private async duration(index: number, sample: FragmentRaw) {
        if (this.monotonic)
            return index + 1 < this.length
                ? (await this.readRaw(index + 1)).presentationTimestamp - sample.presentationTimestamp
                : sample.duration;
        if (!this.manyTimes) {
            const entry = this.smallTimes.get(sample.presentationTimestamp)!;
            if (index < entry.last)
                return 0;
            if (entry.next === null) {
                let next = Infinity;
                for (const time of this.smallTimes.keys())
                    if (time > sample.presentationTimestamp)
                        next = Math.min(next, time);
                entry.next = next;
            }
            return entry.next === Infinity ? sample.duration : entry.next - sample.presentationTimestamp;
        }
        const cached = this.durationCache.get(index);
        if (cached !== undefined)
            return cached;
        const start = Math.floor(index / 256) * 256, end = Math.min(this.length, start + 256);
        const targets: {
            raw: FragmentRaw;
            next: number;
            tied: boolean;
        }[] = [];
        for (let at = start; at < end; at++)
            targets.push({ raw: await this.readRaw(at), next: Infinity, tied: false });
        targets.sort((a, b) => a.raw.presentationTimestamp - b.raw.presentationTimestamp || a.raw.index - b.raw.index);
        for (let at = 0; at < targets.length - 1; at++) {
            targets[at]!.next = targets[at + 1]!.raw.presentationTimestamp;
            targets[at]!.tied = targets[at]!.next === targets[at]!.raw.presentationTimestamp;
        }
        const lastTarget = targets[targets.length - 1]!;
        lastTarget.next = this.maxPresentation > lastTarget.raw.presentationTimestamp ? this.maxPresentation : Infinity;
        // Neighboring decode samples give a tight upper bound for long reversed
        // runs, avoiding a whole-fragment pass for every duration window.
        for (const at of [start - 1, end])
            if (at >= 0 && at < this.length) {
                const neighbor = await this.readRaw(at);
                if (neighbor.presentationTimestamp > lastTarget.raw.presentationTimestamp)
                    lastTarget.next = Math.min(lastTarget.next, neighbor.presentationTimestamp);
            }
        const minimum = targets[0]!.raw.presentationTimestamp;
        const maximum = Math.max(...targets.map(target => target.next));
        for (const bucket of this.buckets) {
            if (bucket.max < minimum || bucket.min > maximum)
                continue;
            await this.scanBucket(bucket, raw => {
                let left = 0, right = targets.length;
                while (left < right) {
                    const mid = Math.floor((left + right) / 2);
                    if (targets[mid]!.raw.presentationTimestamp < raw.presentationTimestamp)
                        left = mid + 1;
                    else
                        right = mid;
                }
                if (left > 0)
                    targets[left - 1]!.next = Math.min(targets[left - 1]!.next, raw.presentationTimestamp);
                for (let at = left; at < targets.length && targets[at]!.raw.presentationTimestamp === raw.presentationTimestamp; at++) {
                    if (raw.index > targets[at]!.raw.index)
                        targets[at]!.tied = true;
                }
            }, targets.map(target => target.raw.presentationTimestamp));
        }
        for (const target of targets) {
            this.durationCache.set(target.raw.index, target.tied
                ? 0
                : target.next === Infinity
                    ? target.raw.duration
                    : target.next - target.raw.presentationTimestamp);
        }
        while (this.durationCache.size > 512)
            this.durationCache.delete(this.durationCache.keys().next().value!);
        return this.durationCache.get(index)!;
    }
    setSenc(start: number, end: number, count: number, subsamples: boolean) {
        this.senc = { start, end, count, subsamples };
        this.encryptionCheckpoints = null;
    }
    private async encryption(index: number): Promise<SampleEncryptionInfo | null> {
        const info = this.track?.encryptionInfo;
        if (!info)
            return null;
        const aux = this.aux;
        if (!this.senc && (!aux || aux.offset === null))
            return null;
        const count = Math.min(this.length, this.senc?.count ?? aux?.sampleCount ?? 0);
        if (index >= count)
            return null;
        const ivSize = info.defaultPerSampleIvSize;
        if (ivSize === null || ivSize < 0 || ivSize > 16)
            throw new RangeError('Missing fragment encryption IV size.');
        const start = this.senc?.start ?? aux?.offset;
        if (start === null || start === undefined)
            throw new RangeError('Incomplete fragment encryption offsets.');
        const sizeFor = async (at: number) => aux!.defaultSampleInfoSize
            || (aux!.sampleSizesOffset !== undefined
                ? await this.byte(aux!.sampleSizesOffset + at)
                : aux!.sampleSizes![at]!);
        const advance = async (at: number, position: number) => {
            if (!this.senc)
                return position + (await sizeFor(at));
            if (!this.senc.subsamples)
                return position + ivSize;
            const length = await this.short(position + ivSize);
            const end = position + ivSize + 2 + 6 * length;
            if (end > this.senc.end)
                throw new RangeError('Truncated senc subsamples.');
            return end;
        };
        let position: number;
        if (this.senc && !this.senc.subsamples)
            position = start + index * ivSize;
        else if (!this.senc && aux!.defaultSampleInfoSize)
            position = start + index * aux!.defaultSampleInfoSize;
        else {
            if (!this.encryptionCheckpoints) {
                const checkpoints = [];
                const stride = Math.max(1, Math.ceil(count / 128));
                let offset = start;
                for (let at = 0; at < count; at++) {
                    if (at % stride === 0)
                        checkpoints.push({ index: at, offset });
                    offset = await advance(at, offset);
                }
                this.encryptionCheckpoints = checkpoints;
            }
            const checkpoint = this.encryptionCheckpoints[Math.min(this.encryptionCheckpoints.length - 1, Math.floor(index / Math.max(1, Math.ceil(count / 128))))]!;
            position = checkpoint.offset;
            for (let at = checkpoint.index; at < index; at++)
                position = await advance(at, position);
        }
        const limit = this.senc?.end ?? position + (await sizeFor(index));
        if (!Number.isSafeInteger(position) || position < 0 || position + ivSize > limit)
            throw new RangeError('Truncated sample IV.');
        const iv = new Uint8Array(16);
        if (ivSize)
            for (let at = 0; at < ivSize; at++)
                iv[at] = await this.byte(position + at);
        else if (info.defaultConstantIv)
            iv.set(info.defaultConstantIv);
        else
            throw new RangeError('Missing constant sample IV.');
        position += ivSize;
        const hasSubsamples = this.senc?.subsamples ?? limit > position;
        let subsamples: SampleEncryptionInfo['subsamples'] = null;
        if (hasSubsamples) {
            const length = await this.short(position);
            position += 2;
            if (position + length * 6 > limit)
                throw new RangeError('Truncated sample encryption subsamples.');
            subsamples = [];
            for (let at = 0; at < length; at++) {
                subsamples.push({ clearLen: await this.short(position), protectedLen: await this.word(position + 2) });
                position += 6;
            }
        }
        return { iv, subsamples };
    }
    get(index: number, encrypted = true) {
        return this.run(async () => {
            const raw = await this.readRaw(index);
            return {
                ...raw,
                presentationTimestamp: raw.presentationTimestamp + this.timestampOffset,
                decodeDuration: raw.duration,
                duration: await this.duration(index, raw),
                encryption: encrypted ? await this.encryption(index) : null,
            };
        });
    }
}
class SampleTable {
    sampleCount = 0;
    decodeDuration = 0;
    private rawSampleCount = 0;
    private boxes = new Map<string, SampleTableBox>();
    private pages = new Map<number, DataView>();
    private timing: SampleTableRuns | null = null;
    private composition: SampleTableRuns | null = null;
    private chunks: SampleTableRuns | null = null;
    private minOffset = 0;
    private maxOffset = 0;
    private firstChunk = 0;
    private pcm = false;
    private keyCursor: {
        key: number;
        next: number;
        position: number;
    } | null = null;
    private sizeCursor: {
        chunk: number;
        index: number;
        offset: number;
    } | null = null;
    private reader: Reader;
    private pcmFrameSize: number | null;
    constructor(reader: Reader, pcmFrameSize: number | null) {
        this.reader = reader;
        this.pcmFrameSize = pcmFrameSize;
    }
    async addBox(name: string, start: number, end: number) {
        const isSize = name === 'stsz' || name === 'stz2';
        const headerSize = isSize ? 12 : 8;
        if (end - start < headerSize)
            throw new RangeError(`Truncated ${name} sample table.`);
        const slice = await this.reader.requestSlice(start, headerSize);
        if (!slice)
            throw new RangeError(`Truncated ${name} sample table.`);
        const version = readU8(slice);
        slice.skip(3);
        let constant = 0;
        let bits = name === 'stsc' ? 96 : name === 'stts' || name === 'ctts' || name === 'co64' ? 64 : 32;
        if (isSize) {
            const field = readU32Be(slice);
            if (name === 'stsz')
                constant = field;
            else {
                bits = field & 255;
                if (![4, 8, 16].includes(bits))
                    throw new RangeError('Invalid stz2 field size.');
            }
        }
        if (name === 'ctts' && version > 1)
            throw new RangeError('Invalid ctts version.');
        const count = readU32Be(slice);
        if (!constant && count > Math.floor((end - start - headerSize) * 8 / bits)) {
            throw new RangeError(`Truncated ${name} sample table.`);
        }
        const key = isSize ? 'size' : name === 'co64' ? 'stco' : name;
        if (this.boxes.has(key))
            throw new RangeError(`Duplicate ${name} sample table.`);
        this.boxes.set(key, { name, start: start + headerSize, count, bits, constant, signed: version === 1 });
    }
    private async row(box: SampleTableBox, index: number): Promise<number[]> {
        if (this.reader.source._disposed)
            throw new InputDisposedError();
        if (index < 0 || index >= box.count)
            throw new RangeError(`Invalid ${box.name} entry index.`);
        if (box.constant)
            return [box.constant];
        const entriesPerPage = Math.floor(16 * 1024 * 8 / box.bits);
        const first = Math.floor(index / entriesPerPage) * entriesPerPage;
        const start = box.start + first * box.bits / 8;
        let view = this.pages.get(start);
        if (!view) {
            const length = Math.ceil(Math.min(entriesPerPage, box.count - first) * box.bits / 8);
            const slice = await this.reader.requestSlice(start, length);
            if (this.reader.source._disposed)
                throw new InputDisposedError();
            if (!slice)
                throw new RangeError(`Truncated ${box.name} sample table.`);
            // Copy the page: a source cache may return a view into a much larger buffer.
            view = toDataView(readBytes(slice, length).slice());
        }
        this.pages.delete(start);
        this.pages.set(start, view);
        while (this.pages.size > 8)
            this.pages.delete(this.pages.keys().next().value!);
        const offset = (index - first) * box.bits / 8;
        if (box.bits === 4)
            return [(view.getUint8(Math.floor(offset)) >> (index % 2 === 0 ? 4 : 0)) & 15];
        if (box.bits === 8)
            return [view.getUint8(offset)];
        if (box.bits === 16)
            return [view.getUint16(offset)];
        if (box.name === 'co64') {
            const value = view.getUint32(offset) * 2 ** 32 + view.getUint32(offset + 4);
            if (!Number.isSafeInteger(value))
                throw new RangeError('Unsafe co64 chunk offset.');
            return [value];
        }
        const result = [view.getUint32(offset)];
        for (let field = 1; field < box.bits / 32; field++) {
            result.push(box.name === 'ctts' && box.signed
                ? view.getInt32(offset + field * 4) : view.getUint32(offset + field * 4));
        }
        return result;
    }
    private async run(box: SampleTableBox, entry: number, start: number, time: number): Promise<SampleTableRun> {
        const row = await this.row(box, entry);
        let count = row[0]!;
        const value = row[1]!;
        let chunk = 0;
        if (box.name === 'stsc') {
            chunk = row[0]! - 1;
            const next = entry + 1 < box.count ? (await this.row(box, entry + 1))[0]! - 1 : Infinity;
            if (chunk < 0 || next <= chunk || value === 0 || row[2] === 0) {
                throw new RangeError('Invalid stsc sample table.');
            }
            count = Math.max(0, Math.min(next, this.boxes.get('stco')?.count ?? 0) - chunk) * value;
        }
        if (!Number.isSafeInteger(start + count) || !Number.isSafeInteger(box.name === 'stts' ? time + count * value : time)) {
            throw new RangeError(`Unsafe ${box.name} sample table prefix.`);
        }
        return { entry, start, count, time, value, chunk };
    }
    private async summarize(box: SampleTableBox): Promise<SampleTableRuns> {
        const stride = Math.max(1, Math.ceil(box.count / 128));
        const checkpoints: SampleTableRun[] = [];
        let start = 0;
        let time = 0;
        for (let entry = 0; entry < box.count; entry++) {
            const run = await this.run(box, entry, start, time);
            if (entry % stride === 0)
                checkpoints.push(run);
            start += run.count;
            if (box.name === 'stts')
                time += run.count * run.value;
            if (box.name === 'ctts' && run.count > 0 && run.start < this.rawSampleCount) {
                this.minOffset = Math.min(this.minOffset, run.value);
                this.maxOffset = Math.max(this.maxOffset, run.value);
            }
        }
        return { box, checkpoints, window: [], total: start, duration: time };
    }
    async initialize() {
        const sizes = this.boxes.get('size');
        const timing = this.boxes.get('stts');
        const chunks = this.boxes.get('stsc');
        if (timing)
            this.timing = await this.summarize(timing);
        if (chunks)
            this.chunks = await this.summarize(chunks);
        this.rawSampleCount = sizes?.count ?? 0;
        if (this.rawSampleCount !== (this.timing?.total ?? 0)
            || this.rawSampleCount !== (this.chunks?.total ?? 0)) {
            throw new RangeError('Inconsistent MP4 sample counts in size, timing, or chunk tables.');
        }
        this.sampleCount = this.rawSampleCount;
        this.decodeDuration = this.timing?.duration ?? 0;
        const composition = this.boxes.get('ctts');
        if (composition?.count && this.rawSampleCount > 0) {
            this.minOffset = Infinity;
            this.maxOffset = -Infinity;
            this.composition = await this.summarize(composition);
            if (this.composition.total < this.rawSampleCount) {
                this.minOffset = Math.min(this.minOffset, 0);
                this.maxOffset = Math.max(this.maxOffset, 0);
            }
        }
        this.firstChunk = this.chunks?.checkpoints[0]?.chunk ?? 0;
        this.pcm = this.pcmFrameSize !== null && !this.composition && this.rawSampleCount > 0;
        if (this.pcm)
            this.sampleCount = Math.max(0, (this.boxes.get('stco')?.count ?? 0) - this.firstChunk);
    }
    private async locate(runs: SampleTableRuns, target: number, coordinate: 'start' | 'time' | 'chunk' = 'start') {
        let low = 0;
        let high = runs.checkpoints.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (runs.checkpoints[mid]![coordinate] <= target)
                low = mid + 1;
            else
                high = mid;
        }
        let run = runs.checkpoints[Math.max(0, low - 1)]!;
        const windowIndex = binarySearchLessOrEqual(runs.window, target, entry => entry[coordinate]);
        const cached = runs.window[windowIndex];
        if (cached && cached.entry > run.entry)
            run = cached;
        while (run.entry + 1 < runs.box.count) {
            // Avoid reading the next run on ordinary sequential packet access.
            if (coordinate === 'start' && run.start + run.count > target)
                break;
            if (coordinate === 'time' && run.time + run.count * run.value > target)
                break;
            const next = runs.window[run.entry + 1 - (runs.window[0]?.entry ?? -1)]
                ?? await this.run(runs.box, run.entry + 1, run.start + run.count, runs.box.name === 'stts' ? run.time + run.count * run.value : 0);
            this.cacheRun(runs, next);
            if (next[coordinate] > target)
                break;
            run = next;
        }
        this.cacheRun(runs, run);
        return run;
    }
    private cacheRun(runs: SampleTableRuns, run: SampleTableRun) {
        const first = runs.window[0];
        const last = runs.window[runs.window.length - 1];
        if (!first || !last || run.entry < first.entry || run.entry > last.entry + 1) {
            runs.window = [run];
        }
        else if (run.entry === last.entry + 1) {
            runs.window.push(run);
            if (runs.window.length > 256)
                runs.window.shift();
        }
    }
    private async decodeIndex(timestamp: number) {
        if (!this.rawSampleCount || timestamp < 0)
            return -1;
        const run = await this.locate(this.timing!, timestamp, 'time');
        return Math.min(this.rawSampleCount - 1, run.start + (run.value === 0
            ? run.count - 1 : Math.min(run.count - 1, Math.floor((timestamp - run.time) / run.value))));
    }
    private async decodeTime(index: number) {
        const run = await this.locate(this.timing!, index);
        return run.time + (index - run.start) * run.value;
    }
    private async offset(index: number) {
        if (!this.composition || index >= this.composition.total)
            return 0;
        return (await this.locate(this.composition, index)).value;
    }
    private async presentationTime(index: number) {
        return await this.decodeTime(index) + await this.offset(index);
    }
    private async keyIndex(index: number, next = false) {
        const keys = this.boxes.get('stss');
        if (!keys)
            return next ? index + 1 : index;
        let cursor = this.keyCursor;
        if (cursor && index === cursor.next) {
            const position = cursor.position + 1;
            cursor = { key: index, next: position + 1 < keys.count
                    ? (await this.row(keys, position + 1))[0]! - 1 : Infinity, position };
        }
        if (!cursor || index < cursor.key || index >= cursor.next) {
            let low = 0;
            let high = keys.count;
            while (low < high) {
                const mid = Math.floor((low + high) / 2);
                if ((await this.row(keys, mid))[0]! - 1 <= index)
                    low = mid + 1;
                else
                    high = mid;
            }
            cursor = { key: low > 0 ? (await this.row(keys, low - 1))[0]! - 1 : -1,
                next: low < keys.count ? (await this.row(keys, low))[0]! - 1 : Infinity, position: low - 1 };
        }
        this.keyCursor = cursor;
        // An stss table can explicitly exclude sample zero, or contain no sync samples.
        return next ? (cursor.next === Infinity ? -1 : cursor.next) : index >= 0 ? cursor.key : -1;
    }
    async getNextKeyframeIndex(index: number) {
        return this.keyIndex(index, true);
    }
    async getSampleIndexForTimestamp(timestamp: number, keyOnly = false) {
        let index = await this.decodeIndex(timestamp - this.maxOffset);
        if (keyOnly)
            index = await this.keyIndex(index);
        if (this.composition) {
            // Bound the search using the global composition-offset range. This also
            // handles signed offsets, ties and reordered/overlapping CTTS runs without
            // a sorted, per-sample presentation-time index.
            let best = index;
            let bestTime = index >= 0 ? await this.presentationTime(index) : -Infinity;
            let candidate = Math.max(0, await this.decodeIndex(bestTime - this.maxOffset - 1) + 1);
            if (keyOnly) {
                const key = await this.keyIndex(candidate);
                candidate = key < candidate ? await this.keyIndex(candidate, true) : key;
            }
            const end = await this.decodeIndex(timestamp - this.minOffset);
            while (candidate >= 0 && candidate <= end) {
                const time = await this.presentationTime(candidate);
                if (time <= timestamp && (time > bestTime || (time === bestTime && candidate > best))) {
                    best = candidate;
                    bestTime = time;
                }
                candidate = keyOnly ? await this.keyIndex(candidate, true) : candidate + 1;
            }
            index = best;
        }
        else if (keyOnly)
            index = await this.keyIndex(index);
        if (this.pcm && index >= 0) {
            const run = await this.locate(this.chunks!, index);
            index = run.chunk + Math.floor((index - run.start) / run.value) - this.firstChunk;
        }
        return index;
    }
    private async nextPresentationTime(index: number, timestamp: number) {
        const beyond = await this.decodeIndex(timestamp - this.minOffset) + 1;
        let best = beyond < this.rawSampleCount ? await this.presentationTime(beyond) : Infinity;
        let candidate = Math.max(0, await this.decodeIndex(timestamp - this.maxOffset - 1) + 1);
        while (candidate < this.rawSampleCount) {
            const decode = await this.decodeTime(candidate);
            if (decode + this.minOffset > best)
                break;
            const time = decode + await this.offset(candidate);
            if ((time > timestamp || (time === timestamp && candidate > index)) && time < best)
                best = time;
            candidate++;
        }
        return best === Infinity ? null : best;
    }
    async getSampleInfo(index: number) {
        if (index < 0 || index >= this.sampleCount)
            return null;
        let rawIndex = index;
        let run: SampleTableRun;
        let chunk: number;
        if (this.pcm) {
            chunk = index + this.firstChunk;
            run = await this.locate(this.chunks!, chunk, 'chunk');
            rawIndex = run.start + (chunk - run.chunk) * run.value;
        }
        else {
            run = await this.locate(this.chunks!, index);
            chunk = run.chunk + Math.floor((index - run.start) / run.value);
        }
        const chunkOffset = (await this.row(this.boxes.get('stco')!, chunk))[0]!;
        const timing = await this.locate(this.timing!, rawIndex);
        const presentationTimestamp = await this.presentationTime(rawIndex);
        let duration = timing.value;
        const sizes = this.boxes.get('size')!;
        const sampleSize = this.pcm ? run.value * this.pcmFrameSize! : (await this.row(sizes, index))[0]!;
        let sampleOffset = chunkOffset;
        if (this.pcm) {
            duration = await this.decodeTime(rawIndex + run.value) - presentationTimestamp;
        }
        else {
            let from = run.start + (chunk - run.chunk) * run.value;
            if (this.sizeCursor?.chunk === chunk && this.sizeCursor.index <= index) {
                from = this.sizeCursor.index;
                sampleOffset = this.sizeCursor.offset;
            }
            if (sizes.constant)
                sampleOffset += (index - from) * sizes.constant;
            else
                for (let sample = from; sample < index; sample++)
                    sampleOffset += (await this.row(sizes, sample))[0]!;
            this.sizeCursor = { chunk, index: index + 1, offset: sampleOffset + sampleSize };
            if (this.composition) {
                const next = await this.nextPresentationTime(index, presentationTimestamp);
                if (next !== null)
                    duration = next - presentationTimestamp;
            }
        }
        if (!Number.isSafeInteger(sampleOffset) || !Number.isSafeInteger(sampleOffset + sampleSize)) {
            throw new RangeError('Unsafe sample byte offset.');
        }
        return { presentationTimestamp, duration, decodeDuration: this.pcm ? duration : timing.value, sampleOffset, sampleSize, chunkOffset,
            isKeyFrame: await this.keyIndex(index) === index };
    }
}
/** A TFRA kept on the input, with four copied 16 KiB LRU pages. */
class FragmentLookupTable {
    private orderPromise: Promise<void> | null = null;
    private timestampsOrdered = true;
    private offsetsOrdered = true;
    private offsetCursor: {
        index: number;
        entry: FragmentLookupTableEntry;
    } | null = null;
    private pages = new Map<number, DataView>();
    private reader: Reader;
    public trackId: number;
    private start: number;
    private count: number;
    private version: number;
    private widths: number[];
    private entrySize: number;
    constructor(reader: Reader, trackId: number, start: number, count: number, version: number, widths: number[], entrySize: number) {
        this.reader = reader;
        this.trackId = trackId;
        this.start = start;
        this.count = count;
        this.version = version;
        this.widths = widths;
        this.entrySize = entrySize;
    }
    static async read(reader: Reader, start: number, end: number) {
        if (end - start < 16)
            throw new RangeError('Truncated tfra header.');
        const slice = await reader.requestSlice(start, 16);
        if (!slice)
            throw new RangeError('Truncated tfra header.');
        const version = readU8(slice);
        if (version > 1)
            throw new RangeError('Unsupported tfra version.');
        slice.skip(3);
        const trackId = readU32Be(slice);
        const word = readU32Be(slice);
        const widths = [(word >> 4 & 3) + 1, (word >> 2 & 3) + 1, (word & 3) + 1];
        const count = readU32Be(slice);
        const entrySize = (version === 1 ? 16 : 8) + widths[0]! + widths[1]! + widths[2]!;
        if (count > Math.floor((end - start - 16) / entrySize))
            throw new RangeError('Truncated tfra entries.');
        return new FragmentLookupTable(reader, trackId, start + 16, count, version, widths, entrySize);
    }
    async at(index: number): Promise<FragmentLookupTableEntry | null> {
        if (this.reader.source._disposed)
            throw new InputDisposedError();
        if (!Number.isInteger(index) || index < 0 || index >= this.count)
            return null;
        const entriesPerPage = Math.floor(FRAGMENT_INDEX_PAGE_SIZE / this.entrySize);
        const first = Math.floor(index / entriesPerPage) * entriesPerPage;
        let view = this.pages.get(first);
        if (!view) {
            const length = Math.min(entriesPerPage, this.count - first) * this.entrySize;
            const slice = await this.reader.requestSlice(this.start + first * this.entrySize, length);
            if (this.reader.source._disposed)
                throw new InputDisposedError();
            if (!slice)
                throw new RangeError('Truncated tfra page.');
            view = toDataView(new Uint8Array(readBytes(slice, length)));
        }
        this.pages.delete(first);
        this.pages.set(first, view);
        while (this.pages.size > MAX_FRAGMENT_INDEX_PAGES)
            this.pages.delete(this.pages.keys().next().value!);
        let offset = (index - first) * this.entrySize;
        const readWord = (width: number) => {
            let value = 0;
            for (let i = 0; i < width; i++)
                value = value * 256 + view!.getUint8(offset++);
            if (!Number.isSafeInteger(value))
                throw new RangeError('Unsafe tfra timestamp or offset.');
            return value;
        };
        const timestamp = readWord(this.version === 1 ? 8 : 4);
        const moofOffset = readWord(this.version === 1 ? 8 : 4);
        readWord(this.widths[0]!); // Traf number is redundant with the matched track ID.
        const trunNumber = readWord(this.widths[1]!);
        const sampleNumber = readWord(this.widths[2]!);
        return { timestamp, moofOffset, trunNumber, sampleNumber };
    }
    private ensureOrder() {
        return this.orderPromise ??= (async () => {
            let previous: FragmentLookupTableEntry | null = null;
            let timestampsOrdered = true;
            let offsetsOrdered = true;
            for (let index = 0; index < this.count; index++) {
                const entry = (await this.at(index))!;
                if (previous) {
                    timestampsOrdered &&= previous.timestamp <= entry.timestamp;
                    offsetsOrdered &&= previous.moofOffset <= entry.moofOffset;
                }
                previous = entry;
            }
            this.timestampsOrdered = timestampsOrdered;
            this.offsetsOrdered = offsetsOrdered;
        })().catch((error) => {
            this.orderPromise = null;
            throw error;
        });
    }
    private async bound(value: number, field: 'timestamp' | 'moofOffset', inclusive: boolean) {
        let low = 0;
        let high = this.count;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            const entry = (await this.at(mid))!;
            if (entry[field] < value || (inclusive && entry[field] === value))
                low = mid + 1;
            else
                high = mid;
        }
        return low;
    }
    async findTimestamp(timestamp: number): Promise<{
        entry: FragmentLookupTableEntry;
        index: number;
    } | null> {
        if (timestamp === -Infinity)
            return null;
        await this.ensureOrder();
        if (!this.timestampsOrdered) {
            let best: {
                index: number;
                entry: FragmentLookupTableEntry;
            } | null = null;
            for (let index = 0; index < this.count; index++) {
                const entry = (await this.at(index))!;
                if (entry.trunNumber >= 1 && entry.sampleNumber >= 1 && entry.timestamp <= timestamp
                    && (!best || entry.timestamp > best.entry.timestamp))
                    best = { entry, index };
            }
            return best;
        }
        let index = await this.bound(timestamp, 'timestamp', true) - 1;
        while (index >= 0) {
            const time = (await this.at(index))!.timestamp;
            const first = await this.bound(time, 'timestamp', false);
            // Stable deduplication: use the first valid source entry at this time.
            for (let candidate = first; candidate <= index; candidate++) {
                const entry = (await this.at(candidate))!;
                if (entry.trunNumber >= 1 && entry.sampleNumber >= 1)
                    return { entry, index: candidate };
            }
            index = first - 1;
        }
        return null;
    }
    async findOffset(offset: number) {
        await this.ensureOrder();
        if (!this.offsetsOrdered) {
            for (let index = 0; index < this.count; index++) {
                const entry = (await this.at(index))!;
                if (entry.moofOffset === offset && entry.trunNumber >= 1 && entry.sampleNumber >= 1)
                    return entry;
            }
            return null;
        }
        if (this.offsetCursor && this.offsetCursor.entry.moofOffset <= offset) {
            for (let step = 0; step < 4; step++) {
                const index = this.offsetCursor.index + step;
                const entry = await this.at(index);
                if (!entry || entry.moofOffset > offset)
                    break;
                if (entry.moofOffset === offset && entry.trunNumber >= 1 && entry.sampleNumber >= 1) {
                    this.offsetCursor = { index, entry };
                    return entry;
                }
            }
        }
        let index = await this.bound(offset, 'moofOffset', false);
        while (index < this.count) {
            const entry = (await this.at(index))!;
            if (entry.moofOffset !== offset)
                break;
            if (entry.trunNumber >= 1 && entry.sampleNumber >= 1) {
                this.offsetCursor = { index, entry };
                return entry;
            }
            index++;
        }
        return null;
    }
}
