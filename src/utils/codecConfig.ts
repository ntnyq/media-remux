import { isEmptyArray } from '@ntnyq/utils'
import { MEDIA_CODEC, REMUX_ERROR_CODE } from '../constants'
import {
  InvalidAacDescriptionError,
  parseAacAudioSpecificConfig,
} from '../vendor/mediabunny/shared/aac-misc'
import { extractColorSpace } from '../vendor/mediabunny/src/codec'
import {
  deserializeAvcDecoderConfigurationRecord,
  parseAvcSps,
} from '../vendor/mediabunny/src/codec-data'
import { createRemuxError, withRemuxErrorCode } from './errors'

/**
 * Builds an H.264 decoder configuration from an AVCDecoderConfigurationRecord.
 *
 * @param description - AVCDecoderConfigurationRecord bytes.
 * @param container - Input container for diagnostics.
 * @returns Codec identifier, display dimensions, and original initialization bytes.
 * @throws {Error} If AVC parsing fails or required parameter sets are missing.
 */
export function avcDecoderConfig(
  description: Uint8Array<ArrayBuffer>,
  container: 'FLV' | 'MKV' | 'MPEG-TS',
): VideoDecoderConfig {
  const avc = deserializeAvcDecoderConfigurationRecord(description)
  const sps = avc?.sequenceParameterSets[0]
  const info = sps && parseAvcSps(sps)

  if (!avc || !info || isEmptyArray(avc.pictureParameterSets)) {
    throw createRemuxError(
      REMUX_ERROR_CODE.invalidInput,
      `Invalid ${container} AVC decoder configuration.`,
    )
  }

  const profile = [...description.subarray(1, 4)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')

  return {
    codec: `avc1.${profile}`,
    codedWidth: info.displayWidth,
    codedHeight: info.displayHeight,
    // Use the same SPS-derived color fields as the MP4 reader, including the
    // limited-range default when the SPS omits video signal metadata.
    colorSpace: extractColorSpace({
      codec: MEDIA_CODEC.avc,
      codecDescription: description,
      avcCodecInfo: avc,
      hevcCodecInfo: null,
      vp9CodecInfo: null,
      av1CodecInfo: null,
      proresCodecInfo: null,
    }),
    ...(info.pixelAspectRatio.num === info.pixelAspectRatio.den
      ? {}
      : {
          displayAspectWidth: info.displayWidth * info.pixelAspectRatio.num,
          displayAspectHeight: info.displayHeight * info.pixelAspectRatio.den,
        }),
    description,
  }
}

/**
 * Reads an AAC-LC AudioSpecificConfig for packet copying.
 *
 * @param description - AudioSpecificConfig bytes.
 * @param container - Input container for diagnostics.
 * @returns The decoder configuration and nominal frame duration in seconds.
 * @throws {Error} If AAC-LC, a channel count, or a positive sample rate are absent.
 */
export function readAacLcConfig(
  description: Uint8Array<ArrayBuffer>,
  container: 'FLV' | 'MKV' | 'MPEG-TS',
) {
  let info

  try {
    info = parseAacAudioSpecificConfig(description)
  } catch (error) {
    if (error instanceof InvalidAacDescriptionError) {
      throw withRemuxErrorCode(error, REMUX_ERROR_CODE.invalidInput)
    }

    throw error
  }

  if (
    info.objectType !== 2 ||
    info.sbrPresent ||
    !info.outputNumberOfChannels ||
    !info.outputSampleRate ||
    !(info.outputSampleRate > 0)
  ) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedCodec,
      `${container} requires AAC-LC with a known channel layout.`,
    )
  }

  return {
    config: {
      codec: 'mp4a.40.2',
      numberOfChannels: info.outputNumberOfChannels,
      sampleRate: info.outputSampleRate,
      description,
    } satisfies AudioDecoderConfig,
    frameDuration: info.frameLength / info.outputSampleRate,
  }
}
