/* oxlint-disable no-bitwise -- Binary media fields require masks, shifts, and flag manipulation. */
/* oxlint-disable no-await-in-loop -- FLV tags are read in file order with bounded memory. */
import { checkAbort } from '../../abort'
import { parseAacAudioSpecificConfig } from '../../vendor/mediabunny/shared/aac-misc'
import { Bitstream } from '../../vendor/mediabunny/shared/bitstream'
import { extractColorSpace } from '../../vendor/mediabunny/src/codec'
import {
  deserializeAvcDecoderConfigurationRecord,
  parseAvcSps,
} from '../../vendor/mediabunny/src/codec-data'
import { EncodedPacket } from '../../vendor/mediabunny/src/packet'
import type { MediaInput, PacketTrack } from './mediaInput'

interface FlvTag {
  kind: 'video' | 'audio'
  timestamp: number
  compositionTime: number
  packetType: number
  isKey: boolean
  data: Uint8Array<ArrayBuffer>
  size: number
}

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
    throw new Error('Truncated FLV file.')
  }

  const bytes = new Uint8Array(
    await blob.slice(offset, offset + length).arrayBuffer(),
  )
  checkAbort(signal)
  if (bytes.length !== length) {
    throw new Error('Incomplete FLV read.')
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
 * Walks tags by range; script data and unselected media payloads stay on disk.
 *
 * @param blob - Source FLV media.
 * @param kind - Optional track kind to read.
 * @param metadataOnly - Skip encoded payloads except decoder configurations.
 * @param signal - Cancellation signal checked around reads.
 * @returns An asynchronous generator that completes without a return value.
 * @yields {FlvTag} One validated media tag at a time.
 * @throws {Error} If FLV structure, selected codecs, or packet types are invalid.
 * @throws The signal's abort reason if cancellation is detected.
 */
async function* readTags(
  blob: Blob,
  kind?: 'video' | 'audio',
  metadataOnly = true,
  signal?: AbortSignal,
): AsyncGenerator<FlvTag, void, unknown> {
  const header = await readBytes(blob, 0, 9, signal)
  if (header[3] !== 1 || ((header[4] ?? 0) & ~5) !== 0) {
    throw new Error('Unsupported FLV header.')
  }

  let offset = new DataView(header.buffer).getUint32(5)
  if (offset < 9) {
    throw new Error('Invalid FLV data offset.')
  }

  const initialSize = await readBytes(blob, offset, 4, signal)
  if (new DataView(initialSize.buffer).getUint32(0) !== 0) {
    throw new Error('Invalid FLV initial tag size.')
  }

  offset += 4

  while (offset < blob.size) {
    const tagHeader = await readBytes(blob, offset, 11, signal)
    const [type] = tagHeader
    const size = uint24(tagHeader, 1)
    if (uint24(tagHeader, 8) !== 0 || ![8, 9, 18].includes(type ?? 0)) {
      throw new Error('Unsupported FLV tag or encrypted data.')
    }

    const tail = await readBytes(blob, offset + 11 + size, 4, signal)
    if (new DataView(tail.buffer).getUint32(0) !== 11 + size) {
      throw new Error('Invalid FLV previous tag size.')
    }

    const tagKind = type === 9 ? 'video' : 'audio'
    if (type !== 18 && (!kind || kind === tagKind)) {
      const prefixSize = type === 9 ? 5 : 2
      if (size < prefixSize) {
        throw new Error('Truncated FLV media tag.')
      }

      const prefix = await readBytes(blob, offset + 11, prefixSize, signal)
      if (
        (type === 9 && ((prefix[0] ?? 0) & 15) !== 7) ||
        (type === 8 && (prefix[0] ?? 0) >> 4 !== 10)
      ) {
        throw new Error('FLV supports only H.264 video and AAC audio.')
      }

      const packetType = prefix[1] ?? -1
      if (
        packetType !== 0 &&
        packetType !== 1 &&
        !(type === 9 && packetType === 2)
      ) {
        throw new Error('Unsupported FLV packet type.')
      }

      const composition = type === 9 ? uint24(prefix, 2) : 0
      const payloadSize = size - prefixSize

      yield {
        kind: tagKind,
        timestamp:
          (uint24(tagHeader, 4) + (tagHeader[7] ?? 0) * 16_777_216) / 1000,

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
                offset + 11 + prefixSize,
                payloadSize,
                signal,
              )
            : new Uint8Array(0),
        size: payloadSize,
      }
    }

    offset += 11 + size + 4
  }
}

/**
 * Compares decoder descriptions by length and byte contents.
 *
 * @param left - First decoder description.
 * @param right - Second decoder description.
 * @returns Whether both buffers contain identical bytes.
 */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  )
}

/**
 * Builds an H.264 decoder configuration from an FLV AVC sequence header.
 *
 * @param description - AVCDecoderConfigurationRecord bytes.
 * @returns Codec identifier, display dimensions, and original initialization bytes.
 * @throws {Error} If AVC parsing fails or required parameter sets are missing.
 */
function videoConfig(description: Uint8Array<ArrayBuffer>): VideoDecoderConfig {
  const avc = deserializeAvcDecoderConfigurationRecord(description)
  const sps = avc?.sequenceParameterSets[0]
  const info = sps && parseAvcSps(sps)
  if (!avc || !info || avc.pictureParameterSets.length === 0) {
    throw new Error('Invalid FLV AVC decoder configuration.')
  }

  const profile = [...description.subarray(1, 4)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')

  return {
    codec: `avc1.${profile}`,
    codedWidth: info.displayWidth,
    codedHeight: info.displayHeight,
    // Use the same SPS-derived color fields as the MP4 reader, including the
    // limited-range default when the SPS omits video signal metadata.
    colorSpace: extractColorSpace({
      codec: 'avc',
      codecDescription: description,
      avcCodecInfo: avc,
      hevcCodecInfo: null,
      vp9CodecInfo: null,
      av1CodecInfo: null,
      proresCodecInfo: null,
    }),
    ...(info.pixelAspectRatio.num === info.pixelAspectRatio.den
      ? {}
      : {
          displayAspectWidth: info.displayWidth * info.pixelAspectRatio.num,
          displayAspectHeight: info.displayHeight * info.pixelAspectRatio.den,
        }),
    description,
  }
}

/**
 * Builds an AAC-LC decoder configuration from an FLV audio sequence header.
 *
 * @param description - AudioSpecificConfig bytes.
 * @returns Codec identifier, channel count, sample rate, and initialization bytes.
 * @throws {Error} If AAC-LC, explicit channels, or a positive sample rate are absent.
 */
function audioConfig(description: Uint8Array<ArrayBuffer>): AudioDecoderConfig {
  const info = parseAacAudioSpecificConfig(description)
  if (
    info.objectType !== 2 ||
    info.sbrPresent ||
    !info.outputNumberOfChannels ||
    !info.outputSampleRate ||
    !(info.outputSampleRate > 0)
  ) {
    throw new Error(
      'FLV requires AAC-LC with an explicit channel configuration.',
    )
  }

  return {
    codec: 'mp4a.40.2',
    numberOfChannels: info.outputNumberOfChannels,
    sampleRate: info.outputSampleRate,
    description,
  }
}

/**
 * Reads the AAC frame-length flag used to derive each audio packet's duration.
 *
 * @param description - AAC AudioSpecificConfig containing the frame-length flag.
 * @returns Samples per frame: 960 when the flag is set, otherwise 1024.
 */
function aacFrameSamples(description: Uint8Array): number {
  const bits = new Bitstream(description)

  // Skip the object type and sample-rate field, whose escape value introduces
  // an explicit 24-bit frequency, then skip channels to reach frameLengthFlag.
  bits.skipBits(5)
  if (bits.readBits(4) === 15) {
    bits.skipBits(24)
  }

  bits.skipBits(4)

  return bits.readBits(1) === 1 ? 960 : 1024
}

/**
 * Scans FLV tag structure and selected decoder configurations before exposing
 * H.264 video and AAC-LC audio tracks. Unselected media payloads stay on disk.
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
  selection: 'all' | 'audio' | 'video' = 'all',
): Promise<MediaInput> {
  const configs = new Map<'video' | 'audio', Uint8Array<ArrayBuffer>>()

  // Validate the entire file before creating output, including later sequence headers.
  for await (const tag of readTags(
    blob,
    selection === 'all' ? undefined : selection,
    true,
    signal,
  )) {
    if (tag.packetType === 0) {
      const previous = configs.get(tag.kind)
      if (previous && !sameBytes(previous, tag.data)) {
        throw new Error('FLV decoder configuration changes within a segment.')
      }

      configs.set(tag.kind, tag.data)
    } else if (tag.packetType === 1 && !configs.has(tag.kind)) {
      throw new Error('FLV media packet precedes its decoder configuration.')
    }
  }

  const tracks: PacketTrack[] = []

  for (const [kind, description] of configs) {
    const config =
      kind === 'video' ? videoConfig(description) : audioConfig(description)
    tracks.push({
      kind,
      config,

      /**
       * Rereads this FLV track, deriving packet durations from codec or tag timing.
       *
       * @param metadataOnly - Whether to omit encoded payloads; defaults to false.
       * @returns An asynchronous generator that completes without a return value.
       * @yields {EncodedPacket} Packets with presentation timing and decode sequence numbers.
       * @throws If tag parsing, decode timestamp ordering, or cancellation fails.
       */
      async *packets(metadataOnly = false) {
        let pending: FlvTag | undefined
        let sequence = 0
        let lastDuration =
          kind === 'audio' && 'sampleRate' in config
            ? aacFrameSamples(description) / config.sampleRate
            : 1 / 30

        /**
         * Converts a media tag to a packet and advances this iterator's sequence.
         *
         * @param tag - Media tag whose payload and composition offset to preserve.
         * @param duration - Decode duration in seconds, also used as a presentation estimate.
         * @returns An encoded packet with the next decode sequence number.
         */
        function packet(tag: FlvTag, duration: number) {
          return new EncodedPacket(
            tag.data,
            tag.isKey ? 'key' : 'delta',
            tag.timestamp + tag.compositionTime,
            duration,
            sequence++,
            tag.size,
            { decodeDuration: duration },
          )
        }

        // Hold one media tag so the next tag can establish its video duration.
        // Audio uses its codec duration; final video reuses the last duration.
        for await (const tag of readTags(blob, kind, metadataOnly, signal)) {
          if (tag.packetType !== 0) {
            if (pending) {
              const delta = tag.timestamp - pending.timestamp
              if (delta < 0 || (delta === 0 && tag.packetType === 1)) {
                throw new Error(
                  'FLV decode timestamps must increase within each track.',
                )
              }

              if (kind === 'video' && delta > 0) {
                lastDuration = delta
              }

              yield packet(pending, lastDuration)
            }

            pending = tag.packetType === 1 ? tag : undefined
          }
        }

        if (pending) {
          yield packet(pending, lastDuration)
        }
      },
    })
  }

  return {
    tracks,

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
