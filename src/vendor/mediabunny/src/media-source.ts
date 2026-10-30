/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Subset migrated from patched Mediabunny 1.62.1; see THIRD_PARTY_NOTICES.md at the package root.
import { AUDIO_CODECS, type AudioCodec, type MediaCodec, SUBTITLE_CODECS, type SubtitleCodec, VIDEO_CODECS, type VideoCodec } from './codec';
import { OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack } from './output';
import { EncodedPacket } from './packet';
/**
 * Base class for media sources. Media sources are used to add media samples to an output file.
 * @group Media sources
 * @public
 */
export abstract class MediaSource {
    /** @internal */
    abstract readonly _codec: MediaCodec;
    /** @internal */
    _connectedTrack: OutputTrack | null = null;
    /** @internal */
    _closingPromise: Promise<void> | null = null;
    /** @internal */
    _closed = false;
    /**
     * Set when the encoder is configured with a bitrate.
     * @internal
     */
    _nominalBitrate: number | null = null;
    /** @internal */
    _ensureValidAdd() {
        if (!this._connectedTrack) {
            throw new Error('Source is not connected to an output track.');
        }
        if (this._connectedTrack.output.state === 'canceled') {
            throw new Error('Output has been canceled.');
        }
        if (this._connectedTrack.output.state === 'finalizing' || this._connectedTrack.output.state === 'finalized') {
            throw new Error('Output has been finalized.');
        }
        if (this._connectedTrack.output.state === 'pending') {
            throw new Error('Output has not started.');
        }
        if (this._closed) {
            throw new Error('Source is closed.');
        }
    }
    /** @internal */
    async _start() { }
    /** @internal */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async _flushAndClose(forceClose: boolean) { }
    /**
     * Closes this source. This prevents future samples from being added and signals to the output file that no further
     * samples will come in for this track. Calling `.close()` is optional but recommended after adding the
     * last sample - for improved performance and reduced memory usage.
     */
    close() {
        if (this._closingPromise) {
            return;
        }
        const connectedTrack = this._connectedTrack;
        if (!connectedTrack) {
            throw new Error('Cannot call close without connecting the source to an output track.');
        }
        if (connectedTrack.output.state === 'pending') {
            throw new Error('Cannot call close before output has been started.');
        }
        this._closingPromise = (async () => {
            await this._flushAndClose(false);
            this._closed = true;
            if (connectedTrack.output.state === 'canceled' || connectedTrack.output.state === 'finalizing'
                || connectedTrack.output.state === 'finalized') {
                return;
            }
            await connectedTrack.output._muxer.onTrackClose(connectedTrack);
        })();
        // close() is synchronous; retain the rejection for finalize/cancel while observing it immediately.
        void this._closingPromise.catch(() => { });
    }
    /** @internal */
    async _flushOrWaitForOngoingClose(forceClose: boolean) {
        return this._closingPromise ??= (async () => {
            await this._flushAndClose(forceClose);
            this._closed = true;
        })();
    }
}
/**
 * Base class for video sources - sources for video tracks.
 * @group Media sources
 * @public
 */
export abstract class VideoSource extends MediaSource {
    /** @internal */
    declare _connectedTrack: OutputVideoTrack | null;
    /** @internal */
    override readonly _codec: VideoCodec;
    /** Internal constructor. */
    constructor(codec: VideoCodec) {
        super();
        if (!VIDEO_CODECS.includes(codec)) {
            throw new TypeError(`Invalid video codec '${codec}'. Must be one of: ${VIDEO_CODECS.join(', ')}.`);
        }
        this._codec = codec;
    }
}
const maybeEnsureIsKeyPacket = (track: OutputVideoTrack, packet: EncodedPacket) => {
    if (track.metadata.hasOnlyKeyPackets && packet.type !== 'key') {
        throw new Error('Cannot add non-key packets to a hasOnlyKeyPackets video track.');
    }
};
/**
 * The most basic video source; can be used to directly pipe encoded packets into the output file.
 * @group Media sources
 * @public
 */
export class EncodedVideoPacketSource extends VideoSource {
    /** Creates a new {@link EncodedVideoPacketSource} whose packets are encoded using `codec`. */
    constructor(codec: VideoCodec) {
        super(codec);
    }
    /**
     * Adds an encoded packet to the output video track. Packets must be added in *decode order*, while a packet's
     * timestamp must be its *presentation timestamp*. B-frames are handled automatically.
     *
     * @param meta - Additional metadata from the encoder. You should pass this for the first call, including a valid
     * decoder config.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) {
        if (!(packet instanceof EncodedPacket)) {
            throw new TypeError('packet must be an EncodedPacket.');
        }
        if (packet.isMetadataOnly) {
            throw new TypeError('Metadata-only packets cannot be added.');
        }
        if (meta !== undefined && (!meta || typeof meta !== 'object')) {
            throw new TypeError('meta, when provided, must be an object.');
        }
        this._ensureValidAdd();
        maybeEnsureIsKeyPacket(this._connectedTrack!, packet);
        return this._connectedTrack!.output._muxer.addEncodedVideoPacket(this._connectedTrack!, packet, meta);
    }
}
/**
 * Base class for audio sources - sources for audio tracks.
 * @group Media sources
 * @public
 */
export abstract class AudioSource extends MediaSource {
    /** @internal */
    declare _connectedTrack: OutputAudioTrack | null;
    /** @internal */
    override readonly _codec: AudioCodec;
    /** Internal constructor. */
    constructor(codec: AudioCodec) {
        super();
        if (!AUDIO_CODECS.includes(codec)) {
            throw new TypeError(`Invalid audio codec '${codec}'. Must be one of: ${AUDIO_CODECS.join(', ')}.`);
        }
        this._codec = codec;
    }
}
/**
 * The most basic audio source; can be used to directly pipe encoded packets into the output file.
 * @group Media sources
 * @public
 */
export class EncodedAudioPacketSource extends AudioSource {
    /** Creates a new {@link EncodedAudioPacketSource} whose packets are encoded using `codec`. */
    constructor(codec: AudioCodec) {
        super(codec);
    }
    /**
     * Adds an encoded packet to the output audio track. Packets must be added in *decode order*.
     *
     * @param meta - Additional metadata from the encoder. You should pass this for the first call, including a valid
     * decoder config.
     *
     * @returns A Promise that resolves once the output is ready to receive more samples. You should await this Promise
     * to respect writer and encoder backpressure.
     */
    add(packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) {
        if (!(packet instanceof EncodedPacket)) {
            throw new TypeError('packet must be an EncodedPacket.');
        }
        if (packet.isMetadataOnly) {
            throw new TypeError('Metadata-only packets cannot be added.');
        }
        if (meta !== undefined && (!meta || typeof meta !== 'object')) {
            throw new TypeError('meta, when provided, must be an object.');
        }
        this._ensureValidAdd();
        return this._connectedTrack!.output._muxer.addEncodedAudioPacket(this._connectedTrack!, packet, meta);
    }
}
/**
 * Base class for subtitle sources - sources for subtitle tracks.
 * @group Media sources
 * @public
 */
export abstract class SubtitleSource extends MediaSource {
    /** @internal */
    declare _connectedTrack: OutputSubtitleTrack | null;
    /** @internal */
    override readonly _codec: SubtitleCodec;
    /** Internal constructor. */
    constructor(codec: SubtitleCodec) {
        super();
        if (!SUBTITLE_CODECS.includes(codec)) {
            throw new TypeError(`Invalid subtitle codec '${codec}'. Must be one of: ${SUBTITLE_CODECS.join(', ')}.`);
        }
        this._codec = codec;
    }
}
