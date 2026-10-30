import { expect, test } from 'vitest'
import type { PacketTrack } from '../src/core/input/mediaInput'
import { inspectTracks, trackSignature } from '../src/core/mediaTracks'
import { EncodedPacket } from '../src/vendor/mediabunny/src/packet'

/**
 * Creates a repeatable video track with a caller-selected decode-order timeline.
 *
 * @param timestamps - Presentation timestamp and packet kind for each decoded sample.
 * @param colorSpace - Optional explicit decoder color metadata.
 * @returns A video track for compatibility and preflight contract checks.
 */
function videoTrack(
  timestamps: readonly (readonly [number, 'key' | 'delta'])[] = [],
  colorSpace?: VideoColorSpaceInit,
): PacketTrack {
  return {
    kind: 'video',
    config: {
      codec: 'avc1.64000a',
      codedWidth: 64,
      codedHeight: 64,
      ...(colorSpace ? { colorSpace } : {}),
    },
    async *packets() {
      for (const [timestamp, type] of timestamps) {
        yield new EncodedPacket(Uint8Array.of(1), type, timestamp, 1)
      }
    },
  }
}

test('compares color metadata by fields regardless of property order or absent null fields', () => {
  expect(trackSignature(videoTrack([], { primaries: null }))).toBe(
    trackSignature(videoTrack()),
  )
  expect(
    trackSignature(
      videoTrack([], {
        fullRange: false,
        matrix: 'bt709',
        transfer: 'bt709',
        primaries: 'bt709',
      }),
    ),
  ).toBe(
    trackSignature(
      videoTrack([], {
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'bt709',
        fullRange: false,
      }),
    ),
  )
})

test.each([
  { primaries: 'smpte170m' },
  { transfer: 'smpte170m' },
  { matrix: 'smpte170m' },
  { fullRange: true },
] satisfies VideoColorSpaceInit[])(
  'keeps incompatible color metadata distinct: %j',
  difference => {
    const baseline = {
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709',
      fullRange: false,
    } satisfies VideoColorSpaceInit
    expect(
      trackSignature(videoTrack([], { ...baseline, ...difference })),
    ).not.toBe(trackSignature(videoTrack([], baseline)))
  },
)

test('allows B-frame reordering within a GOP during timeline preflight', async () => {
  const track = videoTrack([
    [0, 'key'],
    [3, 'delta'],
    [1, 'delta'],
    [2, 'delta'],
    [4, 'key'],
    [7, 'delta'],
    [5, 'delta'],
    [6, 'delta'],
  ])
  await expect(inspectTracks([track])).resolves.toStrictEqual({
    start: 0,
    duration: 8,
  })
})

test('compares proportional display dimensions by their exact aspect ratio', () => {
  const track = videoTrack()
  const config: VideoDecoderConfig = {
    codec: 'avc1.64000a',
    codedWidth: 64,
    codedHeight: 64,
    displayAspectWidth: 192,
    displayAspectHeight: 128,
  }
  expect(trackSignature({ ...track, config })).toBe(
    trackSignature({
      ...track,
      config: { ...config, displayAspectWidth: 96, displayAspectHeight: 64 },
    }),
  )
  expect(trackSignature({ ...track, config })).not.toBe(
    trackSignature({
      ...track,
      config: { ...config, displayAspectWidth: 85, displayAspectHeight: 64 },
    }),
  )
})

test('rejects a delta packet crossing the preceding GOP timeline', async () => {
  const track = videoTrack([
    [0, 'key'],
    [3, 'delta'],
    [1, 'delta'],
    [2, 'delta'],
    [4, 'key'],
    [2, 'delta'],
  ])
  await expect(inspectTracks([track])).rejects.toThrow('previous GOP')
})
