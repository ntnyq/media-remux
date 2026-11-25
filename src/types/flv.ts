import type { MEDIA_CODEC } from '../constants'
import type { Mp3FrameHeader } from './audio'
import type { PacketTrack } from './media'

/**
 * FLV media tag or individual MP3 frame with its normalized timing and payload.
 */
export interface FlvTag {
  /**
   * Audio or video kind associated with the tag.
   */
  kind: PacketTrack['kind']

  /**
   * Decode timestamp of the tag or frame, in seconds.
   */
  timestamp: number

  /**
   * Signed presentation offset from the decode timestamp, in seconds.
   */
  compositionTime: number

  /**
   * Uses 0 for decoder configuration, 1 for media, and 2 for AVC end of sequence.
   */
  packetType: number

  /**
   * Whether the tag is audio or is marked as an FLV video keyframe.
   */
  isKey: boolean

  /**
   * Configuration or encoded payload bytes, with media bytes omitted during metadata reads.
   */
  data: Uint8Array<ArrayBuffer>

  /**
   * Payload length in bytes even when the payload is omitted.
   */
  size: number

  /**
   * Parsed Layer III header when the tag represents an MP3 frame.
   */
  mp3?: Mp3FrameHeader
}

/**
 * Decoder initialization data or MP3 format parameters discovered during FLV inspection.
 */
export type FlvTrackFormat =
  | {
      /**
       * Codec declared by the AVC or AAC sequence header.
       */
      codec: typeof MEDIA_CODEC.avc | typeof MEDIA_CODEC.aac

      /**
       * Decoder initialization bytes from the sequence header.
       */
      description: Uint8Array<ArrayBuffer>
    }
  | {
      /**
       * Codec identified by the FLV MP3 sound format.
       */
      codec: typeof MEDIA_CODEC.mp3

      /**
       * Sample rate derived from the MP3 frame header, in hertz.
       */
      sampleRate: number

      /**
       * Channel count derived from the MP3 frame header.
       */
      numberOfChannels: number
    }
