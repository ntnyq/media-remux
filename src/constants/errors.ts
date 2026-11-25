/**
 * Stable media error codes shared by the core and Worker APIs.
 */
export const REMUX_ERROR_CODE = {
  /**
   * The input is not a supported container.
   */
  unsupportedContainer: 'UNSUPPORTED_CONTAINER',

  /**
   * A selected track uses an unsupported codec.
   */
  unsupportedCodec: 'UNSUPPORTED_CODEC',

  /**
   * The selected operation requires a media feature or capability the remuxer
   * cannot use.
   */
  unsupportedMediaFeature: 'UNSUPPORTED_MEDIA_FEATURE',

  /**
   * Segments differ in selected track layout or configuration.
   */
  incompatibleSegments: 'INCOMPATIBLE_SEGMENTS',

  /**
   * The input is empty, malformed, or contains invalid media data.
   */
  invalidInput: 'INVALID_INPUT',

  /**
   * The requested primary track selection cannot be satisfied.
   */
  missingRequiredTrack: 'MISSING_REQUIRED_TRACK',
} as const
