import { expect, test, vi } from 'vitest'
import { runMediaJob } from '../src'
import { isWorkerRequest, isWorkerResponse } from '../src/browser/protocol'

test('retries a transient OPFS cleanup error up to five times', async () => {
  vi.useFakeTimers()

  try {
    const failure = new Error('Could not open output')
    const locked = new DOMException(
      'Still locked',
      'NoModificationAllowedError',
    )
    const removeEntry = vi.fn<() => Promise<void>>().mockRejectedValue(locked)
    const directory = {
      async getDirectoryHandle() {
        return {
          async getFileHandle() {
            throw failure
          },
        }
      },
      removeEntry,
    } as unknown as FileSystemDirectoryHandle
    const result = runMediaJob(
      { operation: 'remux', input: new Blob(['media']) },
      { directory, createWorker: vi.fn<() => Worker>() },
    )

    await Promise.all([
      expect(result).rejects.toMatchObject({ errors: [failure, locked] }),
      vi.runAllTimersAsync(),
    ])
    expect(removeEntry).toHaveBeenCalledTimes(6)
  } finally {
    vi.useRealTimers()
  }
})

test('reports OPFS as unavailable when navigator has no directory method', async () => {
  vi.stubGlobal('navigator', { storage: {} })

  try {
    const createWorker = vi.fn<() => Worker>()

    await expect(
      runMediaJob(
        { operation: 'remux', input: new Blob(['media']) },
        { createWorker },
      ),
    ).rejects.toThrow(/OPFS is unavailable/u)
    expect(createWorker).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

test.each([
  { mimeType: 'audio/mp4', isValid: true },
  { mimeType: ['audio/mp4'], isValid: false },
])(
  'checks the actual MIME type field type: $isValid',
  ({ mimeType, isValid }) => {
    expect(
      isWorkerResponse({
        type: 'complete',
        result: { bytesProcessed: 1, duration: 1, mimeType },
      }),
    ).toBe(isValid)
  },
)

test.each([
  { phase: 'remux', isValid: true },
  { phase: ['remux'], isValid: false },
])('checks the actual progress phase type: $isValid', ({ phase, isValid }) => {
  expect(
    isWorkerResponse({
      type: 'progress',
      progress: { phase, bytesProcessed: 1, segmentIndex: 0 },
    }),
  ).toBe(isValid)
})

test.each([
  { tracks: 'audio', isValid: true },
  { tracks: 'video-with-optional-audio', isValid: true },
  { tracks: 'first-video-with-optional-audio', isValid: true },
  { tracks: ['audio'], isValid: false },
])(
  'checks the actual track selection type: $isValid',
  ({ tracks, isValid }) => {
    expect(
      isWorkerRequest({
        type: 'run',
        job: { operation: 'remux', input: new Blob(['media']), tracks },
        handle: { createWritable() {} },
        directory: { getFileHandle() {} },
      }),
    ).toBe(isValid)
  },
)

test.each([
  { path: ['parent', 'job'], isValid: true },
  { path: [], isValid: false },
  { path: ['parent/job'], isValid: false },
  { path: ['..', 'job'], isValid: false },
  { path: ['parent', 1], isValid: false },
])('validates OPFS path components: $path', ({ path, isValid }) => {
  expect(
    isWorkerRequest({
      type: 'run',
      job: { operation: 'remux', input: new Blob(['media']) },
      path,
    }),
  ).toBe(isValid)
})

test.each([
  { normalizeAudio: true, isValid: true },
  { normalizeAudio: false, isValid: true },
  { normalizeAudio: 'true', isValid: false },
])(
  'validates the audio normalization flag: $normalizeAudio',
  ({ normalizeAudio, isValid }) => {
    expect(
      isWorkerRequest({
        type: 'run',
        job: { operation: 'remux', input: new Blob(['media']), normalizeAudio },
        path: ['job'],
      }),
    ).toBe(isValid)
  },
)

test.each([
  { code: undefined, isValid: true },
  { code: 'UNSUPPORTED_CODEC', isValid: true },
  { code: 'QuotaExceededError', isValid: false },
  { code: ['UNSUPPORTED_CODEC'], isValid: false },
])('checks the optional media error code: $isValid', ({ code, isValid }) => {
  expect(
    isWorkerResponse({
      type: 'error',
      name: 'Error',
      message: 'Failure',
      code,
    }),
  ).toBe(isValid)
})
