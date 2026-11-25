import type { MEDIA_CODEC, MEDIA_TRACK_KIND } from '../constants'
import type { IsobmffColorInformation } from '../vendor/mediabunny/src/isobmff/isobmff-misc'
import type { TransformationMatrix } from '../vendor/mediabunny/src/misc'
import type { EncodedPacket } from '../vendor/mediabunny/src/packet'

/**
 * Packet iterator shared by audio and video tracks.
 */
interface PacketTrackReader {
  /**
   * Creates a fresh packet iterator in decode order.
   *
   * @param metadataOnly - Whether to omit encoded payload bytes while retaining
   * packet timing, kind, and byte lengths; defaults to false.
   * @param skipPackets - Number of leading packets to skip in decode order.
   * @returns An asynchronous generator yielding encoded packets until track end.
   * @throws If packet parsing fails or the input's cancellation signal is aborted.
   */
  packets: (
    metadataOnly?: boolean,
    skipPackets?: number,
  ) => AsyncGenerator<EncodedPacket, void, unknown>
}

/**
 * Supported audio track with its decoder configuration and optional media edit.
 */
export interface AudioPacketTrack extends PacketTrackReader {
  /**
   * Discriminator for audio codecs and decoder configurations.
   */
  kind: typeof MEDIA_TRACK_KIND.audio

  /**
   * Validated audio codec family.
   */
  codec:
    | typeof MEDIA_CODEC.aac
    | typeof MEDIA_CODEC.mp3
    | typeof MEDIA_CODEC.ac3

  /**
   * Audio format and codec initialization bytes.
   */
  config: AudioDecoderConfig

  /**
   * First playable position in an MP4 audio edit, in packet timeline seconds.
   */
  audioEditStart?: number
}

/**
 * Supported video track with its decoder configuration and display metadata.
 */
export interface VideoPacketTrack extends PacketTrackReader {
  /**
   * Discriminator for video codecs and decoder configurations.
   */
  kind: typeof MEDIA_TRACK_KIND.video

  /**
   * Validated video codec family.
   */
  codec:
    | typeof MEDIA_CODEC.avc
    | typeof MEDIA_CODEC.hevc
    | typeof MEDIA_CODEC.av1

  /**
   * Video format and codec initialization bytes.
   */
  config: VideoDecoderConfig

  /**
   * Optional video display transformation preserved in the output. An absent
   * matrix is treated as identity for compatibility checks.
   */
  matrix?: TransformationMatrix

  /**
   * Numeric container color identifiers used when writing the MP4 video track.
   */
  containerColorInformation?: IsobmffColorInformation

  /**
   * Finds an independently decodable sync sample after an initial delta packet.
   *
   * @param packet - Source packet after which to search.
   * @returns A promise resolving to the next verified random-access packet,
   * or null when the track has no later one.
   * @throws If packet parsing fails or the input's cancellation signal is aborted.
   */
  findNextRandomAccessPacket?: (
    packet: EncodedPacket,
  ) => Promise<EncodedPacket | null>
}

/**
 * Encoded audio or video track with its matching configuration and packet reader.
 */
export type PacketTrack = AudioPacketTrack | VideoPacketTrack

/**
 * Open media input with selected tracks and owned parser resources.
 */
export interface MediaInput {
  /**
   * Available selected tracks. The list can be empty if the requested kind is absent.
   */
  tracks: PacketTrack[]

  /**
   * Indicates that validated tracks remain usable after disposal without
   * reopening the input. Blob-backed FLV tracks acquire no parser resources.
   */
  canReuseAfterDispose?: true

  /**
   * Releases parser resources and abort listeners after packet readers finish.
   * Blob-backed FLV inputs have no resources to release.
   *
   * @returns Nothing.
   */
  dispose: () => void
}

/**
 * Validated presentation timeline shared by all selected tracks in a segment.
 */
export interface SegmentPlan {
  /**
   * Earliest playable timestamp in seconds, possibly negative.
   */
  start: number

  /**
   * Per-track source timestamps that map to the segment start when combining
   * independently timed inputs. By default every track uses `start`.
   */
  trackOrigins?: readonly number[]

  /**
   * Positive span in seconds from start through the latest selected packet end.
   */
  duration: number

  /**
   * Number of leading packets discarded at each position in the selected track list.
   */
  skippedPackets?: readonly number[]

  /**
   * Retained audio presentation bounds in source seconds, before the segment shift.
   */
  audioRange?: {
    /**
     * First retained audio presentation timestamp in seconds.
     */
    start: number

    /**
     * Latest retained audio packet end in seconds.
     */
    end: number
  }
}

/**
 * Bounded decode-clock state carried across all segment preflight scans.
 */
export interface DecodeTimeline {
  /**
   * Records one packet in decode order using the muxer's duration quantization.
   *
   * @param index - Zero-based output track position.
   * @param packet - Packet retaining the source decode duration.
   * @param presentationStart - Visible start after any track-level audio edit.
   * @returns Nothing.
   * @throws If source decode timing is missing, invalid, or exceeds the MP4 sample duration field.
   */
  addPacket(
    index: number,
    packet: EncodedPacket,
    presentationStart?: number,
  ): void

  /**
   * Applies the segment's presentation shifts to its decode constraints.
   *
   * @param plan - Validated shared presentation origin and span, in seconds.
   * @param unshiftedStart - Earliest playable timestamp before track alignment.
   * @returns Nothing.
   */
  finishSegment(plan: SegmentPlan, unshiftedStart: number): void

  /**
   * Checks MP4 sample fields whose quantization depends on the final timeline.
   *
   * @param segments - Opens the inspected segments for metadata-only replay when needed.
   * @param signal - Optional cancellation signal checked during replay.
   * @returns A promise resolving when all copied tracks fit the MP4 fields.
   * @throws If a quantized field exceeds its MP4 range, packet reading fails, or reading is aborted.
   */
  validateSampleTiming(
    segments: () => AsyncIterable<OutputSegment>,
    signal?: AbortSignal,
  ): Promise<void>

  /**
   * Snapshots decode origins and presentation bounds for one-based track IDs.
   * Negative starts use a media edit. AV1 may begin at a positive tfdt.
   *
   * @returns Track IDs mapped to decode and presentation timing in seconds.
   */
  trackTimings(): Map<
    number,
    {
      /**
       * Initial output decode timestamp in seconds.
       */
      decodeStart: number

      /**
       * First visible presentation timestamp in seconds.
       */
      presentationStart: number

      /**
       * Exclusive end of the output presentation span in seconds.
       */
      presentationEnd: number

      /**
       * Indicates that presentation starts after a retained packet's timestamp.
       */
      hasLeadingTrim?: true
    }
  >
}

/**
 * One inspected segment ready for the output pass.
 */
export interface OutputSegment {
  /**
   * Selected source tracks in output track order.
   */
  tracks: PacketTrack[]

  /**
   * Validated presentation timing and trim information for the segment.
   */
  plan: SegmentPlan

  /**
   * Whether packet readers can close their writers when this segment ends.
   */
  isLast: boolean
}

/**
 * Packet sink and completion hook for a configured output track.
 */
export interface TrackWriter {
  /**
   * Sends a packet to its configured encoded media source.
   *
   * @param packet - Encoded packet with normalized output presentation timing.
   * @returns A promise resolving when the source accepts the packet.
   */
  add: (packet: EncodedPacket) => Promise<void>

  /**
   * Marks the encoded source complete before muxer finalization.
   *
   * @returns Nothing.
   */
  close: () => void
}
