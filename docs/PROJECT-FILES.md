# Project files and recovery

## Save, open, and migrate

**Save project** downloads a `.terrain` package containing the complete editable document. Terrain buffers and embedded assets are stored as binary chunks; matching asset data URLs share one chunk. This avoids decimal float arrays and repeated base64 payloads in the file. The format is lossless and does not compress already encoded image/model data.

**Open** detects the content signature, so a renamed file still works. Existing version-1 JSON projects, JSON autosaves, and version-1 inline GLB project extensions remain readable. Larger legacy JSON saves can be opened for migration, then saved as `.terrain`. New GLB exports use version 2 of `TERRAIN_tools_project`, pointing to a binary package in a buffer view. Standard viewers retain the static presentation; Terrain Studio restores the authored behavior.

Autosave stores the same immutable package as a Blob in IndexedDB. Writes run in order, and failed writes leave the previous committed record intact. A failed or outdated save cannot mark a newer edit as saved. Existing JSON autosaves migrate on the next successful save. Autosave belongs to the current browser profile and site address; use downloaded files when changing addresses or browsers. Browser storage quota still applies; **Save to file** indicates that local persistence failed. Keep downloaded files as portable backups.

Props and Foliage show embedded asset usage. **Remove unused models** removes only models unreferenced by every prop, brush, and LOD; it is undoable. Surface maps and HDR images remain part of their authored settings.

Portable [sculpt presets](SCULPTING.md#reuse-sculpt-presets) use `.sculpt.json` files containing tool settings and the custom alpha; load them from the Sculpt inspector. Foliage brush files remain a separate format. Use the full project package to preserve scene contents.

## Limits

| Item                             | Limit                                                             |
| -------------------------------- | ----------------------------------------------------------------- |
| Native `.terrain` file           | 512 MiB                                                           |
| Distinct embedded asset payloads | 384 MiB, checked before asset imports commit                      |
| Individual prepared model GLB    | 320 MiB, for Props and Foliage                                    |
| Native metadata                  | 64 MiB                                                            |
| Terrain scene GLB                | 1 GiB total; 128 MiB JSON chunk                                   |
| Legacy JSON input file           | 384 MiB                                                           |
| SDK legacy JSON output           | 100 million UTF-16 code units; use `.terrain` for larger projects |
| Portable foliage brush JSON      | 100 MB                                                            |
| Portable sculpt preset JSON      | 8 MiB; custom alpha up to 512 × 512 samples                       |

The asset allowance leaves room for editable metadata and maximum supported terrain/alpha buffers. Individual source imports allow 320 MiB per prepared GLB, 256 MiB per surface map (up to 16 megapixels), and 32 MB per HDR/EXR environment. Foliage selection batches may total 384 MiB, including glTF dependencies. These file limits do not guarantee a GPU or process-memory budget. The package writer checks the document schema before producing a file, and failed or oversized imports leave the current scene and history intact.

Model admission is shared by import, document validation, rendering and package reload. Native base64 codecs (with bounded fallbacks) avoid full-size temporary binary strings during model decoding and package writing. Authoring documents still hold embedded model strings in memory, so the 320 MiB ceiling is deliberate; multi-gigabyte sources and collections need a future linked/binary asset store. Native `.terrain` packages avoid the separate string-size limits of legacy JSON exports and portable foliage brush files.

## Core API

```ts
import {
  ProjectPackageWriter,
  parseProjectFile,
  readProjectFile,
} from 'terrain-tools';

const writer = new ProjectPackageWriter();
const blob = writer.encode(project); // Reuses unchanged asset blobs across saves.
const restored = parseProjectFile(await blob.arrayBuffer());
const opened = await readProjectFile(file); // Checks Blob/File size before reading.
writer.clear(); // Release the reusable encoder cache.
```

`serializeProjectPackage(project)` creates a package without retaining an encoder cache. `parseProjectPackage(arrayBuffer)` accepts only native packages. `parseProjectFile(stringOrArrayBuffer)` detects JSON, native packages, and terrain GLBs. `readProjectFile(blob)` provides bounded file loading. `projectAssetBytes`, `assertProjectCapacity`, and `unusedModelAssetIds` support host admission and cleanup workflows. `serializeProject` / `parseProject` retain the legacy JSON API. `loadTerrain` accepts package or GLB ArrayBuffers, browser Files/Blobs, and legacy JSON strings.

## Background encoding

The editor captures an immutable snapshot and encodes it on a worker for both autosave and **Save project**. You can keep editing while a file is prepared; the downloaded filename and contents match the state at the click. Only that download button is disabled until its request completes.

Autosave keeps the active encoding and the newest pending autosave. Intermediate pending autosaves are replaced; callers share the newest result. Exact file snapshots retain their queue position. The editor permits at most two pending snapshots in addition to the active request. IndexedDB commits stay ordered, duplicate coalesced Blobs are written once, and a failed encoding or write leaves the last committed save intact. Worker errors reset its cache so a later request can recover.

Unchanged model/map/HDR payloads are sent to the worker once. Asset aliases share one dictionary entry; the next successful request drops removed payloads. Common foliage records use Float64 values and indexed brush/model names for transfer, avoiding a second object-graph copy; records with extensions or a different property order use the general snapshot path. Snapshot metadata and terrain/alpha buffers are copied on the main thread, and the copied buffers are transferred without detaching live editing buffers. The first transfer of a new asset string still costs main-thread time and duplicates that string into the worker. The worker retains current asset strings and encoded Blobs, so this is a responsiveness improvement, not a zero-copy or fixed-memory guarantee.

```ts
import { BackgroundProjectWriter } from 'terrain-tools';

const writer = new BackgroundProjectWriter({
  maxPending: 4,
  timeoutMs: 120_000,
});
const exact = writer.encode(project); // Snapshot captured now; returns Promise<Blob>.
// Editing project after this call does not change the resulting file.
const blob = await exact;

// Opt-in coalescing: replaced pending callers receive the newest pending Blob.
await writer.encodeLatest(project);
console.log(writer.stats); // Queue, cached asset count/characters, and timing data.
writer.dispose(); // Terminates the worker, releases caches, rejects outstanding requests.
```

The default host is a browser Worker bundled beside the library. Serve the complete `lib` directory, including `lib/assets`; the worker URL resolves relative to the module. Other hosts can supply `workerFactory`. The default queue allows four pending snapshots (configurable 1–64); a full exact-save queue rejects instead of growing without bound. One encoding times out after 120 seconds by default. Keep the synchronous `ProjectPackageWriter` API for environments without workers.

## Binary layout, version 1

All integer fields and Float32 samples are little-endian. The header is 32 bytes:

| Offset | Field                                           |
| -----: | ----------------------------------------------- |
|      0 | Eight-byte signature: `TRNPACK` followed by NUL |
|      8 | uint32 package version, currently 1             |
|     12 | uint32 UTF-8 manifest byte length               |
|     16 | uint32 padded payload byte length               |
|     20 | uint32 CRC-32 of manifest bytes                 |
| 24, 28 | Reserved uint32 fields, zero                    |

The manifest follows the header, padded to a four-byte boundary. It contains `{ kind: "terrain-project", version: 1, project, chunks }`. The authoring schema remains version 1. Buffer and asset fields in `project` contain `{ chunk: index }` references. Chunk descriptors record `kind` (`float32`, `uint8`, or `asset`), byte length, and CRC-32. Asset descriptors also retain the data-URL prefix, base64 character count, and final characters for legacy spelling compatibility.

Payload chunks follow descriptor order, each padded to four bytes. CRC-32 uses the reflected IEEE polynomial `0xEDB88320` and covers unpadded content. Readers validate lengths, supported versions, reference kinds, total budgets, checksums, and the reconstructed project schema. Unreferenced chunks and mismatched asset tails are rejected. Checksums detect accidental corruption; they do not authenticate a file.

The v2 GLB extension is `{ version: 2, bufferView: index }`; that view contains a complete native package in the GLB binary buffer. `extensionsUsed` lists the extension, while ordinary presentation geometry and instancing remain standard glTF data.
