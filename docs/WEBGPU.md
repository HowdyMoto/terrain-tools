# Native WebGPU rendering

The editor, asset import previews, `/runtime.html` and `/world.html` initialize Three.js `WebGPURenderer` asynchronously. The factory verifies the native backend and rejects an unavailable device instead of returning Three's WebGL fallback. Existing `.terrain`, JSON and editable GLB documents are unchanged.

Use current Chrome or Edge with hardware acceleration on localhost or HTTPS. The intended desktop device remains the RTX 5060; a browser's high-performance request is only a preference. Windows tests select this workstation's dedicated adapter through DXGI/Chromium. WebGPU can redact the model name to `nvidia blackwell`; the benchmark enables developer adapter information only in its temporary profile.

## Implementation and pass ownership

- `src/render/renderer.ts` owns native initialization, backend checks and serialized GPU validation scopes. Error scopes reject asynchronous GPU preparation failures before editor history/document commits. A lost device stops drawing and offers project saving; restarting the device requires a reload. Startup failure offers local-save download without creating a renderer.
- Terrain uses TSL node equivalents of triplanar array sampling, aligned stochastic tiling, four-layer height blending, DirectX/OpenGL detail normals, wet banks and shallow caustics. Native baking shares the same surface evaluation. Shared triplanar coordinates are evaluated before conditional sampling, including zero-coverage and anti-tiling branches. Compressed libraries still support eight shared map layers with four active terrain layers.
- Vegetation uses native instance attributes for wind, contact masks and complementary LOD fades. Position and analytic normal/tangent deformation are shared with native shadow passes through reusable shader functions. Material cache keys include node graphs, and repeated uniform references share one node binding. Leaf backlighting remains shadowed and respects authored thickness, tint and material selection.
- Dynamic atmosphere uses `SkyMesh` and double-buffered PMREM capture. Direct sunlight is excluded from the probe to avoid adding an unshadowed second sun. Three `CSMShadowNode` supplies three shadow cascades; camera/settings changes refresh their frusta.
- `webgpu-pipeline.ts` owns one scene pass with linear HDR color, packed view normals, indirect light and velocity attachments. Depth uses WebGPU's 0–1 convention. The opaque capture precedes water refraction/reflection. GTAO removes only captured indirect light. TRAA resolves history with reduced water history weight and optional RCAS sharpening. RenderPipeline owns the sole display/tone conversion.
- Resize, camera changes and history invalidation retire pass targets/history. Disposing the pipeline releases its targets, explicit intermediate textures and TRAA bootstrap depth texture. Stable capture bindings and MRT graphs prevent retained textures, shader programs and uniform buffers across rebuilds. AO and sharpening parameters update uniforms. Camera jitter, renderer target/MRT/clear state and temporary visibility changes are restored after use.
- Water preserves connected ocean/pond/lake placement, wave settings, detailed foam, depth absorption, refraction, approximate screen reflections and underwater attenuation. This is a port of the current water model; spectral `web-ocean` simulation is tracked separately in [#13](https://github.com/HowdyMoto/terrain-tools/issues/13).
- Native lighting preparation exercises full-size shadow/screen resources in an isolated offscreen scene before document/history adoption. Three r186's geometry cleanup also finds shader-discovered attributes; `shared-geometry.ts` defers deletion of borrowed foliage buffers until their base geometry's final lease expires. This version-specific adapter is renderer-local.
- GPU readback for PBR baking is asynchronous. Standard GLB export retains base-color/ORM/normal images, including decompression of KTX2 model textures. Preparation cancellation and failed candidates keep the live scene owned by its original document.

The reusable runtime still accepts an explicit WebGLRenderer for existing applications and baseline comparisons. Its GLSL implementations remain alongside the node implementations. There is no editor backend selector or silent fallback. Custom host `onBeforeCompile` GLSL extensions need their own TSL equivalents on WebGPU.

Three is pinned to 0.186.1: older r180 generated invalid WGSL for array texture sampling with explicit gradients, which terrain needs. The current dependency includes that upstream fix. Type declarations use @types/three 0.186.0 and @webgpu/types 0.1.64. See the [official renderer guide](https://threejs.org/manual/pages/webgpurenderer) and [node post-processing guide](https://threejs.org/manual/pages/webgpu-postprocessing.html).

## Verification

Run `npm ci`, `npm run lint`, `npm test`, and `npm run build`. Then:

```sh
npm run test:browser -- tests/browser/webgpu.spec.mjs tests/browser/webgpu-world.spec.mjs
npm run test:browser -- tests/browser/foliage-shading.spec.mjs -g "transmits backlight"
npm run test:browser -- tests/browser/asset-import.spec.mjs tests/browser/settings-recovery.spec.mjs
```

Native tests assert backend identity and collect GPU validation errors, exercise terrain/foliage/sky/water composition, compare baked maps with the WebGL baseline, export GLB, resize/history reset, startup recovery, and stream the checked-in Meshopt/KTX2 forest/coast. Leaf probes separately measure sunlight transmission, shadow rejection and absorption. Editor integration covers imports, preparation failures, cancellation, undo/redo and autosave recovery.

Linux CI uses Chromium's explicit `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader` flags in its isolated test profile, based on [Chromium's test configuration](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/web_tests/FlagSpecificConfig). Software rendering is correctness evidence only.

This port does not establish a frame-rate improvement or production forest quality. Dedicated vegetation motion vectors, distant forest representations, richer indirect lighting and spectral oceans remain separate work. The reference world contains thousands of spatial/LOD meshes; cold native shader compilation can stall loading or region changes. Shader preparation and large-world frame-time acceptance remain required before claiming a responsive production runtime. Screen-space reflections still miss offscreen scenery; the existing finite streamed-water boundary/connectivity limits remain. Safari/Metal, Firefox and Linux hardware drivers have not been validated in this Windows session.
