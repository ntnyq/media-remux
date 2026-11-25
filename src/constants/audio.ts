/**
 * Number of queued codec requests that triggers a wait for backpressure.
 */
export const MAX_CODEC_QUEUE = 8

/**
 * Sample rate of normalized AAC-LC output, in hertz.
 */
export const AAC_SAMPLE_RATE = 48_000

/**
 * Channel count of normalized stereo AAC-LC output.
 */
export const AAC_CHANNELS = 2

/**
 * Number of PCM samples per channel in each normalized AAC-LC frame.
 */
export const AAC_FRAME_SIZE = 1024

/**
 * WebCodecs settings used for both encoder support checks and AAC-LC encoding.
 */
export const AAC_ENCODER_CONFIG = {
  codec: 'mp4a.40.2',
  sampleRate: AAC_SAMPLE_RATE,
  numberOfChannels: AAC_CHANNELS,
  bitrate: 160_000,
} satisfies AudioEncoderConfig

/**
 * Temporary track ID reserved for spooled AAC samples, beyond the two output tracks.
 */
export const AUDIO_SPOOL_ID = 3

/**
 * Half-width of each interpolation kernel, in source samples.
 */
export const RESAMPLE_RADIUS = 8

/**
 * Number of fractional positions stored in each resampling kernel table.
 */
export const RESAMPLE_PHASES = 64
