import type { PacketTrack, SegmentInfo } from './media'

/**
 * WebCodecs lifecycle and events shared by audio encoders and decoders.
 */
type AudioCodec = EventTarget & {
  /**
   * Current lifecycle state of the native codec.
   */
  state: CodecState

  /**
   * Drains queued requests and delivers their outputs.
   *
   * @returns A promise resolving when the codec finishes draining.
   */
  flush: () => Promise<void>

  /**
   * Releases resources owned by the native codec.
   *
   * @returns Nothing.
   */
  close: () => void
}

/**
 * Adapts one native codec instance to the shared streaming loop.
 *
 * @template Source - Input accepted by the codec.
 */
export interface AudioCodecSession<Source> {
  /**
   * Owned codec used for events and lifecycle management.
   */
  codec: AudioCodec

  /**
   * Applies the session's decoder or encoder configuration.
   *
   * @returns Nothing.
   */
  configure: () => void

  /**
   * Reads the current number of pending codec requests.
   *
   * @returns The queue size exposed by WebCodecs.
   */
  queueSize: () => number

  /**
   * Enqueues an input for encoding or decoding.
   *
   * @param source - Input to submit to the native codec.
   * @returns Nothing. The native codec delivers output asynchronously.
   */
  submit: (source: Source) => void

  /**
   * Releases an owned input after submission is attempted.
   *
   * @param source - Input whose resources are owned by the session.
   * @returns Nothing.
   */
  releaseInput?: (source: Source) => void
}

/**
 * AAC encoder output paired with any decoder metadata emitted alongside it.
 */
export interface AacChunk {
  /**
   * Encoded AAC access unit.
   */
  chunk: EncodedAudioChunk

  /**
   * Decoder configuration reported by the encoder, when available.
   */
  config?: AudioDecoderConfig | undefined
}

/**
 * Selected tracks and timing used to place a segment's audio on the PCM timeline.
 */
export interface AudioSegment {
  /**
   * Selected tracks, which may include a source audio track.
   */
  tracks: PacketTrack[]

  /**
   * Shared segment span and retained audio bounds.
   */
  info: SegmentInfo
}

/**
 * Decoded source PCM and its position on the output sample clock.
 */
export interface PcmBlock {
  /**
   * Float32 PCM samples stored in one plane per source channel.
   */
  planes: Float32Array<ArrayBuffer>[]

  /**
   * Sample rate of the decoded PCM, in hertz.
   */
  sampleRate: number

  /**
   * First sample position on the output clock, possibly fractional.
   */
  start: number

  /**
   * Exclusive end position on the output sample clock.
   */
  end: number

  /**
   * Contiguous preceding PCM planes at the same sample rate, when available.
   */
  previous?: Float32Array<ArrayBuffer>[]

  /**
   * Contiguous following PCM planes at the same sample rate, when available.
   */
  next?: Float32Array<ArrayBuffer>[]
}

/**
 * Stream format and frame boundaries derived from a Layer III header.
 */
export interface Mp3FrameHeader {
  /**
   * Audio sampling frequency in hertz after applying the MPEG version scaling.
   */
  sampleRate: number

  /**
   * Number of channels derived from the frame's channel mode.
   */
  numberOfChannels: number

  /**
   * Playback duration of one frame, in seconds.
   */
  duration: number

  /**
   * Full frame length in bytes, including its header and any padding byte.
   */
  size: number
}
