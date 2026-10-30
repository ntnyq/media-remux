# Media patches

## mediabunny@1.62.1

The browser remuxer writes fragmented MP4/M4A and supplies an internal
`_fragmentIndexStore` to the pinned muxer patch. Each completed fragment appends
one packed 28-byte TFRA v1 record per track that has a sync sample. The muxer
awaits persistence/backpressure, then releases the entire completed chunk and
its samples. Only per-track counts remain in the muxer. Original sample numbers,
track/run references, 64-bit presentation times and offsets are preserved.

The application store uses one 64 KiB write buffer per track and async OPFS
write streams. Finalization commits those streams, reads at most 64 KiB per
request, and writes MFRA/TFRA headers, packed records and MFRO incrementally,
flushing the target after each page. It never builds the complete box tree or
index buffer. The MFRO 32-bit enclosing-size limit is checked before writing the
index. Index storage grows on disk by 28 bytes per recorded track/fragment;
retained index memory does not grow with fragment count.

The caller owns the store and its cleanup. Each browser merge has a unique OPFS
job directory containing output, track indexes and reusable media spools. Success closes temporary
handles before reporting completion; download completion, failure or cancellation
removes the entire directory. Worker termination may briefly leave native OPFS
locks, so cleanup retries transient lock errors. The store preserves the first
I/O error, closes every opened handle, and supports partial reads/writes. The
application always supplies an index store. Upstream callers without the option keep
the earlier compatibility path, retaining only each fragment's sample prefix
through its first sync sample; that path still grows with fragment count.

The patch retains `_fragmentMediaStore` as a compatibility option. As samples enter the
interleaved current fragment, their media bytes are appended to a per-track
spool with a 64 KiB write buffer and awaited backpressure. `sample.data` is then
cleared, including references held by GOP timestamp processing. Once the moof
is known, the muxer reads media in at most 64 KiB pages, flushes each page to the
output and resets the track spool. The next append truncates/reuses the same
logical file; files do not accumulate per GOP. Index and media spools share the
paged file adapter, error propagation and job-directory cleanup. No synchronous
OPFS access handle is required. Whole-mdat callbacks are incompatible with the
media store because they materialize the payload.

Long fragments use correct 64-bit MDAT sizes including the extended header.
Tracks whose payload starts beyond signed 32-bit `trun.data_offset` use an
absolute 64-bit TFHD base and zero run offset; ordinary outputs keep identical
bytes. Without a sample store, timestamp sorting, current-fragment sample objects and
moof/trun metadata still scale with GOP sample count. The bounded media pages do not bound those
objects, an individual caller/queued packet or its backing buffer, source caches,
codec state or total process peaks. Spooling adds disk reads/writes and temporary
space proportional to track fragment payloads, which can be large for long GOPs;
real quota errors remain authoritative over advisory storage estimates.

The application now supplies `_fragmentSampleStore` together with the index
store. It persists transformed media and fixed 56-byte descriptors on arrival,
including packets queued behind another track. The muxer retains scalar queue
and GOP cursors rather than sample arrays. Each track caches two descriptor
pages of 1,024 records (56 KiB each) and one 64 KiB media write page. A fixed
4,096-timestamp (32 KiB) buffer sorts small GOPs; larger GOPs use sorted runs and
pairwise external merges through two reusable scratch files. Merge input/output
pages and the sorted read page are at most 64 KiB. No run-location list or
complete timestamp array is retained.

Timestamp processing updates descriptors by position, preserving duplicate PTS,
B-frame ordering, duration refinement and negative initial offsets. Only the last
sample is cached across GOPs; refinements to already emitted records do not
resurrect them. Fragment summaries scan disk records for flags/defaults/sync
references, then headers and trun entries are written in bounded pages. The
complete moof/trun box tree is never constructed. Absolute TFHD offsets and
extended MDAT sizes remain supported. Whole-moof/mdat callbacks are incompatible
with this option, and an index store is required to avoid the legacy final tree.

Completed prefixes of both descriptors and media are compacted in bounded pages;
queued tails remain valid through logical IDs/offsets. Each track owns four
reusable files, not one file per sample, run or GOP. Production uses exclusive
OPFS synchronous access handles inside the dedicated Worker for positional
updates without copying/reopening whole files. Every handle closes before
completion/error reporting; parent cancellation terminates the Worker and removes
its job directory. First I/O errors propagate, including sorting and release;
mutexes release on failed close/finalization paths.

These bounds cover retained output GOP descriptors, timestamp sorting and
moof/trun generation independently of GOP sample count. Scratch disk space and
sorting I/O still grow with the GOP; severely imbalanced tracks can increase
prefix-compaction I/O. Caller-held/individual packets, codec/encryption metadata,
source caches retain separate costs. Input moof sample paging is described below.
No whole-task memory or process-peak cap is promised. The no-store compatibility
path and progressive FFmpeg path remain unchanged.

The patch also fixes `trun` flag compression: first-sample-only flags are valid
only when every later sample has identical flags. Fragments containing multiple
keyframes must write per-sample flags or seeking can miss intermediate keyframes.

The demuxer walks `moov` by file range instead of loading and retaining its full
buffer. It skips unknown/padding payloads and defers each track's sample tables
until its first packet request. The eight regular sample-table boxes (`stts`,
`ctts`, `stsz`, `stz2`, `stss`, `stsc`, `stco`, `co64`) stay on the input source.
Each track retains at most eight copied 16 KiB raw pages, 128 prefix checkpoints
and 256 decoded runs for each of `stts`, `ctts` and `stsc`, plus scalar cursors.
Neither sample sizes, chunk offsets, sync samples, cumulative sizes nor sorted
presentation offsets are materialized as full arrays. PCM still groups frames
into chunks without a per-chunk array.

The first packet scans run-length timing/composition/chunk mappings to build
bounded checkpoints and composition-offset bounds. Sizes, offsets and sync
sample entries are read on demand. Random seeks may scan from a checkpoint;
very wide composition-offset ranges can require scanning many candidate samples.
This deliberately trades I/O and lookup time for a retained index bounded
independently of sample count. The source cache and its prefetch/coalescing are
separate from parser pages; codec/metadata leaf boxes and encryption auxiliary
information retain their existing behavior. This is not a total-task memory cap.

Fragmented inputs also traverse `mfra` by range and retain TFRA locations instead
of decoded entry arrays. Each track caches at most four copied 16 KiB TFRA pages.
First index use validates ordering in a paged streaming pass; ordered tables use
binary search, while unordered tables use streaming lookup without a sorted copy.
Equal timestamps keep the first valid entry, and zero sample/run references are
skipped. Raw input cache prefetch/coalescing remains independent of these pages.

Per-track timestamp hints and cumulative decode-time anchors are each bounded to
128 records; the shared fragment-summary cache retains at most 128 records.
These caches refresh on reuse and evict the least recently accessed record.
Missing `tfdt` is recovered from an exact TFRA sample reference or by rescanning
a contiguous prefix from a retained decode anchor (or the init boundary). Decode
end time is kept separately from presentation end time, preserving B-frame and
composition-offset timing after eviction. Fragment parsing, time recovery and
publication are serialized; failed reads never publish an incomplete fragment.
A completed fragment and its bounded pages can still be retained by caller-held
packets. Output indexes use the separate disk store described above.

A single input `moof/traf` is now traversed by range as well. `trun` rows stay on
the source; fixed header reads replace whole-moof buffering. Each track fragment
keeps four copied 16 KiB raw pages, 128 adaptive summaries, 256 raw records and
512 computed durations. There are no per-sample arrays, run-count lists or full
presentation sorts. First access streams summaries, with arithmetic accumulation
for default-only runs. Ordered PTS supports binary lookup; reordered lookup scans
candidate blocks, computing duration windows of 256 samples. Stable PTS ties,
signed composition offsets, first-sample flags, implicit/absolute offsets and
TFRA run/sample references preserve packet, duration and seek behavior. The old
2^20 sample rejection is removed; extents and safe integer totals are validated.

Fragment `senc` and `saiz/saio` also retain locations instead of IV/size arrays.
IV and subsample data are read per requested packet; variable-size information
uses at most 128 offset checkpoints. Metadata-only queries skip encryption reads.
These bounds trade CPU and I/O for retained memory; arbitrary reordering may
require repeated block scans. Individual/caller-held packets, per-packet
subsamples, track count, source caches, codec/other leaf boxes and ordinary-MP4
encryption auxiliary tables retain separate costs. This is not a total-process
or peak-memory limit.

Async traversal is serialized because the parser has shared track/fragment
state. Concurrent callers share track initialization; cancellation and I/O errors
propagate and failed table initialization can be retried. Sparse >4 GiB `moov`,
all table encodings/page boundaries, packet/seek results, concurrent tracks,
malformed tables, disposal, eviction/rereads, multi-sample chunks, signed CTTS,
presentation ties, PCM, isolated retained-heap/buffer growth, real Blob remux
reads and both CommonJS entrypoints
are covered in `tests/downloads/mp4Input.test.ts`. Fragmented inputs are covered
by `tests/downloads/mp4Fragments.test.ts` and isolated fragment-memory fixtures.
Single-moof samples, reordered/tied durations, many runs, default-only billions
of samples, extended sizes, encryption, failure/retry/disposal, both CommonJS
bundles and isolated retained heap/buffers are covered in
`tests/downloads/mp4Moof.test.ts` and `tests/fixtures/downloads/mp4MoofMemory.ts`.
Output spooling, byte parity, page boundaries, 64-bit fields, failure/cancellation,
CommonJS bundles and retained heap/buffer growth (including finalization) are
covered by `tests/downloads/mp4OutputIndex.test.ts` and
`tests/downloads/fragmentIndex.test.ts`.
Long-GOP media spooling, reuse, B-frame byte/seek parity, bounded payload buffers,
large MDAT/base offsets, error/cancellation and both CommonJS bundles are covered
by `tests/downloads/mp4FragmentMedia.test.ts` and
`tests/downloads/fragmentMedia.test.ts`.
Paged GOP records, external timestamp sorting, byte parity, queued tails,
partial I/O, errors/cancellation, large fragment offsets and isolated retained
heap/buffers during append/sort/write are covered by
`tests/downloads/fragmentSamples.test.ts` and
`tests/downloads/mp4FragmentSamples.test.ts`.

Source, ESM, declarations and CommonJS entrypoints are patched. Keep the exact patched version
when updating dependencies, and remove the patch once upstream implements these
changes. Packet/timestamp, multi-fragment seeking and isolated retained-heap tests
cover the behavior. No upstream issue or pull request has been submitted.
