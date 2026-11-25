/* oxlint-disable no-await-in-loop -- Tracks and their packet ranges are read in file order. */

import { isNonEmptyObject, isUndefined } from '@ntnyq/utils'
import {
  PACKET_TYPE,
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_TRACK_SELECTION,
  MKV_ID,
} from '../../constants'
import type {
  RemuxTrackSelection,
  MediaInput,
  MkvElement,
  MkvTrack,
  PacketTrack,
} from '../../types'
import {
  avcDecoderConfig,
  createRemuxError,
  invalidMkv,
  readAacLcConfig,
} from '../../utils'
import { resolveIsobmffColorInformation } from '../../vendor/mediabunny/src/isobmff/isobmff-misc'
import type { IsobmffColorInformation } from '../../vendor/mediabunny/src/isobmff/isobmff-misc'
import { EncodedPacket } from '../../vendor/mediabunny/src/packet'
import { readBytes } from '../../vendor/mediabunny/src/reader'
import { readMkvBlocks, readMkvFrameLayout } from './mkvBlocks'
import { MkvReader } from './MkvReader'

/**
 * Reads the EBML document header and the one Matroska segment in the input.
 *
 * @param reader - Range reader positioned independently for each element.
 * @param size - Total input length in bytes.
 * @returns A promise resolving to the single Segment element.
 * @throws If the EBML header is invalid, the document type or version is unsupported,
 * or the input does not contain exactly one supported segment.
 */
async function readSegment(reader: MkvReader, size: number) {
  const header = await reader.element(0, size)

  if (header.id !== MKV_ID.header || header.unknownSize) {
    throw invalidMkv('Invalid MKV EBML header.')
  }

  let docType = ''
  let readVersion = 1

  for await (const element of reader.children(header)) {
    if (element.id === MKV_ID.docType) {
      docType = (await reader.text(element)) ?? ''
    } else if (element.id === MKV_ID.docTypeReadVersion) {
      readVersion = await reader.uint(element, 1)
    }
  }

  if (docType !== 'matroska' || readVersion < 1 || readVersion > 4) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedContainer,
      'Expected a supported Matroska EBML document.',
    )
  }

  let segment: MkvElement | undefined
  let offset = header.end

  while (offset < size) {
    const element = await reader.element(offset, size)

    if (element.id === MKV_ID.segment && !segment) {
      segment = element
    } else if (
      element.unknownSize ||
      (element.id !== MKV_ID.void && element.id !== MKV_ID.crc32)
    ) {
      throw createRemuxError(
        REMUX_ERROR_CODE.unsupportedMediaFeature,
        'Expected one MKV segment in the input.',
      )
    }

    offset = element.end
  }

  if (!segment) {
    throw invalidMkv('Missing MKV segment.')
  }

  return segment
}

/**
 * Reads track metadata. Decoder descriptions are loaded for selected tracks.
 *
 * @param reader - Range reader for the Matroska input.
 * @param tracksElement - Tracks element containing the TrackEntry children.
 * @returns A promise resolving to the track metadata in file order.
 * @throws If a track entry lacks a valid number or type, or repeats a track number.
 */
async function readTracks(reader: MkvReader, tracksElement: MkvElement) {
  const tracks: MkvTrack[] = []
  const numbers = new Set<number>()

  for await (const entry of reader.children(tracksElement)) {
    if (entry.id !== MKV_ID.trackEntry) {
      continue
    }

    const track: MkvTrack = {
      number: 0,
      type: 0,
      codecId: '',
      timestampScale: 1,
      codecDelay: 0,
      defaultDuration: 0,
      hasContentEncodings: false,
      hasTrackOffset: false,
      isEnabled: true,
      isDefault: true,
      allowsLacing: true,
    }

    for await (const element of reader.children(entry)) {
      switch (element.id) {
        case MKV_ID.trackNumber:
          track.number = await reader.uint(element)
          break
        case MKV_ID.trackType:
          track.type = await reader.uint(element)
          break
        case MKV_ID.codecId:
          track.codecId = (await reader.text(element)) ?? ''
          break
        case MKV_ID.codecPrivate:
          track.privateData = element
          break
        case MKV_ID.defaultDuration:
          track.defaultDuration = (await reader.uint(element)) / 1e9
          break
        case MKV_ID.trackTimestampScale:
          track.timestampScale = await reader.float(element, 1)
          break
        case MKV_ID.codecDelay:
          track.codecDelay = await reader.uint(element)
          break
        case MKV_ID.trackOffset:
          track.hasTrackOffset = await reader.hasNonzeroInteger(element)
          break
        case MKV_ID.contentEncodings:
          track.hasContentEncodings = true
          break
        case MKV_ID.flagEnabled:
          track.isEnabled = (await reader.uint(element, 1)) !== 0
          break
        case MKV_ID.flagDefault:
          track.isDefault = (await reader.uint(element, 1)) !== 0
          break
        case MKV_ID.flagLacing:
          track.allowsLacing = (await reader.uint(element, 1)) !== 0
          break
        case MKV_ID.video:
          track.video = element
          break
      }
    }

    if (!track.number || !track.type || numbers.has(track.number)) {
      throw invalidMkv('Invalid or duplicate MKV track number or type.')
    }

    numbers.add(track.number)
    tracks.push(track)
  }

  return tracks
}

/**
 * Applies Matroska display dimensions and reads optional container colour.
 *
 * @param reader - Range reader for the Matroska input.
 * @param video - Video element containing track display and colour fields.
 * @param config - Decoder configuration updated with any explicit display dimensions.
 * @returns A promise resolving to container colour information when present.
 * @throws If the container requests unsupported cropping or display dimensions.
 */
async function readVideoMetadata(
  reader: MkvReader,
  video: MkvElement,
  config: VideoDecoderConfig,
) {
  let pixelWidth = config.codedWidth
  let pixelHeight = config.codedHeight
  let width: number | undefined
  let height: number | undefined
  let unit = 0
  let colour: IsobmffColorInformation | undefined

  for await (const element of reader.children(video)) {
    switch (element.id) {
      case MKV_ID.pixelWidth:
        pixelWidth = await reader.uint(element)
        break
      case MKV_ID.pixelHeight:
        pixelHeight = await reader.uint(element)
        break
      case MKV_ID.displayWidth:
        width = await reader.uint(element)
        break
      case MKV_ID.displayHeight:
        height = await reader.uint(element)
        break
      case MKV_ID.displayUnit:
        unit = await reader.uint(element)
        break
      case MKV_ID.colour:
        colour = await readColour(reader, element, config.colorSpace)
        break
      case MKV_ID.pixelCropBottom:
      case MKV_ID.pixelCropTop:
      case MKV_ID.pixelCropLeft:
      case MKV_ID.pixelCropRight:
        if (await reader.uint(element)) {
          throw createRemuxError(
            REMUX_ERROR_CODE.unsupportedMediaFeature,
            'MKV container-level video cropping is unsupported.',
          )
        }

        break
    }
  }

  if (isUndefined(width) && isUndefined(height)) {
    return colour
  }

  if (unit === 0) {
    width ??= pixelWidth
    height ??= pixelHeight
  }

  if (unit > 3 || !width || !height) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      'Unsupported MKV display dimensions.',
    )
  }

  config.displayAspectWidth = width
  config.displayAspectHeight = height

  return colour
}

/**
 * Resolves explicitly supplied Matroska colour fields against the AVC VUI.
 * Matroska uses the same H.273 identifiers as the MP4 nclx box.
 *
 * @param reader - Range reader for the Matroska input.
 * @param colour - Colour element containing the explicit fields.
 * @param colorSpace - Optional fallback colour space derived from the AVC bitstream.
 * @returns A promise resolving to merged colour information, or undefined if
 * the container supplies no explicit colour values.
 * @throws If a colour identifier exceeds the MP4 nclx field width.
 */
async function readColour(
  reader: MkvReader,
  colour: MkvElement,
  colorSpace: VideoColorSpaceInit | undefined,
): Promise<IsobmffColorInformation | undefined> {
  const fields: {
    matrix?: number
    transfer?: number
    primaries?: number
    fullRange?: boolean
  } = {}

  for await (const element of reader.children(colour)) {
    const field =
      element.id === MKV_ID.matrixCoefficients
        ? 'matrix'
        : element.id === MKV_ID.transferCharacteristics
          ? 'transfer'
          : element.id === MKV_ID.primaries
            ? 'primaries'
            : undefined

    if (field) {
      const value = await reader.uint(element, 2)

      if (value > 0xffff) {
        throw invalidMkv('MKV colour identifier does not fit MP4 nclx.')
      }

      if (value !== 2) {
        fields[field] = value
      }
    } else if (element.id === MKV_ID.range) {
      const range = await reader.uint(element)

      if (range === 1 || range === 2) {
        fields.fullRange = range === 2
      }
    }
  }

  return isNonEmptyObject(fields)
    ? resolveIsobmffColorInformation(colorSpace, fields)
    : undefined
}

/**
 * Estimates the final presentation interval when the video has no track
 * default duration. Only the two largest PTS values are needed, even with B frames.
 *
 * @param reader - Range reader for the Matroska input.
 * @param segment - Segment containing the track's blocks.
 * @param track - Selected video track and its timing metadata.
 * @param tick - Segment timestamp scale in nanoseconds per tick.
 * @returns A promise resolving to the estimated duration in seconds, with a
 * 1/30-second fallback when fewer than two distinct timestamps are present.
 */
async function inferVideoDuration(
  reader: MkvReader,
  segment: MkvElement,
  track: MkvTrack,
  tick: number,
) {
  let latest = -Infinity
  let previous = -Infinity

  for await (const { timestamp } of readMkvBlocks(
    reader,
    segment,
    track,
    tick,
  )) {
    if (timestamp > latest) {
      previous = latest
      latest = timestamp
    } else if (timestamp < latest) {
      previous = Math.max(previous, timestamp)
    }
  }

  return Number.isFinite(previous) ? latest - previous : 1 / 30
}

/**
 * Creates a repeatable decode-order reader for an AVC or AAC-LC track.
 *
 * @param reader - Range reader shared with subsequent frame iteration.
 * @param segment - Segment containing the selected track's blocks.
 * @param track - Selected track entry and codec metadata.
 * @param tick - Segment timestamp scale in nanoseconds per tick.
 * @returns A promise resolving to the decoder configuration and packet reader.
 * @throws If the selected track uses unsupported features or has invalid metadata.
 */
async function createPacketTrack(
  reader: MkvReader,
  segment: MkvElement,
  track: MkvTrack,
  tick: number,
): Promise<PacketTrack> {
  const isVideo = track.type === 1

  if (track.codecId !== (isVideo ? 'V_MPEG4/ISO/AVC' : 'A_AAC')) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedCodec,
      `Unsupported MKV codec: ${track.codecId}. Expected H.264 video or AAC-LC audio.`,
    )
  }

  if (track.hasContentEncodings || track.hasTrackOffset) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      'MKV track content encodings and legacy track offsets are unsupported.',
    )
  }

  if (!Number.isFinite(track.timestampScale) || track.timestampScale <= 0) {
    throw invalidMkv('Invalid MKV track timestamp scale.')
  }

  const data = track.privateData

  if (!data || data.data === data.end) {
    throw invalidMkv('Missing MKV CodecPrivate decoder configuration.')
  }

  const size = data.end - data.data

  // The AVC record contains at most 31 SPS, 255 PPS, and 255 SPS extensions
  // with 16-bit lengths. AAC AudioSpecificConfig is much smaller.
  if (size > (isVideo ? 36 * 1024 * 1024 : 65_536)) {
    throw invalidMkv('Oversized MKV CodecPrivate decoder configuration.')
  }

  const description = readBytes(
    await reader.slice(data.data, size),
    size,
  ).slice()

  if (isVideo) {
    const config = avcDecoderConfig(description, 'MKV')
    const containerColorInformation = track.video
      ? await readVideoMetadata(reader, track.video, config)
      : undefined
    const nominalDuration =
      track.defaultDuration ||
      (await inferVideoDuration(reader, segment, track, tick))

    return {
      kind: MEDIA_TRACK_KIND.video,
      codec: MEDIA_CODEC.avc,
      config,
      ...(containerColorInformation && { containerColorInformation }),
      packets: readPackets.bind(undefined, nominalDuration),
    }
  }

  const aac = readAacLcConfig(description, 'MKV')

  return {
    kind: MEDIA_TRACK_KIND.audio,
    codec: MEDIA_CODEC.aac,
    config: aac.config,
    packets: readPackets.bind(undefined, aac.frameDuration),
  }

  /**
   * Streams source frame bytes in decode order. MKV stores PTS, so the MP4
   * writer constructs a decode clock from the supplied frame durations.
   *
   * @param nominalDuration - Default frame duration in seconds.
   * @param metadataOnly - Whether to omit encoded bytes while retaining packet metadata.
   * @param skipPackets - Number of leading packets to skip in decode order.
   * @yields {EncodedPacket} Encoded frames or packet metadata alone.
   * @throws If block parsing or frame reads fail, video uses lacing, or reading is aborted.
   */
  async function* readPackets(
    nominalDuration: number,
    metadataOnly = false,
    skipPackets = 0,
  ) {
    let sequence = 0

    for await (const block of readMkvBlocks(reader, segment, track, tick)) {
      if (block.lacing !== 0) {
        if (!track.allowsLacing) {
          throw invalidMkv('MKV track forbids laced blocks.')
        }

        if (isVideo) {
          throw createRemuxError(
            REMUX_ERROR_CODE.unsupportedMediaFeature,
            'Laced MKV video is unsupported.',
          )
        }
      }

      const { firstFrameOffset, sizes } = await readMkvFrameLayout(
        reader,
        block,
      )
      const duration = isUndefined(block.duration)
        ? nominalDuration
        : block.duration / sizes.length
      const decodeDuration =
        isVideo && duration > 0 ? duration : nominalDuration
      let position = firstFrameOffset

      for (const [index, byteLength] of sizes.entries()) {
        if (sequence < skipPackets) {
          sequence++
          position += byteLength
          continue
        }

        const bytes = metadataOnly
          ? new Uint8Array(0)
          : readBytes(await reader.slice(position, byteLength), byteLength)

        yield new EncodedPacket(
          bytes,
          !isVideo || block.isKey ? PACKET_TYPE.key : PACKET_TYPE.delta,
          block.timestamp + index * duration,
          duration,
          sequence++,
          byteLength,
          { decodeDuration },
        )
        position += byteLength
      }
    }
  }
}

/**
 * Opens selected AVC/AAC-LC tracks from one Matroska segment.
 *
 * @param blob - Source Matroska Blob.
 * @param signal - Optional cancellation signal checked during range reads.
 * @param selection - Requested track kinds and selection order.
 * @returns A promise resolving to the selected tracks and a disposer for the reader.
 * @throws If Matroska parsing fails, a selected feature is unsupported, or reading is aborted.
 */
export async function openMkvInput(
  blob: Blob,
  signal: AbortSignal | undefined,
  selection: RemuxTrackSelection,
): Promise<MediaInput> {
  const reader = new MkvReader(blob, signal)

  try {
    const segment = await readSegment(reader, blob.size)
    let tick: number | undefined
    let available: MkvTrack[] | undefined

    for await (const element of reader.children(segment)) {
      if (element.id === MKV_ID.info && isUndefined(tick)) {
        tick = 1_000_000

        for await (const field of reader.children(element)) {
          if (field.id === MKV_ID.timestampScale) {
            tick = await reader.uint(field, 1_000_000)
          }
        }
      } else if (element.id === MKV_ID.tracks && !available) {
        available = await readTracks(reader, element)
      }

      if (!isUndefined(tick) && available) {
        break
      }
    }

    if (!tick || !available) {
      throw invalidMkv(
        'Missing MKV track information or invalid timestamp scale.',
      )
    }

    const tracks: PacketTrack[] = []
    const first =
      selection === REMUX_TRACK_SELECTION.firstVideoWithOptionalAudio

    for (const [type, kind] of [
      [1, MEDIA_TRACK_KIND.video],
      [2, MEDIA_TRACK_KIND.audio],
    ] as const) {
      if (
        (selection === REMUX_TRACK_SELECTION.video ||
          selection === REMUX_TRACK_SELECTION.audio) &&
        kind !== selection
      ) {
        continue
      }

      const candidates = available.filter(
        track => track.type === type && track.isEnabled,
      )
      const selected = first
        ? candidates[0]
        : (candidates.find(track => track.isDefault) ?? candidates[0])

      if (selected) {
        tracks.push(await createPacketTrack(reader, segment, selected, tick))
      }
    }

    return { tracks, dispose: reader.dispose }
  } catch (error) {
    reader.dispose()

    throw error
  }
}
