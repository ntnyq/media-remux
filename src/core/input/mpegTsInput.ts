/* oxlint-disable no-await-in-loop -- MPEG-TS cursors consume encoded packets in decode order. */
import { isEmptyArray, isUndefined } from '@ntnyq/utils'
import {
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_TRACK_SELECTION,
} from '../../constants'
import type {
  AudioPacketTrack,
  VideoPacketTrack,
  MediaInput,
  MpegTsInput,
  PacketTrack,
  RemuxTrackSelection,
} from '../../types'
import {
  avcDecoderConfig,
  checkAbort,
  createRemuxError,
  readAacLcConfig,
  withRemuxErrorCode,
} from '../../utils'
import {
  aacChannelMap,
  aacFrequencyTable,
  buildAacAudioSpecificConfig,
  getAacProgramConfigElementChannelCount,
  readAdtsProgramConfigElement,
} from '../../vendor/mediabunny/shared/aac-misc'
import { Bitstream } from '../../vendor/mediabunny/shared/bitstream'
import {
  AvcNalUnitType,
  concatNalUnitsInLengthPrefixed,
  extractAvcDecoderConfigurationRecord,
  extractNalUnitTypeForAvc,
  iterateNalUnitsInAnnexB,
  parseAvcSps,
  removeEmulationPreventionBytes,
  serializeAvcDecoderConfigurationRecord,
} from '../../vendor/mediabunny/src/codec-data'
import {
  readExpGolomb,
  simplifyRational,
} from '../../vendor/mediabunny/src/misc'
import {
  InvalidMpegTsError,
  MPEG_TS_TIMESCALE,
  MpegTsDemuxer,
  MpegTsStreamType,
  normalizeWrappedTimestamp,
  TS_PACKET_SIZE,
  UnsupportedMpegTsError,
} from '../../vendor/mediabunny/src/mpeg-ts/mpeg-ts-demuxer'
import type { AdtsFrame } from '../../vendor/mediabunny/src/mpeg-ts/mpeg-ts-demuxer'
import {
  EncodedPacket,
  PLACEHOLDER_DATA,
} from '../../vendor/mediabunny/src/packet'
import { Reader } from '../../vendor/mediabunny/src/reader'
import { BlobSource } from '../../vendor/mediabunny/src/source'

/**
 * Program Map Table stream types recognized as video, including formats this
 * reader cannot remux.
 */
const videoStreamTypes = new Set([
  0x01,
  0x02,
  0x10,
  MpegTsStreamType.AVC,
  0x20,
  0x21,
  0x24,
  0x33,
  0x42,
])

/**
 * Program Map Table stream types recognized as audio, including formats this
 * reader cannot remux. Private audio is identified through stream descriptors.
 */
const audioStreamTypes = new Set([
  0x03,
  0x04,
  MpegTsStreamType.AAC,
  0x11,
  0x1c,
  0x81,
  0x87,
])

/**
 * Adds remux error codes to recognized MPEG-TS parser failures.
 *
 * @param error - A failure from transport-stream opening or packet reading.
 * @returns The classified error, or the original value for unrecognized failures.
 */
function classifyTsError(error: unknown) {
  if (error instanceof InvalidMpegTsError) {
    return withRemuxErrorCode(error, REMUX_ERROR_CODE.invalidInput)
  }

  if (error instanceof UnsupportedMpegTsError) {
    return withRemuxErrorCode(error, REMUX_ERROR_CODE.unsupportedMediaFeature)
  }

  return error
}

/**
 * Builds AAC initialization bytes from an ADTS header and any required program configuration.
 *
 * @param frame - First ADTS frame, including payload for in-band channel configuration.
 * @returns An MPEG-4 AudioSpecificConfig for the frame's AAC-LC format.
 * @throws If the AAC profile is unsupported or a required program configuration is invalid.
 */
function audioDescription(frame: AdtsFrame) {
  const { objectType, samplingFrequencyIndex, channelConfiguration } =
    frame.header

  if (objectType !== 2) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedCodec,
      'MPEG-TS requires AAC-LC audio.',
    )
  }

  let programConfigElement = null

  if (channelConfiguration === 0) {
    try {
      programConfigElement =
        readAdtsProgramConfigElement(frame.data)?.programConfigElement ?? null
    } catch {
      throw new InvalidMpegTsError('Invalid MPEG-TS AAC program configuration.')
    }

    if (
      !programConfigElement ||
      programConfigElement.objectType + 1 !== objectType ||
      programConfigElement.samplingFrequencyIndex !== samplingFrequencyIndex
    ) {
      throw new InvalidMpegTsError(
        'Missing or invalid MPEG-TS AAC program configuration.',
      )
    }
  }

  return buildAacAudioSpecificConfig({
    objectType,
    outputSampleRate: aacFrequencyTable[samplingFrequencyIndex]!,
    outputNumberOfChannels: programConfigElement
      ? getAacProgramConfigElementChannelCount(programConfigElement)
      : aacChannelMap[channelConfiguration]!,
    programConfigElement: programConfigElement && {
      ...programConfigElement,
      comment: new Uint8Array(0),
    },
  })
}

/**
 * Probes an ADTS stream and exposes repeatable AAC packet iteration.
 *
 * @param demuxer - Shared transport-stream demuxer.
 * @param pid - Packet identifier of the selected AAC stream.
 * @param reference - Shared timestamp rollover reference in MPEG-TS clock ticks.
 * @returns A promise resolving to the AAC decoder configuration and packet reader.
 * @throws If the stream has no ADTS frames or its initial AAC configuration is invalid or unsupported.
 */
async function openAudioTrack(
  demuxer: MpegTsDemuxer,
  pid: number,
  reference: number,
): Promise<AudioPacketTrack> {
  const probe = demuxer.readAdts(pid)
  const first = await probe.next()

  await probe.return()

  if (first.done) {
    throw new InvalidMpegTsError('MPEG-TS audio track has no ADTS frames.')
  }

  const header = first.value.header
  const description = audioDescription(first.value)
  const { config, frameDuration } = readAacLcConfig(description, 'MPEG-TS')

  return {
    kind: MEDIA_TRACK_KIND.audio,
    codec: MEDIA_CODEC.aac,
    config,
    async *packets(metadataOnly = false, skipPackets = 0) {
      let sequenceNumber = 0
      let origin: number | undefined
      let originFrame = 0
      let previous = -Infinity
      const frameTicks = frameDuration * MPEG_TS_TIMESCALE

      for await (const frame of demuxer.readAdts(pid)) {
        const { timing, data } = frame

        if (
          frame.header.objectType !== header.objectType ||
          frame.header.samplingFrequencyIndex !==
            header.samplingFrequencyIndex ||
          frame.header.channelConfiguration !== header.channelConfiguration
        ) {
          throw new UnsupportedMpegTsError(
            'MPEG-TS AAC decoder configuration changes within the input.',
          )
        }

        // A PCE describes the layout until replaced. Ignore its optional comment
        // when checking a repeat, since the comment does not affect decoding.
        if (header.channelConfiguration === 0 && data[0]! >> 5 === 5) {
          const current = audioDescription(frame)

          if (
            !description.every((byte, index) => byte === current[index]) ||
            description.length !== current.length
          ) {
            throw new UnsupportedMpegTsError(
              'MPEG-TS AAC program configuration changes within the input.',
            )
          }
        }

        if (timing && timing.dts !== timing.pts) {
          throw new InvalidMpegTsError('MPEG-TS AAC PTS and DTS must match.')
        }

        const expected = isUndefined(origin)
          ? reference
          : origin + (sequenceNumber - originFrame) * frameTicks

        if (timing) {
          const pts = normalizeWrappedTimestamp(timing.pts, expected)

          // ADTS counts whole audio samples. Avoid introducing sub-sample jitter
          // when the PES clock rounds 44.1 kHz frame boundaries to 90 kHz ticks.
          if (isUndefined(origin) || Math.abs(pts - expected) > 1 + 1e-6) {
            origin = pts
            originFrame = sequenceNumber
          }
        }

        if (isUndefined(origin)) {
          throw new InvalidMpegTsError(
            'MPEG-TS AAC track starts without a PES timestamp.',
          )
        }

        const pts = origin + (sequenceNumber - originFrame) * frameTicks

        if (pts <= previous) {
          throw new UnsupportedMpegTsError(
            'MPEG-TS AAC timestamps must increase.',
          )
        }

        previous = pts

        if (sequenceNumber >= skipPackets) {
          const timestamp = pts / MPEG_TS_TIMESCALE

          yield new EncodedPacket(
            metadataOnly ? PLACEHOLDER_DATA : data,
            'key',
            timestamp,
            frameDuration,
            sequenceNumber,
            data.length,
            { decodeDuration: frameDuration, decodeTimestamp: timestamp },
          )
        }

        sequenceNumber++
      }
    },
  }
}

/**
 * Builds AVC decoder metadata for MP4 with in-band parameter sets.
 *
 * @param data - Annex B access unit containing SPS and PPS NAL units.
 * @returns The avc3 decoder configuration, its record, and the parsed sequence parameter set.
 * @throws If required parameter sets are missing or invalid.
 */
function avcDescription(data: Uint8Array) {
  const record = extractAvcDecoderConfigurationRecord(data)

  if (!record) {
    throw new InvalidMpegTsError(
      'Missing MPEG-TS AVC SPS or PPS at the start of the input.',
    )
  }

  const description = serializeAvcDecoderConfigurationRecord(record)
  const config = avcDecoderConfig(description, 'MPEG-TS')
  const sps = parseAvcSps(record.sequenceParameterSets[0]!)!

  return {
    config: { ...config, codec: config.codec.replace('avc1.', 'avc3.') },
    record,
    sps,
  }
}

/**
 * Serializes SPS properties that must stay compatible with the MP4 sample entry.
 *
 * @param sps - Parsed AVC sequence parameter set.
 * @param includeRendition - Whether to compare dimensions and level as well.
 * @returns A JSON signature for comparing parameter sets.
 */
function spsSignature(
  sps: NonNullable<ReturnType<typeof parseAvcSps>>,
  includeRendition = true,
) {
  return JSON.stringify([
    sps.profileIdc,
    sps.constraintFlags,
    sps.chromaFormatIdc,
    sps.bitDepthLumaMinus8,
    sps.bitDepthChromaMinus8,
    simplifyRational(sps.pixelAspectRatio),
    sps.colourPrimaries,
    sps.transferCharacteristics,
    sps.matrixCoefficients,
    sps.fullRangeFlag,
    ...(includeRendition
      ? [sps.levelIdc, sps.displayWidth, sps.displayHeight]
      : []),
  ])
}

/**
 * Checks that the PPS and SPS referenced by every IDR slice precede it in the access unit.
 *
 * @param data - Annex B access unit already identified as an IDR picture.
 * @returns Whether the picture can load its referenced parameter sets from this access unit.
 */
function hasInBandAvcParameterSets(data: Uint8Array) {
  const sequenceSets = new Set<number>()
  const pictureSets = new Map<number, number>()

  try {
    for (const { offset, length } of iterateNalUnitsInAnnexB(data)) {
      const type = extractNalUnitTypeForAvc(data[offset]!)

      if (
        type !== AvcNalUnitType.SPS &&
        type !== AvcNalUnitType.PPS &&
        type !== AvcNalUnitType.IDR
      ) {
        continue
      }

      // The IDs occur near the start of the RBSP. Do not copy full slices.
      const prefix = data.subarray(offset, offset + Math.min(length, 32))
      const bits = new Bitstream(removeEmulationPreventionBytes(prefix))

      if (type === AvcNalUnitType.SPS) {
        bits.seekToByte(4)
        const spsId = readExpGolomb(bits)

        if (spsId > 31) {
          return false
        }

        sequenceSets.add(spsId)
      } else if (type === AvcNalUnitType.PPS) {
        bits.seekToByte(1)
        const ppsId = readExpGolomb(bits)
        const spsId = readExpGolomb(bits)

        if (ppsId > 255 || spsId > 31) {
          return false
        }

        pictureSets.set(ppsId, spsId)
      } else {
        bits.seekToByte(1)
        readExpGolomb(bits) // first_mb_in_slice
        readExpGolomb(bits) // slice_type
        const spsId = pictureSets.get(readExpGolomb(bits))

        if (isUndefined(spsId) || !sequenceSets.has(spsId)) {
          return false
        }
      }

      if (bits.getBitsLeft() <= 0) {
        return false
      }
    }
  } catch {
    return false
  }

  return true
}

/**
 * Probes an Annex B AVC stream and exposes length-prefixed packets in decode order.
 *
 * @param demuxer - Shared transport-stream demuxer.
 * @param pid - Packet identifier of the selected AVC stream.
 * @param reference - Shared timestamp rollover reference in MPEG-TS clock ticks.
 * @param switches - Segment indexes where an independently decodable rendition begins.
 * @returns A promise resolving to the AVC decoder configuration and packet reader.
 * @throws If the stream has no AVC access units or its initial parameter sets are invalid.
 */
async function openVideoTrack(
  demuxer: MpegTsDemuxer,
  pid: number,
  reference: number,
  switches: ReadonlySet<number>,
): Promise<VideoPacketTrack> {
  const probe = demuxer.readAvc(pid)
  const first = await probe.next()

  await probe.return()

  if (first.done) {
    throw new InvalidMpegTsError('MPEG-TS video track has no AVC access units.')
  }

  const {
    config: initialConfig,
    record,
    sps,
  } = avcDescription(first.value.data)
  const initialSignature = spsSignature(sps)
  const compatibleSignature = spsSignature(sps, false)
  let config = initialConfig

  return {
    kind: MEDIA_TRACK_KIND.video,
    codec: MEDIA_CODEC.avc,
    get config() {
      return config
    },
    async *packets(metadataOnly = false, skipPackets = 0) {
      // Adjacent presentation timestamps can be separated by reordering on
      // either side of the current sample. AVC allows up to 16 reordered frames.
      const window = 2 * 16 + 2
      const previousPts: number[] = []
      const pending: {
        data: Uint8Array
        size: number
        key: boolean
        pts: number
        dts: number
      }[] = []
      let sequenceNumber = 0
      let signature = initialSignature
      let previousSegment: number | undefined
      let remainingSwitches = switches.size
      let previousRawDts: number | undefined
      let previousDts: number | undefined
      let latestPts = -Infinity
      let decodeShift = 0
      let decodeDuration = MPEG_TS_TIMESCALE / 30
      let maximumWidth = sps.displayWidth
      let maximumHeight = sps.displayHeight
      let maximumLevel = sps.levelIdc

      function takePacket() {
        const current = pending.shift()!
        let nextPts = Infinity
        let priorPts = -Infinity

        for (const pts of previousPts) {
          if (pts > current.pts) {
            nextPts = Math.min(nextPts, pts)
          } else if (pts < current.pts) {
            priorPts = Math.max(priorPts, pts)
          }
        }

        for (const { pts } of pending) {
          if (pts > current.pts) {
            nextPts = Math.min(nextPts, pts)
          } else if (pts < current.pts) {
            priorPts = Math.max(priorPts, pts)
          }
        }

        if (pending[0]) {
          decodeDuration = pending[0].dts - current.dts
        }

        const duration =
          nextPts < Infinity
            ? nextPts - current.pts
            : priorPts > -Infinity
              ? current.pts - priorPts
              : decodeDuration

        previousPts.push(current.pts)

        if (previousPts.length > window) {
          previousPts.shift()
        }

        return new EncodedPacket(
          current.data,
          current.key ? 'key' : 'delta',
          current.pts / MPEG_TS_TIMESCALE,
          duration / MPEG_TS_TIMESCALE,
          sequenceNumber++,
          current.size,
          {
            decodeDuration: decodeDuration / MPEG_TS_TIMESCALE,
            decodeTimestamp: current.dts / MPEG_TS_TIMESCALE,
          },
        )
      }

      for await (const { timing, data } of demuxer.readAvc(pid)) {
        if (!timing) {
          throw new UnsupportedMpegTsError(
            'MPEG-TS AVC access units require PES timestamps.',
          )
        }

        const rawDts = normalizeWrappedTimestamp(
          timing.dts,
          previousRawDts ?? reference,
        )
        const pts = normalizeWrappedTimestamp(timing.pts, rawDts)
        const { segmentIndex } = timing
        const switching =
          segmentIndex !== previousSegment &&
          !isUndefined(segmentIndex) &&
          switches.has(segmentIndex)
        const nals = []
        let key = false
        let nextSignature: string | undefined
        let size = 0

        if (
          !switching &&
          !isUndefined(previousRawDts) &&
          rawDts <= previousRawDts
        ) {
          throw new UnsupportedMpegTsError('MPEG-TS AVC DTS must increase.')
        }

        for (const { offset, length } of iterateNalUnitsInAnnexB(data)) {
          const nal = data.subarray(offset, offset + length)
          const type = extractNalUnitTypeForAvc(nal[0]!)

          if (type === AvcNalUnitType.SPS) {
            const updated = parseAvcSps(nal)

            if (!updated) {
              throw new InvalidMpegTsError(
                'Invalid MPEG-TS AVC sequence parameter set.',
              )
            }

            const updatedSignature = spsSignature(updated)

            if (
              updatedSignature !== (nextSignature ?? signature) &&
              (!switching ||
                !isUndefined(nextSignature) ||
                spsSignature(updated, false) !== compatibleSignature)
            ) {
              throw new UnsupportedMpegTsError(
                'Incompatible MPEG-TS AVC sequence parameter set change.',
              )
            }

            nextSignature = updatedSignature

            if (switching) {
              maximumWidth = Math.max(maximumWidth, updated.displayWidth)
              maximumHeight = Math.max(maximumHeight, updated.displayHeight)
              maximumLevel = Math.max(maximumLevel, updated.levelIdc)
            }
          }

          key ||= type === AvcNalUnitType.IDR
          size += 4 + length

          if (!metadataOnly) {
            nals.push(nal)
          }
        }

        if (key && (switching || remainingSwitches < switches.size)) {
          // After a switch the initialization record may have older definitions
          // for the same IDs. Only index IDRs that carry the sets they reference.
          key = hasInBandAvcParameterSets(data)
        }

        if (switching) {
          if (!key || isUndefined(nextSignature)) {
            throw new UnsupportedMpegTsError(
              'An MPEG-TS rendition switch requires an AVC IDR with SPS and PPS.',
            )
          }

          if (isUndefined(previousDts) || pts <= latestPts) {
            throw new UnsupportedMpegTsError(
              'An MPEG-TS rendition switch must advance the AVC presentation clock.',
            )
          }

          // If decode times overlap, splice them at the presentation gap.
          // Keep DTS deltas inside the new rendition and leave all PTS intact.
          decodeShift =
            rawDts <= previousDts ? previousDts + (pts - latestPts) - rawDts : 0
          signature = nextSignature
          remainingSwitches--
        }

        const dts = rawDts + decodeShift

        previousSegment = segmentIndex
        previousRawDts = rawDts
        previousDts = dts
        latestPts = Math.max(latestPts, pts)

        pending.push({
          data: metadataOnly
            ? PLACEHOLDER_DATA
            : concatNalUnitsInLengthPrefixed(nals, 4),
          size,
          key,
          pts,
          dts,
        })

        if (pending.length > window) {
          const packet = takePacket()

          if (packet.sequenceNumber >= skipPackets) {
            yield packet
          }
        }
      }

      if (remainingSwitches > 0) {
        throw new UnsupportedMpegTsError(
          'An MPEG-TS rendition switch has no AVC access unit at its segment boundary.',
        )
      }

      while (pending.length) {
        const packet = takePacket()

        if (packet.sequenceNumber >= skipPackets) {
          yield packet
        }
      }

      // Preflight drains this metadata iterator before the muxer reads config.
      // avcC keeps the initial parameter sets while signaling the highest level.
      if (metadataOnly && switches.size > 0) {
        const { pixelAspectRatio } = sps

        config = {
          ...initialConfig,
          codec: `${initialConfig.codec.slice(0, -2)}${maximumLevel.toString(16).padStart(2, '0')}`,
          codedWidth: maximumWidth,
          codedHeight: maximumHeight,
          ...(pixelAspectRatio.num === pixelAspectRatio.den
            ? {}
            : {
                displayAspectWidth: maximumWidth * pixelAspectRatio.num,
                displayAspectHeight: maximumHeight * pixelAspectRatio.den,
              }),
          description: serializeAvcDecoderConfigurationRecord({
            ...record,
            avcLevelIndication: maximumLevel,
          }),
        }
      }
    },
  }
}

/**
 * Reads a shared rollover reference, falling back to the selected streams on
 * recognized parser errors when the selection excludes a stream.
 *
 * @param demuxer - Shared transport-stream demuxer.
 * @param pids - Packet identifiers of the available AVC and AAC streams.
 * @param selectedPids - Packet identifiers retained for output.
 * @returns A promise resolving to the first usable decode timestamp in MPEG-TS clock ticks.
 * @throws If the applicable PES headers cannot supply a timestamp or a read fails.
 */
async function timestampReference(
  demuxer: MpegTsDemuxer,
  pids: number[],
  selectedPids: number[],
) {
  try {
    return await demuxer.readTimestampReference(pids)
  } catch (error) {
    if (
      pids.length === selectedPids.length ||
      !(
        error instanceof InvalidMpegTsError ||
        error instanceof UnsupportedMpegTsError
      )
    ) {
      throw error
    }

    return await demuxer.readTimestampReference(selectedPids)
  }
}

/**
 * Opens selected H.264 and AAC-LC tracks from an MPEG-TS program.
 *
 * @param blob - Source MPEG-TS Blob.
 * @param signal - Optional cancellation signal used during opening and packet reads.
 * @param selection - Requested media kinds to expose as repeatable packet readers.
 * @param segmented - Declared segment starts, counter reset policy and rendition switches.
 * @returns A promise resolving to the selected tracks and a disposer for the Blob reader.
 * @throws If transport-stream parsing fails, a selected format is unsupported, or reading is aborted.
 */
export async function openMpegTsInput(
  blob: Blob,
  signal: AbortSignal | undefined,
  selection: RemuxTrackSelection,
  segmented?: Omit<MpegTsInput, 'blob'>,
): Promise<MediaInput> {
  const switches = new Set(segmented?.renditionSwitches)

  if (segmented) {
    const { segmentOffsets } = segmented

    if (segmentOffsets[0] !== 0) {
      throw createRemuxError(
        REMUX_ERROR_CODE.invalidInput,
        'MPEG-TS segment offsets must start at byte 0.',
      )
    }

    let previous = -1

    for (const [index, offset] of segmentOffsets.entries()) {
      if (
        !Number.isSafeInteger(offset) ||
        offset <= previous ||
        offset >= blob.size ||
        offset % TS_PACKET_SIZE !== 0
      ) {
        throw createRemuxError(
          REMUX_ERROR_CODE.invalidInput,
          `Invalid MPEG-TS offset for segment ${index}. Segment starts must be strictly increasing, packet-aligned, and within the Blob.`,
        )
      }

      previous = offset
    }

    for (const index of switches) {
      if (
        !Number.isSafeInteger(index) ||
        index <= 0 ||
        index >= segmentOffsets.length
      ) {
        throw createRemuxError(
          REMUX_ERROR_CODE.invalidInput,
          'MPEG-TS rendition switches must refer to later segment boundaries.',
        )
      }
    }
  }

  const source = new BlobSource(blob, { maxCacheSize: 4 * 1024 * 1024 })
  const ref = source.ref()
  const demuxer = new MpegTsDemuxer(
    new Reader(source),
    blob.size,
    () => checkAbort(signal),
    segmented,
  )

  signal?.addEventListener('abort', dispose, { once: true })

  function dispose() {
    signal?.removeEventListener('abort', dispose)
    ref[Symbol.dispose]()
  }

  try {
    const program = await demuxer.readProgram()
    const video = program.find(stream => stream.type === MpegTsStreamType.AVC)
    const audio = program.find(stream => stream.type === MpegTsStreamType.AAC)
    const firstVideo = program.find(stream => videoStreamTypes.has(stream.type))
    const firstAudio = program.find(
      stream => audioStreamTypes.has(stream.type) || stream.privateAudio,
    )
    const pids = [video, audio].flatMap(stream => (stream ? [stream.pid] : []))

    if (!firstVideo && !firstAudio) {
      throw createRemuxError(
        REMUX_ERROR_CODE.unsupportedCodec,
        'MPEG-TS requires H.264 video or AAC-LC audio in ADTS.',
      )
    }

    const tracks: PacketTrack[] = []
    const inFileOrder =
      selection === REMUX_TRACK_SELECTION.firstVideoWithOptionalAudio
    const selectedVideo =
      selection === REMUX_TRACK_SELECTION.audio
        ? undefined
        : inFileOrder
          ? firstVideo
          : (video ?? firstVideo)
    const selectedAudio =
      selection === REMUX_TRACK_SELECTION.video
        ? undefined
        : inFileOrder
          ? firstAudio
          : (audio ?? firstAudio)

    if (selectedVideo && selectedVideo.type !== MpegTsStreamType.AVC) {
      throw createRemuxError(
        REMUX_ERROR_CODE.unsupportedCodec,
        'MPEG-TS requires H.264 video.',
      )
    }

    if (selectedAudio && selectedAudio.type !== MpegTsStreamType.AAC) {
      throw createRemuxError(
        REMUX_ERROR_CODE.unsupportedCodec,
        'MPEG-TS requires AAC-LC audio in ADTS.',
      )
    }

    const selectedPids = [selectedVideo, selectedAudio].flatMap(stream =>
      stream ? [stream.pid] : [],
    )

    if (isEmptyArray(selectedPids)) {
      return { tracks, dispose }
    }

    const reference = await timestampReference(demuxer, pids, selectedPids)

    if (selectedVideo) {
      tracks.push(
        await openVideoTrack(demuxer, selectedVideo.pid, reference, switches),
      )
    }

    if (selectedAudio) {
      tracks.push(await openAudioTrack(demuxer, selectedAudio.pid, reference))
    }

    for (const track of tracks) {
      const packets = track.packets

      track.packets = async function* (metadataOnly, skipPackets) {
        try {
          checkAbort(signal)
          yield* packets(metadataOnly, skipPackets)
          checkAbort(signal)
        } catch (error) {
          checkAbort(signal)

          throw classifyTsError(error)
        }
      }
    }

    return { tracks, dispose }
  } catch (error) {
    dispose()
    checkAbort(signal)

    throw classifyTsError(error)
  }
}
