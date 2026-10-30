# Browser performance baseline

Measured 2026-10-30 on an Apple M1 Pro (10 logical cores, 16 GiB RAM), headless Chromium 151.0.0.0. These are local development measurements, not a cross-device guarantee.

Each case ran serially three times through `runMediaJob`, with both input and output backed by OPFS. The timer includes Worker startup, metadata inspection, packet copying, sorting, output finalization, and spool cleanup. Fetching/staging inputs and deleting the retained output are excluded. Files and browser modules were warm in the operating-system/browser caches; this does not measure cold-storage bandwidth or physical durable-write latency. Peak Worker/process memory was not measured.

## Results

Both inputs contain 150 seconds of 1280×720, 30 fps H.264 with B frames and 48 kHz AAC. Each has 4,500 video frames; the normal case has 75 keyframes, the long-GOP case one keyframe. The latter exceeds the 4,096-timestamp in-memory sorting run and exercises disk sorting.

| Input           |      Size | Three elapsed times      |   Median | Median throughput |
| --------------- | --------: | ------------------------ | -------: | ----------------: |
| Normal, GOP 60  | 160.9 MiB | 711.5 / 745.6 / 764.2 ms | 745.6 ms |       215.9 MiB/s |
| Single GOP 4500 | 159.3 MiB | 814.1 / 753.2 / 768.9 ms | 768.9 ms |       207.2 MiB/s |

Normal-input inspection took 63.9–65.5 ms and finalization 12.1–16.2 ms. The single-GOP input used 62.7–63.7 ms for inspection and 370.7–408.0 ms for finalization: the last fragment's sorting and spool writes occur there. Long GOPs shift more work to the end, so packet-copy progress alone does not represent remaining time.

Encoded bytes are copied rather than re-encoded. The important variables are input size, number of samples, table shape, GOP size, disk/cache behavior, and available quota. A high-bitrate file can show higher MiB/s than a small low-bitrate file with the same packet count. Do not extrapolate these ~160 MiB results linearly to multi-gigabyte inputs, low-end devices, other browsers, or sustained cold disk I/O. Multi-gigabyte process memory and long-run sustained throughput still need measurement.

## Reproduce

Build the package, serve the repository using a local static server, then open `tests/browser/benchmark.html`. Select files and run the benchmark. The page stages each input into OPFS before timing and disposes all benchmark outputs and staged inputs afterward. Use the browser integration page separately for output/cleanup correctness.

The measured fixtures were generated with FFmpeg (not shipped in this package):

```sh
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 150 \
  -c:v libx264 -threads 2 -preset ultrafast -crf 18 -g 60 -bf 2 \
  -c:a aac -movflags +faststart normal.mp4
```

Use `-g 4500` for the long-GOP fixture. Use `ffprobe` to confirm the actual keyframe count; encoder settings/content can affect it. These synthetic files are not committed to the repository.
