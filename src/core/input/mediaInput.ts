/* oxlint-disable no-await-in-loop -- Packet cursors advance in decode order with backpressure. */
import { isString } from '@ntnyq/utils'
import type { ValueOf } from '@ntnyq/utils'
import { checkAbort } from '../../abort'
import {
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_TRACK_SELECTION,
} from '../../constants'
import { createRemuxError, withRemuxErrorCode } from '../../errors'
import type { RemuxTrackSelection } from '../../types'
import { InvalidAacDescriptionError } from '../../vendor/mediabunny/shared/aac-misc'
import {
  Input,
  UnsupportedInputFormatError,
} from '../../vendor/mediabunny/src/input'
import { MP4 } from '../../vendor/mediabunny/src/input-format'
import {
  InvalidIsobmffInputError,
  UnsupportedIsobmffInputError,
} from '../../vendor/mediabunny/src/isobmff/isobmff-demuxer'
import type { IsobmffColorInformation } from '../../vendor/mediabunny/src/isobmff/isobmff-misc'
import { EncodedPacketSink } from '../../vendor/mediabunny/src/media-sink'
import type { TransformationMatrix } from '../../vendor/mediabunny/src/misc'
import type { EncodedPacket } from '../../vendor/mediabunny/src/packet'
import { BlobSource } from '../../vendor/mediabunny/src/source'
import { openFlvInput } from './flvInput'

/**
 * Supported encoded track with its decoder configuration and repeatable packet reader.
 */
export interface PacketTrack {
  /**
   * Media kind of the selected track.
   */
  kind: ValueOf<typeof MEDIA_TRACK_KIND>

  /**
   * Validated codec family used by the encoded packet source.
   */
  codec: ValueOf<typeof MEDIA_CODEC>

  /**
   * Decoder configuration matching kind, including codec initialization bytes.
   */
  config: VideoDecoderConfig | AudioDecoderConfig

  /**
   * Optional video display transformation preserved in the output. An absent
   * matrix is treated as identity for compatibility checks; audio omits it.
   */
  matrix?: TransformationMatrix

  /**
   * Numeric color identifiers explicitly signaled by an MP4 video track.
   */
  containerColorInformation?: IsobmffColorInformation

  /**
   * Creates a fresh packet iterator in decode order, starting at the first packet.
   *
   * @param metadataOnly - Whether to omit encoded payload bytes while retaining
   * packet timing, kind, and byte lengths; defaults to false.
   * @returns An asynchronous generator yielding encoded packets until track end.
   * @throws If packet parsing fails or the input's cancellation signal is aborted.
   */
  packets: (
    metadataOnly?: boolean,
  ) => AsyncGenerator<EncodedPacket, void, unknown>
}

/**
 * Open MP4 or FLV input with selected primary tracks and owned parser resources.
 */
export interface MediaInput {
  /**
   * Available selected tracks. The list can be empty if the requested kind is absent.
   */
  tracks: PacketTrack[]

  /**
   * Releases parser resources and abort listeners after packet readers finish.
   * Blob-backed FLV inputs have no resources to release.
   *
   * @returns Nothing.
   */
  dispose: () => void
}

/**
 * Codes explicit MP4 parser failures without classifying filesystem read errors.
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
 * Track selection applied when opening an individual input.
 */
export type InputTrackSelection = Exclude<
  RemuxTrackSelection,
  typeof REMUX_TRACK_SELECTION.videoWithOptionalAudio
>

/**
 * Opens the selected primary encoded tracks from an MP4 or FLV Blob.
 * Detects FLV by its leading signature and otherwise attempts MP4 parsing.
 * Packet iterators read in decode order and can omit encoded payloads during
 * metadata inspection. The caller must dispose the returned input after use.
 *
 * @param blob - Nonempty source media Blob.
 * @param signal - Optional cancellation signal used during opening and iteration.
 * @param selection - Track kinds to open; defaults to all supported primary tracks.
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
  selection: InputTrackSelection = REMUX_TRACK_SELECTION.all,
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

  const magic = new Uint8Array(await blob.slice(0, 3).arrayBuffer())

  checkAbort(signal)

  if (magic[0] === 0x46 && magic[1] === 0x4c && magic[2] === 0x56) {
    return openFlvInput(blob, signal, selection)
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

    for (const track of [
      selection === REMUX_TRACK_SELECTION.audio
        ? null
        : await input.getPrimaryVideoTrack(),
      selection === REMUX_TRACK_SELECTION.video
        ? null
        : await input.getPrimaryAudioTrack(),
    ]) {
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
          codec !== MEDIA_CODEC.aac
        ) {
          throw createRemuxError(
            REMUX_ERROR_CODE.unsupportedCodec,
            `Unsupported codec: ${codec}. Expected H.264, HEVC, AV1, or AAC.`,
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

        const sink = new EncodedPacketSink(track)
        const containerColorInformation = track.isVideoTrack()
          ? track.getContainerColorInformation()
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

          /**
           * Walks this MP4 track in decode order with bounded packet reads.
           *
           * @param metadataOnly - Whether to omit encoded payloads; defaults to false.
           * @returns An asynchronous generator that completes without a return value.
           * @yields {EncodedPacket} Packets retaining source timing and sequence numbers.
           * @throws If packet reading fails or the cancellation signal is aborted.
           */
          async *packets(metadataOnly = false) {
            try {
              checkAbort(signal)
              let packet = await sink.getFirstPacket({ metadataOnly })

              while (packet) {
                checkAbort(signal)
                yield packet
                checkAbort(signal)
                packet = await sink.getNextPacket(packet, { metadataOnly })
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
