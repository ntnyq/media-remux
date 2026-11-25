/* oxlint-disable no-await-in-loop -- Tracks and segments are consumed in order with bounded memory. */

import { isBoolean, isEmptyArray, isUndefined } from '@ntnyq/utils'
import {
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_PROGRESS_PHASE,
  REMUX_TRACK_SELECTION,
} from '../constants'
import type {
  CombineOptions,
  RemuxInput,
  RemuxOptions,
  RemuxResult,
  MediaInput,
  OutputSegment,
  PacketTrack,
  SegmentPlan,
} from '../types'
import { checkAbort, createRemuxError } from '../utils'
import { captureCombineTimeline } from '../utils/combineTimeline'
import { captureRemuxInput } from '../utils/remuxInput'
import { checkAudioDecoder } from './audioCodecs'
import { createDecodeTimeline } from './decodeTimeline'
import { openMediaInput } from './input/openMediaInput'
import { areTracksCompatible, inspectTracks, selectTracks } from './mediaTracks'
import { writeSegments } from './writeSegments'

/**
 * Captures option values once, including values exposed by prototype accessors.
 *
 * @param options - Caller-owned settings whose fields may change during a job.
 * @returns A plain options object retaining the same I/O resources and signal.
 * @throws {TypeError} If track selection or the audio normalization flag is invalid.
 */
function captureOptions(options: RemuxOptions): RemuxOptions {
  const { writable, storage, signal, onProgress, tracks, normalizeAudio } =
    options

  if (!isUndefined(normalizeAudio) && !isBoolean(normalizeAudio)) {
    throw new TypeError('normalizeAudio must be a boolean.')
  }

  if (
    !isUndefined(tracks) &&
    !Object.values(REMUX_TRACK_SELECTION).includes(tracks)
  ) {
    throw new TypeError('Unsupported media track selection.')
  }

  return {
    writable,
    storage,
    ...(isUndefined(signal) ? {} : { signal }),
    ...(isUndefined(onProgress) ? {} : { onProgress }),
    ...(isUndefined(tracks) ? {} : { tracks }),
    ...(isUndefined(normalizeAudio) ? {} : { normalizeAudio }),
  }
}

/**
 * Remuxes selected tracks from one MP4, FLV, MKV, or MPEG-TS input to fMP4/M4A.
 * H.264 MP4 with leading dependent frames is trimmed to the first verified IDR.
 * The output stream is closed on success and aborted on a write-stage failure.
 * Temporary stores remain owned by the caller; each job needs fresh stores.
 *
 * @param input - Nonempty source media Blob or an MPEG-TS descriptor.
 * @param options - Positioned output stream, fresh temporary stores, optional
 * track selection (defaults to all primary tracks), cancellation, and progress.
 * @returns A promise resolving to duration in seconds, output MIME type, and
 * encoded payload bytes written, excluding container overhead.
 * @throws {TypeError} If the input is not a nonempty media input.
 * @throws {Error} If parsing, selected codecs, decoder configuration, or packet
 * timing is invalid, selected tracks are absent, or video has no usable start.
 * Also propagates storage, output, and progress callback failures.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function remuxMedia(
  input: RemuxInput,
  options: RemuxOptions,
): Promise<RemuxResult> {
  return await remuxInputs([input], options)
}

/**
 * Concatenates compatible segments, normalizing each segment's first playable time to
 * the previous segment's presentation end while preserving internal A/V offsets.
 * The presentation span is calculated after trimming any leading dependent H.264 MP4 frames.
 * All track layouts/configurations are checked before any output is written.
 * Success closes the output stream; write-stage failures attempt cancellation.
 * The caller must supply fresh temporary stores and dispose them after the job.
 *
 * @param inputs - Nonempty list of MP4/FLV/MKV/MPEG-TS Blobs in playback order. Selected
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
  return await remuxInputs(inputs, options)
}

/**
 * Validates selected tracks and computes the shared timeline before writing
 * one input or a sequence of compatible inputs.
 *
 * @param inputs - Media inputs in output order.
 * @param options - Output stream, temporary storage, track selection, and hooks.
 * @returns A promise resolving to the output duration, MIME type, and payload bytes written.
 * @throws If inputs are absent, invalid, or incompatible, or if inspection,
 * output writing, a progress callback, or cancellation fails the job.
 */
async function remuxInputs(
  inputs: readonly RemuxInput[],
  options: RemuxOptions,
): Promise<RemuxResult> {
  const settings = captureOptions(options)
  const selection = settings.tracks

  checkAbort(settings.signal)
  const sources = Array.from(inputs, captureRemuxInput)

  if (isEmptyArray(sources)) {
    throw new TypeError('At least one media segment is required.')
  }

  const segmentPlans: SegmentPlan[] = []
  const reusableTracks = new Map<number, PacketTrack[]>()
  let outputTrackTemplates: PacketTrack[] = []
  let copiedTrackTemplates: PacketTrack[] = []
  let decodeTimeline: ReturnType<typeof createDecodeTimeline> | undefined

  // Validate every segment before opening the output, so a later incompatible
  // segment cannot leave a partially written concatenation behind.
  for (const [index, source] of sources.entries()) {
    checkAbort(settings.signal)
    settings.onProgress?.({
      phase: REMUX_PROGRESS_PHASE.inspect,
      bytesProcessed: 0,
      segmentIndex: index,
    })

    const input = await openMediaInput(source, settings.signal, selection)

    try {
      const tracks = selectTracks(input, selection)
      const copiedTracks = settings.normalizeAudio
        ? tracks.filter(track => track.kind !== MEDIA_TRACK_KIND.audio)
        : tracks

      if (index === 0) {
        outputTrackTemplates = copiedTracks.slice()
        copiedTrackTemplates = copiedTracks
        decodeTimeline = createDecodeTimeline(copiedTracks)
      } else if (
        copiedTrackTemplates.length !== copiedTracks.length ||
        copiedTracks.some((track, trackIndex) => {
          const template = copiedTrackTemplates[trackIndex]

          return !template || !areTracksCompatible(template, track)
        })
      ) {
        throw createRemuxError(
          REMUX_ERROR_CODE.incompatibleSegments,
          `Incompatible track layout or decoder configuration in segment ${index}.`,
        )
      }

      const plan = await inspectTracks(
        tracks,
        settings.signal,
        decodeTimeline,
        settings.normalizeAudio,
        index === 0,
      )

      if (settings.normalizeAudio && plan.audioRange) {
        const audio = tracks.find(
          track => track.kind === MEDIA_TRACK_KIND.audio,
        )

        if (audio) {
          await checkAudioDecoder(audio.config, settings.signal)

          if (outputTrackTemplates.length === copiedTracks.length) {
            outputTrackTemplates.push(audio)
          }
        }
      }

      segmentPlans.push(plan)

      if (input.canReuseAfterDispose) {
        reusableTracks.set(index, tracks)
      }
    } finally {
      input.dispose()
    }
  }

  /**
   * Reads one inspected input at a time, reusing resource-free FLV tracks.
   *
   * @returns An asynchronous generator that completes without a return value.
   * @yields {OutputSegment} Selected tracks and their validated timeline.
   * @throws If reopening, track selection, timeline lookup, or cancellation fails.
   */
  async function* segments(): AsyncGenerator<OutputSegment, void, unknown> {
    for (const [index, source] of sources.entries()) {
      checkAbort(settings.signal)
      const plan = segmentPlans[index]

      if (!plan) {
        throw new Error('Missing segment timeline.')
      }

      const isLast = index + 1 === sources.length
      const tracks = reusableTracks.get(index)

      if (tracks) {
        yield { tracks, plan, isLast }
        continue
      }

      const input = await openMediaInput(source, settings.signal, selection)

      try {
        yield { tracks: selectTracks(input, selection), plan, isLast }
      } finally {
        input.dispose()
      }
    }
  }

  if (!decodeTimeline) {
    throw new Error('Missing output decode timeline.')
  }

  await decodeTimeline.validateSampleTiming(segments, settings.signal)

  return writeSegments(
    outputTrackTemplates,
    segments,
    settings,
    decodeTimeline.trackTimings(),
    segmentPlans.reduce((duration, plan) => duration + plan.duration, 0),
  )
}

/**
 * Combines the primary video and audio from separate MP4/FLV/MKV/MPEG-TS inputs.
 * Defaults to preserving relative timestamps and normalizing the earliest
 * playable time to zero. Independently timed tracks can be aligned explicitly.
 * On a shared timeline, trimming leading H.264 MP4 video also trims audio.
 * Success closes the output stream; write-stage failures attempt cancellation.
 * The caller must supply fresh temporary stores and dispose them after the job.
 *
 * @param video - Media Blob or MPEG-TS descriptor supplying the primary video track.
 * @param audio - Media Blob or MPEG-TS descriptor supplying the primary audio track.
 * @param options - Positioned output stream, fresh temporary stores, optional
 * timeline, cancellation signal, and progress callback.
 * @returns A promise resolving to the shared presentation span in seconds,
 * video/mp4 MIME type, and encoded payload bytes written, excluding container overhead.
 * @throws {TypeError} If either input is not a nonempty media input.
 * @throws {Error} If a required track is absent, parsing or decoder configuration
 * is invalid, packet timing is invalid, or video has no usable start.
 * Also propagates storage, output, and progress callback failures.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function combineTracks(
  video: RemuxInput,
  audio: RemuxInput,
  options: CombineOptions,
): Promise<RemuxResult> {
  const settings = captureOptions(options)
  const timeline = captureCombineTimeline(options.timeline)

  checkAbort(settings.signal)
  const videoSource = captureRemuxInput(video)
  const audioSource = captureRemuxInput(audio)
  const inputs: MediaInput[] = []

  try {
    settings.onProgress?.({
      phase: REMUX_PROGRESS_PHASE.inspect,
      bytesProcessed: 0,
      segmentIndex: 0,
    })

    const videoInput = await openMediaInput(
      videoSource,
      settings.signal,
      REMUX_TRACK_SELECTION.video,
    )

    inputs.push(videoInput)

    const audioInput = await openMediaInput(
      audioSource,
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
    const plan = await inspectTracks(
      tracks,
      settings.signal,
      decodeTimeline,
      settings.normalizeAudio,
      true,
      timeline,
    )

    if (settings.normalizeAudio && plan.audioRange) {
      await checkAudioDecoder(audioTrack.config, settings.signal)
    }

    const segments = () => singleSegment(tracks, plan)

    await decodeTimeline.validateSampleTiming(segments, settings.signal)

    return await writeSegments(
      settings.normalizeAudio && !plan.audioRange ? [videoTrack] : tracks,
      segments,
      settings,
      decodeTimeline.trackTimings(),
      plan.duration,
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
 * @param plan - Validated shared presentation timeline in seconds.
 * @returns An asynchronous generator that completes without a return value.
 * @yields {OutputSegment} The single output segment.
 */
async function* singleSegment(tracks: PacketTrack[], plan: SegmentPlan) {
  yield { tracks, plan, isLast: true }
}
