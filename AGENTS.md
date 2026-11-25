# Repository Guidelines

## Project Structure

- `src/index.ts` exports the public remuxing and browser APIs. `src/worker.ts` is the separate Worker entry point.
- `src/core/` handles remuxing, track combining, segment concatenation, and audio normalization. Format-specific readers live in `src/core/input/`.
- `src/browser/` owns the Worker client and protocol. `src/storage/` defines disk-backed fragment stores and their Origin Private File System (OPFS) adapters.
- `src/vendor/mediabunny/` contains patched upstream sources. Preserve license headers and consult `MIGRATION.md` there before changing the vendored code.
- `tests/` holds Vitest suites, `tests/helpers/` holds shared test utilities, `tests/fixtures/` holds sample media, and `tests/browser/` holds the browser harness.

## Build, Test, and Development Commands

Use a Node version supported by `package.json` and the pinned pnpm version.

- `pnpm install --frozen-lockfile` installs dependencies from the lockfile.
- `pnpm build` bundles both entry points and emits TypeScript declarations in `dist/`. `pnpm dev` rebuilds on changes.
- `pnpm release:check` runs formatting, lint, type checking, and Vitest. Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, or `pnpm test` individually when iterating.
- `pnpm build && pnpm test:browser` runs the Playwright integration suite with Google Chrome. CI runs it on macOS. For interactive checks, serve the repository locally and open `tests/browser/index.html`.

## Coding Style and Naming

Follow strict TypeScript and ESM conventions. Use two spaces, single quotes, LF endings, trailing commas where supported, and omit semicolons. Use camelCase for source modules and PascalCase for class modules, such as `CustomSource.ts`. Run `pnpm format` for Oxfmt and `pnpm lint` for Oxlint. Both tools exclude vendored sources, which still undergo type checking.

## Testing Guidelines

Put regression tests in `tests/<feature>.test.ts`. Run a focused suite with `pnpm test tests/remux.test.ts`. Reuse small fixtures and document generation commands for new fixtures in `tests/fixtures/README.md`. Install FFmpeg to enable the optional independent decode check. Run browser coverage for changes to Worker, OPFS, playback, or native AAC behavior.

## Commits and Pull Requests

Use the short, imperative Conventional Commit style seen in history, such as `feat: support MPEG-TS input`. In pull requests, summarize the change and its impact, link related issues, and report the checks you ran. Include reproduction details for media-specific bugs.
