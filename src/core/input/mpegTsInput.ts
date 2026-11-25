/* oxlint-disable no-await-in-loop -- MPEG-TS cursors consume encoded packets in decode order. */
import { isEmptyArray, isUndefined } from '@ntnyq/utils'
import {
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_TRACK_SELECTION,
} from '../../constants'
import type {
  MediaInput,
  MpegTsInput,
  PacketTrack,
  RemuxTrackSelection,
} from '../../types'
import {
  aacLcDecoderConfig,
  avcDecoderConfig,
  checkAbort,
  createRemuxError,
  withRemuxErrorCode,
} from '../../utils'
import {
  aacChannelMap,
  aacFrequencyTable,
  buildAacAudioSpecificConfig,
  getAacProgramConfigElementChannelCount,
  readAdtsProgramConfigElement,
} from '../../vendor/mediabunny/shared/aac-misc'
import {
  AvcNalUnitType,
  concatNalUnitsInLengthPrefixed,
  extractAvcDecoderConfigurationRecord,
  extractNalUnitTypeForAvc,
  iterateNalUnitsInAnnexB,
  parseAvcSps,
  serializeAvcDecoderConfigurationRecord,
} from '../../vendor/mediabunny/src/codec-data'
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
): Promise<PacketTrack> {
  const probe = demuxer.readAdts(pid)
  const first = await probe.next()

  await probe.return()

  if (first.done) {
    throw new InvalidMpegTsError('MPEG-TS audio track has no ADTS frames.')
  }

  const header = first.value.header
  const description = audioDescription(first.value)
  const config = aacLcDecoderConfig(description, 'MPEG-TS')
  const frameDuration = 1024 / config.sampleRate

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
          yield new EncodedPacket(
            metadataOnly ? PLACEHOLDER_DATA : data,
            'key',
            pts / MPEG_TS_TIMESCALE,
            frameDuration,
            sequenceNumber,
            data.length,
            { decodeDuration: frameDuration },
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
 * @returns The avc3 decoder configuration and parsed sequence parameter set.
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
    sps,
  }
}

/**
 * Serializes SPS properties that must stay compatible with the MP4 sample entry.
 *
 * @param sps - Parsed AVC sequence parameter set.
 * @returns A JSON signature for comparing initial and later parameter sets.
 */
function spsSignature(sps: NonNullable<ReturnType<typeof parseAvcSps>>) {
  return JSON.stringify([
    sps.profileIdc,
    sps.constraintFlags,
    sps.levelIdc,
    sps.chromaFormatIdc,
    sps.bitDepthLumaMinus8,
    sps.bitDepthChromaMinus8,
    sps.displayWidth,
    sps.displayHeight,
    sps.pixelAspectRatio,
    sps.colourPrimaries,
    sps.transferCharacteristics,
    sps.matrixCoefficients,
    sps.fullRangeFlag,
  ])
}

/**
 * Probes an Annex B AVC stream and exposes length-prefixed packets in decode order.
 *
 * @param demuxer - Shared transport-stream demuxer.
 * @param pid - Packet identifier of the selected AVC stream.
 * @param reference - Shared timestamp rollover reference in MPEG-TS clock ticks.
 * @returns A promise resolving to the AVC decoder configuration and packet reader.
 * @throws If the stream has no AVC access units or its initial parameter sets are invalid.
 */
async function openVideoTrack(
  demuxer: MpegTsDemuxer,
  pid: number,
  reference: number,
): Promise<PacketTrack> {
  const probe = demuxer.readAvc(pid)
  const first = await probe.next()

  await probe.return()

  if (first.done) {
    throw new InvalidMpegTsError('MPEG-TS video track has no AVC access units.')
  }

  const { config, sps } = avcDescription(first.value.data)
  const signature = spsSignature(sps)

  return {
    kind: MEDIA_TRACK_KIND.video,
    codec: MEDIA_CODEC.avc,
    config,
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
      let previousDts: number | undefined
      let decodeDuration = MPEG_TS_TIMESCALE / 30

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

        const dts = normalizeWrappedTimestamp(
          timing.dts,
          previousDts ?? reference,
        )
        const pts = normalizeWrappedTimestamp(timing.pts, dts)

        if (!isUndefined(previousDts) && dts <= previousDts) {
          throw new UnsupportedMpegTsError('MPEG-TS AVC DTS must increase.')
        }

        previousDts = dts
        const nals = []
        let key = false
        let size = 0

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

            if (spsSignature(updated) !== signature) {
              throw new UnsupportedMpegTsError(
                'Incompatible MPEG-TS AVC sequence parameter set change.',
              )
            }
          }

          key ||= type === AvcNalUnitType.IDR
          size += 4 + length

          if (!metadataOnly) {
            nals.push(nal)
          }
        }

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

      while (pending.length) {
        const packet = takePacket()

        if (packet.sequenceNumber >= skipPackets) {
          yield packet
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
 * @param segmented - Declared packet-aligned segment starts and reset policy.
 * @returns A promise resolving to the selected tracks and a disposer for the Blob reader.
 * @throws If transport-stream parsing fails, a selected format is unsupported, or reading is aborted.
 */
export async function openMpegTsInput(
  blob: Blob,
  signal: AbortSignal | undefined,
  selection: RemuxTrackSelection,
  segmented?: Omit<MpegTsInput, 'blob'>,
): Promise<MediaInput> {
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
      tracks.push(await openVideoTrack(demuxer, selectedVideo.pid, reference))
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
