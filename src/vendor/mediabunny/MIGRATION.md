# Mediabunny source migration

The current base is [Mediabunny v1.66.2](https://github.com/Vanilagy/mediabunny/tree/v1.66.2) (commit `1f09bdd456b6e238fc53d1fa32b23bc9c49edacb`, MPL-2.0). The npm release supplies the TypeScript source and generated version. The matching Git tag supplies the shared helpers. The upstream source headers and license are included.

The first migration used 1.62.1 with the existing browser extension’s disk-backed MP4 patch. The current migration reconciles retained declarations and class members against 1.62.1, local source, and 1.66.2. Mediabunny ships as source inside this repository.

## Included subset

Roots: `Input`, `MP4`, `BlobSource`, `EncodedPacketSink`, `EncodedPacket`, `Output`, `Mp4OutputFormat`, `StreamTarget`, `EncodedVideoPacketSource`, and `EncodedAudioPacketSource`, plus output store contracts. Referenced top-level declarations/imports were retained transitively; unused declarations/imports were removed.

Track abstractions, codec descriptions, metadata helpers, packet readers, MP4 boxes, and stream targets remain where required by this graph. Raw sample encoding/decoding, conversion, custom decoder registration, HLS, unrelated container readers/writers, Node filesystem implementations, and the upstream public index are excluded. `InputTrack.canDecode` methods were removed because this package never decodes samples.

## Preserved patch behavior

- Range traversal of `moov`, bounded regular sample-table pages/checkpoints.
- Paged TFRA, bounded fragment summaries/anchors, serialized parsing.
- When `tfdt` is missing, the reader recovers the fragment's decode origin from the exact sample referenced by TFRA. Without a usable reference, it scans contiguous fragments from a cached decode-time anchor or from the end of `moov`. In a hybrid MP4, that initial decode clock includes the ordinary sample table's decode duration.
- Range traversal of `moof/trun`, bounded sample/duration caches and auxiliary encryption metadata pages.
- The reader scans `tfhd` defaults and `trun` sample layouts for unsupported tracks as well. The end of the skipped data determines the next `traf`'s implicit base offset. The skipped track's media payload stays unread.
- Output samples/media on disk, external timestamp sorting, incremental `moof/trun` and `mfra/tfra` writing.
- Long-GOP handling, extended MDAT sizes, 64-bit offsets.
- Per-sample sync flags when a fragment contains multiple keyframes.

Regression tests cover sparse large-file paging and real media round trips.

## Migration adaptations

- Imports distinguish runtime values from types.
- Enums use equivalent constant objects/type aliases; constructor parameter properties use explicit fields/assignments for `erasableSyntaxOnly`.
- Optional internal fields admit `undefined` under `exactOptionalPropertyTypes`. Unknown WebCodecs color fields use `null`; absent decoder descriptions are omitted.
- Required `Symbol.dispose` initialization precedes class definitions. Packet iterators implement `Symbol.asyncDispose` for current TypeScript contracts.
- Stream backpressure waits for queued writes, including when the writable high-water mark is zero. Stream cancellation aborts/unlocks its writer. After all writes settle, successful finalization checks cancellation before committing the stream.
- Source close promises include asynchronous muxer work. Cancellation/finalization wait for every source before releasing targets, including when a source fails; cancellation attempts every target cleanup before propagating an error.
- Disk-backed fragment output checks sample durations and composition offsets before writing fragment headers. Core jobs use unsigned 32-bit values for both fields. The compatibility path without preflight timing uses signed composition offsets.
- Fragmented output patches movie and track durations before committing, using integer presentation ends from the written fragments to keep edit lists consistent with quantized samples. GOPs with an explicit decode origin and decode durations can skip timestamp sorting.
- Fragmented files containing AC-3 use zero `mdhd` duration for all initialization tracks. Safari adds fragment durations to that field.
- Selected tracks with multiple MP4 sample descriptions are rejected: one output track has one configuration. Unsupported edit lists and multiple sample descriptions on discarded tracks do not block extraction.
- Selected tracks reject sample references outside the single supported description. The reader resolves sample descriptions after reading track headers and applies the movie transformation after reading the complete movie header.
- Selected sample descriptions must refer to data in the input file. The reader checks the corresponding data-reference entry by range.
- MP4 edit lists reject empty-only lists, additional entries after the first media edit, and non-unit media rates during preflight. Regular and fragmented input shorten a partially trimmed final video frame. Audio tail edits shorten the final intersecting packet and skip packets wholly beyond the edit. Video prefix trims and fully excluded video samples are rejected. Original media-edit timing is retained separately from adjusted offsets, preserving leading empty edits, AAC pre-roll, and movie-timescale rounding. Zero-duration media edits remain open-ended.
- The audio backing exposes the first playable position so the core can discard wholly trimmed packets. Fragmented output writes a leading edit when the first retained audio packet overlaps the edit start.
- AAC configuration parsing exposes explicit and implicit SBR signaling so the FLV adapter can reject HE-AAC rather than infer AAC-LC packet duration from the SBR output sample rate.
- Repeated track fragments for the same track within one moof reject during preflight instead of warning and skipping later samples.
- Sample payload extents are checked during metadata inspection, and missing declared payloads reject instead of ending packet iteration silently. Regular MP4 sync samples follow `stss` even when the first sample is dependent or no sync samples exist.
- Top-level box traversal rejects truncated headers, invalid sizes, and extents beyond the input instead of silently dropping later fragments. Terminal size-zero boxes extend to the physical end of the file. Fragment composition offsets are unsigned for `trun` version 0 and signed for version 1.
- Nested movie/fragment traversal also rejects undersized box headers instead of silently ending a container and dropping its remaining samples.
- The MP4 demuxer distinguishes unsupported features from explicit container validation failures. The adapter maps these errors to stable media codes while preserving read failures and cancellation.
- Hybrid MP4 inputs continue from ordinary samples into movie fragments for packet/keyframe traversal and timestamp lookup. Missing fragment decode times start after the ordinary sample table's decode duration. Inconsistent size, timing, and chunk sample counts reject during inspection.
- AVC SPS height includes the interlaced frame factor before cropping. The FLV adapter preserves the SPS pixel aspect ratio in output decoder configuration and MP4 `pasp` metadata.
- Numeric MP4 nclx/nclc color identifiers survive remuxing and participate in segment compatibility even when WebCodecs has no corresponding string value.
- MP4 tracks retain the exact sample aspect ratio from SPS or `pasp` separately from rounded square-pixel dimensions. Decoder display ratios use reduced integer factors, preserving `pasp` across repeated remuxes. Explicit `pasp` overrides SPS regardless of box order.
- The muxer cancels common aspect-ratio factors before multiplication and rejects values that exceed the `pasp` or video sample entry fields.
- HEVC MP4 retains the original `hvc1` or `hev1` sample entry and `hvcC`. AV1 retains the complete `av1C` record and declares `av01` in the compatible brands. Planned AV1 tracks use a common integer PTS/DTS clock. A keyframe after a gap starts a new fragment with its own `tfdt`, even below the normal minimum fragment duration.
- AC-3 MP4 retains the original `dac3` payload in its `ac-3` sample entry. Its channel layout and sample rate come from `dac3`, which also lets the muxer initialize the track without reading a priming packet.
- Vendor files use independent formatting and are fully typechecked. No `@ts-nocheck` suppression is used.

## 1.66.2 reconciliation

- The MP4 input probe uses the upstream match-position contract with bounded box traversal. AVC and HEVC configuration parsing, AAC program config parsing, packet read-ahead, and output lifecycle build on the upstream release.
- The fragment reader keeps its paged sample tables, bounded caches, and serialized timestamp recovery.
- The disk-backed AAC writer emits roll groups in constant space, using one previous packet of decode pre-roll for samples that have a predecessor. The compatibility path without an index store keeps one TFRA entry per indexed fragment.
- The output target uses iterative chunk writes and retains job-specific backpressure and stream-abort handling. The packet copy path preserves the input sample set, including HEVC leading pictures.

Modified sources here are authoritative and ship in published artifacts. Verify packet/timestamp parity, paging, cancellation, and stream lifecycle when changing them. Do not replace them with an unpatched npm dependency.
