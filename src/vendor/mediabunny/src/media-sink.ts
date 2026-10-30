/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Subset migrated from patched Mediabunny 1.62.1; see THIRD_PARTY_NOTICES.md at the package root.
import { InputDisposedError } from './input';
import { InputTrack } from './input-track';
import { assert, isNumber, promiseWithResolvers } from './misc';
import { EncodedPacket } from './packet';
/**
 * Additional options for controlling packet retrieval.
 * @group Media sinks
 * @public
 */
export type PacketRetrievalOptions = {
    /**
     * When set to `true`, only packet metadata (like timestamp) will be retrieved - the actual packet data will not
     * be loaded.
     */
    metadataOnly?: boolean | undefined;
    /**
     * When set to `true`, key packets will be verified upon retrieval by looking into the packet's bitstream.
     * If not enabled, the packet types will be determined solely by what's stored in the containing file and may be
     * incorrect, potentially leading to decoder errors. Since determining a packet's actual type requires looking into
     * its data, this option cannot be enabled together with `metadataOnly`.
     */
    verifyKeyPackets?: boolean | undefined;
    /**
     * When querying packets in live media that are in the future relative to the current live edge, Mediabunny will,
     * by default, wait for the stream to advance until the query can be satisfied. In a sense, Mediabunny simply treats
     * live streams as media files that are still being written, and any read that depends on future information will
     * wait until it can be fulfilled.
     *
     * If you want to query packets based only on the currently known information, set this field to `true` - this way,
     * Mediabunny will never wait for the live stream to catch up.
     *
     * For non-live media, this field has no effect.
     */
    skipLiveWait?: boolean | undefined;
};
const validatePacketRetrievalOptions = (options: PacketRetrievalOptions) => {
    if (!options || typeof options !== 'object') {
        throw new TypeError('options must be an object.');
    }
    if (options.metadataOnly !== undefined && typeof options.metadataOnly !== 'boolean') {
        throw new TypeError('options.metadataOnly, when defined, must be a boolean.');
    }
    if (options.verifyKeyPackets !== undefined && typeof options.verifyKeyPackets !== 'boolean') {
        throw new TypeError('options.verifyKeyPackets, when defined, must be a boolean.');
    }
    if (options.verifyKeyPackets && options.metadataOnly) {
        throw new TypeError('options.verifyKeyPackets and options.metadataOnly cannot be enabled together.');
    }
    if (options.skipLiveWait !== undefined && typeof options.skipLiveWait !== 'boolean') {
        throw new TypeError('options.skipLiveWait, when defined, must be a boolean.');
    }
};
const validateTimestamp = (timestamp: number) => {
    if (!isNumber(timestamp)) {
        throw new TypeError('timestamp must be a number.'); // It can be non-finite, that's fine
    }
};
const maybeFixPacketType = (track: InputTrack, promise: Promise<EncodedPacket | null>, options: PacketRetrievalOptions) => {
    if (options.verifyKeyPackets) {
        return promise.then(async (packet) => {
            if (!packet || packet.type === 'delta') {
                return packet;
            }
            const determinedType = await track.determinePacketType(packet);
            if (determinedType) {
                // @ts-expect-error Technically readonly
                packet.type = determinedType;
            }
            return packet;
        });
    }
    else {
        return promise;
    }
};
/**
 * Sink for retrieving encoded packets from an input track.
 * @group Media sinks
 * @public
 */
export class EncodedPacketSink {
    /** @internal */
    _track: InputTrack;
    /** Creates a new {@link EncodedPacketSink} for the given {@link InputTrack}. */
    constructor(track: InputTrack) {
        if (!(track instanceof InputTrack)) {
            throw new TypeError('track must be an InputTrack.');
        }
        this._track = track;
    }
    /**
     * Retrieves the track's first packet (in decode order), or null if it has no packets. The first packet is very
     * likely to be a key packet, but it doesn't have to be.
     */
    async getFirstPacket(options: PacketRetrievalOptions = {}) {
        validatePacketRetrievalOptions(options);
        if (this._track.input._disposed) {
            throw new InputDisposedError();
        }
        return maybeFixPacketType(this._track, this._track._backing.getFirstPacket(options), options);
    }
    /** Retrieves the track's first key packet (in decode order), or null if it has no key packets. */
    async getFirstKeyPacket(options: PacketRetrievalOptions = {}) {
        validatePacketRetrievalOptions(options);
        const firstPacket = await this.getFirstPacket(options);
        if (!firstPacket) {
            return null;
        }
        if (firstPacket.type === 'key') {
            // Great
            return firstPacket;
        }
        return this.getNextKeyPacket(firstPacket, options);
    }
    /**
     * Retrieves the packet corresponding to the given timestamp, in seconds. More specifically, returns the last packet
     * (in presentation order) with a start timestamp less than or equal to the given timestamp. This method can be
     * used to retrieve a track's last packet using `getPacket(Infinity)`. The method returns null if the timestamp
     * is before the first packet in the track.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getPacket(timestamp: number, options: PacketRetrievalOptions = {}) {
        validateTimestamp(timestamp);
        validatePacketRetrievalOptions(options);
        if (this._track.input._disposed) {
            throw new InputDisposedError();
        }
        return maybeFixPacketType(this._track, this._track._backing.getPacket(timestamp, options), options);
    }
    /**
     * Retrieves the packet following the given packet (in decode order), or null if the given packet is the
     * last packet.
     */
    async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions = {}) {
        if (!(packet instanceof EncodedPacket)) {
            throw new TypeError('packet must be an EncodedPacket.');
        }
        validatePacketRetrievalOptions(options);
        if (this._track.input._disposed) {
            throw new InputDisposedError();
        }
        return maybeFixPacketType(this._track, this._track._backing.getNextPacket(packet, options), options);
    }
    /**
     * Retrieves the key packet corresponding to the given timestamp, in seconds. More specifically, returns the last
     * key packet (in presentation order) with a start timestamp less than or equal to the given timestamp. A key packet
     * is a packet that doesn't require previous packets to be decoded. This method can be used to retrieve a track's
     * last key packet using `getKeyPacket(Infinity)`. The method returns null if the timestamp is before the first
     * key packet in the track.
     *
     * To ensure that the returned packet is guaranteed to be a real key frame, enable `options.verifyKeyPackets`.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getKeyPacket(timestamp: number, options: PacketRetrievalOptions = {}): Promise<EncodedPacket | null> {
        validateTimestamp(timestamp);
        validatePacketRetrievalOptions(options);
        if (this._track.input._disposed) {
            throw new InputDisposedError();
        }
        if (!options.verifyKeyPackets) {
            return this._track._backing.getKeyPacket(timestamp, options);
        }
        let packet = await this._track._backing.getKeyPacket(timestamp, options);
        while (packet) {
            assert(packet.type === 'key');
            const determinedType = await this._track.determinePacketType(packet);
            if (determinedType !== 'delta') {
                return packet;
            }
            // Try the previous key packet instead (in hopes that it's actually a key packet)
            let step = 1 / await this._track.getTimeResolution();
            let previousPacket: EncodedPacket | null;
            while (true) {
                previousPacket = await this._track._backing.getKeyPacket(packet.timestamp - step, options);
                if (!previousPacket || previousPacket.timestamp < packet.timestamp) {
                    break;
                }
                // Huge timestamps, the step wasn't enough to move us, try again
                step *= 2;
            }
            packet = previousPacket;
        }
        return null;
    }
    /**
     * Retrieves the key packet following the given packet (in decode order), or null if the given packet is the last
     * key packet.
     *
     * To ensure that the returned packet is guaranteed to be a real key frame, enable `options.verifyKeyPackets`.
     */
    async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions = {}): Promise<EncodedPacket | null> {
        if (!(packet instanceof EncodedPacket)) {
            throw new TypeError('packet must be an EncodedPacket.');
        }
        validatePacketRetrievalOptions(options);
        if (this._track.input._disposed) {
            throw new InputDisposedError();
        }
        if (!options.verifyKeyPackets) {
            return this._track._backing.getNextKeyPacket(packet, options);
        }
        let nextPacket = await this._track._backing.getNextKeyPacket(packet, options);
        while (nextPacket) {
            assert(nextPacket.type === 'key');
            const determinedType = await this._track.determinePacketType(nextPacket);
            if (determinedType !== 'delta') {
                return nextPacket;
            }
            // Try the next key packet instead (in hopes that it's actually a key packet)
            nextPacket = await this._track._backing.getNextKeyPacket(nextPacket, options);
        }
        return null;
    }
    /**
     * Creates an async iterator that yields the packets in this track in decode order. To enable fast iteration, this
     * method will intelligently preload packets based on the speed of the consumer.
     *
     * @param startPacket - (optional) The packet from which iteration should begin. This packet will also be yielded.
     * @param endPacket - (optional) The packet at which iteration should end. This packet will _not_ be yielded.
     */
    packets(startPacket?: EncodedPacket, endPacket?: EncodedPacket, options: PacketRetrievalOptions = {}): AsyncGenerator<EncodedPacket, void, unknown> {
        if (startPacket !== undefined && !(startPacket instanceof EncodedPacket)) {
            throw new TypeError('startPacket must be an EncodedPacket.');
        }
        if (startPacket !== undefined && startPacket.isMetadataOnly && !options?.metadataOnly) {
            throw new TypeError('startPacket can only be metadata-only if options.metadataOnly is enabled.');
        }
        if (endPacket !== undefined && !(endPacket instanceof EncodedPacket)) {
            throw new TypeError('endPacket must be an EncodedPacket.');
        }
        validatePacketRetrievalOptions(options);
        if (this._track.input._disposed) {
            throw new InputDisposedError();
        }
        const packetQueue: EncodedPacket[] = [];
        let { promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers();
        let { promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers();
        let ended = false;
        let terminated = false;
        // This stores errors that are "out of band" in the sense that they didn't occur in the normal flow of this
        // method but instead in a different context. This error should not go unnoticed and must be bubbled up to
        // the consumer.
        let outOfBandError = null as unknown;
        let hasOutOfBandError = false;
        const timestamps: number[] = [];
        // The queue should always be big enough to hold 1 second worth of packets
        const maxQueueSize = () => Math.max(2, timestamps.length);
        // The following is the "pump" process that keeps pumping packets into the queue
        (async () => {
            let packet = startPacket ?? await this.getFirstPacket(options);
            while (packet && !terminated && !this._track.input._disposed) {
                if (endPacket && packet.sequenceNumber >= endPacket?.sequenceNumber) {
                    break;
                }
                if (packetQueue.length > maxQueueSize()) {
                    ({ promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers());
                    await queueDequeue;
                    continue;
                }
                packetQueue.push(packet);
                onQueueNotEmpty();
                ({ promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers());
                packet = await this.getNextPacket(packet, options);
            }
            ended = true;
            onQueueNotEmpty();
        })().catch((error) => {
            if (!hasOutOfBandError) {
                outOfBandError = error;
                hasOutOfBandError = true;
                onQueueNotEmpty();
            }
        });
        const track = this._track;
        return {
            async next() {
                while (true) {
                    if (track.input._disposed) {
                        throw new InputDisposedError();
                    }
                    else if (terminated) {
                        return { value: undefined, done: true };
                    }
                    else if (hasOutOfBandError) {
                        throw outOfBandError;
                    }
                    else if (packetQueue.length > 0) {
                        const value = packetQueue.shift()!;
                        const now = performance.now();
                        timestamps.push(now);
                        while (timestamps.length > 0 && now - timestamps[0]! >= 1000) {
                            timestamps.shift();
                        }
                        onQueueDequeue();
                        return { value, done: false };
                    }
                    else if (ended) {
                        return { value: undefined, done: true };
                    }
                    else {
                        await queueNotEmpty;
                    }
                }
            },
            async return() {
                terminated = true;
                onQueueDequeue();
                onQueueNotEmpty();
                return { value: undefined, done: true };
            },
            async throw(error) {
                throw error;
            },
            async [Symbol.asyncDispose]() { await this.return(); },
            [Symbol.asyncIterator]() {
                return this;
            },
        };
    }
}
