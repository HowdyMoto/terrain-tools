# CC0 Foliage Assets

Source records for Terrain Studio's foliage models. The original ZIP archives and extracted glTF files were downloaded and verified on 2026-10-16 (UTC), with 2K textures. These approximately 1.99 GB of original downloads are kept locally and excluded from Git. The repository includes the prepared runtime GLBs, alpha maps, credits and manifests; a fresh clone does not need the original downloads to run or build the editor.

**Author credits: [CREDITS.md](CREDITS.md).** License references: [LICENSE.md](LICENSE.md). Exact file sizes and SHA-256 hashes: [manifest.json](manifest.json).

| Download source                                            | Local extracted model                                        | Original ZIP size |
| ---------------------------------------------------------- | ------------------------------------------------------------ | ----------------: |
| [Fern 02](https://polyhaven.com/a/fern_02)                 | `poly-haven/fern_02/gltf-2k/fern_02_2k.gltf`                 |           3.39 MB |
| [Shrub Sorrel 01](https://polyhaven.com/a/shrub_sorrel_01) | `poly-haven/shrub_sorrel_01/gltf-2k/shrub_sorrel_01_2k.gltf` |           3.70 MB |
| [Grass Medium 01](https://polyhaven.com/a/grass_medium_01) | `poly-haven/grass_medium_01/gltf-2k/grass_medium_01_2k.gltf` |           7.99 MB |
| [Pine Tree 01](https://polyhaven.com/a/pine_tree_01)       | `poly-haven/pine_tree_01/gltf-2k/pine_tree_01_2k.gltf`       |         982.15 MB |

Sizes use decimal MB. The archives total **997.24 MB**; retaining both archives and extracted files uses approximately **1.99 GB**. To rebuild the prepared foliage, download the **2K glTF** option from each source page. Save its `.gltf.zip` in `poly-haven/<asset>/` and extract its model, buffer and textures into `poly-haven/<asset>/gltf-2k/`, matching the paths above. Each asset folder's tracked `SOURCE.txt` records its credits. Verify downloads against `manifest.json` when reproducing the recorded versions; upstream assets can change.

## Using the models

Ready-to-paint derivatives now live in [public/foliage/photoreal](../../public/foliage/photoreal/), with [four default brushes](../../docs/FOLIAGE-ASSETS.md). Original alpha PNGs were downloaded separately into [alpha-maps](alpha-maps/manifest.json) to restore leaf transparency missing from the glTF package textures. That manifest records official URLs, sizes and checksums; the original archives below remain unchanged.

Keep each `.gltf`, its `.bin`, and its `textures/` folder together. Open the `.gltf` file in Blender or another glTF-compatible application. These are the original source packages; their geometry, materials, and textures have not been edited.

Terrain Studio's model importer accepts a single static **GLB**, with a 30 MB limit. For that workflow, select a suitable plant variant, place its origin at the base, and export it as a GLB with embedded textures. The pine source is especially large and needs geometry reduction or a suitable lower-detail version before importing. No visual or engine-compatibility validation of these source packages is claimed.

The files live outside `public/`, so source archives are not automatically copied into the editor's production build.

## Verification

All four ZIP archives passed CRC checks. All 29 extracted files match their archive contents byte for byte. Every external glTF buffer and image is present; buffer sizes, buffer views, and accessor bounds were checked. `manifest.json` records SHA-256 hashes for each archive and extracted file.

## Additional recommended texture set

[Leaf Set 030 from ambientCG](https://ambientcg.com/view?id=LeafSet030) was **not downloaded**. Chrome blocked the provider's download host, `acg-download.struffelproductions.com`, with `ERR_BLOCKED_BY_CLIENT` when requesting the 2K JPG ZIP. No leaf texture files are included in this collection.

Official download: [LeafSet030_2K-JPG.zip](https://ambientcg.com/get?file=LeafSet030_2K-JPG.zip). Attribution to use if it is added later: ambientCG / Lennart Demes; CC0 1.0 Universal. See [ambientCG's license](https://docs.ambientcg.com/license/) and [publisher information](https://docs.ambientcg.com/legal/).
