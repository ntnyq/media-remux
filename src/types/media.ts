import type { ValueOf } from '@ntnyq/utils'
import type { MEDIA_CODEC, MEDIA_TRACK_KIND } from '../constants'
import type { IsobmffColorInformation } from '../vendor/mediabunny/src/isobmff/isobmff-misc'
import type { TransformationMatrix } from '../vendor/mediabunny/src/misc'
import type { EncodedPacket } from '../vendor/mediabunny/src/packet'

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
   * Numeric container color identifiers used when writing the MP4 video track.
   */
  containerColorInformation?: IsobmffColorInformation

  /**
   * First playable position in an MP4 audio edit, in packet timeline seconds.
   */
  audioEditStart?: number

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
 * Open media input with selected tracks and owned parser resources.
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
 * Validated presentation timeline shared by all selected tracks in a segment.
 */
export interface SegmentInfo {
  /**
   * Earliest playable timestamp in seconds, possibly negative.
   */
  start: number

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
   * @throws {Error} If source decode timing is missing.
   */
  addPacket(
    index: number,
    packet: EncodedPacket,
    presentationStart?: number,
  ): void

  /**
   * Applies the segment's common presentation shift to its decode constraints.
   *
   * @param info - Validated shared presentation origin and span, in seconds.
   * @returns Nothing.
   */
  finishSegment(info: SegmentInfo): void

  /**
   * Snapshots decode origins and presentation bounds for one-based track IDs.
   * Negative starts use a media edit. AV1 may begin at a positive tfdt.
   *
   * @returns Track IDs mapped to decode and presentation timing in seconds.
   */
  trackTimings(): Map<
    number,
    {
      decodeStart: number
      presentationStart: number
      presentationEnd: number
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
  info: SegmentInfo

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
