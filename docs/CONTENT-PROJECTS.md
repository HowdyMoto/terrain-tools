# Project folders

An artist's landscape is a **`.terrain` document**, not a new application build. Use the same editor and runtime for every landscape. The document embeds its terrain, paint, materials, models, brushes, instances and lighting, so opening it does not require copying art into `src/` or `public/`.

Keep each content project in its own directory, preferably outside the toolkit checkout:

```text
Documents/
  GitHub/terrain-tools/          # Editor, runtime, tests and general documentation
  Terrain Studio Projects/
    My Landscape/
      My-Landscape.terrain      # OPEN THIS: the main editable project
      README.md                 # Open/rebuild instructions and known limits
      CREDITS.md                # Artists, links, licenses and modifications
      content-manifest.json     # Content manifest, units, versions and checksums
      sources/                  # Original downloads and DCC authoring files
      prepared/                 # Converted heightmaps, texture sets and static GLBs
      scenes/                   # Alternate scenes and named editable revisions
      tools/                    # This project's conversion/build scripts
      exports/                  # GLBs, baked maps and other delivery files
      evidence/                 # Optional validation logs and screenshots
```

The **main `.terrain` file belongs in the root**, like a solution/project file in a desktop tool. Open it directly with **Open** in Terrain Studio. Use one clearly named main document; put lighting studies, alternate scenes and named revisions in `scenes/`. `exports/` is for delivery output, not the working project. Create supporting directories only as needed.

This keeps the existing native package version and embedded assets. The document is self-contained; surrounding files preserve source artwork, credits and reproducibility. `content-manifest.json` is supporting inventory. Give it `"kind": "terrain-content-manifest"` and `"project": "My-Landscape.terrain"`, relative to the project root. If selected in **Open**, the editor points to the document. Legacy metadata and documents under `exports/` remain readable.

The Project tab explains the layout and saving behavior:

![Project file guidance in the editor](benchmarks/project-files-2026-10-20.png)

## Create a project folder

From the toolkit checkout, with Node 22.12+ (Node 24 used for development):

```powershell
npm ci
npm run build:runtime
npm run project:create -- "C:/Users/your-name/Documents/Terrain Studio Projects/My Landscape"
npm run dev
```

The last path must be a **new folder** inside an existing parent. The command creates a 256 m, 128 × 128 cell editable project named after the folder, a root `.terrain` file, credit/inventory/readme files and the supporting directories above (except optional `evidence/`). It installs no dependencies in the content folder and refuses existing folders, including empty ones. Open the printed `.terrain` path in the editor, then generate/sculpt terrain and import your art. You can also create a folder yourself and place an existing saved document at its root.

## Work in the editor

1. Run `npm ci` once in the toolkit checkout, then `npm run dev`. Open Vite's printed Local URL.
2. Use **Open** to select a content project's `.terrain` file. A full project open restores its embedded brushes, maps, instances and lighting.
3. Use **Save project** after editing. Choose the **project root** if the browser asks, or move the downloaded file there. Deliberately replace the main document when saving ongoing work; put named revisions in `scenes/` so the root has one obvious entry. Browser autosave is a recovery copy for the current browser/site address; it does not update the disk file automatically.
4. Import PBR sets and foliage from `prepared/`, retaining original downloads and license files in `sources/`. Use **Export scene** for GLB delivery and put the result in `exports/`.
5. Keep revisions as separate named files or use a dedicated content repository with appropriate large-file storage. Back up both the editable document and the original authoring sources.

Use **Save surface**, **Save brush**, and sculpt presets for reusable content across projects. Keep those files in the content library, then load them through the normal editor controls. The toolkit need not contain a named scene button, a hardcoded local path, or a dependency on a particular artist's asset pack.

## Reorganize an existing project

Move the main document from `exports/` to the root **without regenerating it**. Put other editable scene variants in `scenes/`, and update `project` / `sourceProject` paths in their manifests. Keep source art, prepared assets, credits, undoable authoring data and original filenames intact. Update local build/validation scripts and README links to use the new paths; builders should refuse to overwrite an artist-edited document. Preserve the manifests' generation checksums: moving a file does not change its bytes, and an edited document must not be relabeled as an untouched generated output. Historical evidence can retain its original paths.

The local Namaqualand, Pine Forest and Tropical Grove projects now use this layout. Namaqualand's lighting variants are in `scenes/`. Their art stays outside this repository. The forest inventory lookup accepts both root documents and the old one-level `exports/` arrangement.

## Convert a DCC scene

A Blender or Unreal scene is not automatically an editable heightfield. Bake a bounded, single-valued terrain surface to PNG16/RAW16 or construct the core height buffer in a project script. Record physical dimensions, elevation range, axis conversion and any excluded overhangs. Keep cliffs and other non-heightfield forms as separate props.

Prepare static GLBs with embedded standard PBR textures and usable pivots. Convert Blender procedural/translucent materials and engine-specific shaders deliberately; the native document does not execute those shaders. Terrain maps use PNG/JPEG/WebP with numeric channels packed into ORM; HDR/EXR support is for environment panoramas. Retain original files and document approximation, reduction and color-space decisions.

For a scripted build, run `npm run build` in the toolkit checkout, then import its public `lib/core.js` from the external project's script. `createProject`, `serializeProjectPackage`, and `parseProjectFile` provide document construction and validation. Accept the toolkit path as a script argument rather than modifying app source. Run the script from the content project; use the toolkit's existing locked dependencies where required and record their versions. No additional application package or plugin is necessary.

Validate the native package, then open it in a fresh browser profile, inspect close and distant views, and save/reopen it. Check real asset memory and frame cost; file admission limits are not GPU performance guarantees. Keep evidence with the content project and promote only reusable fixes or concise general findings into the toolkit. See [file limits and recovery](PROJECT-FILES.md), [material import](MATERIALS.md), and [foliage import](FOLIAGE.md).

## Sharing and hosting

Share the `.terrain` document together with credits. Share the source directory separately when collaborators need to rebuild or re-author the artwork. The runtime's `loadTerrain` accepts the native file as a Blob or ArrayBuffer; a separate content host may supply it over HTTP. A deployed viewer can load content URLs without bundling every landscape into the editor build. Configure the content host's access and CORS policy explicitly.

Project directories, linked external assets, a recent-project library, and automatic saving back to the opened filesystem path are not implemented. Embedded packages and explicit browser downloads are the current supported workflow.
