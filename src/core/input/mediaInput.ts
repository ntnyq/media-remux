/* oxlint-disable no-await-in-loop -- Packet cursors advance in decode order with backpressure. */
import { isString, isUndefined } from '@ntnyq/utils'
import {
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_TRACK_SELECTION,
  MKV_ID,
} from '../../constants'
import type { RemuxTrackSelection, MediaInput, PacketTrack } from '../../types'
import { checkAbort, createRemuxError, withRemuxErrorCode } from '../../utils'
import { InvalidAacDescriptionError } from '../../vendor/mediabunny/shared/aac-misc'
import {
  AvcNalUnitType,
  extractNalUnitTypeForAvc,
  iterateAvcNalUnits,
} from '../../vendor/mediabunny/src/codec-data'
import {
  Input,
  UnsupportedInputFormatError,
} from '../../vendor/mediabunny/src/input'
import { MP4 } from '../../vendor/mediabunny/src/input-format'
import {
  InvalidIsobmffInputError,
  UnsupportedIsobmffInputError,
} from '../../vendor/mediabunny/src/isobmff/isobmff-demuxer'
import { EncodedPacketSink } from '../../vendor/mediabunny/src/media-sink'
import { TS_PACKET_SIZE } from '../../vendor/mediabunny/src/mpeg-ts/mpeg-ts-demuxer'
import type { EncodedPacket } from '../../vendor/mediabunny/src/packet'
import { BlobSource } from '../../vendor/mediabunny/src/source'
import { openFlvInput } from './flvInput'
import { openMkvInput } from './mkvInput'
import { openMpegTsInput } from './mpegTsInput'

/**
 * Adds remux error codes to explicit MP4 parser failures.
 *
 * @param error - A failure from MP4 input opening or packet reading.
 * @returns The classified error, or the original value for unrecognized failures.
 */
function classifyMp4Error(error: unknown): unknown {
  if (error instanceof UnsupportedInputFormatError) {
    return withRemuxErrorCode(error, REMUX_ERROR_CODE.unsupportedContainer)
  }

  if (error instanceof UnsupportedIsobmffInputError) {
    return withRemuxErrorCode(error, REMUX_ERROR_CODE.unsupportedMediaFeature)
  }

  if (
    error instanceof InvalidIsobmffInputError ||
    error instanceof InvalidAacDescriptionError
  ) {
    return withRemuxErrorCode(error, REMUX_ERROR_CODE.invalidInput)
  }

  return error
}

/**
 * Checks whether an H.264 packet's first slice is an IDR that resets reference pictures.
 *
 * @param packet - Encoded H.264 packet containing its NAL units.
 * @param config - Video decoder configuration used to locate the NAL units.
 * @returns Whether the first slice is a validly bounded IDR NAL unit.
 */
function isAvcIdrPacket(packet: EncodedPacket, config: VideoDecoderConfig) {
  for (const { offset, length } of iterateAvcNalUnits(packet.data, config)) {
    const header = packet.data[offset]

    if (
      isUndefined(header) ||
      length < 1 ||
      offset + length > packet.byteLength
    ) {
      return false
    }

    const type = extractNalUnitTypeForAvc(header)

    if (type >= AvcNalUnitType.NON_IDR_SLICE && type <= AvcNalUnitType.IDR) {
      return type === AvcNalUnitType.IDR
    }
  }

  return false
}

/**
 * Opens the selected encoded tracks from an MP4, FLV, MKV, or MPEG-TS Blob.
 * Detects FLV, EBML, and MPEG-TS by signature and otherwise attempts MP4 parsing.
 * Packet iterators read in decode order and can omit encoded payloads during
 * metadata inspection. The caller must dispose the returned input after use.
 *
 * @param blob - Nonempty source media Blob.
 * @param signal - Optional cancellation signal used during opening and iteration.
 * @param selection - Track kinds and ordering to use; defaults to both primary tracks.
 * @returns A promise resolving to track configurations, packet iterators, and
 * a disposer. The track list may be empty if the selected kind is absent.
 * @throws {TypeError} If the input is not a nonempty Blob.
 * @throws {Error} If parsing fails, a selected track is encrypted, its codec is
 * unsupported, or its decoder configuration is missing or invalid.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function openMediaInput(
  blob: Blob,
  signal?: AbortSignal,
  selection: RemuxTrackSelection = REMUX_TRACK_SELECTION.all,
): Promise<MediaInput> {
  checkAbort(signal)

  if (!(blob instanceof Blob)) {
    throw new TypeError('Media input must be a nonempty Blob.')
  }

  if (blob.size === 0) {
    throw withRemuxErrorCode(
      new TypeError('Media input must be a nonempty Blob.'),
      REMUX_ERROR_CODE.invalidInput,
    )
  }

  const magic = new Uint8Array(await blob.slice(0, 4).arrayBuffer())

  checkAbort(signal)

  if (magic[0] === 0x46 && magic[1] === 0x4c && magic[2] === 0x56) {
    return openFlvInput(blob, signal, selection)
  }

  if (
    magic.length === 4 &&
    new DataView(magic.buffer).getUint32(0) === MKV_ID.header
  ) {
    return openMkvInput(blob, signal, selection)
  }

  if (magic[0] === 0x47) {
    const sync = new Uint8Array(
      await blob.slice(0, 2 * TS_PACKET_SIZE + 1).arrayBuffer(),
    )

    checkAbort(signal)

    if (
      sync[TS_PACKET_SIZE] === 0x47 &&
      (sync.length <= 2 * TS_PACKET_SIZE || sync[2 * TS_PACKET_SIZE] === 0x47)
    ) {
      return openMpegTsInput(blob, signal, selection)
    }
  }

  const input = new Input({
    formats: [MP4],
    source: new BlobSource(blob, { maxCacheSize: 4 * 1024 * 1024 }),
  })

  /**
   * Releases the MP4 parser immediately when its cancellation signal fires.
   *
   * @returns Nothing.
   */
  const abort = () => input.dispose()

  signal?.addEventListener('abort', abort, { once: true })

  try {
    const tracks: PacketTrack[] = []
    const inFileOrder =
      selection === REMUX_TRACK_SELECTION.firstVideoWithOptionalAudio

    const selected = inFileOrder
      ? [(await input.getVideoTracks())[0], (await input.getAudioTracks())[0]]
      : [
          selection === REMUX_TRACK_SELECTION.audio
            ? null
            : await input.getPrimaryVideoTrack(),
          selection === REMUX_TRACK_SELECTION.video
            ? null
            : await input.getPrimaryAudioTrack(),
        ]

    for (const track of selected) {
      checkAbort(signal)

      if (track) {
        // Protected sample entries remain encrypted even when their scheme or
        // auxiliary IV metadata is unsupported or missing. Never copy ciphertext
        // into a clear output track; unselected tracks may still be discarded.
        const codecId = await track.getInternalCodecId()

        if (
          isString(codecId) &&
          ['encv', 'enca'].includes(codecId.toLowerCase())
        ) {
          throw createRemuxError(
            REMUX_ERROR_CODE.unsupportedMediaFeature,
            'Encrypted MP4 tracks are unsupported.',
          )
        }

        const codec = await track.getCodec()

        if (
          codec !== MEDIA_CODEC.avc &&
          codec !== MEDIA_CODEC.hevc &&
          codec !== MEDIA_CODEC.av1 &&
          codec !== MEDIA_CODEC.aac &&
          codec !== MEDIA_CODEC.mp3 &&
          codec !== MEDIA_CODEC.ac3
        ) {
          throw createRemuxError(
            REMUX_ERROR_CODE.unsupportedCodec,
            `Unsupported codec: ${codec}. Expected H.264, HEVC, AV1, AAC, MP3, or AC-3.`,
          )
        }

        const config = await track.getDecoderConfig()

        if (!config) {
          throw createRemuxError(
            REMUX_ERROR_CODE.invalidInput,
            'Missing decoder configuration.',
          )
        }

        if (
          (codec === MEDIA_CODEC.hevc || codec === MEDIA_CODEC.av1) &&
          !config.description?.byteLength
        ) {
          throw createRemuxError(
            REMUX_ERROR_CODE.invalidInput,
            `Missing ${codec === MEDIA_CODEC.hevc ? 'hvcC' : 'av1C'} configuration in MP4 video track.`,
          )
        }

        if (codec === MEDIA_CODEC.ac3 && config.description?.byteLength !== 3) {
          throw createRemuxError(
            REMUX_ERROR_CODE.invalidInput,
            'Missing or invalid dac3 configuration in MP4 audio track.',
          )
        }

        const sink = new EncodedPacketSink(track)
        const containerColorInformation = track.isVideoTrack()
          ? track.getContainerColorInformation()
          : undefined
        const audioEditStart = track.isAudioTrack()
          ? track.getMediaEditStart()
          : undefined

        tracks.push({
          kind: track.isVideoTrack()
            ? MEDIA_TRACK_KIND.video
            : MEDIA_TRACK_KIND.audio,
          codec,
          config,
          ...(track.isVideoTrack()
            ? { matrix: await track.getTransformationMatrix() }
            : {}),
          ...(containerColorInformation && { containerColorInformation }),
          ...(isUndefined(audioEditStart) ? {} : { audioEditStart }),
          ...(codec === MEDIA_CODEC.avc && !('sampleRate' in config)
            ? {
                async findNextRandomAccessPacket(packet: EncodedPacket) {
                  try {
                    let candidate = await sink.getNextKeyPacket(packet)

                    while (candidate) {
                      checkAbort(signal)

                      if (isAvcIdrPacket(candidate, config)) {
                        return candidate
                      }

                      candidate = await sink.getNextKeyPacket(candidate)
                    }

                    checkAbort(signal)

                    return null
                  } catch (error) {
                    checkAbort(signal)

                    throw classifyMp4Error(error)
                  }
                },
              }
            : {}),

          /**
           * Walks this MP4 track in decode order with bounded packet reads.
           *
           * @param metadataOnly - Whether to omit encoded payloads; defaults to false.
           * @param skipPackets - Number of leading packets to skip without reading payloads.
           * @returns An asynchronous generator that completes without a return value.
           * @yields {EncodedPacket} Packets retaining source timing and sequence numbers.
           * @throws If packet reading fails or the cancellation signal is aborted.
           */
          async *packets(metadataOnly = false, skipPackets = 0) {
            try {
              checkAbort(signal)
              let packet = await sink.getFirstPacket({
                metadataOnly: metadataOnly || skipPackets > 0,
              })

              while (packet) {
                checkAbort(signal)

                if (skipPackets > 0) {
                  skipPackets--
                } else {
                  yield packet
                  checkAbort(signal)
                }

                packet = await sink.getNextPacket(packet, {
                  metadataOnly: metadataOnly || skipPackets > 0,
                })
              }

              checkAbort(signal)
            } catch (error) {
              // Abort disposes the parser, which can reject an in-flight read.
              // Keep the caller's cancellation reason instead of that cleanup error.
              checkAbort(signal)

              throw classifyMp4Error(error)
            }
          },
        })
      }
    }

    return {
      tracks,

      /**
       * Detaches cancellation handling and releases the underlying MP4 parser.
       *
       * @returns Nothing.
       */
      dispose() {
        signal?.removeEventListener('abort', abort)
        input.dispose()
      },
    }
  } catch (error) {
    signal?.removeEventListener('abort', abort)
    input.dispose()
    checkAbort(signal)

    throw classifyMp4Error(error)
  }
}
