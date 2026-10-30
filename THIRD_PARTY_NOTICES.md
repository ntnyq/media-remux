# Third-party notices

## Mediabunny 1.62.1 (modified source subset)

- Upstream: https://github.com/Vanilagy/mediabunny/tree/v1.62.1
- Copyright (c) 2026-present, Vanilagy and contributors
- License: Mozilla Public License, v. 2.0 (MPL-2.0)
- License text: `src/vendor/mediabunny/LICENSE`
- Included source: `src/vendor/mediabunny/src/` and `src/vendor/mediabunny/shared/`
- Modifications: `src/vendor/mediabunny/MIGRATION.md`

The included sources are a declaration-level dependency subset for MP4 encoded-packet input/output, incorporating the existing disk-backed MP4 patch. This package does not install, import, or require the `mediabunny` npm package. Vendor files retain their upstream copyright/license headers. Modifications remain covered by MPL-2.0. The exact modified source used to build the distributed JavaScript is included in the npm package and this repository.

Original code outside the vendor directory is licensed under the repository's MIT license. Distribution includes both licenses; package metadata states `MIT AND MPL-2.0`.

The FLV reader is an original implementation following the [Adobe Flash Video File Format Specification 10.1](https://rtmp.veriskope.com/pdf/video_file_format_spec_v10_1.pdf). No mpegts.js or FFmpeg implementation code or binaries are included. FFmpeg is an optional, independently installed test verifier.
