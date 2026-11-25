/**
 * Parsed EBML element header with bounded payload offsets.
 */
export interface MkvElement {
  /**
   * Element identifier with the EBML width marker retained.
   */
  id: number

  /**
   * Absolute byte offset of the first payload byte.
   */
  data: number

  /**
   * Exclusive payload end or enclosing bound, as an absolute byte offset.
   */
  end: number

  /**
   * Whether the header used EBML's unknown-size sentinel.
   */
  unknownSize: boolean
}

/**
 * Location and timing of a Matroska block after its track header is parsed.
 */
export interface MkvBlock {
  /**
   * Absolute byte offset of the data after the track number, timecode, and flags.
   */
  offset: number

  /**
   * Exclusive end of the block payload, as an absolute byte offset.
   */
  end: number

  /**
   * Presentation timestamp of the first frame in seconds, adjusted for codec delay.
   */
  timestamp: number

  /**
   * Whether the block is marked as a keyframe or has no reference block.
   */
  isKey: boolean

  /**
   * Lacing mode encoded in the block flags.
   */
  lacing: number

  /**
   * Explicit duration of all frames in the block, in seconds, when present.
   */
  duration?: number
}

/**
 * BlockGroup children used to resolve frame timing and validate dependencies.
 */
export interface BlockGroup {
  /**
   * Encoded Block element when found.
   */
  block?: MkvElement

  /**
   * Optional BlockDuration element for the block's explicit duration.
   */
  duration?: MkvElement

  /**
   * Optional DiscardPadding element checked for unsupported padding.
   */
  discardPadding?: MkvElement

  /**
   * Whether the group declares a reference to another block.
   */
  hasReference: boolean

  /**
   * Whether the group contains codec state or block additions.
   */
  hasCodecChanges: boolean
}

/**
 * TrackEntry metadata retained before choosing and opening Matroska tracks.
 */
export interface MkvTrack {
  /**
   * Track number used to associate encoded blocks with this track.
   */
  number: number

  /**
   * Numeric Matroska track type, with 1 for video and 2 for audio.
   */
  type: number

  /**
   * Codec identifier declared by the TrackEntry.
   */
  codecId: string

  /**
   * Track-specific multiplier for block-relative timestamps and durations.
   */
  timestampScale: number

  /**
   * Codec delay subtracted from presentation timestamps, in nanoseconds.
   */
  codecDelay: number

  /**
   * Default frame duration in seconds, with zero when absent.
   */
  defaultDuration: number

  /**
   * Whether the track declares content encodings.
   */
  hasContentEncodings: boolean

  /**
   * Whether the track declares a nonzero legacy track offset.
   */
  hasTrackOffset: boolean

  /**
   * Whether the track is enabled for playback and selection.
   */
  isEnabled: boolean

  /**
   * Whether the track is marked as a default candidate for its kind.
   */
  isDefault: boolean

  /**
   * Whether the track allows multiple frames in one block.
   */
  allowsLacing: boolean

  /**
   * Optional CodecPrivate element holding decoder initialization data.
   */
  privateData?: MkvElement

  /**
   * Optional Video element holding display and colour metadata.
   */
  video?: MkvElement
}
