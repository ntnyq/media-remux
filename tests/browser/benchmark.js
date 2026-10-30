/* oxlint-disable no-await-in-loop -- Benchmark runs and fixture writes must finish before the next measurement. */
import { runMediaJob } from '../../dist/index.js'

/**
 * Runs serially to avoid overlapping Workers and disk contention.
 * Input loading is deliberately excluded from the timer.
 *
 * @param inputs - Named media Blobs to benchmark.
 * @param rounds - Number of serial runs for each input.
 * @returns Browser information and timing rows for every run.
 */
export async function benchmark(inputs, rounds = 3) {
  const rows = []
  const root = await navigator.storage.getDirectory()
  const directoryName = `media-remux-benchmark-${crypto.randomUUID()}`
  const directory = await root.getDirectoryHandle(directoryName, {
    create: true,
  })
  try {
    for (const { name, blob } of inputs) {
      // Stage outside the timer so packet reads use an OPFS-backed File.
      const handle = await directory.getFileHandle('input.media', {
        create: true,
      })
      const writer = await handle.createWritable()
      await writer.write(blob)
      await writer.close()
      const input = await handle.getFile()
      for (let round = 0; round < rounds; round++) {
        const started = performance.now()
        const phases = {}
        const result = await runMediaJob(
          { operation: 'remux', input },
          {
            createWorker: () =>
              new Worker(new URL('worker.js', import.meta.url), {
                type: 'module',
              }),
            onProgress(event) {
              phases[event.phase] ??= performance.now() - started
            },
          },
        )
        const elapsedMs = performance.now() - started
        await result.dispose()
        rows.push({
          name,
          round: round + 1,
          inputBytes: blob.size,
          outputBytes: result.file.size,
          payloadBytes: result.bytesProcessed,
          elapsedMs,
          inspectMs: (phases.remux ?? elapsedMs) - (phases.inspect ?? 0),
          copyMs: (phases.finalize ?? elapsedMs) - (phases.remux ?? 0),
          finalizeMs: elapsedMs - (phases.finalize ?? elapsedMs),
          mibPerSecond: blob.size / 1024 ** 2 / (elapsedMs / 1000),
          duration: result.duration,
        })
        document.querySelector('#result').textContent = JSON.stringify(
          { status: 'running', rows },
          null,
          2,
        )
      }
    }
  } finally {
    await root.removeEntry(directoryName, { recursive: true })
  }
  const report = {
    status: 'passed',
    inputStorage: 'opfs',
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    rows,
  }
  document.querySelector('#result').textContent = JSON.stringify(
    report,
    null,
    2,
  )
  return report
}

document.querySelector('#run').addEventListener('click', async () => {
  const inputs = [...document.querySelector('#files').files].map(blob => ({
    name: blob.name,
    blob,
  }))
  try {
    await benchmark(inputs)
  } catch (error) {
    document.querySelector('#result').textContent = JSON.stringify({
      status: 'failed',
      message: error.message,
      stack: error.stack,
    })
  }
})
