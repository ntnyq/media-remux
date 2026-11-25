import { expect, test } from 'vitest'
import { areTracksCompatible, inspectTracks } from '../../src/core/mediaTracks'
import type { VideoPacketTrack } from '../../src/types'
import { EncodedPacket } from '../../src/vendor/mediabunny/src/packet'

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
): VideoPacketTrack {
  return {
    kind: 'video',
    codec: 'avc',
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
  expect(
    areTracksCompatible(videoTrack([], { primaries: null }), videoTrack()),
  ).toBe(true)
  expect(
    areTracksCompatible(
      videoTrack([], {
        fullRange: false,
        matrix: 'bt709',
        transfer: 'bt709',
        primaries: 'bt709',
      }),
      videoTrack([], {
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'bt709',
        fullRange: false,
      }),
    ),
  ).toBe(true)
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
      areTracksCompatible(
        videoTrack([], { ...baseline, ...difference }),
        videoTrack([], baseline),
      ),
    ).toBe(false)
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

  expect(
    areTracksCompatible(
      { ...track, config },
      {
        ...track,
        config: { ...config, displayAspectWidth: 96, displayAspectHeight: 64 },
      },
    ),
  ).toBe(true)
  expect(
    areTracksCompatible(
      { ...track, config },
      {
        ...track,
        config: { ...config, displayAspectWidth: 85, displayAspectHeight: 64 },
      },
    ),
  ).toBe(false)
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

test('compares only the bytes in a decoder description view', () => {
  const track = videoTrack()
  const withDescription = (description: VideoDecoderConfig['description']) => ({
    ...track,
    config: { ...track.config, ...(description ? { description } : {}) },
  })
  const bytes = Uint8Array.of(0, 1, 2, 3)

  expect(
    areTracksCompatible(
      withDescription(new DataView(bytes.buffer, 1, 2)),
      withDescription(Uint8Array.of(1, 2).buffer),
    ),
  ).toBe(true)
  expect(
    areTracksCompatible(
      withDescription(bytes.subarray(1, 3)),
      withDescription(bytes.subarray(2, 4)),
    ),
  ).toBe(false)
  expect(areTracksCompatible(track, withDescription(new ArrayBuffer(0)))).toBe(
    true,
  )
})
