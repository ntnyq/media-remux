/* oxlint-disable no-await-in-loop -- Tracks and segments are consumed in order with bounded memory. */

import { checkAbort } from '../abort'
import {
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_PROGRESS_PHASE,
  REMUX_TRACK_SELECTION,
} from '../constants'
import { createRemuxError } from '../errors'
import type { RemuxOptions, RemuxResult } from '../types'
import { checkAudioDecoder } from './audioCodecs'
import { createDecodeTimeline } from './decodeTimeline'
import { openMediaInput } from './input/mediaInput'
import type { MediaInput, PacketTrack } from './input/mediaInput'
import { selectTracks, trackSignature, inspectTracks } from './mediaTracks'
import type { SegmentInfo } from './mediaTracks'
import { writeSegments } from './writeSegments'

/**
 * Captures option values once, including values exposed by prototype accessors.
 *
 * @param options - Caller-owned settings whose fields may change during a job.
 * @returns A plain options object retaining the same I/O resources and signal.
 */
function captureOptions(options: RemuxOptions): RemuxOptions {
  const { writable, storage, signal, onProgress, tracks, normalizeAudio } =
    options

  if (normalizeAudio !== undefined && typeof normalizeAudio !== 'boolean') {
    throw new TypeError('normalizeAudio must be a boolean.')
  }

  return {
    writable,
    storage,
    ...(signal === undefined ? {} : { signal }),
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(tracks === undefined ? {} : { tracks }),
    ...(normalizeAudio === undefined ? {} : { normalizeAudio }),
  }
}

/**
 * Remuxes selected tracks from one MP4, FLV, or MKV Blob to fMP4/M4A.
 * H.264 MP4 with leading dependent frames is trimmed to the first verified IDR.
 * The output stream is closed on success and aborted on a write-stage failure.
 * Temporary stores remain owned by the caller; each job needs fresh stores.
 *
 * @param input - Nonempty source MP4, FLV, or MKV Blob.
 * @param options - Positioned output stream, fresh temporary stores, optional
 * track selection (defaults to all primary tracks), cancellation, and progress.
 * @returns A promise resolving to duration in seconds, output MIME type, and
 * encoded payload bytes written, excluding container overhead.
 * @throws {TypeError} If the input is not a nonempty Blob.
 * @throws {Error} If parsing, selected codecs, decoder configuration, or packet
 * timing is invalid, selected tracks are absent, or video has no usable start.
 * Also propagates storage, output, and progress callback failures.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function remuxMedia(
  input: Blob,
  options: RemuxOptions,
): Promise<RemuxResult> {
  return await concatMedia([input], options)
}

/**
 * Concatenates compatible segments, normalizing each segment's first playable time to
 * the previous segment's presentation end while preserving internal A/V offsets.
 * The presentation span is calculated after trimming any leading dependent H.264 MP4 frames.
 * All track layouts/configurations are checked before any output is written.
 * Success closes the output stream; write-stage failures attempt cancellation.
 * The caller must supply fresh temporary stores and dispose them after the job.
 *
 * @param inputs - Nonempty list of MP4/FLV/MKV Blobs in playback order. Selected
 * track layouts and decoder configurations must match. Audio normalization
 * allows different or absent audio in otherwise compatible video segments.
 * @param options - Positioned output stream, fresh temporary stores, optional
 * track selection (defaults to all primary tracks), cancellation, and progress.
 * @returns A promise resolving to combined duration in seconds, output MIME
 * type, and encoded payload bytes written, excluding container overhead.
 * @throws {TypeError} If no segments are supplied or an input is not a nonempty Blob.
 * @throws {Error} If selected tracks are absent, segment configurations differ,
 * parsing or packet timing is invalid, or a video segment has no usable start.
 * Also propagates storage, output, and progress callback failures.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function concatMedia(
  inputs: readonly Blob[],
  options: RemuxOptions,
): Promise<RemuxResult> {
  const settings = captureOptions(options)
  const selection = settings.tracks

  checkAbort(settings.signal)
  const blobs = [...inputs]

  if (blobs.length === 0) {
    throw new TypeError('At least one media segment is required.')
  }

  const infos: SegmentInfo[] = []
  let baseline: PacketTrack[] = []
  let signature = ''
  let decodeTimeline: ReturnType<typeof createDecodeTimeline> | undefined

  // Validate every segment before opening the output, so a later incompatible
  // segment cannot leave a partially written concatenation behind.
  for (const [index, blob] of blobs.entries()) {
    settings.onProgress?.({
      phase: REMUX_PROGRESS_PHASE.inspect,
      bytesProcessed: 0,
      segmentIndex: index,
    })

    const input = await openMediaInput(blob, settings.signal, selection)

    try {
      const tracks = selectTracks(input, selection)
      const copiedTracks = settings.normalizeAudio
        ? tracks.filter(track => track.kind !== MEDIA_TRACK_KIND.audio)
        : tracks
      const current = JSON.stringify(copiedTracks.map(trackSignature))

      if (index === 0) {
        baseline = tracks
        signature = current
        decodeTimeline = createDecodeTimeline(copiedTracks)
      } else if (current !== signature) {
        throw createRemuxError(
          REMUX_ERROR_CODE.incompatibleSegments,
          `Incompatible track layout or decoder configuration in segment ${index}.`,
        )
      }

      const info = await inspectTracks(
        tracks,
        settings.signal,
        decodeTimeline,
        settings.normalizeAudio,
        index === 0,
      )

      if (settings.normalizeAudio && info.audioRange) {
        const audio = tracks.find(
          track => track.kind === MEDIA_TRACK_KIND.audio,
        )

        if (audio && 'sampleRate' in audio.config) {
          await checkAudioDecoder(audio.config)

          if (baseline.length === copiedTracks.length) {
            baseline.push(audio)
          }
        }
      }

      infos.push(info)
    } finally {
      input.dispose()
    }
  }

  /**
   * Reopens inspected inputs one at a time and releases each after consumption.
   *
   * @returns An asynchronous generator that completes without a return value.
   * @yields {{ tracks: PacketTrack[], info: SegmentInfo, isLast: boolean }} The selected tracks and timeline.
   * @throws If reopening, track selection, timeline lookup, or cancellation fails.
   */
  async function* segments() {
    for (const [index, blob] of blobs.entries()) {
      const input = await openMediaInput(blob, settings.signal, selection)

      try {
        const info = infos[index]

        if (!info) {
          throw new Error('Missing segment timeline.')
        }

        yield {
          tracks: selectTracks(input, settings.tracks),
          info,
          isLast: index + 1 === blobs.length,
        }
      } finally {
        input.dispose()
      }
    }
  }

  if (!decodeTimeline) {
    throw new Error('Missing output decode timeline.')
  }

  return writeSegments(
    baseline,
    segments,
    settings,
    decodeTimeline.trackTimings(),
    infos.reduce((duration, info) => duration + info.duration, 0),
  )
}

/**
 * Combines the primary video and audio from separate MP4/FLV/MKV Blobs.
 * Existing relative timestamps are preserved and the earliest playable time becomes zero.
 * When H.264 MP4 video is trimmed to an IDR, audio before its PTS is discarded.
 * Success closes the output stream; write-stage failures attempt cancellation.
 * The caller must supply fresh temporary stores and dispose them after the job.
 *
 * @param video - Nonempty MP4, FLV, or MKV Blob supplying the primary video track.
 * @param audio - Nonempty MP4/FLV/MKV Blob supplying the primary audio track.
 * @param options - Positioned output stream, fresh temporary stores, optional
 * cancellation signal, and progress callback.
 * @returns A promise resolving to the shared presentation span in seconds,
 * video/mp4 MIME type, and encoded payload bytes written, excluding container overhead.
 * @throws {TypeError} If either input is not a nonempty Blob.
 * @throws {Error} If a required track is absent, parsing or decoder configuration
 * is invalid, packet timing is invalid, or video has no usable start.
 * Also propagates storage, output, and progress callback failures.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function combineTracks(
  video: Blob,
  audio: Blob,
  options: Omit<RemuxOptions, 'tracks'>,
): Promise<RemuxResult> {
  const settings = captureOptions(options)
  const inputs: MediaInput[] = []

  try {
    settings.onProgress?.({
      phase: REMUX_PROGRESS_PHASE.inspect,
      bytesProcessed: 0,
      segmentIndex: 0,
    })

    const videoInput = await openMediaInput(
      video,
      settings.signal,
      REMUX_TRACK_SELECTION.video,
    )

    inputs.push(videoInput)

    const audioInput = await openMediaInput(
      audio,
      settings.signal,
      REMUX_TRACK_SELECTION.audio,
    )

    inputs.push(audioInput)

    const videoTrack = videoInput.tracks.find(
      track => track.kind === MEDIA_TRACK_KIND.video,
    )
    const audioTrack = audioInput.tracks.find(
      track => track.kind === MEDIA_TRACK_KIND.audio,
    )

    if (!videoTrack || !audioTrack) {
      throw createRemuxError(
        REMUX_ERROR_CODE.missingRequiredTrack,
        'combineTracks requires a video track followed by an audio track.',
      )
    }

    const tracks = [videoTrack, audioTrack]
    const decodeTimeline = createDecodeTimeline(
      settings.normalizeAudio ? [videoTrack] : tracks,
    )
    const info = await inspectTracks(
      tracks,
      settings.signal,
      decodeTimeline,
      settings.normalizeAudio,
    )

    if (
      settings.normalizeAudio &&
      info.audioRange &&
      'sampleRate' in audioTrack.config
    ) {
      await checkAudioDecoder(audioTrack.config)
    }

    return await writeSegments(
      tracks,
      () => singleSegment(tracks, info),
      settings,
      decodeTimeline.trackTimings(),
      info.duration,
    )
  } finally {
    for (const input of inputs) {
      input.dispose()
    }
  }
}

/**
 * Adapts combined tracks to the segment stream consumed by writeSegments().
 *
 * @param tracks - Ordered video and audio tracks to emit together.
 * @param info - Validated shared presentation timeline in seconds.
 * @returns An asynchronous generator that completes without a return value.
 * @yields {{ tracks: PacketTrack[], info: SegmentInfo, isLast: boolean }} The single output segment.
 */
async function* singleSegment(tracks: PacketTrack[], info: SegmentInfo) {
  yield { tracks, info, isLast: true }
}
