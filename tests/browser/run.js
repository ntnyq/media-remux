/* oxlint-disable no-await-in-loop -- Browser scenarios intentionally run in isolation and exercise ordered I/O. */
import { runMediaJob } from '../../dist/index.js'

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

async function run() {
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
    const jobs = [
      { operation: 'combine', video, audio },
      { operation: 'remux', input: audio },
      { operation: 'concat', inputs: [flv, flv] },
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
    for (const mutation of [
      'inputs',
      'options',
      'inherited-job',
      'inherited-options',
    ]) {
      const inputs = [audio, audio]
      const job =
        mutation === 'inherited-job'
          ? Object.create({ operation: 'concat', inputs })
          : { operation: 'concat', inputs }
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
        result.duration > 3.6 && result.duration < 3.7,
        'Active job lost its submitted inputs',
      )
      await result.dispose()
      assert(
        (await listNames(directory)).length === 0,
        'Captured job left temporary files',
      )
      checks.push({ capturedJob: mutation, cleanup: 'clean' })
    }
    for (const [label, input, message] of [
      ['truncated', video.slice(0, video.size - 1), 'sample payload'],
      ['leading-delta', await fixture('leading-delta.mp4'), 'keyframe'],
    ]) {
      let failure
      try {
        await runMediaJob(
          { operation: 'remux', input },
          { createWorker, directory },
        )
      } catch (error) {
        failure = error
      }
      assert(
        failure instanceof Error && failure.message.includes(message),
        `Invalid ${label} input did not reject with the expected error`,
      )
      assert(
        (await listNames(directory)).length === 0,
        'Invalid input left temporary files',
      )
      checks.push({ invalidInput: label, cleanup: 'clean' })
    }
    const controller = new AbortController()
    try {
      await runMediaJob(
        {
          operation: 'concat',
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
      assert(error.name === 'AbortError', error.message)
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
          { operation: 'remux', input: video },
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
          { operation: 'remux', input: audio },
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
  try {
    await run()
  } catch (error) {
    output.textContent = JSON.stringify(
      { status: 'failed', message: error.message, stack: error.stack, checks },
      null,
      2,
    )
  }
})
