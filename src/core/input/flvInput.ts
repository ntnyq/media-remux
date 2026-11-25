/* oxlint-disable no-await-in-loop -- FLV tags are read in file order with bounded memory. */

import {
  PACKET_TYPE,
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_TRACK_SELECTION,
} from '../../constants'
import type {
  RemuxTrackSelection,
  FlvTag,
  FlvTrackFormat,
  MediaInput,
  PacketTrack,
} from '../../types'
import {
  avcDecoderConfig,
  checkAbort,
  createRemuxError,
  parseMp3FrameHeader,
  readAacLcConfig,
  areBytesSame,
} from '../../utils'
import { readBlobBytes } from '../../utils/remuxInput'
import { EncodedPacket } from '../../vendor/mediabunny/src/packet'

/**
 * Reads an exact FLV byte range with cancellation checks around the Blob read.
 *
 * @param blob - Source FLV Blob.
 * @param offset - Starting byte offset within the Blob.
 * @param length - Exact number of bytes to read.
 * @param signal - Optional cancellation signal.
 * @returns A promise resolving to a new buffer containing the requested bytes.
 * @throws {Error} If the range exceeds the Blob or the read is incomplete.
 * @throws The signal's abort reason if cancellation is detected.
 */
async function readBytes(
  blob: Blob,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  checkAbort(signal)

  if (offset < 0 || length < 0 || offset + length > blob.size) {
    throw createRemuxError(REMUX_ERROR_CODE.invalidInput, 'Truncated FLV file.')
  }

  const bytes = await readBlobBytes(blob, offset, offset + length, signal)

  if (bytes.length !== length) {
    throw createRemuxError(
      REMUX_ERROR_CODE.invalidInput,
      'Incomplete FLV read.',
    )
  }

  return bytes
}

/**
 * Decodes a big-endian unsigned 24-bit integer, treating missing bytes as zero.
 *
 * @param bytes - Buffer containing the binary field.
 * @param offset - Index of the field's most significant byte.
 * @returns The decoded integer from 0 through 0xffffff.
 */
function uint24(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 65_536 +
    (bytes[offset + 1] ?? 0) * 256 +
    (bytes[offset + 2] ?? 0)
  )
}

/**
 * Splits a legacy FLV MP3 payload into whole frames. Only frame headers are
 * read during preflight. A tag timestamps its first frame.
 *
 * @param blob - Source FLV Blob containing the tag payload.
 * @param tag - Payload byte range and first frame timestamp in seconds.
 * @param metadataOnly - Whether to omit encoded frame bytes.
 * @param signal - Optional cancellation signal checked around reads.
 * @yields {FlvTag} One sample per complete MP3 frame.
 * @throws If a frame is invalid, the payload is truncated, or a read fails.
 */
async function* readMp3Frames(
  blob: Blob,
  tag: { offset: number; size: number; timestamp: number },
  metadataOnly: boolean,
  signal?: AbortSignal,
): AsyncGenerator<FlvTag, void, unknown> {
  const end = tag.offset + tag.size
  let offset = tag.offset
  let elapsed = 0

  while (offset < end) {
    const header = await readBytes(
      blob,
      offset,
      Math.min(4, end - offset),
      signal,
    )
    const mp3 = parseMp3FrameHeader(header)

    if (!mp3 || offset + mp3.size > end) {
      throw createRemuxError(
        REMUX_ERROR_CODE.invalidInput,
        'Invalid or truncated FLV MP3 frame.',
      )
    }

    yield {
      kind: MEDIA_TRACK_KIND.audio,
      timestamp: tag.timestamp + elapsed,
      compositionTime: 0,
      packetType: 1,
      isKey: true,
      data: metadataOnly
        ? new Uint8Array(0)
        : await readBytes(blob, offset, mp3.size, signal),
      size: mp3.size,
      mp3,
    }

    offset += mp3.size
    elapsed += mp3.duration
  }
}

/**
 * Walks tags by range; script data and unselected media payloads stay on disk.
 *
 * @param blob - Source FLV media.
 * @param kind - Optional track kind to read.
 * @param metadataOnly - Skip encoded payloads except decoder configurations.
 * @param signal - Cancellation signal checked around reads.
 * @returns An asynchronous generator that completes without a return value.
 * @yields {FlvTag} One validated media tag or MP3 frame at a time.
 * @throws {Error} If FLV structure, selected codecs, or packet types are invalid.
 * @throws The signal's abort reason if cancellation is detected.
 */
async function* readTags(
  blob: Blob,
  kind?: PacketTrack['kind'],
  metadataOnly = true,
  signal?: AbortSignal,
): AsyncGenerator<FlvTag, void, unknown> {
  const header = await readBytes(blob, 0, 9, signal)

  if (header[3] !== 1 || ((header[4] ?? 0) & ~5) !== 0) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      'Unsupported FLV header.',
    )
  }

  let offset = new DataView(header.buffer).getUint32(5)

  if (offset < 9) {
    throw createRemuxError(
      REMUX_ERROR_CODE.invalidInput,
      'Invalid FLV data offset.',
    )
  }

  const initialSize = await readBytes(blob, offset, 4, signal)

  if (new DataView(initialSize.buffer).getUint32(0) !== 0) {
    throw createRemuxError(
      REMUX_ERROR_CODE.invalidInput,
      'Invalid FLV initial tag size.',
    )
  }

  offset += 4

  while (offset < blob.size) {
    const tagHeader = await readBytes(blob, offset, 11, signal)
    const [type] = tagHeader
    const size = uint24(tagHeader, 1)

    if (uint24(tagHeader, 8) !== 0 || ![8, 9, 18].includes(type ?? 0)) {
      throw createRemuxError(
        REMUX_ERROR_CODE.unsupportedMediaFeature,
        'Unsupported FLV tag or encrypted data.',
      )
    }

    const tail = await readBytes(blob, offset + 11 + size, 4, signal)

    if (new DataView(tail.buffer).getUint32(0) !== 11 + size) {
      throw createRemuxError(
        REMUX_ERROR_CODE.invalidInput,
        'Invalid FLV previous tag size.',
      )
    }

    const tagKind = type === 9 ? MEDIA_TRACK_KIND.video : MEDIA_TRACK_KIND.audio
    const payloadOffset = offset + 11

    offset += 11 + size + 4

    if (type !== 18 && (!kind || kind === tagKind)) {
      const prefixSize = type === 9 ? 5 : 2

      if (size < prefixSize) {
        throw createRemuxError(
          REMUX_ERROR_CODE.invalidInput,
          'Truncated FLV media tag.',
        )
      }

      const prefix = await readBytes(blob, payloadOffset, prefixSize, signal)
      const soundFormat = (prefix[0] ?? 0) >> 4
      // The extension supplies the signed high byte of the FLV timestamp.
      const timestamp =
        (((tagHeader[7] ?? 0) << 24) | uint24(tagHeader, 4)) / 1000

      // Legacy MP3 has no packet-type byte after the audio tag header.
      if (type === 8 && (soundFormat === 2 || soundFormat === 14)) {
        yield* readMp3Frames(
          blob,
          { offset: payloadOffset + 1, size: size - 1, timestamp },
          metadataOnly,
          signal,
        )
        continue
      }

      if (
        (type === 9 && ((prefix[0] ?? 0) & 15) !== 7) ||
        (type === 8 && soundFormat !== 10)
      ) {
        throw createRemuxError(
          REMUX_ERROR_CODE.unsupportedCodec,
          'FLV supports only H.264 video and AAC or MP3 audio.',
        )
      }

      const packetType = prefix[1] ?? -1

      if (
        packetType !== 0 &&
        packetType !== 1 &&
        !(type === 9 && packetType === 2)
      ) {
        throw createRemuxError(
          REMUX_ERROR_CODE.unsupportedMediaFeature,
          'Unsupported FLV packet type.',
        )
      }

      const composition = type === 9 ? uint24(prefix, 2) : 0
      const payloadSize = size - prefixSize

      yield {
        kind: tagKind,
        timestamp,

        // FLV composition offsets are signed 24-bit milliseconds; uint24 reads
        // them unsigned, so restore the sign before converting to seconds.
        compositionTime:
          (composition >= 0x80_00_00
            ? composition - 0x1_00_00_00
            : composition) / 1000,
        packetType,
        isKey: type === 8 || (prefix[0] ?? 0) >> 4 === 1,
        data:
          packetType === 0 || !metadataOnly
            ? await readBytes(
                blob,
                payloadOffset + prefixSize,
                payloadSize,
                signal,
              )
            : new Uint8Array(0),
        size: payloadSize,
      }
    }
  }
}

/**
 * Scans FLV tag structure and selected decoder configurations before exposing
 * H.264 video and AAC-LC or MP3 audio tracks. Unselected payloads stay on disk.
 * Each packet iterator rereads its track, derives durations from decode timing
 * or codec defaults, and optionally skips encoded payloads. Disposal is a no-op
 * because this Blob-backed input owns no file handles.
 *
 * @param blob - Source FLV Blob, normally identified by openMediaInput().
 * @param signal - Optional cancellation signal checked around Blob reads.
 * @param selection - Track kinds to inspect; defaults to both video and audio.
 * @returns A promise resolving to tracks with stable decoder configurations,
 * repeatable packet iterators, and a no-op disposer. Absent kinds are omitted.
 * @throws {Error} If the file is truncated, its tag structure is invalid,
 * selected codecs are unsupported, or decoder configurations are invalid,
 * change within the file, or follow their media packets. Packet iteration also
 * rejects invalid decode timestamp ordering.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function openFlvInput(
  blob: Blob,
  signal?: AbortSignal,
  selection: RemuxTrackSelection = REMUX_TRACK_SELECTION.all,
): Promise<MediaInput> {
  const formats = new Map<PacketTrack['kind'], FlvTrackFormat>()

  // Validate the entire file before creating output, including later sequence headers.
  for await (const tag of readTags(
    blob,
    selection === REMUX_TRACK_SELECTION.audio ||
      selection === REMUX_TRACK_SELECTION.video
      ? selection
      : undefined,
    true,
    signal,
  )) {
    const previous = formats.get(tag.kind)

    if (tag.mp3) {
      const { sampleRate, numberOfChannels } = tag.mp3

      if (
        previous &&
        (previous.codec !== MEDIA_CODEC.mp3 ||
          previous.sampleRate !== sampleRate ||
          previous.numberOfChannels !== numberOfChannels)
      ) {
        throw createRemuxError(
          REMUX_ERROR_CODE.unsupportedMediaFeature,
          'FLV decoder configuration changes within a segment.',
        )
      }

      if (!previous) {
        formats.set(tag.kind, {
          codec: MEDIA_CODEC.mp3,
          sampleRate,
          numberOfChannels,
        })
      }
    } else if (
      previous &&
      (previous.codec === MEDIA_CODEC.mp3 ||
        (tag.packetType === 0 && !areBytesSame(previous.description, tag.data)))
    ) {
      throw createRemuxError(
        REMUX_ERROR_CODE.unsupportedMediaFeature,
        'FLV decoder configuration changes within a segment.',
      )
    } else if (tag.packetType === 0) {
      formats.set(tag.kind, {
        codec:
          tag.kind === MEDIA_TRACK_KIND.video
            ? MEDIA_CODEC.avc
            : MEDIA_CODEC.aac,
        description: tag.data,
      })
    } else if (tag.packetType === 1 && !previous) {
      throw createRemuxError(
        REMUX_ERROR_CODE.invalidInput,
        'FLV media packet precedes its decoder configuration.',
      )
    }
  }

  const tracks: PacketTrack[] = []

  for (const [kind, format] of formats) {
    const { codec } = format

    if (codec === MEDIA_CODEC.mp3) {
      tracks.push({
        kind: MEDIA_TRACK_KIND.audio,
        codec,
        config: {
          codec,
          sampleRate: format.sampleRate,
          numberOfChannels: format.numberOfChannels,
        },
        packets: readPackets.bind(undefined, 1 / 30),
      })
    } else if (codec === MEDIA_CODEC.aac) {
      const aac = readAacLcConfig(format.description, 'FLV')

      tracks.push({
        kind: MEDIA_TRACK_KIND.audio,
        codec,
        config: aac.config,
        packets: readPackets.bind(undefined, aac.frameDuration),
      })
    } else {
      tracks.push({
        kind: MEDIA_TRACK_KIND.video,
        codec,
        config: avcDecoderConfig(format.description, 'FLV'),
        packets: readPackets.bind(undefined, 1 / 30),
      })
    }

    /**
     * Rereads this FLV track, deriving packet durations from codec or tag timing.
     *
     * @param defaultDuration - Initial fallback frame duration in seconds.
     * @param metadataOnly - Whether to omit encoded payloads; defaults to false.
     * @param skipPackets - Number of leading packets to skip in decode order.
     * @returns An asynchronous generator that completes without a return value.
     * @yields {EncodedPacket} Packets with presentation timing and decode sequence numbers.
     * @throws If tag parsing, decode timestamp ordering, or cancellation fails.
     */
    async function* readPackets(
      defaultDuration: number,
      metadataOnly = false,
      skipPackets = 0,
    ) {
      let pending: FlvTag | undefined
      let sequence = 0
      let lastDuration = defaultDuration
      let lastTimestamp = -Infinity
      let lastMediaTimestamp = -Infinity

      /**
       * Converts a media tag to a packet at the current sequence number.
       *
       * @param tag - Media tag whose payload and composition offset to preserve.
       * @param duration - Decode duration in seconds, also used as a presentation estimate.
       * @returns An encoded packet with its source decode sequence number.
       */
      function packet(tag: FlvTag, duration: number) {
        return new EncodedPacket(
          tag.data,
          tag.isKey ? PACKET_TYPE.key : PACKET_TYPE.delta,
          tag.timestamp + tag.compositionTime,
          duration,
          sequence,
          tag.size,
          { decodeDuration: duration, decodeTimestamp: tag.timestamp },
        )
      }

      // Hold one media tag so the next tag can establish its video duration.
      // Audio uses its codec duration; final video reuses the last duration.
      for await (const tag of readTags(blob, kind, metadataOnly, signal)) {
        if (tag.packetType !== 0) {
          if (
            tag.timestamp < lastTimestamp ||
            (tag.packetType === 1 && tag.timestamp <= lastMediaTimestamp)
          ) {
            throw createRemuxError(
              REMUX_ERROR_CODE.invalidInput,
              'FLV decode timestamps must increase within each track.',
            )
          }

          lastTimestamp = tag.timestamp

          if (tag.packetType === 1) {
            lastMediaTimestamp = tag.timestamp
          }

          if (pending) {
            const delta = tag.timestamp - pending.timestamp

            if (kind === MEDIA_TRACK_KIND.video && delta > 0) {
              lastDuration = delta
            }

            if (sequence >= skipPackets) {
              yield packet(pending, pending.mp3?.duration ?? lastDuration)
            }

            sequence++
          }

          pending = tag.packetType === 1 ? tag : undefined
        }
      }

      if (pending && sequence >= skipPackets) {
        yield packet(pending, pending.mp3?.duration ?? lastDuration)
      }
    }
  }

  return {
    tracks,
    canReuseAfterDispose: true,

    /**
     * Satisfies the input cleanup contract; Blob-backed FLV owns no handles.
     *
     * @returns Nothing.
     */
    dispose() {
      // Blob-backed FLV inputs do not own file handles or other resources.
    },
  }
}
