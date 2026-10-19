# Keep content projects outside the toolkit

An artist's landscape is a **`.terrain` document**, not a new application build. Use the same editor and runtime for every landscape. The document embeds its terrain, paint, materials, models, brushes, instances and lighting, so opening it does not require copying art into `src/` or `public/`.

Keep each content project in its own directory, preferably outside the toolkit checkout:

```text
Documents/
  GitHub/terrain-tools/          # Editor, runtime, tests and general documentation
  Terrain Studio Projects/
    My Landscape/
      README.md                 # Open/rebuild instructions and known limits
      CREDITS.md                # Artists, links, licenses and modifications
      content-manifest.json     # Content manifest, units, versions and checksums
      sources/                  # Original downloads and DCC authoring files
      prepared/                 # Converted heightmaps, texture sets and static GLBs
      tools/                    # This project's conversion/build scripts
      exports/                  # Editable .terrain files and delivery exports
      evidence/                 # Local validation logs and screenshots
```

The folder convention is for organization; it is **not a second project format**. Terrain Studio opens the `.terrain` file, not `content-manifest.json` or the directory. A native file is self-contained, while the surrounding directory preserves provenance and reproducible source art.

Give the metadata file `"kind": "terrain-content-manifest"` and a `"project"` field containing the document path, such as `"exports/My Landscape.terrain"`. If someone selects that metadata in **Open**, the editor directs them to the document. Older unversioned manifests with a `.terrain` path in `"project"` receive the same guidance.

## Work in the editor

1. Run `npm ci` once in the toolkit checkout, then `npm run dev`. Open Vite's printed Local URL.
2. Use **Open** to select a content project's `.terrain` file. A full project open restores its embedded brushes, maps, instances and lighting.
3. Use **Save project** after editing. Choose the project's `exports/` directory if the browser asks, or move the downloaded file there. Browser autosave is a recovery copy for the current browser/site address; it is not a directory-backed project library.
4. To start new content, set its name, generate or import terrain, then import PBR sets and foliage from its `prepared/` folder. Save the resulting document in that project's `exports/` directory.
5. Keep revisions as separate named files or use a dedicated content repository with appropriate large-file storage. Back up both the editable document and the original authoring sources.

Use **Save surface**, **Save brush**, and sculpt presets for reusable content across projects. Keep those files in the content library, then load them through the normal editor controls. The toolkit need not contain a named scene button, a hardcoded local path, or a dependency on a particular artist's asset pack.

## Convert a DCC scene

A Blender or Unreal scene is not automatically an editable heightfield. Bake a bounded, single-valued terrain surface to PNG16/RAW16 or construct the core height buffer in a project script. Record physical dimensions, elevation range, axis conversion and any excluded overhangs. Keep cliffs and other non-heightfield forms as separate props.

Prepare static GLBs with embedded standard PBR textures and usable pivots. Convert Blender procedural/translucent materials and engine-specific shaders deliberately; the native document does not execute those shaders. Terrain maps use PNG/JPEG/WebP with numeric channels packed into ORM; HDR/EXR support is for environment panoramas. Retain original files and document approximation, reduction and color-space decisions.

For a scripted build, run `npm run build` in the toolkit checkout, then import its public `lib/core.js` from the external project's script. `createProject`, `serializeProjectPackage`, and `parseProjectFile` provide document construction and validation. Accept the toolkit path as a script argument rather than modifying app source. Run the script from the content project; use the toolkit's existing locked dependencies where required and record their versions. No additional application package or plugin is necessary.

Validate the native package, then open it in a fresh browser profile, inspect close and distant views, and save/reopen it. Check real asset memory and frame cost; file admission limits are not GPU performance guarantees. Keep evidence with the content project and promote only reusable fixes or concise general findings into the toolkit. See [file limits and recovery](PROJECT-FILES.md), [material import](MATERIALS.md), and [foliage import](FOLIAGE.md).

## Sharing and hosting

Share the `.terrain` document together with credits. Share the source directory separately when collaborators need to rebuild or re-author the artwork. The runtime's `loadTerrain` accepts the native file as a Blob or ArrayBuffer; a separate content host may supply it over HTTP. A deployed viewer can load content URLs without bundling every landscape into the editor build. Configure the content host's access and CORS policy explicitly.

Project directories, linked external assets, a recent-project library, and automatic saving back to the opened filesystem path are not implemented. Embedded packages and explicit browser downloads are the current supported workflow.
