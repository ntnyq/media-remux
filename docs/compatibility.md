# Media compatibility and timelines

English · [简体中文](./zh/compatibility.md)

[Documentation](./README.md) · [Core API](./core.md) · [Error handling](./errors.md)

## Containers and codecs

| Input                                 | Video                                         | Audio                                                                                                         | Selected-track requirements                                                                                                                                              |
| ------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MP4, including fragmented MP4 and M4A | H.264, HEVC (`hvc1` and `hev1`), AV1 (`av01`) | AAC, MP3, AC-3 (`ac-3`)                                                                                       | Each selected track needs a single sample description and media data within the input. HEVC and AV1 need their codec configuration boxes. AC-3 needs a valid `dac3` box. |
| FLV                                   | Standard AVC                                  | AAC-LC with 960 or 1024 samples per frame, or complete MP3 frames with a bitrate declared in the frame header | Selected-track decoder configuration must stay stable. HE-AAC/SBR, including implicit signaling, is rejected.                                                            |
| Matroska (MKV)                        | H.264                                         | AAC-LC                                                                                                        | One Matroska Segment and standard `CodecPrivate` for selected tracks. AAC lacing is supported.                                                                           |
| MPEG-TS                               | Annex B H.264 starting at an IDR with SPS/PPS | AAC-LC in ADTS                                                                                                | One program, 188-byte transport packets, and stable PIDs for selected tracks.                                                                                            |

Tracks are selected per input. The default uses primary video and audio. The first-track selection uses container order, or the first recognized tracks in the MPEG-TS program map. MPEG-TS primary selection prefers supported formats. Encrypted selected MP4 tracks and unsupported or encrypted FLV tags cause errors. MKV preflight rejects selected-track content encoding, legacy track offsets, video lacing, container-level cropping, block additions, configuration changes, and nonzero `DiscardPadding`.

The output is fragmented MP4, with M4A naming for audio only. HEVC and AV1 preserve the source sample entry type and decoder configuration. MPEG-TS H.264 is written as `avc3` with in-band parameter sets. Playback support for codecs such as MP3 or AC-3 in MP4 depends on the browser and playback API.

## Concatenation and audio normalization

Copy-mode concatenation requires matching selected track layouts. Compare codec strings, decoder description bytes, video dimensions, reduced display aspect ratios, color configuration, transforms, and audio sample rates and channel counts. Retained video segments must start at usable keyframes. Each segment is rebased to the previous segment's presentation end. Offsets and gaps within the segment are preserved.

Set `normalizeAudio: true` on a core or Worker job to encode retained mono or stereo audio as a continuous 48 kHz stereo AAC-LC track. Encoding requires a WebCodecs AAC-LC encoder and decoders for the retained audio configurations. Video packets are copied. With compatible video, this allows concatenation of differing audio configurations or segments with missing audio. When the task contains a usable audio range, silent samples fill gaps and segments without audio. If trimming removes all audio, the job copies the video and skips encoding. [Normalized concatenation example](./examples.md#job-examples)

## Timestamps and trimming

- Remuxing rebases the earliest playable time to zero. Combining uses the [selected timeline mode](./core.md#combineoptions-and-combinetimeline).
- H.264 MP4 with leading dependent frames starts at the first verified IDR sync sample. With a shared timeline, audio packets before the retained video start are dropped. A first retained MP3 frame that needs data from dropped frames requires `normalizeAudio: true`. Normalization can decode the lead-in and trim the resulting PCM. Copying produces video-only output if the trim leaves no audio packets.
- The output retains decode order, including for B frames. Timestamps are rounded to the output timescale. Sample durations and nonnegative composition offsets must fit in an unsigned 32-bit value at that timescale.
- AV1 uses matching decode and presentation timestamps. Start delays and gaps can be represented at keyframe fragment boundaries. Preflight rejects overlapping decode times and gaps followed by a non-keyframe.
- MP4 supports an optional leading empty edit followed by one rate-1 media edit. Audio edits can trim the leading or trailing range. Copy mode can preserve a partly trimmed initial packet in the first segment via an output edit. An audio edit starting inside a packet in a later segment requires normalization. A video end edit can shorten the final presented frame. Preflight rejects head trimming of video, edits that remove a whole video sample, and unsupported edit sequences or rates.
- FLV requires increasing DTS on each track. Handle wraps or discontinuities by supplying independently readable segments. MKV block timestamps represent PTS and the reader accounts for track timing and `CodecDelay`.

## MPEG-TS segment boundaries

For an already continuous MPEG-TS stream with matching PIDs and continuous counters, a `Blob` assembled from ordered parts can go directly to `remuxMedia`. Parts may cut through access units. The reader handles 33-bit timestamp wrap and preserves the shared A/V timeline, including gaps. Elementary stream framing has a 32 MiB buffer limit. Inputs that exceed the limit fail with `UNSUPPORTED_MEDIA_FEATURE`.

Use [`MpegTsInput`](./core.md#remuxinput-and-mpegtsinput) to record the absolute starts of 188-byte-aligned segments. With `allowContinuityCounterReset: true`, a selected PID may reset its continuity counter on its first payload of a later segment if the packet starts a valid PES and the preceding PES is complete. Ordinary `Blob` inputs and descriptors with the option omitted use strict counter validation. Mid-segment jumps, jumps that continue an existing PES, and detectable truncation still fail.

Set `renditionSwitches` to the indexes of aligned segments where the AVC rendition changes. Each marked segment must start with an IDR access unit carrying the SPS and PPS it references. Dimensions and AVC level may change at those boundaries when the profile, bit depth, chroma format, pixel aspect ratio, and color properties match. The MP4 sample entry records the largest dimensions and highest level. After a switch, an IDR must carry its referenced parameter sets to be indexed for seeking. Video DTS can be adjusted at the switch to keep decode order. Video PTS and the audio timeline are preserved.

Packet errors on a descriptor can include a zero-based segment index, PID, and absolute byte position. If a whole TS packet is lost exactly where a reset is allowed and the next packet starts a valid PES, the stream alone may not distinguish packet loss from a reset. Use trusted segment lengths or checksums when that distinction is needed. Handle program changes and timestamp resets before submitting the stream. [Descriptor example](./examples.md#preserve-mpeg-ts-segment-boundaries)
