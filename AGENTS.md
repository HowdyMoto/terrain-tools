# Repository Guidelines

## Project Structure & Module Organization

Terrain Studio is a TypeScript/Three.js terrain library and local browser editor. Its public MIT-licensed repository is `HowdyMoto/terrain-tools` on GitHub.

- `src/core/`: engine-independent terrain, authoring, history and serialization.
- `src/runtime/`, `src/render/`, `src/physics/`: reusable runtime, editor rendering and optional Rapier integration.
- `src/editor/` and `src/main.ts`: authoring controls and application entry point.
- `tests/`: Vitest core/runtime/physics tests; `tests/browser/`: Playwright integration tests.
- `examples/`, `public/`: integration examples and reference assets.
- `docs/`: usage guides, architecture, roadmap and measured evidence.
- `scripts/`: reproducible asset builders and benchmarks.
- `lib/`, `dist/`, `.qa/`, `test-results/`: generated outputs and local verification artifacts; do not treat them as source.

Create directories only when needed. Keep `README.md` entry points and `docs/ROADMAP.md` status accurate; passing tests do not establish production readiness.

## Build, Test, and Development Commands

Requires Node.js 22.12+ (Node 24 is used for development), npm, and native WebGPU in Chrome/Edge for the editor and interactive examples. Three 0.186.1, @types/three 0.186.0 and @webgpu/types 0.1.64 are pinned; see README.md for dependency upgrade commands. Install locked dependencies with `npm ci`.

- `npm run dev`: start the local Vite editor; `/runtime.html` is the integration example.
- `/world.html`: the streamed 2 × 2 km reference with shared compressed assets and optional Rapier integration.
- `npm run build:assets:runtime`: rebuild the bundled Meshopt/KTX2 pack from checked-in derivatives using pinned WASM/Node tools; ordinary builds do not encode assets.
- `npm run benchmark:world`: sustained 1080p traversal/teleport benchmark after building; requires the RTX 5060 unless explicitly passed `--allow-other-gpu`.
- `npm run typecheck`: strict TypeScript checks.
- `npm run lint`: ESLint recommended JavaScript/TypeScript checks for production code in `src/`; Prettier handles formatting.
- `npm test`: full Vitest suite.
- `npm test -- tests/runtime.test.ts`: one test file; append `-t "test name"` to select a test.
- `npm run build`: check types, build the runtime/declarations into `lib/`, and build the editor/examples into `dist/`.
- `npm run build:assets:foliage`: rebuild bundled CC0 GLBs from the local original collection and alpha masks; uses pinned meshoptimizer/sharp dev dependencies. Ordinary builds use the prepared assets. See `docs/FOLIAGE-ASSETS.md`.
- `npm run test:browser`: Playwright against the production build (run `npm run build` first).
- `npm run test:browser -- tests/browser/settings-recovery.spec.mjs`: one browser test file.
- `npm run test:browser -- tests/browser/webgpu.spec.mjs tests/browser/webgpu-world.spec.mjs`: native shader, PBR export and prepared-world checks.
- `npm run format` / `npm run format:check`: write/check Prettier formatting.

Browser tests use installed Google Chrome on Windows and port 5175. `scripts/chrome-gpu.mjs` reads DXGI adapters through built-in PowerShell/.NET and selects the RTX 5060 when present for the temporary test profile; it does not change user graphics settings. See `playwright.config.ts` before running on another platform. Benchmark commands and their required builds are documented in `README.md`.

When selecting a toolchain, document exact dependency installation, local execution, build, and test commands in `README.md`. Commit the appropriate dependency manifest and lockfile, and update this guide with verified commands.

## Coding Style & Naming Conventions

Use TypeScript with strict checks, two-space indentation, single quotes and trailing commas as configured in `.prettierrc.json`. Keep public APIs typed and optional physics dependencies lazy-loaded. ESLint 10 with typescript-eslint checks production TypeScript through `npm run lint`; test and build-script lint coverage is not yet configured. Avoid mixing tabs and spaces.

Choose descriptive names that reflect each module's responsibility. Keep functions focused and document public interfaces, units, and assumptions when they affect results.

## Testing Guidelines

Vitest covers core/runtime behavior and actual Rapier simulations. Playwright covers rendered authoring, persistence, export and recovery in Chrome. No coverage threshold is configured.

Use descriptive test names covering expected behavior, boundary conditions, and invalid inputs. Add regression tests for bug fixes. Keep fixtures small and deterministic.

For authoring changes, preserve the committed document, live resources, undo/redo and autosave when preparation fails or is cancelled. Stage fallible work before history changes. Test recovery with injected failures and a successful retry, not just the happy path. Report browser/device and realistic-asset validation limits explicitly.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects, for example `Add terrain input validation`, and keep each commit focused. Keep original foliage downloads, personal content projects, generated builds and local verification artifacts out of Git; prepared runtime assets and their credits are tracked.

Pull requests should explain the change, its purpose, and validation performed. Link relevant issues and include screenshots for visual changes. State any checks that could not run and update documentation when setup or behavior changes.
