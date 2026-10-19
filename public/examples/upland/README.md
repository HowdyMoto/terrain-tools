# Upland meadow assets

Open `upland-meadow.terrain` in Terrain Studio, or choose Upland meadow in `runtime.html`. All scene assets are embedded in the native package.

The PNGs are original AI-generated color/opacity artwork produced with the built-in image generation tool. They are not scans or measured PBR maps. Deterministic meshes, authored lighting, procedural surface detail, and fixed placement seeds form a reproducible example; this is not a calibrated simulation dataset or an AA quality certification.

- `meadow-albedo.png`: dry meadow ground color.
- `limestone-albedo.png`: weathered limestone color.
- `grass-cutout.png`: grass color with original alpha preserved.
- `upland-tuft.glb` / `upland-lean.glb`: segmented grass cards, alpha test 0.45, embedded PNG.
- `upland-distant.glb`: shared lower-detail grass.
- `upland-limestone.glb`: irregular rock mesh with embedded PNG.
- `manifest.json`: counts, viewpoints, dimensions, and hashes.

Run `npm run build:runtime` then `npm run build:example:upland` from the repository root to rebuild meshes and the native scene without changing the PNGs. Rebuild the app afterward. See `docs/REFERENCE-SCENE.md` and `docs/reference-asset-prompts.json` in the repository for usage, limitations, and prompts.
