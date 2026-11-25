/* oxlint-disable no-await-in-loop -- Browser scenarios intentionally run in isolation and exercise ordered I/O. */
import {
  isRemuxError,
  MEDIA_JOB_OPERATION,
  REMUX_TRACK_SELECTION,
  runMediaJob,
} from '../../dist/index.js'

const output = document.querySelector('#result')
const checks = []

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function fixture(name) {
  const response = await fetch(`../fixtures/${name}`)

  assert(response.ok, 'Cannot load fixture')

  return response.blob()
}

async function listNames(directory) {
  const names = []

  for await (const name of directory.keys()) {
    names.push(name)
  }

  return names.toSorted()
}

async function playbackTiming(
  file,
  {
    label,
    playToEnd = false,
    onFrame,
    waitForInitialFrame = true,
    timeoutMs = 10_000,
  },
) {
  const video = document.createElement('video')

  video.muted = true
  video.preload = 'auto'
  document.body.append(video)
  const url = URL.createObjectURL(file)
  let timer
  let callback

  try {
    const { promise: frame, resolve } = Promise.withResolvers()
    const { promise: failed, reject } = Promise.withResolvers()
    const ended = playToEnd
      ? new Promise(done =>
          video.addEventListener('ended', done, { once: true }),
        )
      : null

    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label}: playback timed out at ${video.currentTime}s of ${video.duration}s (readyState ${video.readyState}, paused ${video.paused})`,
          ),
        ),
      timeoutMs,
    )

    function observeFrame(_, metadata) {
      resolve(metadata.mediaTime)

      if (onFrame) {
        onFrame(metadata.mediaTime)
        callback = video.requestVideoFrameCallback(observeFrame)
      }
    }

    callback = video.requestVideoFrameCallback(observeFrame)
    video.addEventListener(
      'error',
      () => reject(new Error(video.error?.message ?? 'Playback failed')),
      { once: true },
    )
    video.src = url

    // Capture the initial frame while paused so playback cannot advance past it.
    if (waitForInitialFrame) {
      await Promise.race([frame, failed])
    }

    const [firstFrame] = await Promise.race([
      Promise.all([frame, video.play(), ended]),
      failed,
    ])

    if (playToEnd && 'webkitAudioDecodedByteCount' in video) {
      assert(video.webkitAudioDecodedByteCount > 0, 'No audio was decoded')
    }

    return { firstFrame, duration: video.duration }
  } finally {
    clearTimeout(timer)
    video.cancelVideoFrameCallback(callback)
    video.pause()
    video.removeAttribute('src')
    video.load()
    video.remove()
    URL.revokeObjectURL(url)
  }
}

async function verifyAv1Splice(video, audio, options) {
  const clip = await runMediaJob(
    { operation: MEDIA_JOB_OPERATION.combine, video, audio },
    options,
  )

  try {
    const joined = await runMediaJob(
      { operation: MEDIA_JOB_OPERATION.concat, inputs: [clip.file, clip.file] },
      options,
    )

    try {
      let previousFrame = 0
      let longestFrameInterval = 0
      let resumedAt = 0
      const actual = await playbackTiming(joined.file, {
        label: 'av1-splice-gap',
        playToEnd: true,
        waitForInitialFrame: false,
        onFrame(timestamp) {
          const interval = timestamp - previousFrame

          if (interval > longestFrameInterval) {
            longestFrameInterval = interval
            resumedAt = timestamp
          }

          previousFrame = timestamp
        },
      })
      const expectedResume = clip.duration

      assert(
        longestFrameInterval > 0.8 &&
          Math.abs(resumedAt - expectedResume) < 0.04,
        'AV1 playback did not retain the gap and resume at the splice',
      )
      assert(
        Math.abs(actual.duration - joined.duration) < 0.001,
        'AV1 browser duration lost the presentation tail',
      )
      checks.push({ playback: 'av1-splice-gap', resumedAt, ...actual })
    } finally {
      await joined.dispose()
    }
  } finally {
    await clip.dispose()
  }
}

async function verifyEditedAudio(context, options, normalizeAudio) {
  const input = await fixture('audio-edited-head.m4a')
  const job = normalizeAudio
    ? {
        operation: MEDIA_JOB_OPERATION.concat,
        inputs: [input, input],
        normalizeAudio,
      }
    : { operation: MEDIA_JOB_OPERATION.remux, input }
  const result = await runMediaJob(job, options)

  try {
    const decoded = await context.decodeAudioData(
      await result.file.arrayBuffer(),
    )
    const expectedDuration = normalizeAudio ? 2 : 1

    assert(
      Math.abs(result.duration - expectedDuration) < 0.001 &&
        Math.abs(decoded.duration - expectedDuration) < 0.0001,
      `AAC head edit changed playback duration to ${decoded.duration} seconds`,
    )

    const pcm = decoded.getChannelData(0)

    for (const start of normalizeAudio ? [0.01, 1.01] : [0.01]) {
      const window = pcm.subarray(
        Math.round(start * decoded.sampleRate),
        Math.round((start + 0.03) * decoded.sampleRate),
      )
      let crossings = 0

      for (let index = 1; index < window.length; index++) {
        if (window[index - 1] <= 0 && window[index] > 0) {
          crossings++
        }
      }

      const frequency = (crossings * decoded.sampleRate) / window.length

      assert(
        Math.abs(frequency - 990) < 70,
        `AAC head edit played the wrong tone at ${start}s (${frequency} Hz)`,
      )
    }

    checks.push({
      playback: normalizeAudio
        ? 'edited-audio-normalized'
        : 'edited-audio-copy',
      duration: decoded.duration,
    })
  } finally {
    await result.dispose()
  }
}

async function verifyNormalizedAudio(context, video, options) {
  const encoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate: 48_000,
    numberOfChannels: 2,
    bitrate: 160_000,
  }

  if (
    !context ||
    typeof AudioEncoder === 'undefined' ||
    !(await AudioEncoder.isConfigSupported(encoderConfig)).supported
  ) {
    return
  }

  await verifyEditedAudio(context, options, true)

  const offsetAudio = await runMediaJob(
    {
      operation: MEDIA_JOB_OPERATION.combine,
      video,
      audio: await fixture('audio-edited-head.m4a'),
      normalizeAudio: true,
      timeline: { audioOffset: 0.25 },
    },
    options,
  )

  try {
    const decoded = await context.decodeAudioData(
      await offsetAudio.file.arrayBuffer(),
    )
    const pcm = decoded.getChannelData(0)
    const peak = (start, end) =>
      pcm
        .subarray(
          Math.round(start * decoded.sampleRate),
          Math.round(end * decoded.sampleRate),
        )
        .reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)

    assert(peak(0.1, 0.2) < 0.005, 'Audio started before the specified offset')
    assert(
      peak(0.28, 0.32) > 0.03,
      'Audio was silent after the specified offset',
    )
    checks.push({ playback: 'offset-normalized-audio' })
  } finally {
    await offsetAudio.dispose()
  }

  const [aac48, aac44] = await Promise.all([
    fixture('progressive.mp4'),
    fixture('progressive-two-audio.mp4'),
  ])
  const result = await runMediaJob(
    {
      operation: MEDIA_JOB_OPERATION.concat,
      inputs: [video, aac48, video, aac44, video],
      tracks: REMUX_TRACK_SELECTION.videoWithOptionalAudio,
      normalizeAudio: true,
    },
    options,
  )
  const expected = [
    [1, 0],
    [3, 440],
    [5, 0],
    [6.3, 660],
    [7.5, 0],
  ]
  const observed = []

  try {
    const decoded = await context.decodeAudioData(
      await result.file.arrayBuffer(),
    )
    const pcm = decoded.getChannelData(0)
    const { duration } = await playbackTiming(result.file, {
      label: 'normalized-mixed-audio',
      playToEnd: true,
      timeoutMs: 30_000,
    })

    assert(
      Math.abs(duration - result.duration) < 0.005,
      `Normalized audio duration ${duration} differs from the job duration ${result.duration}`,
    )

    for (const [timestamp, frequency] of expected) {
      const end = Math.round(timestamp * decoded.sampleRate)
      const samples = pcm.subarray(end - 2048, end)

      assert(samples.length === 2048, `Missing audio at ${timestamp} seconds`)

      let crossings = 0

      for (let index = 1; index < samples.length; index++) {
        if (samples[index - 1] <= 0 && samples[index] > 0) {
          crossings++
        }
      }

      const pitch = (crossings * decoded.sampleRate) / samples.length
      const rms = Math.sqrt(
        samples.reduce((sum, sample) => sum + sample * sample, 0) /
          samples.length,
      )

      assert(
        frequency === 0
          ? rms < 0.002
          : rms > 0.01 && Math.abs(pitch - frequency) < 30,
        `Unexpected audio level or pitch at ${timestamp} seconds`,
      )
      observed.push({ timestamp, rms, frequency: pitch })
    }

    checks.push({
      playback: 'normalized-mixed-audio',
      duration,
      observed,
    })
  } finally {
    await result.dispose()
  }

  if (
    typeof AudioDecoder === 'undefined' ||
    !(
      await AudioDecoder.isConfigSupported({
        codec: 'mp3',
        sampleRate: 44_100,
        numberOfChannels: 1,
      })
    ).supported
  ) {
    return
  }

  const mp3 = await runMediaJob(
    {
      operation: MEDIA_JOB_OPERATION.remux,
      input: await fixture('leading-delta-mp3.mp4'),
      normalizeAudio: true,
    },
    options,
  )

  try {
    const decoded = await context.decodeAudioData(await mp3.file.arrayBuffer())
    const pcm = decoded.getChannelData(0)
    const rms = (start, end) => {
      const range = pcm.subarray(
        Math.round(start * decoded.sampleRate),
        Math.round(end * decoded.sampleRate),
      )

      return Math.sqrt(
        range.reduce((sum, sample) => sum + sample * sample, 0) / range.length,
      )
    }
    const before = rms(0.002, 0.015)
    const firstFrame = rms(0.023, 0.042)

    assert(before < 0.005, 'MP3 preroll leaked into the retained timeline')
    assert(firstFrame > 0.04, 'First retained MP3 frame decoded as silence')
    checks.push({ playback: 'normalized-mp3-preroll', before, firstFrame })
  } finally {
    await mp3.dispose()
  }
}

async function run(audioContext) {
  const root = await navigator.storage.getDirectory()
  const directoryName = `media-remux-browser-test-${crypto.randomUUID()}`
  const directory = await root.getDirectoryHandle(directoryName, {
    create: true,
  })
  const createWorker = () =>
    new Worker(new URL('worker.js', import.meta.url), { type: 'module' })

  try {
    const video = await fixture('video.mp4')
    const audio = await fixture('audio.m4a')
    const flv = await fixture('progressive.flv')
    const ac3 = await fixture('progressive-ac3.mp4')
    const jobs = [
      { operation: MEDIA_JOB_OPERATION.combine, video, audio },
      { operation: MEDIA_JOB_OPERATION.remux, input: audio },
      { operation: MEDIA_JOB_OPERATION.remux, input: ac3 },
      {
        operation: MEDIA_JOB_OPERATION.concat,
        inputs: [flv, flv],
        tracks: REMUX_TRACK_SELECTION.videoWithOptionalAudio,
      },
    ]

    for (const job of jobs) {
      const progress = []
      const result = await runMediaJob(job, {
        createWorker,
        directory,
        onProgress: event => progress.push(event),
      })

      assert(result.file.size > 1000, 'Output is empty')
      assert(
        progress.some(event => event.phase === 'finalize'),
        'Missing finalization progress',
      )
      const names = await listNames(directory)

      assert(names.length === 1, 'Unexpected job directory count')
      const temporary = await directory.getDirectoryHandle(names[0])

      assert(
        JSON.stringify(await listNames(temporary)) === '["output.mp4"]',
        'Spools survived completion',
      )
      const outputBytes = new Uint8Array(
        await result.file.slice(4, 8).arrayBuffer(),
      )

      assert(
        new TextDecoder().decode(outputBytes) === 'ftyp',
        'Output is not MP4',
      )
      await result.dispose()
      await result.dispose()
      assert(
        (await listNames(directory)).length === 0,
        'dispose left files behind',
      )
      checks.push({
        operation: job.operation,
        size: result.file.size,
        duration: result.duration,
      })
    }

    const vfr = await fixture('vfr-bframes.mp4')
    const vfrFlv = await fixture('vfr-bframes.flv')
    const mpegTs = await fixture('continuous-av.mpegts')
    const segmentStart = 5076
    const tsPacketSize = 188
    const tsBytes = new Uint8Array(await mpegTs.arrayBuffer())

    for (
      let offset = segmentStart + 3;
      offset < tsBytes.length;
      offset += tsPacketSize
    ) {
      tsBytes[offset] = (tsBytes[offset] & 0xf0) | ((tsBytes[offset] + 1) & 15)
    }

    const segmentedTs = {
      blob: new Blob([tsBytes]),
      segmentOffsets: [0, segmentStart],
      allowContinuityCounterReset: true,
    }
    const tsVideoStart = (15000 - 12910) / 90000
    const fragmentedAudio = await fixture('subtitle-first.mp4')
    const playbackCases = [
      ['cfr-av', { operation: MEDIA_JOB_OPERATION.combine, video, audio }, 0],
      [
        'vfr-av',
        { operation: MEDIA_JOB_OPERATION.combine, video: vfr, audio },
        0.4,
      ],
      [
        'vfr-flv-av',
        { operation: MEDIA_JOB_OPERATION.combine, video: vfrFlv, audio },
        0.4,
      ],
      ['vfr-remux', { operation: MEDIA_JOB_OPERATION.remux, input: vfr }, 0],
      [
        'leading-delta-av-remux',
        {
          operation: MEDIA_JOB_OPERATION.remux,
          input: await fixture('leading-delta-av.mp4'),
        },
        0,
        true,
      ],
      [
        'mp3-flv-remux',
        {
          operation: MEDIA_JOB_OPERATION.remux,
          input: await fixture('progressive-mp3.flv'),
        },
        0,
        true,
      ],
      [
        'mkv-remux',
        {
          operation: MEDIA_JOB_OPERATION.remux,
          input: await fixture('progressive.mkv'),
        },
        0,
        true,
      ],
      [
        'mpeg-ts-remux',
        {
          operation: MEDIA_JOB_OPERATION.remux,
          input: mpegTs,
        },
        tsVideoStart,
        true,
      ],
      [
        'segmented-mpeg-ts-remux',
        { operation: MEDIA_JOB_OPERATION.remux, input: segmentedTs },
        tsVideoStart,
        true,
      ],
      [
        'segmented-mpeg-ts-combine',
        {
          operation: MEDIA_JOB_OPERATION.combine,
          video: segmentedTs,
          audio: segmentedTs,
        },
        tsVideoStart,
        true,
      ],
      [
        'mixed-container-combine',
        {
          operation: MEDIA_JOB_OPERATION.combine,
          video: segmentedTs,
          audio: fragmentedAudio,
        },
        1 / 6,
      ],
      [
        'aligned-mixed-container-combine',
        {
          operation: MEDIA_JOB_OPERATION.combine,
          video: segmentedTs,
          audio: fragmentedAudio,
          timeline: 'align-starts',
        },
        0,
      ],
      [
        'vfr-mp4-flv',
        { operation: MEDIA_JOB_OPERATION.concat, inputs: [vfr, vfrFlv] },
        0,
      ],
      [
        'vfr-flv-mp4',
        { operation: MEDIA_JOB_OPERATION.concat, inputs: [vfrFlv, vfr] },
        0,
      ],
    ]

    const av1 = document
      .createElement('video')
      .canPlayType('video/mp4; codecs="av01.0.00M.10"')
      ? await fixture('av1-main10.mp4')
      : null

    if (av1) {
      playbackCases.push([
        'av1-av',
        {
          operation: MEDIA_JOB_OPERATION.combine,
          video: av1,
          audio,
        },
        0,
      ])
    }

    for (const [label, job, firstFrame, playToEnd] of playbackCases) {
      const result = await runMediaJob(job, { createWorker, directory })

      try {
        const actual = await playbackTiming(result.file, {
          label,
          playToEnd,
          // AV1 can require active playback before Chrome presents a frame.
          waitForInitialFrame: label !== 'av1-av',
        })

        assert(
          Math.abs(actual.firstFrame - firstFrame) < 0.00005,
          `${label}: first-frame timestamp ${actual.firstFrame} differs from ${firstFrame}`,
        )
        assert(
          Math.abs(actual.duration - result.duration) < 0.001,
          `${label}: browser duration ${actual.duration} differs from job duration ${result.duration}`,
        )
        checks.push({ playback: label, ...actual })
      } finally {
        await result.dispose()
      }
    }

    if (av1) {
      await verifyAv1Splice(av1, audio, { createWorker, directory })
    }

    const audioOptions = {
      createWorker,
      directory,
    }

    if (audioContext) {
      await verifyEditedAudio(audioContext, audioOptions, false)
    }

    await verifyNormalizedAudio(audioContext, video, audioOptions)

    const fractionalAv = await fixture('fractional-av.mp4')
    const concatenated = await runMediaJob(
      {
        operation: MEDIA_JOB_OPERATION.concat,
        inputs: Array.from({ length: 16 }, () => fractionalAv),
      },
      { createWorker, directory },
    )

    try {
      assert(
        concatenated.file.size > 1024 * 1024,
        'Fractional A/V output did not flush its initial OPFS page',
      )
      const repeated = await runMediaJob(
        { operation: MEDIA_JOB_OPERATION.remux, input: concatenated.file },
        { createWorker, directory },
      )

      try {
        assert(
          repeated.bytesProcessed === concatenated.bytesProcessed &&
            Math.abs(repeated.duration - concatenated.duration) < 0.001,
          'Fractional A/V changed during repeated remux',
        )
        checks.push({
          operation: 'fractional-av-round-trip',
          size: concatenated.file.size,
        })
      } finally {
        await repeated.dispose()
      }
    } finally {
      await concatenated.dispose()
    }

    for (const mutation of [
      'inputs',
      'options',
      'inherited-job',
      'inherited-options',
    ]) {
      const inputs = [audio, audio]
      const job =
        mutation === 'inherited-job'
          ? Object.create({ operation: MEDIA_JOB_OPERATION.concat, inputs })
          : { operation: MEDIA_JOB_OPERATION.concat, inputs }
      const options =
        mutation === 'inherited-options'
          ? Object.create({ createWorker, directory })
          : { createWorker, directory }
      const pending = runMediaJob(job, options)

      if (mutation === 'inputs') {
        inputs.length = 0
      } else if (mutation === 'options') {
        options.createWorker = () => {
          throw new Error(
            'Changed Worker factory must not affect an active job',
          )
        }
      }

      const result = await pending

      assert(
        Math.abs(result.duration - 3.6) < 0.001,
        'Active job lost its submitted inputs',
      )
      await result.dispose()
      assert(
        (await listNames(directory)).length === 0,
        'Captured job left temporary files',
      )
      checks.push({ capturedJob: mutation, cleanup: 'clean' })
    }

    const lostTsPacket = 6956

    for (const [label, input, message, code] of [
      [
        'truncated',
        video.slice(0, video.size - 1),
        'sample payload',
        'INVALID_INPUT',
      ],
      ['no-video', audio, 'required video track', 'MISSING_REQUIRED_TRACK'],
      [
        'cut-mp3',
        await fixture('leading-delta-mp3.mp4'),
        'normalizeAudio',
        'UNSUPPORTED_MEDIA_FEATURE',
      ],
      [
        'segmented-mpeg-ts-packet-loss',
        {
          ...segmentedTs,
          blob: new Blob([
            tsBytes.subarray(0, lostTsPacket),
            tsBytes.subarray(lostTsPacket + tsPacketSize),
          ]),
        },
        'continuity counter is out of sequence. (segment 1, PID 257, byte offset 6956)',
        'INVALID_INPUT',
      ],
    ]) {
      let failure

      try {
        await runMediaJob(
          {
            operation: MEDIA_JOB_OPERATION.remux,
            input,
            tracks: REMUX_TRACK_SELECTION.videoWithOptionalAudio,
          },
          { createWorker, directory },
        )
      } catch (error) {
        failure = error
      }

      assert(
        isRemuxError(failure) &&
          failure.code === code &&
          failure.message.includes(message),
        `Invalid ${label} input did not preserve its media error`,
      )
      assert(
        (await listNames(directory)).length === 0,
        'Invalid input left temporary files',
      )
      checks.push({ invalidInput: label, code, cleanup: 'clean' })
    }

    const controller = new AbortController()

    try {
      await runMediaJob(
        {
          operation: MEDIA_JOB_OPERATION.concat,
          inputs: Array.from({ length: 25 }, () => video),
        },
        {
          createWorker,
          directory,
          signal: controller.signal,
          onProgress(event) {
            if (event.phase === 'remux') {
              controller.abort(new DOMException('test abort', 'AbortError'))
            }
          },
        },
      )

      throw new Error('Cancellation did not reject')
    } catch (error) {
      assert(error.name === 'AbortError' && !isRemuxError(error), error.message)
    }

    assert(
      (await listNames(directory)).length === 0,
      'Cancellation left temporary files',
    )
    checks.push({ cancellation: 'clean' })

    for (const createFailure of [
      () => {
        throw new Error('factory failure')
      },
      () =>
        new Worker(new URL('crash.js', import.meta.url), { type: 'module' }),
    ]) {
      let failed = false

      try {
        await runMediaJob(
          { operation: MEDIA_JOB_OPERATION.remux, input: video },
          { createWorker: createFailure, directory },
        )
      } catch {
        failed = true
      }

      assert(failed, 'Worker failure did not reject')
      assert(
        (await listNames(directory)).length === 0,
        'Failed Worker left files',
      )
    }

    checks.push({ workerFailure: 'clean' })
    // Two simultaneous jobs must use exclusive files and leave no locks behind.
    const concurrent = await Promise.all(
      [1, 2].map(() =>
        runMediaJob(
          { operation: MEDIA_JOB_OPERATION.remux, input: audio },
          { createWorker, directory },
        ),
      ),
    )

    await Promise.all(concurrent.map(result => result.dispose()))
    assert(
      (await listNames(directory)).length === 0,
      'Concurrent jobs left files',
    )
    checks.push({ concurrency: 'clean' })
    output.textContent = JSON.stringify({ status: 'passed', checks }, null, 2)
  } finally {
    await root.removeEntry(directoryName, { recursive: true })
  }
}

document.querySelector('#run').addEventListener('click', async () => {
  output.textContent = 'Running'

  const audioContext =
    typeof AudioContext === 'undefined' ? null : new AudioContext()

  try {
    await audioContext?.resume()
    await run(audioContext)
  } catch (error) {
    output.textContent = JSON.stringify(
      { status: 'failed', message: error.message, stack: error.stack, checks },
      null,
      2,
    )
  } finally {
    await audioContext?.close()
  }
})
