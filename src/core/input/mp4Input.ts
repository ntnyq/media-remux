/* oxlint-disable no-await-in-loop -- Packet cursors advance in decode order with backpressure. */
import { isString, isUndefined } from '@ntnyq/utils'
import {
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_TRACK_SELECTION,
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
import type { EncodedPacket } from '../../vendor/mediabunny/src/packet'
import { BlobSource } from '../../vendor/mediabunny/src/source'

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
 * Reports a selected MP4 codec outside the supported families.
 *
 * @param codec - Codec reported by the MP4 parser, if known.
 * @returns An error with the unsupported-codec code.
 */
function unsupportedMp4Codec(codec: string | null) {
  return createRemuxError(
    REMUX_ERROR_CODE.unsupportedCodec,
    `Unsupported codec: ${codec}. Expected H.264, HEVC, AV1, AAC, MP3, or AC-3.`,
  )
}

/**
 * Opens the selected MP4 video and audio tracks with bounded packet readers.
 *
 * @param blob - Source MP4 Blob.
 * @param signal - Optional cancellation signal for parsing and iteration.
 * @param selection - Track kinds and ordering to use.
 * @returns A promise resolving to selected tracks and the parser disposer.
 * @throws If parsing fails or a selected track is encrypted, unsupported, or invalid.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function openMp4Input(
  blob: Blob,
  signal: AbortSignal | undefined,
  selection: RemuxTrackSelection,
): Promise<MediaInput> {
  const input = new Input({
    formats: [MP4],
    source: new BlobSource(blob, { maxCacheSize: 4 * 1024 * 1024 }),
    formatOptions: {
      isobmff: { _suppressMetadataTags: true, _suppressPsshParsing: true },
    },
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

        const sink = new EncodedPacketSink(track)

        /**
         * Walks this MP4 track in decode order with bounded packet reads.
         *
         * @param metadataOnly - Whether to omit encoded payloads; defaults to false.
         * @param skipPackets - Number of leading packets to skip without reading payloads.
         * @returns An asynchronous generator that completes without a return value.
         * @yields {EncodedPacket} Packets retaining source timing and sequence numbers.
         * @throws If packet reading fails or the cancellation signal is aborted.
         */
        async function* packets(metadataOnly = false, skipPackets = 0) {
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
        }

        if (track.isVideoTrack()) {
          const codec = await track.getCodec()

          if (
            codec !== MEDIA_CODEC.avc &&
            codec !== MEDIA_CODEC.hevc &&
            codec !== MEDIA_CODEC.av1
          ) {
            throw unsupportedMp4Codec(codec)
          }

          const config = await track.getDecoderConfig()

          if (!config) {
            throw createRemuxError(
              REMUX_ERROR_CODE.invalidInput,
              'Missing decoder configuration.',
            )
          }

          if (codec !== MEDIA_CODEC.avc && !config.description?.byteLength) {
            throw createRemuxError(
              REMUX_ERROR_CODE.invalidInput,
              `Missing ${codec === MEDIA_CODEC.hevc ? 'hvcC' : 'av1C'} configuration in MP4 video track.`,
            )
          }

          const containerColorInformation = track.getContainerColorInformation()

          tracks.push({
            kind: MEDIA_TRACK_KIND.video,
            codec,
            config,
            matrix: await track.getTransformationMatrix(),
            ...(containerColorInformation && { containerColorInformation }),
            packets,
            ...(codec === MEDIA_CODEC.avc && {
              /**
               * Checks later sync samples for an H.264 IDR.
               *
               * @param packet - Packet after which to look for random access.
               * @returns A promise resolving to the next verified IDR or null.
               * @throws If packet reading or cancellation fails.
               */
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
            }),
          })
        } else {
          const codec = await track.getCodec()

          if (
            codec !== MEDIA_CODEC.aac &&
            codec !== MEDIA_CODEC.mp3 &&
            codec !== MEDIA_CODEC.ac3
          ) {
            throw unsupportedMp4Codec(codec)
          }

          const config = await track.getDecoderConfig()

          if (!config) {
            throw createRemuxError(
              REMUX_ERROR_CODE.invalidInput,
              'Missing decoder configuration.',
            )
          }

          if (
            codec === MEDIA_CODEC.ac3 &&
            config.description?.byteLength !== 3
          ) {
            throw createRemuxError(
              REMUX_ERROR_CODE.invalidInput,
              'Missing or invalid dac3 configuration in MP4 audio track.',
            )
          }

          const audioEditStart = track.getMediaEditStart()

          tracks.push({
            kind: MEDIA_TRACK_KIND.audio,
            codec,
            config,
            ...(isUndefined(audioEditStart) ? {} : { audioEditStart }),
            packets,
          })
        }
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
