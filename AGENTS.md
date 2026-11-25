# Repository Guidelines

## Project Structure

- `src/index.ts` exports the public remuxing and browser APIs. `src/worker.ts` is the separate Worker entry point.
- `src/core/` handles remuxing, track combining, segment concatenation, and audio normalization. Format-specific readers live in `src/core/input/`.
- `src/browser/` owns the Worker client and protocol. `src/storage/` defines disk-backed fragment stores and their Origin Private File System (OPFS) adapters.
- `src/vendor/mediabunny/` contains patched upstream sources. Preserve license headers and consult `MIGRATION.md` there before changing the vendored code.
- `tests/input/` covers input readers and lifecycle, `tests/mp4/` covers MP4 boxes, tracks, and codecs, and `tests/remux/` covers the public APIs, timeline handling, and audio normalization.
- `tests/output/` covers muxer timing and stream lifecycle, `tests/storage/` covers disk-backed fragment stores, and `tests/browser/` holds Worker tests and the browser harness.
- `tests/helpers/` holds shared test utilities and `tests/fixtures/` holds sample media.

## Build, Test, and Development Commands

Use a Node version supported by `package.json` and the pinned pnpm version.

- `pnpm install --frozen-lockfile` installs dependencies from the lockfile.
- `pnpm build` bundles both entry points and emits TypeScript declarations in `dist/`. `pnpm dev` rebuilds on changes.
- `pnpm release:check` runs formatting, lint, type checking, and Vitest. Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, or `pnpm test` individually when iterating.
- `pnpm build && pnpm test:browser` runs the Playwright integration suite with Google Chrome. CI runs it on macOS. For interactive checks, serve the repository locally and open `tests/browser/index.html`.

## Coding Style and Naming

Follow strict TypeScript and ESM conventions. Use two spaces, single quotes, LF endings, trailing commas where supported, and omit semicolons. Use camelCase for source modules and PascalCase for class modules, such as `CustomSource.ts`. Run `pnpm format` for Oxfmt and `pnpm lint` for Oxlint. Both tools exclude vendored sources, which still undergo type checking.

### JSDoc

- In `src/` outside `src/vendor/`, document every top-level function, constant, and type declaration, including internal declarations, and every interface member. Add JSDoc directly above each declaration or member.
- Use multiline JSDoc exclusively in this scope, even for one-sentence descriptions. Put `/**` and `*/` on separate lines and prefix each body line with `*`.
- Start with a description and leave a blank JSDoc line before any tags. Use `@param` for each parameter, `@template` for generic parameters, and `@returns` for return values, including void and promises. Document generator output with `@yields` and add `@returns` when the generator returns a final value. Document applicable failure conditions with `@throws`.

## Testing Guidelines

Put regression tests in the corresponding `tests/<area>/<feature>.test.ts` suite. Run a focused suite with `pnpm test tests/remux/api.test.ts` or run a whole area with `pnpm test tests/mp4/`. Reuse small fixtures and document generation commands for new fixtures in `tests/fixtures/README.md`. Install FFmpeg to enable the optional independent decode check. Run browser coverage for changes to Worker, OPFS, playback, or native AAC behavior.

## Commits and Pull Requests

Use the short, imperative Conventional Commit style seen in history, such as `feat: support MPEG-TS input`. In pull requests, summarize the change and its impact, link related issues, and report the checks you ran. Include reproduction details for media-specific bugs.
