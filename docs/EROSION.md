# Terrain erosion

## Weather an existing landscape

In **Sculpt**, choose **Weather landscape**. Select hydraulic channels, thermal slopes, or rainfall followed by thermal settling. **Calculate preview** runs on a separate worker. Orbit and zoom in the viewport, then switch between **Original** and **Result**. Each calculation starts from the terrain at the time the panel opened; it does not accumulate earlier previews.

**Apply erosion** commits heights and settings as one undoable action. It refreshes terrain geometry, surface rules, foliage/prop anchors, and collision. **Cancel**, the close button, or Escape terminates an active worker and discards its result. Editing settings invalidates an existing preview. Authoring controls are disabled during preview; original project data remains available to autosave. Physics test bodies are cleared on entry.

A preview retains the committed terrain, picking buffers, foliage and props. Original, Cancel, and settings changes restore those resources without rebuilding. Recoverable preview, collision or history-capture failures restore the original landscape and preserve undo/redo; the panel keeps the calculated result available for retry. Apply also works while viewing Original. Collision changes only after preparation and history capture succeed.

Erosion settings persist in native projects, legacy JSON, autosave, and embedded scene GLB, and survive terrain generation. See [recovery verification](benchmarks/erosion-recovery-2026-10-15.json) for failure injection, exact restoration, retry and native undo/redo evidence.

## Choose the effect

| Control                    | Effect                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Droplets / cell            | Rainfall coverage. Start at 2; increase toward 4–8 for more developed drainage.                                                       |
| Rainfall seed              | Repeats the same droplet paths for the same terrain and settings.                                                                     |
| Channel radius             | Soil-removal footprint in grid cells. Narrow kernels cut sharper channels. The panel reports metres per cell.                         |
| Hydraulic depth limit      | Maximum excavation below the input surface, in metres. Applies to the hydraulic stage; later thermal settling can move more material. |
| Stable slope               | Angle of repose in degrees. Thermal transport moves soil only where neighbouring height differences exceed this angle.                |
| Thermal passes / rate      | Duration and amount of settling. Higher values soften steep ridges and form deposits below them.                                      |
| Removal / deposition rates | Fractions of available soil/carrying capacity exchanged per droplet step.                                                             |
| Sediment capacity          | Scales the load carried by flowing water. Zero disables hydraulic removal.                                                            |
| Flow inertia               | Direction persistence. Low values follow the local gradient more closely.                                                             |
| Evaporation / travel steps | Control how far droplets can carry sediment before depositing their remaining load.                                                   |

The **Erode** brush uses the same conservative thermal transport locally. **Erode · stable slope**, brush strength, pressure, radius, falloff, and alpha determine the effect. Transfers require both endpoints to be inside the editable mask, so the brush does not deposit outside its footprint.

## Boundaries and interpretation

The outermost vertices and vertices touching painted holes or prop cutouts stay fixed. Droplets that reach these protected areas drain away with their sediment. Other droplets deposit their remaining load on evaporation or travel completion. The preview reports removed, deposited, and drained hydraulic volumes; thermal settling redistributes soil without net loss, apart from floating-point rounding.

Heights stay within the terrain bounds. The algorithm does not change hole masks, paint, material definitions, foliage placements, or props. Altitude/slope-based surface appearance and placement heights follow the new terrain; population rules are not re-run automatically.

This is an artistic heightfield process, not a calibrated hydrology or geotechnical model. Rainfall is a sampling density, not a measured rainfall rate. Grid resolution changes available channel detail and the world width of the kernel. Flat surfaces with no downhill gradient remain flat. Maximum settings can be expensive on a 512-cell grid; the worker remains cancellable.

The particle-flow design uses the gradient, sediment-capacity, erosion, and deposition concepts illustrated in [Sebastian Lague's hydraulic erosion implementation](https://github.com/SebLague/Hydraulic-Erosion/blob/master/Assets/Scripts/Erosion.cs). This implementation adds world-scale normalization, bounded excavation, protected cutout rims, explicit drainage accounting, and isolated authoring transactions.

## Core API

```ts
import {
  defaultErosionSettings,
  runErosion,
  effectiveHoles,
} from 'terrain-tools';

const settings = { ...defaultErosionSettings(), seed: 23, rainfall: 4 };
const result = runErosion(
  { ...project, holes: effectiveHoles(project) },
  settings,
);
// The input buffers remain unchanged. The host owns project, terrain and history.
const candidate = { ...project, heights: result.heights, erosion: settings };
const edit = terrain.beginEdit(candidate);
let colliders;
try {
  terrain.rebuildTerrain(); // beginEdit already anchors candidate foliage and props.
  colliders = physics?.prepare(
    candidate,
    undefined,
    terrain.collisionMeshes(true, false),
  );
  if (colliders) physics!.assertPrepared(colliders);
  history.checkpoint(project);
  if (colliders) physics!.apply(colliders);
  edit.commit();
  project = candidate;
} finally {
  colliders?.dispose();
  edit.dispose(); // Restores retained resources if preparation or history capture failed.
}
```

`runErosion` is synchronous. For interactive tools, consume the `erodeTerrain` generator in a worker and post its progress messages. It returns the same result on completion. Terminating the worker discards its private working buffers. The package core has no Three.js or physics dependency.
