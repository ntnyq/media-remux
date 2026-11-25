import {
  MKV_ID,
  REMUX_ERROR_CODE,
  REMUX_TRACK_SELECTION,
} from '../../constants'
import type { MediaInput, RemuxInput, RemuxTrackSelection } from '../../types'
import { checkAbort, withRemuxErrorCode } from '../../utils'
import { isMpegTsInput, readBlobBytes } from '../../utils/remuxInput'
import { TS_PACKET_SIZE } from '../../vendor/mediabunny/src/mpeg-ts/mpeg-ts-demuxer'
import { openFlvInput } from './flvInput'
import { openMkvInput } from './mkvInput'
import { openMp4Input } from './mp4Input'
import { openMpegTsInput } from './mpegTsInput'

/**
 * Opens selected encoded tracks from a media Blob or an MPEG-TS descriptor.
 * Detects FLV, EBML, and MPEG-TS by signature and otherwise attempts MP4 parsing.
 * Packet iterators read in decode order and can omit encoded payloads during
 * metadata inspection. The caller must dispose the returned input after use.
 *
 * @param source - Nonempty source media Blob or an MPEG-TS descriptor.
 * @param signal - Optional cancellation signal used during opening and iteration.
 * @param selection - Track kinds and ordering to use; defaults to both primary tracks.
 * @returns A promise resolving to track configurations, packet iterators, and
 * a disposer. The track list may be empty if the selected kind is absent.
 * @throws {TypeError} If the input is not a nonempty media input.
 * @throws {Error} If parsing fails, a selected track is encrypted, its codec is
 * unsupported, or its decoder configuration is missing or invalid.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function openMediaInput(
  source: RemuxInput,
  signal?: AbortSignal,
  selection: RemuxTrackSelection = REMUX_TRACK_SELECTION.all,
): Promise<MediaInput> {
  checkAbort(signal)

  if (!(source instanceof Blob) && isMpegTsInput(source)) {
    return openMpegTsInput(source.blob, signal, selection, source)
  }

  const blob = source

  if (!(blob instanceof Blob)) {
    throw new TypeError('Media input must be a nonempty Blob.')
  }

  if (blob.size === 0) {
    throw withRemuxErrorCode(
      new TypeError('Media input must be a nonempty Blob.'),
      REMUX_ERROR_CODE.invalidInput,
    )
  }

  const magic = await readBlobBytes(blob, 0, 4, signal)

  if (magic[0] === 0x46 && magic[1] === 0x4c && magic[2] === 0x56) {
    return openFlvInput(blob, signal, selection)
  }

  if (
    magic.length === 4 &&
    new DataView(magic.buffer).getUint32(0) === MKV_ID.header
  ) {
    return openMkvInput(blob, signal, selection)
  }

  if (magic[0] === 0x47) {
    const sync = await readBlobBytes(blob, 0, 2 * TS_PACKET_SIZE + 1, signal)

    if (
      sync[TS_PACKET_SIZE] === 0x47 &&
      (sync.length <= 2 * TS_PACKET_SIZE || sync[2 * TS_PACKET_SIZE] === 0x47)
    ) {
      return openMpegTsInput(blob, signal, selection)
    }
  }

  return openMp4Input(blob, signal, selection)
}
