/**
 * MPEG-1 Layer III bitrates in kilobits per second, indexed by header value.
 */
export const MPEG1_LAYER3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
] as const

/**
 * MPEG-2 and MPEG-2.5 Layer III bitrates in kilobits per second, indexed by header value.
 */
export const MPEG2_LAYER3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
] as const

/**
 * MPEG-1 sample rates in hertz, scaled down for MPEG-2 and MPEG-2.5.
 */
export const MPEG1_SAMPLE_RATES = [44_100, 48_000, 32_000] as const
