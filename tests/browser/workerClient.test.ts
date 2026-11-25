import { expect, test, vi } from 'vitest'
import { runMediaJob } from '../../src'

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
