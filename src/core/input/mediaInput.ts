/* oxlint-disable no-await-in-loop -- Packet cursors advance in decode order with backpressure. */
import { checkAbort } from '../../abort'
import { Input } from '../../vendor/mediabunny/src/input'
import { MP4 } from '../../vendor/mediabunny/src/input-format'
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
   * Media kind, corresponding to H.264 video or AAC audio.
   */
  kind: 'video' | 'audio'

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
 * Opens the selected primary H.264/AAC tracks from an MP4 or FLV Blob.
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
  selection: 'all' | 'audio' | 'video' = 'all',
): Promise<MediaInput> {
  checkAbort(signal)
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new TypeError('Media input must be a nonempty Blob.')
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
      selection === 'audio' ? null : await input.getPrimaryVideoTrack(),
      selection === 'video' ? null : await input.getPrimaryAudioTrack(),
    ]) {
      checkAbort(signal)
      if (track) {
        // Protected sample entries remain encrypted even when their scheme or
        // auxiliary IV metadata is unsupported or missing. Never copy ciphertext
        // into a clear output track; unselected tracks may still be discarded.
        const codecId = await track.getInternalCodecId()
        if (
          typeof codecId === 'string' &&
          ['encv', 'enca'].includes(codecId.toLowerCase())
        ) {
          throw new Error('Encrypted MP4 tracks are unsupported.')
        }

        const codec = await track.getCodec()
        if (codec !== 'avc' && codec !== 'aac') {
          throw new Error(`Unsupported codec: ${codec}. Expected H.264 or AAC.`)
        }

        const config = await track.getDecoderConfig()
        if (!config) {
          throw new Error('Missing decoder configuration.')
        }

        const sink = new EncodedPacketSink(track)
        tracks.push({
          kind: track.isVideoTrack() ? 'video' : 'audio',
          config,
          ...(track.isVideoTrack()
            ? { matrix: await track.getTransformationMatrix() }
            : {}),

          /**
           * Walks this MP4 track in decode order with bounded packet reads.
           *
           * @param metadataOnly - Whether to omit encoded payloads; defaults to false.
           * @returns An asynchronous generator that completes without a return value.
           * @yields {EncodedPacket} Packets retaining source timing and sequence numbers.
           * @throws If packet reading fails or the cancellation signal is aborted.
           */
          async *packets(metadataOnly = false) {
            let packet = await sink.getFirstPacket({ metadataOnly })

            while (packet) {
              checkAbort(signal)
              yield packet
              packet = await sink.getNextPacket(packet, { metadataOnly })
            }

            checkAbort(signal)
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
    throw error
  }
}
