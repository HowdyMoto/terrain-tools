# Performance evidence

## Streamed world and prepared assets

Build with `npm ci` and `npm run build`, then run `npm run benchmark:world`. The production `/world.html` example covers 2 × 2 km using 250 m tiles with 128 cells per side. Three 36-second laps traverse forest, open ground and coast at 20 m/s with teleports between regions. It enables Rapier terrain collision, three 2048-pixel shadow cascades, ambient occlusion and temporal AA. At most 12 tiles reside at once; two prepare concurrently. Heights and plant placement are deterministic procedural inputs, with five prepared CC0 plant GLBs and eight shared ground materials. This is a repeatable integration scene, not a calibrated photorealistic forest.

Current 1080p captures: [forest](benchmarks/world-forest-2026-10-19.png) and [coast](benchmarks/world-coast-2026-10-19.png). They show the present sparse understory, repeated ground detail and approximate shallow caustics. Finite ocean patches can expose boundary artifacts; global hydrology and seamless distant ocean presentation are not established by the terrain seam tests.

The [1080p RTX 5060 Laptop report](benchmarks/world-streaming-2026-10-19.json) records Chrome 155.0.8059.82 / ANGLE D3D11, frame cadence, CPU update/render submission, asynchronous GPU timers, tile load times, long tasks and residency snapshots. Screenshots are taken outside the timed interval. `--quick` is a smoke run; `--full-detail` disables terrain LOD for comparison. The 30 FPS acceptance flag requires frame-time p95 ≤ 33.5 ms and no rendering/load failures. A correctness pass alone does not imply that flag passes. Run this separately from other benchmarks, browser tests and asset encoders.

The final 4,177-frame run had no rendering/load errors but **failed the steady 30 FPS target**. Frame p50/p95/p99/max were 16.7/50.1/149.9/633.3 ms. CPU update/submission p95 was 44.1 ms and render GPU p95 was 32.7 ms. Tile preparation p50/p95 were 580.8/1,443.0 ms, including initial loads and time waiting on concurrent work; the measured interval contained 225 long tasks. An earlier three-lap run similarly measured frame p95 at 50.0 ms. This exposes real streaming/shader/upload stalls and substantial forest draw costs; it does not establish CryEngine-level fidelity or smooth traversal. An upload scheduler and distant vegetation work remain necessary.

Residency stayed at or below 12 tiles. Conservative per-tile CPU/GPU sums peaked at 487,624,680 / 476,805,624 bytes under their separate 768 MiB limits. Unique shared assets settled at 100,435,778 CPU bytes (including 50,964,564 encoded-string bytes) and 50,869,316 estimated GPU bytes. Peak registry staging reservation was 221,829,716 bytes, with 58,407,992 bytes of peak hash scratch reported separately; both remain under the shared 512 MiB preparation ceiling. Main-thread heap peaked at 637,255,806 bytes and varied with garbage collection; this is not a whole-process measurement. Teardown returned resident tiles, registry bytes/leases/pending requests and renderer texture/geometry counts to zero. Pressure/cancellation tests separately verify active leases survive failed admissions and unleased entries expire. These finite runs establish bounded tested residency and successful cleanup, not proof against every long-session leak.

Terrain detail is also measured in an isolated 1920 × 1080, two-tile normal-shaded fixture with 25 frames per mode. LOD selected 4,536 triangles versus 65,536 at full detail; median GPU time was 0.109 versus 0.223 ms, and CPU submission was 0.60 versus 0.40 ms. No shared-edge background pixels were detected. Mean maximum-channel difference was 0.326/255, with 0.00121% of pixels differing by more than eight levels. These small timings are sensitive to warmup and scheduling; they demonstrate reduced geometry/GPU work, not whole-forest frame rate. Unit tests separately verify boundary normals, hole topology, full-resolution collision and settling after near/far teleports. See [raw LOD comparison](benchmarks/world-lod-2026-10-19.json).

`npm run build:assets:runtime -- .qa/runtime-assets-repeat` rebuilds the sample pack offline. All 14 output files, including its metadata, matched byte-for-byte across two builds ([reproducibility](benchmarks/runtime-assets-reproducibility-2026-10-19.json)). The recorded preparation took 401.9 seconds; this wall-clock result includes machine contention and is not an encoder throughput guarantee. The five quality-oriented UASTC/Meshopt GLBs total 19,111,596 download bytes versus 10,038,176 source bytes; compression here reduces GPU residency, not download size. Their estimated BC7 texture storage is 24,118,128 bytes. The four eight-layer terrain arrays download 3,553,166 bytes and retain 11,185,664 CPU/GPU bytes on this adapter. Source hashes, bounds, collision-input references, authors and licenses are in `public/runtime-assets/manifest.json`. The ground images are generated sample artwork, not CC0 photogrammetry. See [preparation report](benchmarks/runtime-assets-preparation-2026-10-19.json).

The [GPU readback comparisons](benchmarks/runtime-assets-quality-2026-10-19.json) measured albedo/normal/height PSNR of 45.4/52.6/59.8 dB and exact ORM samples. Fern color PSNR was 53.0 dB; alpha coverage at the 0.5 cutout threshold changed by 0.037% of pixels. Quantized geometry bounds differed by less than 0.000009 m. The fern's estimated GPU bytes fell from 16,804,034 to 4,209,968; prepared decoded CPU bytes were also 4,209,968. These are texture/geometry fixtures, not every imported asset or view distance. Browser checks cover shared palettes, compressed import preview, cancellation, failed load/retry, undo/redo, autosave reload and standard GLB presentation export.

GitHub Actions runs locked installation, lint, unit tests, type/build checks and browser correctness on Linux Chromium with software rendering. Hardware performance remains a separate Windows/RTX measurement. Driver allocations, shaders, browser workers and host source documents are outside the residency counters. Per-tile estimates conservatively count some shared data again; do not sum them with the unique asset registry as exact process memory. Main-thread JavaScript heap is sampled separately and can rise between garbage collections. Residency limits protect reported resources and reservations; they are not an operating-system memory cap.

## Forest rendering on the RTX 5060

Build with `npm run build:runtime`, then run `node scripts/benchmark-forest.mjs "C:/path/to/content-project/exports/scene.terrain" .qa/forest-render.json`. The native document and its parent folder's `content-manifest.json` stay outside the source tree. The manifest needs `viewpoints.original` or `viewpoints.trail`, each with three-number `position` and `target` arrays. An optional third argument selects another runtime directory within the workspace. No additional dependencies or running editor server are needed beyond `npm ci` and installed Windows Chrome.

The harness checks the actual NVIDIA RTX 5060 adapter, uses 1920 × 1080 at device scale 1, warms up 160 rendered frames, then measures 240 frames along a repeating short camera path at FOV 75. It preserves the authored lighting, shadows, foliage, terrain-following eye offset and fixed simulation steps. One unfinished GPU frame is allowed, with nonblocking checks on animation callbacks. GPU timer queries cover render-target segments and are drained before reporting; disjoint measurements fail. FPS is submission cadence, not physical display scanout. The viewpoint can differ from entering a ground-level walk in the editor. Run benchmarks separately from builds and other GPU work.

Contact shading now resolves its depth-aware upscale once and reuses its depth for the HDR beauty pass, reducing hidden-surface shading without reducing vegetation or shadow quality. Temporal detail recovery runs in the existing output pass. The GPU optimization applies to runtime hosts and the editor; walking retains the responsive one-frame scheduler. See [raw measurements, image checks and input latency](benchmarks/forest-performance-2026-10-17.json). These are bounded local scenes, not a universal frame-rate or production-readiness guarantee.

Measured on 2026-10-17 with Chrome 155 / ANGLE D3D11 on the RTX 5060 Laptop GPU. Each scene keeps three 2048 px shadow cascades, contact shading, temporal stabilization and its authored foliage:

| Scene                      | FPS before → after |  Mean GPU time before → after | Frame interval p95 before → after |
| -------------------------- | -----------------: | ----------------------------: | --------------------------------: |
| Namaqualand                |        28.6 → 29.8 | 28.65 → 24.26 ms (15.3% less) |                    50.1 → 33.4 ms |
| Pine Forest, 21,444 plants |        29.9 → 29.9 | 20.45 → 18.04 ms (11.8% less) |                    33.4 → 33.5 ms |

Pine's submission cadence stays near 30 FPS because a frame still exceeds one 60 Hz refresh interval. It gains GPU headroom, not a measured FPS increase on this path. A between-refresh timer experiment reached higher submission rates but increased input delay, so it was removed. The retained scheduler waits for the GPU and the next animation callback without queuing old camera frames.

The earlier paired run measured Namaqualand at 27.0 → 29.9 FPS with 16.3% less GPU time, and Pine at 30.0 → 29.9 FPS with 8.9% less GPU time. Another local browser-validation task was active during parts of this session, including the repeat; exact percentages are development samples with possible GPU contention. In the actual fullscreen editor walk, median handled-input-to-observed-GPU-completion stayed at 33.5 ms for both device scales (p95 about 50.2 ms), with one pending frame. Physical display latency is not measured.

## Terrain CPU updates

Command: `npm run build:runtime`, then `npm run benchmark`.

Observed on 2026-10-14 on Windows with Node 24.18.1 and an AMD Ryzen AI 7 350 CPU ([raw CPU report](benchmarks/cpu-2026-10-14.json)). Values are a development measurement, not guaranteed budgets. Local-edit medians use 12 edits with a 5 m brush positioned inside one 32-cell chunk.

| Grid      | Total chunks | Chunks updated | Full geometry build | Local geometry median | Full collider build | Local collider median |
| --------- | -----------: | -------------: | ------------------: | --------------------: | ------------------: | --------------------: |
| 256 × 256 |           64 |              1 |            274.8 ms |               2.84 ms |            211.0 ms |               2.76 ms |
| 512 × 512 |          256 |              1 |            682.7 ms |               3.70 ms |           1017.0 ms |               2.91 ms |

A separate 50,000-instance contact benchmark built 256 foliage batches in 660.3 ms and measured 0.086 ms median CPU contact/matrix update time over 120 steps. Only instances within a 4 m contact region and active recovery state require matrix updates.

These timings exclude GPU rendering, asset decode, texture upload, editor history snapshots, IndexedDB autosave, and frame scheduling. They do not establish an end-to-end 60 FPS budget, nor a large-world streaming guarantee. Brushes spanning chunk boundaries update multiple chunks; larger brushes and more contacts increase work. Imported mesh complexity and shadow cost require browser/GPU benchmarks with representative assets.

## Surface texture variation

Run `npm run build:runtime`, then `npm run benchmark:surfaces -- --resolution=1024 --samples=30`. The CLI serves local library modules and the checked-in reference package through intercepted browser requests; no running server or external assets are required. It writes timings and comparison renders into `test-results/`.

Measured on 2026-10-15 with Chrome 155, ANGLE/D3D11, and an AMD Radeon 860M. The 960 × 540 buffer uses pixel ratio 1, no antialiasing or shadows, the reference terrain’s generated color maps plus procedural surface detail, and 1024² arrays. Foliage and props are omitted to isolate surface cost. Every phase has eight warm-up frames and 30 measurements; a reverse-order pass exposes order effects.

| Varied layers | GPU median, forward / reverse | GPU p95, forward / reverse |
| ------------- | ----------------------------: | -------------------------: |
| None          |                1.27 / 1.43 ms |             1.72 / 1.77 ms |
| Meadow only   |                2.09 / 1.91 ms |             2.59 / 2.27 ms |
| All four      |                4.08 / 4.17 ms |             4.61 / 4.66 ms |

All six phases returned 30 valid timer-query samples without disjoint events. Geometry remained 32,768 triangles in 16 draw calls, and GPU texture count stayed at four. The shader evaluates all four layers; enabling variation on an unused layer still adds work. The option therefore remains off by default. The raw report also includes blocking times that synchronize/read back the GPU; those are not interactive FPS.

[Raw surface report](benchmarks/surface-variation-1024-2026-10-15.json). These results cover one integrated GPU, fixed camera, and reference surface set. They do not establish a production budget, mobile behavior, 1080p/4K cost, or complete-scene performance with foliage, shadows, editing, and exports.

## Browser foliage rendering

Build first, then run `npm run benchmark:foliage -- --count=50000` and optionally add `--shadows`. The same comparison is available interactively at `/foliage-benchmark.html`.

Measured on 2026-10-14 with Chrome 155, ANGLE/D3D11, and an AMD Radeon 860M. Each mode uses 30 measured frames after eight warm-up frames, a 960 × 540 drawing buffer at pixel ratio 1, no antialiasing, a moving camera, and active wind. The scene has 50,000 procedural pines on a flat 512 m terrain. Detail mode uses the 28-triangle pine at 80 m, 60% retained density, a 260 m cutoff, and 10% hysteresis.

| Shadows       | Detail mode  | GPU median / p95 | Blocking frame median / p95 | Selection/update CPU median / p95 |
| ------------- | ------------ | ---------------- | --------------------------- | --------------------------------- |
| Off           | Full         | 5.37 / 6.08 ms   | 11.2 / 14.0 ms              | 0.0 / 0.1 ms                      |
| Off           | Distance LOD | 1.20 / 1.72 ms   | 7.3 / 12.5 ms               | 0.9 / 1.5 ms                      |
| 1024² sun map | Full         | 11.78 / 13.63 ms | 17.0 / 21.3 ms              | 0.0 / 0.1 ms                      |
| 1024² sun map | Distance LOD | 2.32 / 3.27 ms   | 9.2 / 12.9 ms               | 0.9 / 1.6 ms                      |

GPU values use `EXT_disjoint_timer_query_webgl2`; all 30 samples in each mode were valid with no disjoint event. Blocking-frame values include a synchronous one-pixel readback to wait for rendering completion. They include readback overhead and are **not interactive FPS**. CPU update values include wind/contact bookkeeping as well as distance selection.

The median main-pass count fell from 3,671,858 to 328,752 triangles and from 452 to 180 draw calls. These renderer counters exclude the shadow pass; GPU timing includes it. Detail mode ended with 12,153 instances selected before frustum culling, while the full authored population remained 50,000.

The exact motion cache skips a tile only when camera travel cannot cross any instance's next hysteresis boundary. Stationary cameras reuse the previous selection; teleports and edited terrain anchors re-evaluate it. A reference test checks cached results against a complete per-instance scan through motion and teleports. Packed draw buffers change only for tiles with changed selection.

[Raw measurement without shadows](benchmarks/foliage-50000-2026-10-14.json) · [Raw measurement with shadows](benchmarks/foliage-50000-shadows-2026-10-14.json)

These measurements demonstrate a reduction on this hardware and scene. Procedural opaque pines do not represent production foliage cards, expensive imported materials, large textures, or a complete game. Camera speed, LOD thresholds, mesh complexity, density, shadow resolution, and driver load affect both CPU and GPU cost. Asset preparation, editor history/autosave, asset streaming, cross-fades, and target-platform game budgets require separate validation.

## Flexibility mask costs

Per-vertex masks add a four-float attribute (16 bytes per vertex) for each prepared mesh/mask variant. Tiles share this vertex storage. Each masked batch owns a one-float contact buffer (4 bytes per allocated instance per mesh part/LOD), and each tile retains contact values for hidden instances. Contact-only updates upload the scalar instead of rebuilding instance transforms. Pending upload ranges collapse to a complete buffer update after 64 ranges, keeping metadata bounded while frustum culling delays rendering.

Masked shaders calculate per-vertex contact bending, wind, and a deformation Jacobian for normals. The earlier GPU table uses whole-plant response and predates these masks and the revised conservative deformation bounds. It does not measure masked-shader cost. Run fresh measurements on the target device with representative meshes, masks, materials, and shadows before choosing a production budget. The deterministic browser rendering check verifies rigid/flexible pixels, recovery, directional/point-shadow changes, and GPU derivatives; it is a correctness fixture rather than a performance benchmark.

## Cross-fade costs

Add `--fade=0.25` to `npm run benchmark:foliage -- --count=50000 --shadows` to compare full detail, instant distance selection, and 0.25-second cross-fades on the same camera path. The interactive benchmark also has a duration control. Zero omits the cross-fade phase. Reports include the number of plants transitioning, submitted representations, and the CPU cost of preparing fade-enabled batches outside the measured frames.

Measured on 2026-10-14 with Chrome 155 and the AMD Radeon 860M, using the same 50,000-pine scene, 1024² sun map, eight warm-up frames, and 30 measured frames per mode ([raw cross-fade report](benchmarks/foliage-crossfade-50000-shadows-2026-10-14.json)):

| Detail mode          | GPU median / p95 | Blocking frame median / p95 | Selection/update CPU median / p95 | Transitioning plants median / p95 |
| -------------------- | ---------------- | --------------------------- | --------------------------------- | --------------------------------- |
| Full                 | 4.67 / 5.52 ms   | 7.2 / 8.2 ms                | 0.0 / 0.1 ms                      | 0 / 0                             |
| Instant distance LOD | 1.13 / 1.99 ms   | 4.0 / 6.2 ms                | 0.4 / 0.7 ms                      | 0 / 0                             |
| 0.25 s cross-fade    | 1.38 / 2.72 ms   | 4.9 / 7.4 ms                | 0.6 / 1.2 ms                      | 226 / 482                         |

All 90 GPU queries were valid without a disjoint event. Median main-pass geometry increased from 309,634 to 317,416 triangles with fades; median draw calls stayed at 168. Fade-enabled batch preparation took 84.4 ms outside the measured frames. Compare modes within this run: the earlier table was recorded under different system load and is not a before/after optimization comparison. Blocking times include readback, and this fixture uses opaque procedural pines without flexibility masks.

Transition state keeps two float weight arrays, a timestamp, and a target per plant: `8 × levelCount + 9` bytes per instance in typed buffers, excluding Set/object overhead. Each batch adds 12 bytes per allocated instance for coverage bounds and a stable seed. Model vertex/index data remains shared. Only active transitions update coverage; settled tiles use the ordinary wind/material shader. Each tile switches to the cached dither variant when needed, and back after its final transition completes.

Long fades and rapid camera changes retain more geometry. Up to four visible LODs can overlap after repeated retargeting. First-use shader compilation, large teleports, detailed alpha cards, and target-game frame budgets need separate measurements; the moving-camera procedural fixture is not a worst-case guarantee.

## Background save responsiveness

Run `npm run build`, then `npm run benchmark:persistence -- --assets=48`, or open `/persistence-benchmark.html`. The comparison encodes a 512-cell terrain, 50,000 foliage records, and two synthetic model payloads totalling 48 MiB. It does not render or decode those assets. The resulting package is 60,122,140 bytes.

Recorded on Windows/Chrome 155 at 2026-10-15 00:17 UTC ([raw report](benchmarks/persistence-48mib-2026-10-15.json)):

| Save     | Main-thread encoder: call / total | Background encoder: call / total | Animation frames during encoding: main / background |
| -------- | --------------------------------- | -------------------------------- | --------------------------------------------------- |
| First    | 288.0 / 288.0 ms                  | 15.4 / 310.7 ms                  | 0 / 17                                              |
| Cached 1 | 86.2 / 86.2 ms                    | 26.0 / 111.6 ms                  | 0 / 6                                               |
| Cached 2 | 77.0 / 77.0 ms                    | 2.2 / 80.7 ms                    | 0 / 5                                               |

“Call” measures synchronous main-thread work before the operation returns; “total” includes waiting for the completed Blob. Background work improves responsiveness while adding worker startup, transfer, and reconstruction overhead. The largest animation-frame gaps were 292.4 / 86.8 / 77.7 ms for the synchronous path and 18.4 / 26.4 / 18.0 ms for the background path. All three pairs produced matching byte lengths and package checksums.

Common foliage records transfer as Float64 numeric buffers and indexed brush/model names. Records with extra fields or a nonstandard property order preserve the generic cloning path. Unchanged referenced assets stay in the worker cache; removed assets are pruned. The editor bounds pending snapshots and coalesces autosaves, while explicit file requests preserve the clicked state.

This is three development measurements, not a frame-budget guarantee. Capture, first payload transfer, worker startup, and encoding are included. Scene rendering, model/texture decode, history, IndexedDB writes, file downloads, and GLB presentation export are excluded. Browser scheduling and garbage collection can still cause pauses, as the first cached background sample shows. The worker retains a copy of current asset strings and encoded Blobs, and pending snapshots consume additional memory; the measurement does not establish a process-memory budget. See [background encoding and queue semantics](PROJECT-FILES.md#background-encoding).

## History retention and restore costs

Run `npm run build:runtime`, then `npm run benchmark:history`. The benchmark runs the former full-copy implementation and the shared implementation in separate Node processes with forced garbage collection. Each retains 24 checkpoints on a 512 × 512-cell terrain with 50,000 plants and 6,990,638 characters of synthetic embedded model/map payloads. Each checkpoint is followed by one local height change. The fixture measures payload retention; its synthetic assets are not renderable.

Measured on 2026-10-14 with Node 24.18.1 and the Windows/AMD CPU listed above ([raw history report](benchmarks/history-2026-10-14.json)):

| Implementation   | Retained heap delta | Retained ArrayBuffer delta | Checkpoint median | First checkpoint |     Undo / redo |
| ---------------- | ------------------: | -------------------------: | ----------------: | ---------------: | --------------: |
| Full copies      |           312.0 MiB |                  125.5 MiB |           58.4 ms |          73.7 ms |  57.8 / 64.4 ms |
| Shared snapshots |            28.1 MiB |                    5.7 MiB |           15.8 ms |         122.3 ms | 102.6 / 93.3 ms |

Combined measured retention fell from 437.5 to 33.8 MiB, about 92%. Unchanged plants and embedded strings are reused; local terrain changes retain only changed 64 KiB blocks. The first checkpoint constructs the snapshot graph. Undo and redo reconstruct an independent editable project and are slower in this measurement. These timings exclude asset decoding, scene/physics rebuilding, autosave, rendering, and live-project allocation; they are not end-to-end input latency or frame-rate measurements. Garbage collection and allocator timing affect memory deltas.

The editor defaults to 64 total undo/redo states and an estimated 256 MiB retained-data budget. This comparison uses 24 states to match the prior implementation. The shared estimate was 36.6 MiB before clearing and zero afterward. That accounting includes conservative payload/metadata estimates and history entries; it is separate from the measured process-memory deltas. Distant states expire when either limit is exceeded. One available state is kept even when oversized, and temporary restore candidates and GPU resources are outside the budget.

## Erosion processing

Run `npm run build:runtime`, then `npm run benchmark:erosion`. On the same Windows/Node/CPU environment, one calculation on a 192 m Alpine terrain with seed 42, two droplets per cell, a two-cell kernel, up to 64 steps, and 12 thermal passes measured:

| Grid      | CPU calculation |
| --------- | --------------: |
| 128 × 128 |          0.71 s |
| 256 × 256 |          3.89 s |
| 512 × 512 |         24.16 s |

These are single development measurements, excluding worker startup, rendering, collision, and editor refresh. Longer-lived droplets, wider kernels, more rainfall, and more thermal passes increase cost. The editor computes on a disposable worker and reports progress; browser tests verify cancelling a live 512-cell job and starting a subsequent job. This is an offline authoring operation, not a per-frame runtime effect.

## Reversible edit preview

Run `npm run benchmark:edit-preview -- --count=50000 --samples=7` after a runtime build. The benchmark measures candidate-buffer copying, retained scene preparation and rollback on a 128-cell, 192 m flat terrain with procedural grass. On Node 24.18.1 and the Ryzen AI 7 350, one warmup followed by seven samples measured:

| Plants | Buffer-copy median | Preparation median | Rollback median | Extra array-buffer bytes |
| -----: | -----------------: | -----------------: | --------------: | -----------------------: |
|  5,263 |            0.11 ms |            8.03 ms |         0.07 ms |     1,118,154 (1.07 MiB) |
| 50,000 |            0.19 ms |           48.50 ms |         0.12 ms |     7,649,756 (7.30 MiB) |

The array-buffer counter returned to its baseline in every sample after rollback, a task yield and explicit garbage collection. JavaScript object/string overhead, GPU allocation/upload, actual sculpting, history capture, collider construction, autosave and frame scheduling are excluded. Retained foliage also advances off-screen during an active stroke to preserve animation and recovery continuity; that ongoing cost is not measured here. These results are a bounded CPU fixture, not an end-to-end brush latency or process-memory budget. The 50,000-plant preparation time is still a visible stroke-start cost to reduce. Imported/masked/LOD-rich populations need separate measurements.

Raw results: [5,263 plants](benchmarks/edit-preview-5263-2026-10-15.json) and [50,000 plants](benchmarks/edit-preview-50000-2026-10-15.json).

Surface tint, shading sliders, normal convention and repetition changes retain texture arrays and all spatial geometry. Map changes replace texture arrays only; altitude/slope rules, feathering and paint clearing prepare terrain/picking buffers but retain plants, props and colliders. Surface drafts copy four layer records and view settings rather than the full terrain or instance arrays. Browser allocation probes verify these paths; they are not a large-scene latency or GPU-upload benchmark.

Foliage names and future-placement controls (probability, scale/yaw ranges, density, spacing and allowed surfaces) retain the current draw buffers. They still copy brush/instance records and capture history. The recovery tests verify that probability editing succeeds while draw-buffer allocation is blocked; this is not a latency measurement for large populations. Visual response/detail changes, population and clearing prepare replacement foliage buffers.
