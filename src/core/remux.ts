/* oxlint-disable no-await-in-loop -- Tracks and segments are consumed in order with bounded memory. */
import { checkAbort } from '../abort'
import type { RemuxOptions, RemuxResult } from '../types'
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
  const { writable, storage, signal, onProgress, tracks } = options

  return {
    writable,
    storage,
    ...(signal === undefined ? {} : { signal }),
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(tracks === undefined ? {} : { tracks }),
  }
}

/**
 * Remuxes selected primary H.264/AAC tracks from one MP4 or FLV Blob to fMP4/M4A.
 * The output stream is closed on success and aborted on a write-stage failure.
 * Temporary stores remain owned by the caller; each job needs fresh stores.
 *
 * @param input - Nonempty source MP4 or FLV Blob.
 * @param options - Positioned output stream, fresh temporary stores, optional
 * track selection (defaults to all primary tracks), cancellation, and progress.
 * @returns A promise resolving to duration in seconds, output MIME type, and
 * copied encoded payload bytes excluding container overhead.
 * @throws {TypeError} If the input is not a nonempty Blob.
 * @throws {Error} If parsing, selected codecs, decoder configuration, or packet
 * timing is invalid, selected tracks are absent, or video lacks an initial
 * keyframe. Also propagates storage, output, and progress callback failures.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function remuxMedia(
  input: Blob,
  options: RemuxOptions,
): Promise<RemuxResult> {
  return await concatMedia([input], options)
}

/**
 * Concatenates compatible segments, normalizing each segment's earliest PTS to
 * the previous segment's presentation end while preserving internal A/V offsets.
 * All track layouts/configurations are checked before any output is written.
 * Success closes the output stream; write-stage failures attempt cancellation.
 * The caller must supply fresh temporary stores and dispose them after the job.
 *
 * @param inputs - Nonempty list of MP4/FLV Blobs in playback order. Selected
 * track layouts and decoder configurations must match across every segment.
 * @param options - Positioned output stream, fresh temporary stores, optional
 * track selection (defaults to all primary tracks), cancellation, and progress.
 * @returns A promise resolving to combined duration in seconds, output MIME
 * type, and copied encoded payload bytes excluding container overhead.
 * @throws {TypeError} If no segments are supplied or an input is not a nonempty Blob.
 * @throws {Error} If selected tracks are absent, segment configurations differ,
 * parsing or packet timing is invalid, or video lacks an initial keyframe.
 * Also propagates storage, output, and progress callback failures.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function concatMedia(
  inputs: readonly Blob[],
  options: RemuxOptions,
): Promise<RemuxResult> {
  const settings = captureOptions(options)
  checkAbort(settings.signal)
  const blobs = [...inputs]
  if (blobs.length === 0) {
    throw new TypeError('At least one media segment is required.')
  }

  const infos: SegmentInfo[] = []
  let baseline: PacketTrack[] = []
  let signature = ''

  // Validate every segment before opening the output, so a later incompatible
  // segment cannot leave a partially written concatenation behind.
  for (const [index, blob] of blobs.entries()) {
    settings.onProgress?.({
      phase: 'inspect',
      bytesProcessed: 0,
      segmentIndex: index,
    })

    const input = await openMediaInput(blob, settings.signal, settings.tracks)

    try {
      const tracks = selectTracks(input, settings.tracks)
      const current = JSON.stringify(tracks.map(track => trackSignature(track)))
      if (index === 0) {
        baseline = tracks
        signature = current
      } else if (current !== signature) {
        throw new Error(
          `Incompatible track layout or decoder configuration in segment ${index}.`,
        )
      }

      infos.push(await inspectTracks(tracks, settings.signal))
    } finally {
      input.dispose()
    }
  }

  /**
   * Reopens inspected inputs one at a time and releases each after consumption.
   *
   * @returns An asynchronous generator that completes without a return value.
   * @yields {{ tracks: PacketTrack[], info: SegmentInfo }} Selected tracks paired
   * with the segment's validated timeline.
   * @throws If reopening, track selection, timeline lookup, or cancellation fails.
   */
  async function* segments() {
    for (const [index, blob] of blobs.entries()) {
      const input = await openMediaInput(blob, settings.signal, settings.tracks)

      try {
        const info = infos[index]
        if (!info) {
          throw new Error('Missing segment timeline.')
        }

        yield { tracks: selectTracks(input, settings.tracks), info }
      } finally {
        input.dispose()
      }
    }
  }

  return writeSegments(baseline, segments(), settings)
}

/**
 * Combines the primary H.264 video and AAC audio from separate MP4/FLV Blobs.
 * Existing relative timestamps are preserved and the earliest PTS becomes zero.
 * Success closes the output stream; write-stage failures attempt cancellation.
 * The caller must supply fresh temporary stores and dispose them after the job.
 *
 * @param video - Nonempty MP4/FLV Blob supplying the primary H.264 video track.
 * @param audio - Nonempty MP4/FLV Blob supplying the primary AAC audio track.
 * @param options - Positioned output stream, fresh temporary stores, optional
 * cancellation signal, and progress callback.
 * @returns A promise resolving to the shared presentation span in seconds,
 * video/mp4 MIME type, and copied encoded payload bytes without container overhead.
 * @throws {TypeError} If either input is not a nonempty Blob.
 * @throws {Error} If a required track is absent, parsing or decoder configuration
 * is invalid, packet timing is invalid, or video lacks an initial keyframe.
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
      phase: 'inspect',
      bytesProcessed: 0,
      segmentIndex: 0,
    })

    const videoInput = await openMediaInput(video, settings.signal, 'video')
    inputs.push(videoInput)

    const audioInput = await openMediaInput(audio, settings.signal, 'audio')
    inputs.push(audioInput)

    const videoTrack = videoInput.tracks.find(track => track.kind === 'video')
    const audioTrack = audioInput.tracks.find(track => track.kind === 'audio')
    if (!videoTrack || !audioTrack) {
      throw new Error(
        'combineTracks requires a video track followed by an audio track.',
      )
    }

    const tracks = [videoTrack, audioTrack]
    const info = await inspectTracks(tracks, settings.signal)

    return await writeSegments(tracks, singleSegment(tracks, info), settings)
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
 * @yields {{ tracks: PacketTrack[], info: SegmentInfo }} The supplied tracks and
 * timeline as a single segment.
 */
async function* singleSegment(tracks: PacketTrack[], info: SegmentInfo) {
  yield { tracks, info }
}
