const MPEG1_LAYER3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
] as const
const MPEG2_LAYER3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
] as const
const MPEG1_SAMPLE_RATES = [44_100, 48_000, 32_000] as const

/**
 * Stream format and frame boundaries derived from a Layer III header.
 */
export interface Mp3FrameHeader {
  sampleRate: number
  numberOfChannels: number
  duration: number
  size: number
}

/**
 * Parses a four-byte MPEG-1, MPEG-2, or MPEG-2.5 Layer III frame header.
 * Free-format frames have no fixed header bitrate to calculate their length.
 */
export function parseMp3FrameHeader(bytes: Uint8Array): Mp3FrameHeader | null {
  const [sync = 0, versionAndLayer = 0, rate = 0, mode = 0] = bytes
  const version = (versionAndLayer >> 3) & 3
  const layer = (versionAndLayer >> 1) & 3

  if (
    bytes.length < 4 ||
    sync !== 0xff ||
    (versionAndLayer & 0xe0) !== 0xe0 ||
    version === 1 ||
    layer !== 1
  ) {
    return null
  }

  const mpeg1 = version === 3
  const bitrates = mpeg1 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES
  const bitrate = bitrates[rate >> 4]
  const baseSampleRate = MPEG1_SAMPLE_RATES[(rate >> 2) & 3]

  if (!bitrate || !baseSampleRate) {
    return null
  }

  const sampleRate = baseSampleRate / (mpeg1 ? 1 : version === 2 ? 2 : 4)
  const samples = mpeg1 ? 1152 : 576
  const duration = samples / sampleRate

  return {
    sampleRate,
    numberOfChannels: mode >> 6 === 3 ? 1 : 2,
    duration,
    size:
      Math.floor((bitrate * 1000 * samples) / (8 * sampleRate)) +
      ((rate >> 1) & 1),
  }
}

/**
 * Checks whether the first Layer III frame starts without a bit reservoir.
 * A protected frame has a two-byte CRC before the side information.
 */
export function isIndependentMp3Frame(bytes: Uint8Array): boolean {
  const header = parseMp3FrameHeader(bytes)

  if (!header || header.size > bytes.length) {
    return false
  }

  const versionAndLayer = bytes[1]!
  const sideInfo = (versionAndLayer & 1) === 0 ? 6 : 4
  const isMpeg1 = ((versionAndLayer >> 3) & 3) === 3
  const sideInfoSize = isMpeg1
    ? header.numberOfChannels === 1
      ? 17
      : 32
    : header.numberOfChannels === 1
      ? 9
      : 17

  return (
    sideInfo + sideInfoSize <= header.size &&
    bytes[sideInfo] === 0 &&
    (!isMpeg1 || (bytes[sideInfo + 1]! & 0x80) === 0)
  )
}
