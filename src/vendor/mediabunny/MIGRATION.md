# Mediabunny source migration

Base: [Mediabunny v1.62.1](https://github.com/Vanilagy/mediabunny/tree/v1.62.1), MPL-2.0. All source files retain the upstream header. The original upstream LICENSE is included verbatim.

The input was the 1.62.1 source with the existing browser extension's disk-backed MP4 patch applied. The upstream release supplied the `shared/` helpers absent from the installed npm source directory. No Mediabunny package is installed in this repository.

## Included subset

Roots: `Input`, `MP4`, `BlobSource`, `EncodedPacketSink`, `EncodedPacket`, `Output`, `Mp4OutputFormat`, `StreamTarget`, `EncodedVideoPacketSource`, and `EncodedAudioPacketSource`, plus output store contracts. Referenced top-level declarations/imports were retained transitively; unused declarations/imports were removed.

Track abstractions, codec descriptions, metadata helpers, packet readers, MP4 boxes, and stream targets remain where required by this graph. Internal codec helpers cover more than the public H.264/AAC subset; that does not expose those codecs as package features. Raw sample encoding/decoding, conversion, custom decoder registration, HLS, unrelated container readers/writers, Node filesystem implementations, and the upstream public index are excluded. `InputTrack.canDecode` methods were removed because this package never decodes samples.

## Preserved patch behavior

- Range traversal of `moov`, bounded regular sample-table pages/checkpoints.
- Paged TFRA, bounded fragment summaries/anchors, serialized parsing.
- Range traversal of `moof/trun`, bounded sample/duration caches and auxiliary encryption metadata pages.
- Output samples/media on disk, external timestamp sorting, incremental `moof/trun` and `mfra/tfra` writing.
- Long-GOP handling, extended MDAT sizes, 64-bit offsets.
- Per-sample sync flags when a fragment contains multiple keyframes.

`PATCHES.md` preserves historical patch design notes. Its extension-specific adapter/test paths describe the originating repository, not this package's current API. Migrated regressions cover sparse large-file paging and real media round trips.

## Migration adaptations

- Imports distinguish runtime values from types.
- Enums use equivalent constant objects/type aliases; constructor parameter properties use explicit fields/assignments for `erasableSyntaxOnly`.
- Optional internal fields admit `undefined` under `exactOptionalPropertyTypes`. Unknown WebCodecs color fields use `null`; absent decoder descriptions are omitted.
- Required `Symbol.dispose` initialization precedes class definitions. Packet iterators implement `Symbol.asyncDispose` for current TypeScript contracts.
- Stream cancellation aborts/unlocks its writer; successful finalization closes/unlocks it.
- Source close promises include asynchronous muxer work. Cancellation/finalization wait for every source before releasing targets, including when a source fails; cancellation attempts every target cleanup before propagating an error.
- Disk-backed fragment output rejects sample durations outside unsigned 32-bit range and composition offsets outside signed 32-bit range before writing fragment headers, preventing silent field truncation.
- Multiple MP4 sample descriptions are rejected: one output track has one configuration.
- MP4 edit lists reject empty-only lists, additional entries after the first media edit, and non-unit media rates during preflight instead of logging a warning and silently changing playback. Edits also reject when they hide whole video frames at the start or trim a sample's presentation end, checked during regular and fragmented metadata-only packet inspection. Original media-edit timing is retained separately from adjusted offsets, preserving leading empty edits, AAC pre-roll, and movie-timescale rounding. Zero-duration media edits remain open-ended.
- AAC configuration parsing exposes explicit and implicit SBR signaling so the FLV adapter can reject HE-AAC rather than infer AAC-LC packet duration from the SBR output sample rate.
- Repeated track fragments for the same track within one moof reject during preflight instead of warning and skipping later samples.
- Sample payload extents are checked during metadata inspection, and missing declared payloads reject instead of ending packet iteration silently. Regular MP4 sync samples follow `stss` even when the first sample is dependent or no sync samples exist.
- Top-level box traversal rejects truncated headers, invalid sizes, and extents beyond the input instead of silently dropping later fragments. Terminal size-zero boxes extend to the physical end of the file. Fragment composition offsets are unsigned for `trun` version 0 and signed for version 1.
- Nested movie/fragment traversal also rejects undersized box headers instead of silently ending a container and dropping its remaining samples.
- Hybrid MP4 inputs continue from ordinary samples into movie fragments for packet/keyframe traversal and timestamp lookup. Missing fragment decode times start after the ordinary sample table's decode duration. Inconsistent size, timing, and chunk sample counts reject during inspection.
- AVC SPS height includes the interlaced frame factor before cropping. The FLV adapter preserves the SPS pixel aspect ratio in output decoder configuration and MP4 `pasp` metadata.
- MP4 tracks retain the exact sample aspect ratio from SPS or `pasp` separately from rounded square-pixel dimensions. Decoder display ratios use reduced integer factors, preserving `pasp` across repeated remuxes. Explicit `pasp` overrides SPS regardless of box order.
- Vendor files use independent formatting and are fully typechecked. No `@ts-nocheck` suppression is used.

Modified sources here are authoritative and ship in published artifacts. Verify packet/timestamp parity, paging, cancellation, and stream lifecycle when changing them. Do not replace them with an unpatched npm dependency.
