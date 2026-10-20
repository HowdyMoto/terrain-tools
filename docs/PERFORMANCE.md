# Performance evidence

The editor and interactive runtime examples use native WebGPU. The first optimization pass removes repeated shader construction and reduces native streaming stalls; steady 30 FPS remains a separate acceptance target. Other measurements are **WebGL baselines** unless explicitly marked otherwise. See [WebGPU scope](WEBGPU.md). `benchmark:surfaces`, `benchmark:foliage` and `benchmark-forest.mjs` still exercise explicit legacy WebGL paths.

## Generated tree impostors and streamed responsiveness — 20 October 2026

The optional **`/world.html?impostors&wide-clusters`** profile generates relightable distant pine views from the existing source model, uses two vertex-oriented cards (four triangles), and groups compatible near/intermediate draws into 128 m cells. Ordinary 64 m near grouping and default distant-only grouping remain available. Authored placements, LOD distances/densities, terrain error, lighting and shadows are unchanged; the final tree representation changes. Exports retain full primary meshes. This runtime prototype needs no new artist-authored assets; editor preview/apply controls remain #17.

The streaming work also shares Standard water graphs, retains up to 64 unused runtime programs / 8 MiB of generated source, seeds temporal history in place, yields detached foliage/collider preparation around frames, and asynchronously prepares water in its actual target/MRT/nested render context. Detailed source draw arrays allocate on first selection; admission reserves their possible growth. Decoded source/base geometry and combined draw storage remain bounded by cell/resource limits rather than fully paged per plant. The example now permits only **one unfinished composed GPU frame**. Earlier unfenced submission FPS is not directly comparable.

Final source `46f8dd6` was frozen during the sequential optimized/default/optimized traversal runs below. No local builds, tests, source edits or encoders overlapped timing. All use **Chrome 155, RTX 5060 Laptop GPU, AC power, 1920 × 1080**, the same three-lap 108-second forest/open/coast route, full-detail Rapier collision, default Natural lighting and staged water. The core renderer/runtime hash remains unchanged after adding the example's comparison links and final tests/documentation.

| Configuration                    | Average FPS | Frame p95 / p99 | Worst interval | CPU submission p95 | GPU render p95 |
| -------------------------------- | ----------: | --------------: | -------------: | -----------------: | -------------: |
| Default mesh foliage             |        34.2 |  50.1 / 50.4 ms |         183 ms |            28.7 ms |       12.22 ms |
| Impostors + 128 m groups, first  |        43.9 |  33.4 / 66.6 ms |         117 ms |            14.1 ms |       11.40 ms |
| Impostors + 128 m groups, repeat |        38.9 |  33.5 / 66.7 ms |         217 ms |            20.1 ms |       11.35 ms |

**Both optimized runs meet the reference traversal criteria: p95 ≤33.5 ms and no intervals ≥250 ms.** The default mesh configuration still misses frame p95. One default run and two optimized runs establish local profile acceptance, not a universal speedup. Loading changes resident content: average sampled residents are 10.04 default / 9.81–10.46 optimized, with a maximum of 12 and brief empty views after teleports. Optimized tile-load p95 is 728–1,120 ms, versus 987 ms default; complete tile preparation can exceed three seconds. Render timing includes the visible work during these loads. It does not certify continuously complete coverage during arbitrary teleports.

A separate loaded-and-warmed 12-second measurement per optimized view records:

| View        |  FPS | Frame p95 | CPU median | GPU median | Resident tiles |
| ----------- | ---: | --------: | ---------: | ---------: | -------------: |
| Forest      | 30.5 |   33.5 ms |     8.5 ms |   10.47 ms |              9 |
| Open ground | 50.2 |   33.4 ms |     8.3 ms |    4.52 ms |             12 |
| Coast       | 58.6 |   16.8 ms |     7.2 ms |    4.50 ms |             12 |

These fixed views have stable residents and no measured long tasks. FPS counts submissions with a bounded GPU queue, not monitor scanout. GPU render queries omit independent compute; this reference uses Standard water. The fuller external tropical composition and spectral-water quality settings need their own acceptance runs.

The pine atlas stores 40 views of sRGB albedo/coverage, numeric normal/depth and roughness/metalness/leaf mask, using **30 MiB on each of CPU and GPU**. World admission counts each borrowed atlas once; source ownership and source exports remain intact. Sampled optimized residency estimates peak around 477 MiB CPU / 440 MiB GPU, excluding driver allocations, worker heaps, host documents and post targets. Dry views now retain the four-attachment opaque capture and blit to avoid changing shader context when water appears; its additional attachments/depth reserve about 71.2 MiB at 1080p. Wider groups can submit more off-screen geometry; sampled coastal triangle counts increase in this comparison. All accepted runs have no captured errors or failed tiles and return tracked world/asset/renderer allocations to zero. The bounded unused-program cache persists until renderer disposal.

Correctness checks include cancellation/retry and restored renderer state during baking; first-visible water with zero new shader builds or pipeline creations; repeated teleport/resize history seeding; exact grouped transforms, IDs, contacts, fades and source exports; and bounded cell work with 64-fold world-area growth and revisits. Native 64/128 m grouping images match the separate-draw reference across four view/sun combinations per mode. The six-view pine impostor comparison is approximate: dark-canopy coverage is 84–92% of the full source and silhouette overlap is 0.70–0.83. It is not close-up parity, full multi-layer parallax, exact per-leaf motion/history, or calibrated CryEngine fidelity. No mipmaps are generated yet. See [capture workflow and limits](FOLIAGE.md#generate-distant-tree-impostors).

All **362 unit tests**, typecheck, lint and production/runtime/declaration builds pass. Final native RTX checks cover both world profiles, impostor baking, grouping, temporal resets and water staging. The full browser suite and other hardware browsers were not locally rerun. [Raw runs, source fingerprints, validation and limits](benchmarks/impostors-streaming-2026-10-20.json) include the earlier failed profiles; the 80-triangle prototype was rejected, and a 32-unused-program cache allowed forest-return recompilation. Neither is presented as the final result.

Reproduce these separately from tests, builds, source edits and encoders:

```sh
npm ci
npm run build
npm run benchmark:world -- --wide-clusters --impostors --no-captures --output=.qa/world-optimized.json
npm run benchmark:world -- --no-captures --output=.qa/world-default.json
npm run benchmark:world -- --wide-clusters --impostors --no-captures --output=.qa/world-optimized-repeat.json
npm run benchmark:world -- --steady --wide-clusters --impostors --no-captures --output=.qa/world-optimized-resident.json
```

## Changed-cluster updates and optional near grouping — 20 October 2026

The follow-up removes retained-source version scans from settled wind-only frames. Placement, contact, fades and bounds changes invalidate only the affected clusters. Source buffers remain available for authoring/export; unchanged frames retain their packed state. Alpha-blended and refractive materials keep separate object sorting. A regression observes **zero source-version reads across 30 settled frames**, followed by correct resynchronization after reanchoring. Primary exports omit the internal source marker.

`foliageClusters: { nearby: true }` optionally groups compatible primary/intermediate representations into 64 m cells; default clustering remains distant-only. The [native CC0 pine test](../tests/browser/foliage-clusters.spec.mjs) compares two sun directions at near/distant views, including primary/intermediate cross-fades, with matching pixels within the test tolerance. CPU checks compare exact packed transforms, IDs, contact and fade values through motion, culling, recovery, reanchoring, rollback and rebuild. All **353 unit tests**, typecheck, lint and build pass. Eleven targeted RTX Chrome cases pass across this iteration, including five final cases after option wiring; the full browser suite and other devices were not locally rerun.

The new **RTX 5060 / Chrome 155 / AC / 1080p** default-path world comparison runs baseline/candidate/candidate/baseline, with source edits, builds, tests and encoders stopped. Forest submission FPS ranges **43.2–45.1 baseline / 42.6–47.8 candidate**, with 33.4 ms p95 in all four runs. Open-view FPS ranges **59.1–59.8 / 48.3–59.8**; the slower candidate run reaches 33.4 ms p95 versus 16.8 ms in the others. Coast stays about 60 FPS. Resident tiles and terrain detail match. **No reliable default-path FPS gain is established.** These quiet fixed views meet the local 33.5 ms p95 threshold; they do not resolve streaming stalls or prove sustained dense-world acceptance. Earlier near-field prototypes measured while source edits could trigger background work are excluded from performance claims.

The separate external **7,323-plant Tropical Grove** comparison uses Standard water, the complete native shadow/sky/GTAO/temporal pipeline, 90 warmup frames, 10-second coast/canopy windows in forward/reverse order, and one unfinished GPU frame. The optional near mode preserves selected plants and triangles in each matching phase:

| View                     | Selected batches default → nearby | CPU submission median default → nearby | GPU render median default → nearby |
| ------------------------ | --------------------------------: | -------------------------------------: | ---------------------------------: |
| Coast, forward / reverse |             293 / 321 → 104 / 110 |                  9.4–10.2 → 5.6–5.9 ms |         9.67–10.21 → 9.71–10.22 ms |
| Canopy                   |                         416 → 183 |                 10.9–11.2 → 7.6–7.8 ms |           9.08–9.09 → 9.03–9.12 ms |

Default cadence stays about 30 FPS. Near mode records 30.7–31.7 FPS coast and about 30 FPS canopy, with 33.4–33.5 ms p95. This supports reduced submission cost in these views, with similar measured GPU cost; it is one run per configuration, not a universal speedup or a geometry reduction. Coast forward/reverse select 1,495/1,840 plants because of LOD history; compare configurations within the same phase. Canopy selects 3,424 plants in every case. Tracked renderer storage increases by 0.24–1.87 MiB across matching phases, excluding CPU source buffers and driver allocations. Wider clusters can submit extra off-screen geometry in other scenes. The option remains off by default. All accepted runs have no captured rendering/GPU errors and release tracked allocations to zero. See [full measurements, hashes, validation and limits](benchmarks/foliage-cluster-updates-2026-10-20.json).

After saving a baseline built `lib/` inside the workspace and building the candidate, reproduce the tropical configurations sequentially:

```sh
npm run benchmark:tropical-water -- --runtime-lib=.qa/baseline/lib --variants=standard --no-canopy --output=.qa/tropical-baseline.json
npm run benchmark:tropical-water -- --variants=standard --no-canopy --output=.qa/tropical-default.json
npm run benchmark:tropical-water -- --variants=standard --no-canopy --near-clusters --output=.qa/tropical-near.json
```

The source project is read-only. Pass `--project="C:/path/to/scene.terrain"` to use another document. `npm run benchmark:world -- --steady --no-captures` checks the default resident views; add `--near-clusters` for the optional mode. These harnesses have different queue policies, so do not compare their FPS directly.

## Forest streaming, clusters and canopy light — 20 October 2026

TerrainWorldScene now moves chunk geometry, normals, bounds, LODs and morph bounds to a bounded worker pool, yields between main-thread preparation stages, and offers a staged GPU warmup hook before admitting a tile. `/world.html?prewarm` opts into serialized `compileAsync` work. Requiring compilation before admission delayed visible content, so it is off by default. Equal wind/fade/leaf-lighting configurations reuse node graphs across tiles with independent per-material wind values. These changes target load hitches and repeated shader preparation; they do not guarantee that every shadow/MRT pipeline or asset upload is already warm.

Compatible distant LODs combine draws into 128 m cells. In the native CC0 pine image test, clustered and separate batches retain the same triangles, wind, cutout shadows and pixels across two sun directions while using fewer than half as many active draw batches. Source batches stay resident for authoring; larger cells trade culling precision and extra instance storage for fewer submissions. This is not baked impostor geometry or plant residency streaming. See [foliage behavior](FOLIAGE.md#distance-and-detail).

Optional [canopy lighting](ENVIRONMENT.md) adds a 38,016-byte, terrain-following visibility/tint field. It is worker-baked from crown ellipsoids and local material tints, not traced triangle GI. Tests compare indirect-only shade, direct sunlight preservation, bounded bounce, a night-time solar cycle, object isolation and rigid terrain transforms. Failed CPU/GPU allocation preserves the document, pixels, redo and autosave; retry/undo/redo/reload are covered. Full GI and calibrated production reference scenes remain work in progress.

After the game was closed, the AC-powered **1920 × 1080 / RTX 5060 Laptop GPU / Chrome 155** resident-view comparison loaded and warmed every view before recording 12 seconds. Baseline is main commit `506554a`; candidate uses workers, shared graphs and clustering, with canopy lighting and prewarming off. Resident tile counts stay constant at 9/12/12 and selected terrain triangles match at 34,368/38,928/43,024. These are submission rates, not completed frames or monitor scanout.

| Resident view | Baseline FPS → candidate FPS | Frame p95 before → after | CPU submission median before → after |
| ------------- | ---------------------------: | -----------------------: | -----------------------------------: |
| Forest        |                  22.9 → 29.1 |           50.1 → 50.0 ms |                       42.5 → 33.4 ms |
| Open          |                  33.2 → 57.2 |           50.0 → 16.9 ms |                       27.4 → 15.7 ms |
| Coast         |                  46.8 → 54.4 |           33.4 → 33.3 ms |                       20.6 → 16.9 ms |

This single pair supports improved CPU submission in these views, with workstation/clock variability still present. **The dense forest still fails the 30 FPS frame-time target.** Aggregating all views hides that failure; the harness now requires each resident view's p95 to pass. The separate three-lap candidate traversal records 41.1 submitted FPS, 33.4 ms p95, 66.7 ms p99 and a 2.50-second worst interval, with 37 long tasks. Resident content changes during traversal, so its aggregate is not a quality-matched FPS comparison. Earlier prewarm-on trials also spent more time with missing tiles and are excluded from improvement claims. All accepted runs have no captured errors and return tracked resources to zero. See [raw world comparison and qualifications](benchmarks/forest-streaming-2026-10-20.json).

The clean **7,323-plant Tropical Grove** integrated water run uses one unfinished GPU frame, 90 warmup frames and 10-second coastal/canopy windows in forward/reverse order. Standard records **21.1–29.6 FPS**, Balanced **25.1–29.8**, and High **21.6–29.8**. Most frame p95 values are 50 ms. The order/clock variation prevents a reliable FPS ranking or incremental canopy-cost claim. The optional canopy field bakes in 1.82 s on its worker and adds 38,016 texture bytes. CPU submission remains substantial; render GPU medians are about 9–11 ms, excluding FFT compute. No errors or tracked cleanup residue occur. See [clean integrated report](benchmarks/tropical-water-clean-2026-10-20.json). The earlier [game-contended diagnostic](benchmarks/tropical-water-contention-2026-10-20.json) is retained only as rejected timing evidence.

A separate instrumented coastal run timestamps the ocean simulation compute pass directly, including FFT and foam. Balanced records **0.096 ms median / 0.112 ms p95**; High records **0.470 / 0.491 ms**, with 91 timed samples each. The 366 total warmup/timed timestamp readbacks report no probe errors. These narrow-pass costs do not include water shading, reflection capture or the forest; its short instrumented FPS is not used for whole-scene acceptance. Balanced/High simulation reservations remain about 13.17/84.67 MiB. See [compute probe and exact source hashes](benchmarks/tropical-water-compute-2026-10-20.json). Standard remains the default; the dense scene has not met sustained 30 FPS.

To reproduce after closing GPU-heavy applications:

```sh
npm ci
npm run build
npm run benchmark:world -- --no-captures --output=.qa/world-current.json
npm run benchmark:world -- --steady --no-captures --output=.qa/world-resident.json
npm run benchmark:tropical-water -- --project="C:/path/to/Tropical-Grove.terrain" --output=.qa/tropical-water.json --seconds=10
npm run benchmark:tropical-water -- --project="C:/path/to/Tropical-Grove.terrain" --compute-only --output=.qa/ocean-compute.json
```

Run these sequentially and separately from tests, builds and asset encoding. Water testing uses the public built runtime, a read-only external project, native RTX 5060, 1920 × 1080, the Natural look, wind, shadows, GTAO and temporal stabilization. It compares both coastal and canopy views in forward/reverse renderer order, then checks the canopy field. Each iteration observes the queue fence before its next animation frame, limiting unfinished GPU frames to one. CPU samples exclude that wait; native render timestamps exclude FFT compute, while frame intervals include integrated work. `--compute-only` instead adds native timestamp queries around the ocean compute pass and runs a shorter coast-only probe. Water reports include source/project hashes, power state and NVIDIA context. Driver memory is a point sample, not attributed process accounting; monitor scanout is not measured. Windows tests/these benchmarks use a temporary execution request to avoid Modern Standby and release it at exit; saved power configuration is unchanged.

At that checkpoint, the 2 km world script could queue GPU work; its FPS is not directly comparable with the fence-bounded water harness or the newer bounded world profile above. Keep that distinction when reviewing these historical measurements. All 348 unit tests, typecheck, lint, build and changed-file formatting passed. Seventeen distinct targeted Chrome cases passed across that iteration, including eight final canopy/recovery/clustering/world cases. See [validation record and retry details](benchmarks/forest-streaming-validation-2026-10-20.json). The full unit command is `npm test -- --maxWorkers=4 --testTimeout=30000`; the existing full-size sculpt-preset fixture can exceed its default 5 s timeout under workstation load. Its isolated default-timeout retry passed. No assertion was weakened. Full browser-suite and other-device validation remain outstanding.

## Terrain LOD preparation cache — 20 October 2026

A sampled current-world profile identified repeated terrain LOD triangle searches during streamed tile preparation. The builder now caches grid triangle indices and Float64 barycentric weights by chunk dimensions, with an eight-entry LRU bound (under 2 MiB of typed arrays). Heights, sampled errors, morph targets and returned coarse index buffers remain independent per call; holes retain their authoritative topology. The bounded cache survives scene disposal and is outside per-world residency counters. No geometry, error tolerance or transition settings changed.

The separate **awake** Node 24.18.1 CPU benchmark processes 500 varying-height 32×32 chunks per trial in baseline/current/current/baseline order. Warmed preparation median falls from **5.40–5.42 ms** to **0.216–0.221 ms**; p95 falls from **7.46–7.54 ms** to **0.320–0.356 ms**. The first current call, including table construction, takes 11.36 ms; the second current trial reuses it. All 2,000 output streams have identical aggregate hashes across modes. Timings exclude input preparation and output hashing; this is a CPU preparation result, not a 25× FPS claim. Five byte-exact legacy dimension fixtures and independent-height/mutation/eviction/hole checks also pass. All **338 unit tests**, build, typecheck and lint pass; native world, PBR/resize and foliage upload checks pass on RTX Chrome. One world check stalled during Windows Modern Standby and passed in a fresh browser after waking. That interrupted run and the earlier pre-awake microbenchmark are excluded from accepted performance evidence. Windows reported battery power at 27% before the accepted awake tests; comparisons to earlier AC/unknown-power runs cannot establish a controlled speedup.

Reproduce the source benchmark using a standalone pre-change copy of `src/core/terrain-lod.ts`:

```sh
npm run benchmark:terrain-lod -- --baseline=.qa/terrain-lod-before.ts --output=.qa/terrain-lod.json
```

The subsequent three-lap RTX 5060 world traversal records **18.86 FPS** over 108.086 seconds, with frame p50/p95/max **33.0/149.7/2,733.2 ms**, CPU submission p95 **72.4 ms** and available GPU timestamp p95 **13.31 ms**. Tile preparation p95 is 2,381.3 ms, including queued time; 498 long tasks remain. No rendering/loading errors occur, and teardown returns tracked world/asset/renderer allocations to zero (the bounded global topology cache remains). **Steady 30 FPS still fails.** Windows reported battery operation before/during this awake run. The earlier pre-cache traversal below occurred before standby and did not record its power condition; these single runs do not establish a controlled whole-world speedup. The paired source benchmark establishes the preparation improvement. Worker preparation, shader compilation/upload scheduling and distant geometry remain open. See [raw final traversal](benchmarks/world-terrain-lod-cache-2026-10-20.json) and [source, validation and CPU comparison](benchmarks/terrain-lod-cache-2026-10-20.json).

## Foliage allocation and uploads — 20 October 2026

The renderer now reserves each LOD's exact deterministic density subset, preserves instance IDs/matrices when a fade changes only coverage, and uploads active packed slots on version changes. Three's `DynamicDrawUsage` forced redundant full-capacity transfers in unchanged render passes; the native packed streams now use versioned updates. Primary buffers, authored anchors/contact state and referenced geometry still remain resident. Full-density tree LODs preserve every tree and do not receive density-related capacity savings. This is preparation toward #9, not distant forest clusters, impostors or per-plant streaming.

The CPU-only fixture keeps 4 m spacing while increasing population, uses built-in pine geometry with 60%/20% retained density at 40/100 m, a 180 m cull distance, fades and two teleports. Baseline/current/current/baseline runs contain 440 recorded updates per population. All 72 checkpoints match exact packed IDs, transforms, fade values and view statistics. Reserved authored matrix/contact/fade attributes are:

| Authored plants | Previous bytes | Current bytes | Reduction |
| --------------- | -------------: | ------------: | --------: |
| 1,000           |        456,000 |       277,856 |     39.1% |
| 10,000          |      4,560,000 |     2,757,128 |     39.5% |
| 50,000          |     22,800,000 |    13,715,568 |     39.8% |

These exclude shared geometry/textures, CPU transition/contact maps, native packed streams and motion snapshots; they are not total heap or VRAM figures. CPU timings overlap and have approximately 0.1 ms browser timer granularity. At 50k, update p95 is 0.5 ms in both current trials and 0.5/1.1 ms in the baseline trials. A spatial hierarchy prototype was measured and removed because it added overhead; the existing tile distance guards remain in use.

The separate native RTX 5060 comparison renders 400 real CC0 ferns at 1080p, using the same 25% distant density in both builds, shadows, Standard water capture, GTAO and TRAA. The sampled view has 231 selected plants, 153,825 triangles and six batches in both builds. Current GPU p50 is 4.00–4.13 ms versus 3.93 ms baseline; CPU submission p50 is 3.7–4.3 ms versus 4.0–4.2 ms. Frame p95 remains 33.4 ms in every trial. This establishes **no reliable FPS improvement**. Total tracked renderer bytes decrease by 225,720, from 225,475,600 to 225,249,880; teardown returns them to zero. Final screenshots are byte-for-byte identical in all four trials (SHA-256 `5a66dc2dca3850acfb7dd961384ec8ee2ab06f65db2570231bd6e29c83eb28e8`), and temporal/reference errors are identical. Timings run separately from builds, browser suites and other benchmarks, with the dedicated GPU idle before measurement.

The native regression uses 400 CC0 ferns with 25% LOD density, shadows, water, temporal rendering, interrupted fades, complete culling and return. GPU queue instrumentation verifies that all 24 recorded instance writes cover exactly the active slots (103,872 bytes versus 127,200 reserved bytes across those writes). Three subsequent normal wind-only frames produce **zero packed instance writes**. This probe excludes initial mapped-buffer allocation and unrelated texture/uniform transfers. A zero-delta terrain update explicitly refreshes anchors and is not the wind-only probe. Tests also cover 0%-capacity levels, exact density reservations, reset, rollback, motion/teleport/resize, shared shadows, prepared-world cleanup and authoring failure/retry/undo/autosave recovery. Build, lint and all 331 unit tests pass, along with ten distinct relevant Chrome scenarios. Full browser-suite, other devices, Linux/software and dense banana/jacaranda rendering were not rerun.

Reproduce after `npm run build`; run each command separately. Save a baseline `lib/` before rebuilding the candidate:

```sh
npm run benchmark:foliage-selection -- --baseline-lib=.qa/baseline/lib --output=.qa/selection.json
npm run benchmark:foliage-motion -- --baseline-lib=.qa/baseline/lib --density=0.25 --output=.qa/render.json
npm run test:browser -- tests/browser/foliage-density.spec.mjs tests/browser/foliage-motion.spec.mjs tests/browser/foliage-crossfade.spec.mjs tests/browser/foliage-batching.spec.mjs tests/browser/foliage-recovery.spec.mjs tests/browser/webgpu-world.spec.mjs
```

Raw comparisons, upload probes, fingerprints and limits are in the [allocation/upload report](benchmarks/foliage-allocation-2026-10-20.json).

A separate clean **pre-cache** whole-world run traversed three laps of forest/open/coast at 1080p on the dedicated RTX 5060, without captures or concurrent benchmarks/builds/tests. It recorded 1,937 frames over 108.112 seconds: **17.92 FPS average**, frame p50/p95/max **32.7/200.1/1,983.3 ms**, CPU submission p95 **69.3 ms**, and available GPU timestamp p95 **13.95 ms**. Tile preparation p95 was 2,627.9 ms (including queued time); 443 long tasks were recorded. All tiles loaded without errors and teardown returned tracked renderer/world/asset allocations to zero. **Steady 30 FPS still fails.** This retest includes the preceding motion-history changes and is not an isolated before/after comparison of this allocation pass; the bounded comparison above supplies that comparison. Main-thread stalls and streaming scheduling remain the priority. See [raw pre-cache world results](benchmarks/world-foliage-buffers-2026-10-20.json).

## Foliage motion history — 19 October 2026

Native vegetation now evaluates previous wind/contact deformation and ID-matched instance placement, with reactive fresh/LOD coverage. A stable camera projection binding, frame-scoped camera/object history, and restoration of perspective aspect fix motion caused by jitter and temporal pipeline rebuilds. The prior renderer compared animated leaves against an undeformed rest pose. These corrections are automatic when native temporal stabilization is used; [behavior and limits](FOLIAGE.md#motion-and-temporal-stabilization) describe runtime integration.

The bounded comparison uses **400 checked-in CC0 Poly Haven ferns**, 213,144 selected triangles in six batches at the sampled final view, LOD transitions, layered terrain, shadows, Standard ocean capture, GTAO and TRAA at **1920 × 1080**. It runs baseline/current/current/baseline, with 30 warmup frames and 120 recorded frames per trial, on Windows Chrome 155 / Node 24.18.1 / RTX 5060 Laptop GPU, driver 617.42. The GPU was idle before the run. No build, correctness suite, encoder or other benchmark ran concurrently. Source/build fingerprints and raw samples are in the [report](benchmarks/foliage-motion-performance-2026-10-19.json).

| Metric                                           | Baseline trial range | Corrected trial range |
| ------------------------------------------------ | -------------------- | --------------------- |
| Median GPU render time                           | 4.26 ms              | 4.13–4.19 ms          |
| GPU p95                                          | 4.46–10.62 ms        | 4.98–5.18 ms          |
| Median CPU update/submission                     | 3.0–3.4 ms           | 3.3–3.6 ms            |
| CPU p95                                          | 5.4–6.8 ms           | 5.8–6.6 ms            |
| Frame interval p95                               | 33.4 ms              | 33.4–33.5 ms          |
| Tracked renderer GPU bytes                       | 225,282,775          | 225,475,600           |
| Mean RGB error against the paused MSAA reference | 7.11 / 255           | 6.13–6.18 / 255       |
| Mean RGB error at reference edges                | 31.37 / 255          | 22.58–22.95 / 255     |

This shows better reference agreement without a measurable median GPU cost increase in this fixture, plus about **0.18 MiB** tracked GPU storage. The approximately 0.1 ms median GPU difference is within run/clock variability; it is not an optimization claim. CPU medians suggest roughly 0.25 ms added work at this population, with overlapping tails. GPU timestamps cover the composed passes. Frame intervals include RAF and timestamp-resolution overhead, and the short run does not establish sustained 30 FPS in a full forest. Renderer bytes exclude CPU histories, browser/driver allocations and source assets.

The image metric compares the final temporal view, with one paused pose draw, against four warmed paused non-temporal MSAA frames with matching intended projection. It includes the combined motion, projection and history corrections; it is not an isolated ghosting metric or a physically correct reference. See the [baseline](benchmarks/foliage-motion-before-2026-10-19.png) and [corrected](benchmarks/foliage-motion-after-2026-10-19.png) documentation captures. Separate local before/after WebM recordings and extracted moving frames were inspected; they are excluded from performance timing. Fine leaf aliasing and temporal softness remain visible.

Current matrix/contact/fade and previous matrix/contact/validity occupy two packed instance streams (152 bytes per instance on the GPU). Static wind-only frames do not repack these buffers. Streaming admission conservatively adds 88 GPU bytes and 352 CPU bytes per capacity slot, plus 1 KiB per batch, beyond existing matrix accounting. Some geometry accounting can include these bytes again; these are admission reservations for one view, not an exact heap measurement. Extra views require host budgeting. Teardown returned all tracked renderer bytes to zero in all four trials.

After `npm run build`, run `npm run benchmark:foliage-motion`. For a comparison, save the baseline `lib/` first, rebuild the candidate, then run:

```sh
npm run benchmark:foliage-motion -- --baseline-lib=.qa/baseline/lib --output=.qa/motion-comparison.json
npx playwright install ffmpeg
npm run benchmark:foliage-motion -- --baseline-lib=.qa/baseline/lib --capture --output=.qa/motion-visuals.json
```

The finalized harness owns preview port 5197 (`--port=5198` overrides it), validates the native adapter, and separates screenshots/readback/video from timed rendering. The recorded timing used the existing local asset server on port 5186 with both SDKs served through fixed file routes; the subsequent separate video run verified the owned-preview path. This does not affect the SDK source/build hashes or asset contents.

Validation passed build/type checks, lint, all **329 unit tests** and **15 distinct targeted Chrome scenarios**. The analytic probe measured 0.01579285 NDC wind velocity against 0.01580310 expected, and zero motion when paused. The fern fixture measured zero paused opaque motion and at most 1.2e-7 NDC after teleport/resize settling. Tangents/vertex colors compile within the default device limits, tracked GPU resources return to zero, and shared shadow buffers survive caster removal. Recovery retains exact document/history assertions through injected failure, successful retry, undo and reload. Two existing reload checks were updated to wait for startup readiness before reading the project name; their initial five-second name checks fired while loading was still active. The two retries passed. Linux/software, other devices, dense banana/jacaranda populations and the full browser suite were not rerun.

```sh
npm test -- --maxWorkers=4 --testTimeout=15000
npm run test:browser -- tests/browser/foliage-motion.spec.mjs tests/browser/foliage-batching.spec.mjs tests/browser/foliage-crossfade.spec.mjs tests/browser/foliage-recovery.spec.mjs tests/browser/webgpu.spec.mjs tests/browser/webgpu-world.spec.mjs tests/browser/webgpu-device-loss.spec.mjs tests/browser/web-ocean.spec.mjs
```

## Optional spectral ocean — 19 October 2026

The web-ocean-derived provider adds six native GPU FFT cascades and persistent foam on the existing renderer device. Its simulation allocation reservation is **13.17 MiB Balanced** or **84.67 MiB High**, including buffers and simulation texture mipmaps. These values exclude scene captures, terrain masks, geometry and the existing shared pore texture. Synchronized world tiles share matching simulations, while conservative residency reservations still charge per tile. Independent clocks and animation rates use separate histories.

Targeted checks exercise animation, coastal composition with a separate pond, shared/disposed GPU resources, allocation failure/retry, undo and persistence. They are correctness checks; no integrated incremental GPU timing or dense-tropical FPS comparison was measured for this addition. The earlier streaming and Standard-water measurements below do not establish spectral-ocean performance. See [configuration and limits](WATER.md#choose-an-ocean-renderer) and [integration evidence](benchmarks/web-ocean-integration-2026-10-19.json).

## Native streaming optimization — 19 October 2026

The optimization working tree, based on `a2ace3f` and preceding the final shadow-disposal correction below, was measured on the **RTX 5060 Laptop GPU**, driver 617.42, Windows Chrome 155.0.8059.82, at **1920 × 1080**. This uses the same requested three-lap route and timing harness as the original native report, in a fresh temporary browser profile with screenshots disabled. No benchmark, browser test, build or asset encoder ran concurrently with the accepted run. Population counts, texture settings, shadow resolution/cascades, terrain error targets and screen effects are unchanged.

| Metric                                      | Original native port | Optimized native |
| ------------------------------------------- | -------------------: | ---------------: |
| Average submitted FPS, including stalls     |                0.147 |        **35.72** |
| Submitted frames                            |                   30 |            3,860 |
| Recording duration, including final loading |             204.75 s |         108.07 s |
| Frame interval p95                          |          28,751.5 ms |          54.8 ms |
| Worst frame interval                        |          51,090.6 ms |       1,200.0 ms |
| CPU update/render submission p95            |          28,747.1 ms |          50.2 ms |
| Steady 30 FPS acceptance                    |                 Fail |             Fail |

The table records the isolated run **before the final shadow-disposal correction**. That checkpoint passed all 13 targeted browser checks. Its subsequent [retest](benchmarks/world-webgpu-contended-2026-10-19.json) measured **24.16 FPS**, **115.4 ms p95**, and **2,345.4 ms worst interval**, with no reported errors and zero tracked allocations after teardown. iRacing started during that run (17:12:01 local time); after the benchmark stopped, RTX utilization was 68% and iRacing consumed 2.77 CPU seconds in an approximately one-second sample. This is a contended measurement, not evidence that the cleanup change caused a regression. The later current-code clean traversal, including foliage motion/history and allocation changes, is reported [above](#foliage-allocation-and-uploads--20-october-2026); it remains below target and does not isolate these intervening changes.

CPU sampling identified repeated TSL shader building as the original dominant cost, especially in shadow passes. Spatial foliage batches now share materials and native instance attributes; LOD fades keep one shader. Terrain tiles share a graph with independent palette/shore bindings, and their single native position morph reads a vertex attribute instead of triggering a new program for each morph texture. Opaque shadows no longer evaluate full terrain PBR just to produce alpha 1. Stable shadow overrides and one scene-transform update per composed frame reduce repeated work in warm frames.

The focused cold-forest probe reduced main terrain shader builds from 44 to one. Browser readback verifies independent foliage matrices across 50 batches and two renderers, independent red/blue tile palettes, a changed morph on only one tile, exact terrain silhouette agreement with WebGL in that fixture, and unchanged rendering of a surviving tile after its neighbor is disposed. Shadow cleanup waits until source-material disposal listeners finish, preventing double release of shared GPU bindings. Regression checks remove/rebuild foliage while other shadow casters remain alive, and exercise failed foliage/surface edits, retry, undo/redo and persistence. Build, lint and 321 unit tests pass, along with targeted native rendering/resource and legacy cutout-shadow checks. This is not a full browser-suite rerun.

The accepted traversal reported no rendering/load errors and released all tracked tiles, assets and renderer resources. **Frame consistency still needs work**: two intervals exceeded one second. The fresh pre-port WebGL reference below averaged 52.63 FPS and its p95 also missed steady 30 FPS. These are complete implementation comparisons, not API-only or equal-image-quality claims. The original native stalls skipped route phases, so its executed camera samples differ. This measures streaming/teleport responsiveness, not stationary FPS, editor FPS, physical display latency or dense populations of the supplied high-polygon banana model. GPU timestamp samples are not equivalent cross-backend coverage.

See [raw optimized timings](benchmarks/world-webgpu-optimized-2026-10-19.json) and [source fingerprints, profiling, validation and limits](benchmarks/webgpu-optimization-2026-10-19.json). Short prototype timings and an attempt interrupted to eliminate overlap with a finishing browser test are excluded. Reproduce after `npm run build` with `npm run benchmark:world -- --no-captures --output=test-results/world-timing.json`.

## Native WebGPU migration comparison — 19 October 2026

Production builds at `7992451` (pre-port WebGL) and `a2ace3f` (native WebGPU) were measured sequentially on the **RTX 5060 Laptop GPU**, NVIDIA driver 617.42, Windows Chrome 155.0.8059.82, 1920 × 1080, device scale 1. iRacing was closed before measurement; no other benchmark, build, browser test or asset encoder ran concurrently. Prepared assets, procedural world inputs, requested route and authoring settings were unchanged. Three and the rendering pipelines changed, so this compares complete implementations rather than isolating the graphics API or asserting identical image quality.

| Metric                                           | Fresh WebGL rerun | Native WebGPU repeat |
| ------------------------------------------------ | ----------------: | -------------------: |
| Average submitted FPS, including stalls          |             52.63 |            **0.147** |
| Recording duration, including final tile loading |          108.08 s |             204.75 s |
| Submitted frames                                 |             5,688 |                   30 |
| Frame interval p95                               |           54.4 ms |      **28,751.5 ms** |
| Worst frame interval                             |          660.7 ms |      **51,090.6 ms** |
| CPU update/render submission p95                 |           45.5 ms |          28,747.1 ms |
| Frame intervals over one second                  |                 0 |                   10 |
| Steady 30 FPS acceptance                         |              Fail |                 Fail |

The original native repeat loses 99.72% of effective traversal FPS. This is dominated by multi-second freezes and **is not a warmed stationary-view FPS measurement**. The route advances by wall time; these stalls skip route phases, so the native run does not establish a successfully rendered three-lap traversal. Main-thread update/render spans reach 51 seconds, while spot checks often found little GPU activity. Follow-up profiling identified repeated node shader construction as the dominant cause; the optimization above addresses that work. The ten native GPU timing samples do not provide equivalent coverage to the WebGL queries, and no GPU-time improvement is claimed. Both completed without reported rendering/load errors and released all tracked tile/asset resources at teardown.

See the [comparison and methodology](benchmarks/webgpu-performance-comparison-2026-10-19.json), [fresh WebGL raw timings](benchmarks/world-webgl-recheck-2026-10-19.json) and [native raw timings](benchmarks/world-webgpu-2026-10-19.json). An [exploratory native run](benchmarks/world-webgpu-exploratory-2026-10-19.json) similarly recorded only 29 frames with multi-second freezes; its older timing boundary included a warmup-crossing first interval, so it is excluded from the primary FPS comparison. An initial screenshot-enabled attempt timed out before measurement and is also excluded. The historical WebGL report below averaged 38.65 FPS under its earlier session conditions; the fresh rerun is the primary comparison.

Reproduce with `npm ci`, `npm run build`, then `npm run benchmark:world -- --no-captures --output=test-results/world-timing.json`. The harness requires the RTX 5060 unless explicitly overridden. For the old build, create a separate checkout of `7992451`, install its locked dependencies, build there, and serve its production output on a different port; invoke the current harness with `--url=http://127.0.0.1:5184`. Do not build while measuring. `--output` preserves separate reports; its parent directory must exist. Screenshot capture is outside timing and can be skipped to avoid cold-frame capture timeouts.

Average FPS counts submitted frames over the browser-clock recording window. Frame percentiles omit the first interval because it begins before recording; raw samples retain it for auditing. The window includes waiting for final tile loads, and neither metric measures physical display scanout or input latency. Initial readiness in the raw report means assets reached the idle promise, not that the first frame finished compiling. These are bounded development runs with background/clock variability and a small native sample count. The new harness passed syntax/format checks and the two complete comparison runs; renderer source was unchanged and the full correctness suite was not rerun for this measurement.

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
