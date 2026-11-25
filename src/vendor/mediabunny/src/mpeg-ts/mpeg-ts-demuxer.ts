/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Sequential AVC/ADTS subset of Mediabunny 1.66.2; see MIGRATION.md.
import { Bitstream } from '../../shared/bitstream';
import { MAX_ADTS_FRAME_HEADER_SIZE, MIN_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader, type AdtsFrameHeader } from '../adts/adts-reader';
import { AvcNalUnitType, extractNalUnitTypeForAvc } from '../codec-data';
import { readExpGolomb } from '../misc';
import { FileSlice, readBytes, type Reader } from '../reader';

export const TS_PACKET_SIZE = 188;
export const MPEG_TS_TIMESCALE = 90_000;
const TIMESTAMP_MODULUS = 2 ** 33;
// Limit elementary-stream framing independently of the transport packet cache.
const MAX_ELEMENTARY_BUFFER_SIZE = 32 * 1024 * 1024;
const MAX_BUFFERED_PES_TIMINGS = 65_536;

// The upstream normalization maps a wrapped timestamp into a window anchored
// on a reference. Use a rolling DTS-centered window for sequential reads.
export const normalizeWrappedTimestamp = (timestamp: number, reference: number) =>
    timestamp + Math.round((reference - timestamp) / TIMESTAMP_MODULUS) * TIMESTAMP_MODULUS;

export const MpegTsStreamType = { AAC: 0x0f, AVC: 0x1b } as const;

export class InvalidMpegTsError extends Error {
    constructor(message: string, packet?: TsPacket) {
        super(withPacketLocation(message, packet));
    }
}
export class UnsupportedMpegTsError extends Error {
    constructor(message: string, packet?: TsPacket) {
        super(withPacketLocation(message, packet));
    }
}

type TsPacket = { pos: number; pid: number; startsUnit: boolean; bytes: Uint8Array; segmentIndex: number | undefined };
type TsPayload = { counter: number; packet: TsPacket; data: Uint8Array };
type SegmentOptions = { segmentOffsets: readonly number[]; allowContinuityCounterReset?: boolean };
type ProgramAssociation = { number: number; mapPid: number };
type ProgramStream = { type: number; pid: number; privateAudio: boolean };
type PesTiming = { pts: number; dts: number };
type PesPayload = { data: Uint8Array; timing: PesTiming | null };
export type AdtsFrame = PesPayload & { header: AdtsFrameHeader };
type PesState = {
    header: Uint8Array;
    headerBytes: number;
    headerSize: number;
    bytesLeft: number;
    timing: PesTiming | null;
    open: boolean;
    previousPayload?: TsPayload;
    segmentIndex?: number | undefined;
};

function withPacketLocation(message: string, packet: TsPacket | undefined) {
    if (packet?.segmentIndex === undefined) {
        return message;
    }
    return `${message} (segment ${packet.segmentIndex}, PID ${packet.pid}, byte offset ${packet.pos})`;
}

function incompletePes(stream: PesState) {
    return stream.open && (stream.headerBytes < stream.headerSize
        || (stream.bytesLeft !== 0 && stream.bytesLeft !== Infinity));
}

const privateAudioRegistrations = new Set(['AC-3', 'AC-4', 'EAC3', 'DTS1', 'DTS2', 'DTS3', 'Opus']);

function hasPrivateAudioDescriptor(pmt: Uint8Array, start: number, end: number, packet: TsPacket) {
    let privateAudio = false;
    for (let at = start; at < end;) {
        const tag = pmt[at]!;
        const size = pmt[at + 1];
        if (size === undefined || at + 2 + size > end) {
            throw new InvalidMpegTsError('Invalid MPEG-TS PMT stream descriptor.', packet);
        }
        // DVB AC-3, enhanced AC-3 and DTS descriptors, or a registered audio format.
        privateAudio ||= tag === 0x6a || tag === 0x7a || tag === 0x7b
            || (tag === 0x05 && size >= 4
                && privateAudioRegistrations.has(String.fromCharCode(...pmt.subarray(at + 2, at + 6))));
        at += 2 + size;
    }
    return privateAudio;
}

function packetPayload(packet: TsPacket) {
    const { bytes } = packet;
    const flags = bytes[3]!;
    const adaptationFieldControl = (flags >> 4) & 3;
    if (bytes[1]! & 0x80 || adaptationFieldControl === 0) {
        throw new InvalidMpegTsError('Invalid MPEG-TS packet header.', packet);
    }
    if (flags & 0xc0) {
        throw new UnsupportedMpegTsError('Scrambled MPEG-TS packets are unsupported.', packet);
    }
    const start = adaptationFieldControl & 2 ? 5 + bytes[4]! : 4;
    if (start > TS_PACKET_SIZE) {
        throw new InvalidMpegTsError('Invalid MPEG-TS adaptation field length.', packet);
    }
    return bytes.subarray(adaptationFieldControl & 1 ? start : TS_PACKET_SIZE);
}

// A duplicate still counts as a payload packet at a segment boundary.
function nextPayload(packet: TsPacket, previous?: TsPayload, allowReset = false): TsPayload | null | undefined {
    const data = packetPayload(packet);
    if (data.length === 0) {
        return undefined;
    }
    const counter = packet.bytes[3]! & 0x0f;
    if (previous && counter !== ((previous.counter + 1) & 0x0f)) {
        if (counter === previous.counter && packet.startsUnit === previous.packet.startsUnit
            && data.length === previous.data.length && data.every((byte, index) => byte === previous.data[index])) {
            return null;
        }
        if (!allowReset) {
            throw new InvalidMpegTsError('MPEG-TS payload continuity counter is out of sequence.', packet);
        }
    }
    return { counter, packet, data };
}

function readPesTimestamp(bits: Bitstream, prefix: number, packet: TsPacket) {
    if (bits.readBits(4) !== prefix) {
        throw new InvalidMpegTsError('Invalid MPEG-TS PES timestamp prefix.', packet);
    }
    let timestamp = 0;
    for (const length of [3, 15, 15]) {
        timestamp = timestamp * 2 ** length + bits.readBits(length);
        if (bits.readBits(1) !== 1) {
            throw new InvalidMpegTsError('Invalid MPEG-TS PES timestamp marker.', packet);
        }
    }
    return timestamp;
}

function readPesTiming(header: Uint8Array, size: number, packet: TsPacket): PesTiming | null {
    const ptsDtsFlags = header[7]! >> 6;
    if (ptsDtsFlags === 0) {
        return null;
    }
    if (ptsDtsFlags === 1 || size < (ptsDtsFlags === 3 ? 19 : 14)) {
        throw new InvalidMpegTsError('Invalid MPEG-TS PES timestamp fields.', packet);
    }
    const bits = new Bitstream(header.subarray(9, size));
    const pts = readPesTimestamp(bits, ptsDtsFlags, packet);
    return { pts, dts: ptsDtsFlags === 3 ? readPesTimestamp(bits, 1, packet) : pts };
}

export class MpegTsDemuxer {
    private readonly reader: Reader;
    private readonly fileSize: number;
    private readonly check: () => void;
    private readonly segments: SegmentOptions | undefined;
    private program: { association: ProgramAssociation; streams: ProgramStream[] } | undefined;

    constructor(reader: Reader, fileSize: number, check: () => void, segments?: SegmentOptions) {
        this.reader = reader;
        this.fileSize = fileSize;
        this.check = check;
        this.segments = segments;
    }

    private async *transportPackets(start = 0, segmentIndex = this.segments ? 0 : undefined) {
        const blockSize = 256 * TS_PACKET_SIZE;
        const offsets = this.segments?.segmentOffsets;
        for (let block = start; block < this.fileSize; block += blockSize) {
            this.check();
            const length = Math.min(blockSize, this.fileSize - block);
            if (length % TS_PACKET_SIZE !== 0) {
                throw new InvalidMpegTsError('Truncated MPEG-TS packet.');
            }
            const slice = await this.reader.requestSlice(block, length);
            this.check();
            if (!slice) {
                throw new InvalidMpegTsError('Incomplete MPEG-TS read.');
            }
            const data = readBytes(slice, length);
            for (let offset = 0; offset < length; offset += TS_PACKET_SIZE) {
                const bytes = data.subarray(offset, offset + TS_PACKET_SIZE);
                const pos = block + offset;
                if (segmentIndex !== undefined && pos === offsets?.[segmentIndex + 1]) {
                    segmentIndex++;
                }
                const packet: TsPacket = {
                    pos,
                    pid: ((bytes[1]! & 0x1f) << 8) | bytes[2]!,
                    startsUnit: (bytes[1]! & 0x40) !== 0,
                    bytes,
                    segmentIndex,
                };
                if (bytes[0] !== 0x47) {
                    throw new InvalidMpegTsError('Invalid MPEG-TS packet sync byte.', packet);
                }
                yield packet;
            }
        }
    }

    private async readSection(first: TsPacket, tableId: number) {
        const section = new Uint8Array(1024);
        let size = 0;
        let length = 3;
        let previous: TsPayload | undefined;
        for await (const packet of this.transportPackets(first.pos, first.segmentIndex)) {
            if (packet.pid !== first.pid) {
                continue;
            }
            const payload = nextPayload(packet, previous);
            if (!payload) {
                if (packet.pos === first.pos) {
                    return null;
                }
                continue;
            }
            previous = payload;
            let { data } = payload;
            if (packet.startsUnit) {
                const start = 1 + data[0]!;
                if (start >= data.length) {
                    throw new InvalidMpegTsError('Invalid MPEG-TS program table pointer.', packet);
                }
                if (packet.pos === first.pos) {
                    data = data.subarray(start);
                    if (data[0] !== tableId) {
                        return null;
                    }
                } else {
                    data = data.subarray(1, start);
                }
            }
            let offset = 0;
            while (offset < data.length && size < length) {
                const count = Math.min(length - size, data.length - offset);
                section.set(data.subarray(offset, offset + count), size);
                size += count;
                offset += count;
                if (size === 3) {
                    length = 3 + (((section[1]! & 0x0f) << 8) | section[2]!);
                    if (length < 7 || length > section.length || !(section[1]! & 0x80)) {
                        throw new InvalidMpegTsError('Invalid MPEG-TS program table length.', packet);
                    }
                }
            }
            if (size === length) {
                let crc = -1;
                for (const byte of section.subarray(0, length)) {
                    crc ^= byte << 24;
                    for (let bit = 0; bit < 8; bit++) {
                        crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
                    }
                }
                if (crc !== 0) {
                    throw new InvalidMpegTsError('Invalid MPEG-TS program table checksum.', packet);
                }
                return section.subarray(0, length);
            }
            if (packet.pos !== first.pos && packet.startsUnit) {
                break;
            }
        }
        throw new InvalidMpegTsError('Truncated MPEG-TS program table.', previous?.packet ?? first);
    }

    private async readAssociation(packet: TsPacket) {
        const pat = await this.readSection(packet, 0);
        if (!pat) {
            return undefined;
        }
        const end = pat.length - 4;
        if (end < 8 || (end - 8) % 4 !== 0) {
            throw new InvalidMpegTsError('Invalid MPEG-TS PAT.', packet);
        }
        if (!(pat[5]! & 1)) {
            return undefined; // This version is not yet current.
        }
        if (pat[6] !== 0 || pat[7] !== 0) {
            throw new UnsupportedMpegTsError('Multi-section MPEG-TS program tables are unsupported.', packet);
        }
        let association: ProgramAssociation | null = null;
        for (let at = 8; at < end; at += 4) {
            const number = (pat[at]! << 8) | pat[at + 1]!;
            if (number === 0) {
                continue; // Network information PID.
            }
            if (association) {
                throw new UnsupportedMpegTsError('Only single-program MPEG-TS is supported.', packet);
            }
            association = { number, mapPid: ((pat[at + 2]! & 0x1f) << 8) | pat[at + 3]! };
        }
        return association;
    }

    private async readProgramMap(packet: TsPacket, programNumber: number) {
        const pmt = await this.readSection(packet, 2);
        if (!pmt) {
            return undefined;
        }
        const end = pmt.length - 4;
        if (end < 12) {
            throw new InvalidMpegTsError('Invalid MPEG-TS PMT.', packet);
        }
        if (!(pmt[5]! & 1)) {
            return undefined;
        }
        if (((pmt[3]! << 8) | pmt[4]!) !== programNumber || pmt[6] !== 0 || pmt[7] !== 0) {
            throw new InvalidMpegTsError('Invalid MPEG-TS PMT program or section number.', packet);
        }
        const streams: ProgramStream[] = [];
        let at = 12 + (((pmt[10]! & 0x0f) << 8) | pmt[11]!);
        while (at + 5 <= end) {
            const type = pmt[at]!;
            const descriptorEnd = at + 5 + (((pmt[at + 3]! & 0x0f) << 8) | pmt[at + 4]!);
            if (descriptorEnd > end) {
                throw new InvalidMpegTsError('Invalid MPEG-TS PMT stream descriptors.', packet);
            }
            streams.push({
                type,
                pid: ((pmt[at + 1]! & 0x1f) << 8) | pmt[at + 2]!,
                privateAudio: type === 0x06 && hasPrivateAudioDescriptor(pmt, at + 5, descriptorEnd, packet),
            });
            at = descriptorEnd;
        }
        if (at !== end) {
            throw new InvalidMpegTsError('Invalid MPEG-TS PMT stream descriptors.', packet);
        }
        return streams;
    }

    async readProgram() {
        let association: ProgramAssociation | null = null;
        for await (const packet of this.transportPackets()) {
            if (!packet.startsUnit) {
                continue;
            }
            if (packet.pid === 0) {
                const current = await this.readAssociation(packet);
                if (current !== undefined) {
                    association = current;
                }
            } else if (packet.pid === association?.mapPid) {
                const streams = await this.readProgramMap(packet, association.number);
                if (streams) {
                    this.program = { association, streams };
                    return streams;
                }
            }
        }
        throw new InvalidMpegTsError('MPEG-TS input has no program association and map tables.');
    }

    private async checkProgram(packet: TsPacket, pids: number[]) {
        if (!this.program || !packet.startsUnit) {
            return;
        }
        const { association, streams } = this.program;
        if (packet.pid === 0) {
            const current = await this.readAssociation(packet);
            if (current !== undefined && (current?.number !== association.number || current.mapPid !== association.mapPid)) {
                throw new UnsupportedMpegTsError('The MPEG-TS program association changes within the input.', packet);
            }
        } else if (packet.pid === association.mapPid) {
            const current = await this.readProgramMap(packet, association.number);
            if (current && pids.some(pid => {
                const type = streams.find(stream => stream.pid === pid)?.type;
                return !current.some(stream => stream.pid === pid && stream.type === type);
            })) {
                throw new UnsupportedMpegTsError('A selected MPEG-TS stream changes PID or codec within the input.', packet);
            }
        }
    }

    async *pesPayloads(pids: number[]): AsyncGenerator<PesPayload, void, unknown> {
        const streams = new Map<number, PesState>(pids.map(pid => [pid, {
            header: new Uint8Array(9 + 255), headerBytes: 0, headerSize: 9,
            bytesLeft: 0, timing: null, open: false,
        }]));
        for await (const packet of this.transportPackets()) {
            const stream = streams.get(packet.pid);
            if (!stream) {
                if (packet.pid === 0 || packet.pid === this.program?.association.mapPid) {
                    await this.checkProgram(packet, pids);
                }
                continue;
            }
            const { segmentIndex } = packet;
            // Only relax the counter check. PES completeness and parsing are checked below.
            const allowReset = this.segments?.allowContinuityCounterReset === true
                && segmentIndex !== undefined && segmentIndex > 0
                && segmentIndex !== stream.segmentIndex && packet.startsUnit;
            const payload = nextPayload(packet, stream.previousPayload, allowReset);
            if (payload !== undefined) {
                stream.segmentIndex = segmentIndex;
            }
            if (!payload) {
                continue;
            }
            stream.previousPayload = payload;
            let { data } = payload;
            if (packet.startsUnit) {
                if (incompletePes(stream)) {
                    throw new InvalidMpegTsError('Truncated MPEG-TS PES packet.', packet);
                }
                stream.headerBytes = 0;
                stream.headerSize = 9;
                stream.bytesLeft = -1;
                stream.timing = null;
                stream.open = true;
            }
            if (!stream.open) {
                continue;
            }
            while (data.length && stream.headerBytes < stream.headerSize) {
                const count = Math.min(data.length, stream.headerSize - stream.headerBytes);
                stream.header.set(data.subarray(0, count), stream.headerBytes);
                stream.headerBytes += count;
                data = data.subarray(count);
                if (stream.headerBytes === 9) {
                    const header = stream.header;
                    if (header[0] !== 0 || header[1] !== 0 || header[2] !== 1
                        || (header[6]! & 0xc0) !== 0x80) {
                        throw new InvalidMpegTsError('Invalid MPEG-TS PES header.', packet);
                    }
                    stream.headerSize = 9 + header[8]!;
                    const pesLength = (header[4]! << 8) | header[5]!;
                    stream.bytesLeft = pesLength ? 6 + pesLength - stream.headerSize : Infinity;
                    if (stream.bytesLeft < 0) {
                        throw new InvalidMpegTsError('Invalid MPEG-TS PES packet length.', packet);
                    }
                }
                if (stream.headerBytes === stream.headerSize) {
                    stream.timing = readPesTiming(stream.header, stream.headerSize, packet);
                }
            }
            const count = Math.min(data.length, stream.bytesLeft);
            if (count > 0) {
                yield { data: data.subarray(0, count), timing: stream.timing };
                stream.bytesLeft -= count;
                stream.timing = null;
            }
        }
        for (const stream of streams.values()) {
            if (incompletePes(stream)) {
                throw new InvalidMpegTsError('Truncated MPEG-TS PES packet.', stream.previousPayload?.packet);
            }
        }
    }

    async readTimestampReference(pids: number[]) {
        for await (const payload of this.pesPayloads(pids)) {
            if (payload.timing) {
                return payload.timing.dts;
            }
        }
        throw new InvalidMpegTsError('MPEG-TS input has no PES timestamps.');
    }

    async *readAvc(pid: number) {
        const payloads = this.pesPayloads([pid]);
        try {
            const context = new PacketReadingContext(payloads);
            while (true) {
                const packet = await context.readAvc();
                if (!packet) {
                    return;
                }
                yield packet;
            }
        } finally {
            await payloads.return();
        }
    }

    async *readAdts(pid: number): AsyncGenerator<AdtsFrame, void, unknown> {
        const payloads = this.pesPayloads([pid]);
        try {
            const context = new PacketReadingContext(payloads);
            while (true) {
                const packet = await context.readAdts();
                if (!packet) {
                    return;
                }
                yield packet;
            }
        } finally {
            await payloads.return();
        }
    }
}

/** The upstream elementary-stream scratch buffer, shared by AVC and ADTS framing. */
class PacketReadingContext {
    private readonly payloads: AsyncGenerator<PesPayload, void, unknown>;
    private scratch = new Uint8Array(2 ** 16);
    private end = 0;
    private reachedEnd = false;
    private timings: { offset: number; timing: PesTiming }[] = [];

    constructor(payloads: AsyncGenerator<PesPayload, void, unknown>) {
        this.payloads = payloads;
    }

    private async ensureBuffered(length: number) {
        while (this.end < length && !this.reachedEnd) {
            const next = await this.payloads.next();
            if (next.done) {
                this.reachedEnd = true;
                break;
            }
            const { data, timing } = next.value;
            const end = this.end + data.length;
            if (end > MAX_ELEMENTARY_BUFFER_SIZE) {
                throw new UnsupportedMpegTsError('MPEG-TS elementary stream exceeds the 32 MiB framing buffer limit.');
            }
            if (timing) {
                if (this.timings.length >= MAX_BUFFERED_PES_TIMINGS) {
                    throw new UnsupportedMpegTsError('MPEG-TS elementary stream has too many pending PES timestamps.');
                }
                this.timings.push({ offset: this.end, timing });
            }
            if (end > this.scratch.length) {
                const scratch = new Uint8Array(Math.min(MAX_ELEMENTARY_BUFFER_SIZE, Math.max(end, 2 * this.scratch.length)));
                scratch.set(this.scratch.subarray(0, this.end));
                this.scratch = scratch;
            }
            this.scratch.set(data, this.end);
            this.end += data.length;
        }
    }

    private take(start: number, end: number, timingOffset: number, fallbackOffset = timingOffset) {
        let timing = this.takeTiming(timingOffset);
        timing ??= this.takeTiming(fallbackOffset);
        const data = this.scratch.slice(start, end);
        this.discardPrefix(end);
        return { data, timing };
    }

    private takeTiming(offset: number) {
        let timing: PesTiming | null = null;
        let count = 0;
        for (const marker of this.timings) {
            if (marker.offset > offset) {
                break;
            }
            timing = marker.timing;
            count++;
        }
        this.timings.splice(0, count);
        return timing;
    }

    private discardPrefix(length: number) {
        this.scratch.copyWithin(0, length, this.end);
        this.end -= length;
        for (const marker of this.timings) {
            marker.offset -= length;
        }
    }

    async readAvc() {
        const chunkSize = 1024;
        let scan = 0;
        let start = -1;
        let nalStart = 0;
        let firstSlice = -1;
        let lastFirstMacroblock = 0;
        while (true) {
            await this.ensureBuffered(scan + chunkSize);
            const chunk = this.scratch.subarray(0, this.end);
            while (scan + 4 < chunk.length) {
                const zero = chunk.indexOf(0, scan);
                if (zero === -1 || zero + 4 >= chunk.length) {
                    scan = zero === -1 ? chunk.length : zero;
                    break;
                }
                scan = zero + 1;
                const startCodeLength = chunk[zero + 1] === 0
                    ? chunk[zero + 2] === 1 ? 3
                        : chunk[zero + 2] === 0 && chunk[zero + 3] === 1 ? 4 : 0
                    : 0;
                if (!startCodeLength) {
                    continue;
                }
                const header = zero + startCodeLength;
                const type = extractNalUnitTypeForAvc(chunk[header]!);
                const isSlice = type === AvcNalUnitType.NON_IDR_SLICE
                    || type === AvcNalUnitType.SLICE_DPA || type === AvcNalUnitType.IDR;
                const startsAccessUnit = type === AvcNalUnitType.SEI || type === AvcNalUnitType.SPS
                    || type === AvcNalUnitType.PPS || type === AvcNalUnitType.AUD;
                let firstMacroblock = 0;
                if (isSlice) {
                    const bits = new Bitstream(chunk.subarray(header + 1));
                    try {
                        firstMacroblock = readExpGolomb(bits);
                    } catch {
                        if (chunk.length - header > 8 || this.reachedEnd) {
                            throw new InvalidMpegTsError('Invalid MPEG-TS AVC slice header.');
                        }
                        scan = zero;
                        break;
                    }
                    if (bits.getBitsLeft() < 0) {
                        if (this.reachedEnd) {
                            throw new InvalidMpegTsError('Truncated MPEG-TS AVC slice header.');
                        }
                        scan = zero;
                        break;
                    }
                }
                if (firstSlice >= 0 && (startsAccessUnit || (isSlice && firstMacroblock <= lastFirstMacroblock))) {
                    // Use the original start, even if the current AU spanned several PES packets.
                    return this.take(start, zero, nalStart, firstSlice);
                }
                if (start < 0) {
                    start = zero;
                    // A start code itself can straddle PES packets. Attribute
                    // a new access unit to the PES containing its NAL header.
                    nalStart = header;
                }
                if (isSlice) {
                    if (firstSlice < 0) {
                        firstSlice = header;
                    }
                    lastFirstMacroblock = firstMacroblock;
                }
                scan = header + 1;
            }
            if (this.reachedEnd) {
                return firstSlice < 0 ? null : this.take(start, this.end, nalStart, firstSlice);
            }
            if (start < 0 && scan > 0) {
                // No NAL started in this prefix, but carry its last timing forward.
                const timing = this.takeTiming(scan - 1);
                this.discardPrefix(scan);
                if (timing) {
                    this.timings.unshift({ offset: -1, timing });
                }
                scan = 0;
            }
        }
    }

    async readAdts() {
        await this.ensureBuffered(MAX_ADTS_FRAME_HEADER_SIZE);
        if (this.end === 0) {
            return null;
        }
        const header = readAdtsFrameHeader(FileSlice.tempFromBytes(this.scratch.subarray(0, this.end)));
        if (!header) {
            throw new InvalidMpegTsError('Invalid MPEG-TS ADTS frame header.');
        }
        await this.ensureBuffered(header.frameLength);
        const headerSize = header.crcCheck === null ? MIN_ADTS_FRAME_HEADER_SIZE : MAX_ADTS_FRAME_HEADER_SIZE;
        if (this.end < header.frameLength || header.frameLength === headerSize) {
            throw new InvalidMpegTsError('Truncated or empty MPEG-TS ADTS frame.');
        }
        // The first raw data block may begin in the following PES, but the
        // timestamp belongs to the PES that started this ADTS frame.
        const { data, timing } = this.take(headerSize, header.frameLength, 0);
        return { data, timing, header };
    }
}
