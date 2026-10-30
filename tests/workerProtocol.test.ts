import { expect, test } from 'vitest'
import { isWorkerRequest, isWorkerResponse } from '../src/browser/protocol'

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
