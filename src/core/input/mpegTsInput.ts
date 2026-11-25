/* oxlint-disable no-await-in-loop -- MPEG-TS cursors consume encoded packets in decode order. */
import { checkAbort } from '../../abort'
import {
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_TRACK_SELECTION,
} from '../../constants'
import { createRemuxError, withRemuxErrorCode } from '../../errors'
import type { RemuxTrackSelection } from '../../types'
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
  UnsupportedMpegTsError,
} from '../../vendor/mediabunny/src/mpeg-ts/mpeg-ts-demuxer'
import type { AdtsFrame } from '../../vendor/mediabunny/src/mpeg-ts/mpeg-ts-demuxer'
import {
  EncodedPacket,
  PLACEHOLDER_DATA,
} from '../../vendor/mediabunny/src/packet'
import { Reader } from '../../vendor/mediabunny/src/reader'
import { BlobSource } from '../../vendor/mediabunny/src/source'
import { aacLcDecoderConfig, avcDecoderConfig } from './codecConfig'
import type { MediaInput, PacketTrack } from './mediaInput'

function classifyTsError(error: unknown) {
  if (error instanceof InvalidMpegTsError) {
    return withRemuxErrorCode(error, REMUX_ERROR_CODE.invalidInput)
  }

  if (error instanceof UnsupportedMpegTsError) {
    return withRemuxErrorCode(error, REMUX_ERROR_CODE.unsupportedMediaFeature)
  }

  return error
}

/** Builds MPEG-4 AAC initialization data from the ADTS header and optional PCE. */
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

        const expected =
          origin === undefined
            ? reference
            : origin + (sequenceNumber - originFrame) * frameTicks

        if (timing) {
          const pts = normalizeWrappedTimestamp(timing.pts, expected)

          // ADTS counts whole audio samples. Avoid introducing sub-sample jitter
          // when the PES clock rounds 44.1 kHz frame boundaries to 90 kHz ticks.
          if (origin === undefined || Math.abs(pts - expected) > 1 + 1e-6) {
            origin = pts
            originFrame = sequenceNumber
          }
        }

        if (origin === undefined) {
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

/** Properties that must stay compatible with the MP4 track's sample entry. */
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

        if (previousDts !== undefined && dts <= previousDts) {
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

/** Keeps both tracks on the same rollover clock when their PES headers are readable. */
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

export async function openMpegTsInput(
  blob: Blob,
  signal: AbortSignal | undefined,
  selection: RemuxTrackSelection,
): Promise<MediaInput> {
  const source = new BlobSource(blob, { maxCacheSize: 4 * 1024 * 1024 })
  const ref = source.ref()
  const demuxer = new MpegTsDemuxer(new Reader(source), blob.size, () =>
    checkAbort(signal),
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
    const pids = [video, audio].flatMap(stream => (stream ? [stream.pid] : []))

    if (pids.length === 0) {
      throw createRemuxError(
        REMUX_ERROR_CODE.unsupportedCodec,
        'MPEG-TS requires H.264 video or AAC-LC audio in ADTS.',
      )
    }

    const tracks: PacketTrack[] = []
    const selectedVideo =
      selection === REMUX_TRACK_SELECTION.audio ? undefined : video
    const selectedAudio =
      selection === REMUX_TRACK_SELECTION.video ? undefined : audio
    const selectedPids = [selectedVideo, selectedAudio].flatMap(stream =>
      stream ? [stream.pid] : [],
    )

    if (selectedPids.length === 0) {
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
