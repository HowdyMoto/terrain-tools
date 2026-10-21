import {
  propCutoutControls,
  bindPropCutoutControls,
  placementFootprintControls,
} from './editor/prop-cutout-controls';
import { fitPropCutout } from './core/props';
import {
  defaultWaterSettings,
  parseWaterSettings,
  waterPreset,
} from './core/water';
import type { WaterSettings } from './core/water';
import type { PreparedWater } from './runtime/water';
import { waterControls, bindWaterControls } from './editor/water-controls';
import {
  renderCompactInspector,
  updateInspectorTool,
} from './editor/inspector-layout';
import { parseEyeHeight, resizeTerrain } from './core/project-settings';
import {
  foliageFlexibilityControls,
  bindFoliageFlexibilityControls,
} from './editor/foliage-flexibility-controls';
import type { FoliageBrush, PropInstance, TerrainProject } from './core/types';
import {
  foliageShadingControls,
  bindFoliageShadingControls,
} from './editor/foliage-shading-controls';
import type { PreparedFoliage } from './runtime/foliage';
import type { PreparedSurface, PreparedViewport } from './render/viewport';
import type { ViewportLoadStage } from './render/viewport';
import { StartupLoading } from './editor/startup-loading';
import type { EditTransaction } from './render/edit-transaction';
import type { PreparedColliders } from './physics/rapier';
import type { TransformControlsMode } from 'three/addons/controls/TransformControls.js';
import { cancelled, checkSignal } from './render/resources';
import {
  foliageDetailControls,
  bindFoliageDetailControls,
} from './editor/foliage-lod-controls';
import {
  environmentControls,
  bindEnvironmentControls,
} from './editor/environment-controls';
import { MAX_ENVIRONMENT_BYTES } from './runtime/environment';
import { updateDaylightReadout } from './editor/daylight-controls';
import {
  defaultEnvironmentSettings,
  parseEnvironmentSettings,
} from './core/environment';
import type { EnvironmentSettings } from './core/environment';
import { defaultErosionSettings } from './core/erosion';
import { showErosionPanel } from './editor/erosion-panel';
import { showOrmPanel } from './editor/orm-panel';
import { showMaterialImport } from './editor/material-import-panel';
import { readTextureDataUrl } from './editor/orm-client';
import { textureAccept } from './editor/texture-formats';
import { showFoliageImport } from './editor/foliage-import-panel';
import { foliageImportDraft } from './editor/foliage-import';
import {
  serializeMaterialPreset,
  parseMaterialPreset,
  applyMaterialPreset,
  MAX_MATERIAL_PRESET_BYTES,
} from './core/material-preset';
import type { MaterialLayer } from './core/types';
import type { TerrainBakeResolution } from './runtime/bake-material';
import {
  applyHeightmap,
  decodeRaw16,
  encodeRaw16,
  terrainHeightmap,
  resampleHeightmap,
  sampleHeightmap,
} from './core/heightmap';
import { decodeHeightmapPNG, encodeHeightmapPNG } from './core/heightmap-png';
import {
  defaultSculptSettings,
  defaultSculptBrushSettings,
  SCULPT_BRUSH_TOOLS,
  builtInAlpha,
} from './core/sculpt';
import {
  serializeSculptPreset,
  parseSculptPreset,
  MAX_SCULPT_PRESET_BYTES,
} from './core/sculpt-preset';
import type { SculptSettings, SculptBrushSettings } from './core/types';
import './style.css';
import './editor/inspector-layout.css';
import {
  createIcons,
  Mountain,
  MousePointer2,
  Layers,
  Trees,
  Box,
  Sun,
  Undo2,
  Redo2,
  Download,
  Upload,
  Save,
  Maximize,
  Expand,
  Footprints,
  Plus,
  Minus,
  Waves,
  Wind,
  Circle,
  MoveUp,
  MoveDown,
  Brush,
  Scissors,
  Eraser,
  Grid2X2,
  ChevronDown,
  ChevronRight,
  Play,
  Settings2,
  Sprout,
  LocateFixed,
  Trash2,
  Info,
  ImagePlus,
  Check,
  X,
  FolderOpen,
} from 'lucide';
import {
  createProject,
  applyBrush,
  populateFoliage,
  generateTerrain,
  heightAt,
} from './core/terrain';
import {
  serializeFoliageBrush,
  importFoliageBrush,
} from './core/foliage-preset';
import {
  addDefaultFoliage,
  defaultFoliageChoices,
  foliageCreditsURL,
} from './editor/default-foliage';
import type { DefaultFoliageKind } from './editor/default-foliage';
import { foliageModels, editFoliageModels } from './core/foliage';
import { readProjectFile } from './core/glb-project';
import { checkModelFileSize } from './core/model-limits';
import {
  assertProjectCapacity,
  projectAssetBytes,
  unusedModelAssetIds,
} from './core/project-package';
import { History } from './core/history';
import type { BrushStroke, SculptTool } from './core/types';
import { Viewport } from './render/viewport';
import { bindViewportNavigation } from './editor/viewport-navigation';
import type { TerrainRegion } from './runtime/terrain-scene';
import {
  download,
  loadLocal,
  saveLocal,
  readDataUrl,
  projectDownload,
} from './editor/storage';
const iconSet = {
  Mountain,
  MousePointer2,
  Layers,
  Trees,
  Box,
  Sun,
  Undo2,
  Redo2,
  Download,
  Upload,
  Save,
  Maximize,
  Expand,
  Footprints,
  Plus,
  Minus,
  Waves,
  Wind,
  Circle,
  MoveUp,
  MoveDown,
  Brush,
  Scissors,
  Eraser,
  Grid2x2: Grid2X2,
  ChevronDown,
  ChevronRight,
  Play,
  Settings2,
  Sprout,
  LocateFixed,
  Trash2,
  Info,
  ImagePlus,
  Check,
  X,
  FolderOpen,
};
const icon = (name: string) => '<i data-lucide="' + name + '"></i>';
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const refreshIcons = () =>
  createIcons({ icons: iconSet, attrs: { 'stroke-width': 1.6 } });
let project = createProject();
const history = new History();
let tab = 'sculpt',
  tool: SculptTool = 'raise',
  materialIndex = 0,
  brushIndex = 0,
  foliageModelIndex = 0,
  selectedProp: number | null = null;
let propFootprintMode: 'circle' | 'rectangle' | 'model' = 'circle';
let propWidth = 7,
  propDepth = 5;
let propTransformMode: TransformControlsMode = 'translate';
let propSnap = false;
let radius = 12,
  strength = 1,
  falloff = 0.65,
  targetHeight = 10,
  propModel = 'boulder',
  propCut = false,
  propRadius = 3,
  dropMode = false,
  strokeSeed = 1;
let saveTimer: ReturnType<typeof setTimeout>,
  rebuildTimer: ReturnType<typeof setTimeout>;
let dirty = false;
let documentRevision = 0;
let activePreparation: AbortController | undefined;
let assetLodIndex: number | null = null;
let surfacePresetRules = false;
let selectedWater = 'ocean';
let pendingWater: WaterSettings | undefined;
let waterPlacement: 'ellipse' | 'basin' | 'polygon' | null = null;
let waterPoints: { x: number; y: number; z: number }[] = [];
let waterDraftProject: TerrainProject | undefined;
let erosionPanel: ReturnType<typeof showErosionPanel> | undefined;
let ormPanel: ReturnType<typeof showOrmPanel> | undefined;
let exportController: AbortController | undefined;
let heightmapMinimum = -20,
  heightmapMaximum = 60,
  heightmapFlip = false,
  rawWidth = 129,
  rawHeight = 129,
  rawLittleEndian = true;
const sculptSettings = () => project.sculpt ?? defaultSculptSettings();
const editSculptSettings = () => (project.sculpt ??= defaultSculptSettings());

function rememberSculptBrush() {
  viewport.finishStroke();
  if (
    tab !== 'sculpt' ||
    !SCULPT_BRUSH_TOOLS.includes(tool as SculptBrushSettings['tool'])
  )
    return;
  cancelPreparation();
  documentRevision++;
  editSculptSettings().brush = {
    name: sculptSettings().brush?.name ?? 'Sculpt brush',
    tool: tool as SculptBrushSettings['tool'],
    radius,
    strength,
    falloff,
    target: targetHeight,
  };
  persist();
}
function restoreSculptBrush() {
  if (tab !== 'sculpt') return;
  const brush = sculptSettings().brush ?? defaultSculptBrushSettings();
  radius = brush.radius;
  strength = brush.strength;
  falloff = brush.falloff;
  targetHeight = brush.target;
  viewport.brushRadius = radius;
  setTool(brush.tool, false);
}
function activeAlpha(stamp = false) {
  const settings = sculptSettings();
  if (settings.alphaKind === 'custom') return settings.alpha;
  if (settings.alphaKind === 'none' && !stamp) return undefined;
  return builtInAlpha(
    settings.alphaKind === 'none' ? 'round' : settings.alphaKind,
  );
}
function syncSculptInput() {
  viewport.stampOnce = tool === 'stamp';
  viewport.brushSquare = tool === 'stamp';
  viewport.brushRotation = (sculptSettings().rotation * Math.PI) / 180;
  viewport.pressureEnabled = sculptSettings().pressure;
}
let activeStroke:
  { original: TerrainProject; view: EditTransaction; seed: number } | undefined;
let strokeProps = false;
let strokeRegion: TerrainRegion | undefined;
let pendingRegion: TerrainRegion | undefined,
  pendingFoliage = false,
  strokeChanged = false,
  strokeGeometry = false;
function mergeRegion(
  a: TerrainRegion | undefined,
  b: TerrainRegion,
): TerrainRegion {
  return a
    ? {
        minX: Math.min(a.minX, b.minX),
        maxX: Math.max(a.maxX, b.maxX),
        minZ: Math.min(a.minZ, b.minZ),
        maxZ: Math.max(a.maxZ, b.maxZ),
      }
    : b;
}
const tools: { id: SculptTool; name: string; icon: string; hint: string }[] = [
  {
    id: 'stamp',
    name: 'Stamp',
    icon: 'image-plus',
    hint: 'Place a rotated height stamp once per click',
  },
  { id: 'raise', name: 'Raise', icon: 'move-up', hint: 'Build up the terrain' },
  {
    id: 'lower',
    name: 'Lower',
    icon: 'move-down',
    hint: 'Carve into the terrain',
  },
  {
    id: 'smooth',
    name: 'Smooth',
    icon: 'waves',
    hint: 'Soften height transitions',
  },
  {
    id: 'flatten',
    name: 'Flatten',
    icon: 'minus',
    hint: 'Blend toward the target elevation',
  },
  {
    id: 'terrace',
    name: 'Terrace',
    icon: 'layers',
    hint: 'Create stepped landforms',
  },
  {
    id: 'noise',
    name: 'Noise',
    icon: 'mountain',
    hint: 'Add seeded surface variation',
  },
  {
    id: 'erode',
    name: 'Erode',
    icon: 'wind',
    hint: 'Move loose soil down slopes above the stable angle',
  },
  {
    id: 'hole',
    name: 'Cut hole',
    icon: 'scissors',
    hint: 'Remove surface and collision',
  },
  {
    id: 'fill',
    name: 'Fill hole',
    icon: 'plus',
    hint: 'Restore manually cut terrain',
  },
];
$('#app').innerHTML =
  `<header class="topbar"><a class="brand" href="#" aria-label="Terrain Studio">${icon('mountain')}<span>TERRAIN<span class="brand-light">STUDIO</span></span><span class="preview-badge">DEV</span></a><div class="project-title"><span class="project-dot"></span><input maxlength="120" id="project-name" value="Alpine study" aria-label="Project name"/><span id="save-state">Local project</span></div><div class="top-actions"><button class="icon-button" id="undo" title="Undo · Ctrl Z" aria-label="Undo">${icon('undo-2')}</button><button class="icon-button" id="redo" title="Redo · Ctrl Shift Z" aria-label="Redo">${icon('redo-2')}</button><span class="divider"></span><button id="open" title="Open the .terrain file in your project folder’s root">${icon('folder-open')}Open</button><button id="save">${icon('save')}Save project</button><select id="export-mode" aria-label="GLB surface export" title="PBR mode bakes one terrain atlas; higher resolutions retain more surface detail."><option value="colors">Fast colors</option><option value="pbr-1024">PBR · 1024²</option><option value="pbr-2048">PBR · 2048²</option><option value="pbr-4096">PBR · 4096²</option></select><button id="export" class="primary">${icon('download')}Export scene</button></div></header>
<div class="workspace"><nav class="rail" aria-label="Editor tools">${[
    ['sculpt', 'mountain', 'Sculpt'],
    ['materials', 'layers', 'Surfaces'],
    ['foliage', 'trees', 'Foliage'],
    ['props', 'box', 'Props'],
    ['light', 'sun', 'Light'],
    ['wind', 'wind', 'Wind'],
    ['water', 'waves', 'Water'],
    ['project', 'settings-2', 'Project'],
  ]
    .map(
      ([id, i, label]) =>
        `<button data-tab="${id}" class="rail-button ${tab === id ? 'active' : ''}" title="${label}">${icon(i)}<span>${label}</span></button>`,
    )
    .join(
      '',
    )}<button id="help" class="rail-button help-button" title="Controls and workflow">${icon('info')}<span>Guide</span></button></nav>
<aside class="inspector"><div id="inspector-content"></div><div class="inspector-footer"><span class="live-dot"></span>All dimensions in metres</div></aside>
<main class="stage"><div id="viewport"></div><div class="viewport-top"><div class="viewport-label"><span class="live-dot"></span><span id="view-mode">Perspective</span> <span class="muted">/</span> Lit</div><div class="viewport-actions"><button id="walk" title="Choose where to walk · V" aria-label="Walk in first person" aria-keyshortcuts="V" aria-pressed="false">${icon('footprints')}</button><button id="fullscreen" title="Fullscreen 3D view · Shift+F" aria-label="Fullscreen 3D view" aria-keyshortcuts="Shift+F" aria-pressed="false">${icon('expand')}</button><button id="frame" title="Frame terrain · F" aria-label="Frame terrain">${icon('maximize')}</button><button id="wire" title="Toggle wireframe" aria-label="Toggle wireframe">${icon('grid-2x2')}</button><button id="screenshot" title="Save viewport image" aria-label="Save viewport image">${icon('image-plus')}</button></div></div><div id="walk-placement-label" aria-hidden="true" hidden></div><div id="walk-reticle" aria-hidden="true"></div><div class="viewport-bottom"><div id="walk-hint" class="tool-pill" role="status" hidden></div><div class="tool-pill" id="active-tool">${icon('brush')}<span>Raise terrain</span><kbd>LMB</kbd></div><div class="axis-widget"><span class="axis-y">Y</span><span class="axis-z">Z</span><span class="axis-x">X</span></div></div><div id="toast" role="status" aria-live="polite"></div></main>
<aside class="scene-panel"><div class="panel-heading"><h2>Scene</h2><span class="count" id="scene-count">01</span></div><div class="scene-root">${icon('chevron-down')}${icon('layers')}<span>Landscape</span></div><button class="scene-item selected" id="terrain-select">${icon('mountain')}<span>Terrain surface</span><span class="tag">MESH</span></button><div class="scene-item">${icon('trees')}<span>Foliage instances</span><span id="foliage-count" class="count">0</span></div><div class="scene-item">${icon('waves')}<span>Ocean</span><button id="water-toggle" class="text-button" aria-label="Toggle ocean visibility" title="Show or hide the ocean. Set its height in Water.">On</button></div><div id="prop-list"></div><div class="scene-section"><h3>Surface layers <span>4</span></h3><div id="layer-list"></div></div><div class="scene-section terrain-info"><h3>Terrain information</h3><dl><dt>Grid / size</dt><dd><span id="resolution-label"></span> cells<small id="size-label"></small></dd><dt>Cell spacing</dt><dd id="spacing-label"></dd><dt>Shading</dt><dd id="shading-label">Smooth</dd></dl></div><div class="scene-section physics-card"><div class="physics-heading">${icon('circle')}<h3>Physics preview</h3><span class="tag">RAPIER</span></div><p>Drop a body to test the surface, cutouts, and foliage recovery.</p><button id="physics" class="full-button">${icon('play')}Enable physics</button><button id="clear-balls" class="text-button full-button">Clear test bodies</button></div><div class="scene-bottom"><span class="live-dot"></span><span id="physics-state">Collision preview off</span></div></aside></div>
<footer class="statusbar"><div><span class="status-key">LMB</span> sculpt <span class="status-key">RMB</span> orbit <span class="status-key">MMB</span> pan <span class="status-key">Scroll</span> zoom</div><div id="coordinates">X 0.0 &nbsp; Y 0.0 &nbsp; Z 0.0</div><div><span id="triangle-count">— triangles</span><span class="status-separator">|</span><span id="fps">— FPS</span><span class="gpu-dot"></span>WebGPU</div></footer><div id="prop-transform-tools" hidden><div class="button-row"><button data-prop-transform="translate" aria-pressed="true">Move</button><button data-prop-transform="rotate" aria-pressed="false">Rotate</button><button data-prop-transform="scale" aria-pressed="false">Scale</button></div><label title="Move: 0.5 m · Rotate: 15° · Uniform scale: 0.1"><input id="prop-snap" type="checkbox"/> Snap</label><span id="prop-transform-hint">Drag a handle · Esc cancels</span></div><div id="preparation-status" hidden role="status"><span></span><button id="cancel-preparation">Cancel</button></div><input id="file-open" type="file" accept=".json,.terrain,.glb" hidden/><input id="heightmap-open" type="file" accept=".png,.r16,.raw" hidden/><input id="alpha-open" type="file" accept="image/png" hidden/><input id="sculpt-preset-open" type="file" accept=".json" hidden/><input id="surface-preset-open" type="file" accept=".json" hidden/><input id="brush-open" type="file" accept=".json" hidden/><input id="asset-open" type="file" accept=".glb" hidden/><input id="environment-open" type="file" accept=".hdr,.exr" hidden/><input id="texture-open" type="file" accept="${textureAccept}" hidden/><dialog id="guide"><button id="close-guide" class="icon-button dialog-close" aria-label="Close guide">${icon('x')}</button><span class="eyebrow">FIELD NOTES / 01</span><h1>Shape a world.</h1><p>Sculpt the landscape, define its surfaces, then bring it to life.</p><div class="guide-grid"><div><h3>Navigate</h3><p>Right drag to orbit. Middle drag to pan. Scroll to zoom. Press F to frame the terrain. Shift+F toggles fullscreen for the 3D view.</p><h3>Walk the terrain</h3><p>Press V or the footprints button, then point anywhere on the terrain. The marker shows your standing height and facing direction. Click (or press Enter) to start there, including on steep slopes. Right drag while choosing a spot to change your facing direction. V or Esc cancels placement. Move with WASD, look with the mouse, and hold Shift to run. V or Esc restores your editor view. Set eye height (default 1.8 m) and terrain dimensions in the Project tab. Walking follows terrain and stops at edges and holes; it has no continuous prop or foliage collision.</p><h3>Sculpt</h3><p>Left drag applies the selected brush. [ and ] resize it. Flatten uses the target elevation; terrace uses the step height. Cut hole removes entire terrain cells and their collision. Press Esc during a stroke to cancel it.</p></div><div><h3>Build an ecosystem</h3><p>Surfaces blend by altitude and slope. Foliage brushes restrict placement to allowed surface types. Populate uses a reproducible seed.</p><h3>Keep your work</h3><p>Changes autosave in this browser. Save project downloads a compact .terrain package with embedded assets. Keep the main file in your project folder’s root, alternate scenes in scenes/, and delivery GLBs in exports/. Existing JSON projects remain readable. Export scene creates a GLB with terrain, instanced foliage, props, and embedded authoring data. Open the GLB here or in the terrain runtime to restore layered PBR, wind, and interaction. Other GLB viewers show a static scene. Choose PBR beside Export scene to include baked terrain textures, or Fast colors for a smaller vertex-color presentation.</p></div></div><p class="guide-note">This development build supports a single heightfield up to 512 × 512 cells, four material layers, static GLB assets, and 50,000 foliage instances. Large-world streaming and production asset/export workflows are still in development.</p></dialog>`;
// Native device initialization is asynchronous. Keep controls inert until their
// handlers and the restored project are ready.
$('#app').inert = true;
const startupLoading = new StartupLoading();
await startupLoading.stage(0, 'Starting graphics…');
async function downloadLocalProject() {
  const saved = await loadLocal();
  if (!saved)
    throw new Error('No locally saved project was found in this browser.');
  download(
    await projectDownload(saved),
    saved.name.replace(/[^a-z0-9-_]/gi, '-') + '.terrain',
  );
}
const viewport = await Viewport.create($('#viewport'), project).catch(
  (error) => {
    startupLoading.close();
    const panel = document.createElement('section');
    panel.id = 'renderer-unavailable';
    panel.className = 'renderer-notice';
    panel.setAttribute('role', 'alert');
    const title = document.createElement('h1');
    title.textContent = 'WebGPU could not start';
    const message = document.createElement('p');
    message.textContent = String(
      error instanceof Error ? error.message : error,
    );
    const save = document.createElement('button');
    save.textContent = 'Download locally saved project';
    save.onclick = async () => {
      save.disabled = true;
      try {
        const saved = await loadLocal();
        if (!saved) {
          message.textContent =
            'No locally saved project was found in this browser.';
          return;
        }
        download(
          await projectDownload(saved),
          saved.name.replace(/[^a-z0-9-_]/gi, '-') + '.terrain',
        );
      } catch (failure) {
        message.textContent =
          'Could not recover local save: ' + String(failure);
      } finally {
        save.disabled = false;
      }
    };
    const retry = document.createElement('button');
    retry.textContent = 'Reload';
    retry.onclick = () => location.reload();
    panel.append(title, message, save, retry);
    document.body.append(panel);
    throw error;
  },
);
$('#viewport').addEventListener('terrain-renderer-lost', () => {
  startupLoading.close();
  cancelPreparation();
  $('#app').inert = true;
  const panel = document.createElement('section');
  panel.className = 'renderer-notice';
  panel.setAttribute('role', 'alert');
  const message = document.createElement('p');
  message.textContent =
    'The graphics device disconnected. Save your project, then reload to restart WebGPU.';
  const save = document.createElement('button');
  save.textContent = 'Save project';
  save.onclick = () => $('#save').click();
  const reload = document.createElement('button');
  reload.textContent = 'Reload';
  reload.onclick = () => location.reload();
  panel.append(message, save, reload);
  document.body.append(panel);
});
bindViewportNavigation(viewport, {
  unavailable: () =>
    $('#app').inert ||
    !!activePreparation ||
    !!document.querySelector('dialog[open]'),
  onChange: syncPropTools,
  notify,
});
$('#viewport').append($('#prop-transform-tools'));
const range = (
  id: string,
  label: string,
  value: number,
  min: number,
  max: number,
  step = 0.1,
  unit = '',
) =>
  `<label class="range-field"><span>${label}<output id="out-${id}">${value.toFixed(step >= 1 ? 0 : 2)}${unit}</output></span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"/></label>`;
const select = (
  id: string,
  label: string,
  options: [string, string][],
  value: string,
) =>
  `<label class="field"><span>${label}</span><select id="${id}">${options.map(([v, l]) => `<option value="${escape(v)}" ${v === value ? 'selected' : ''}>${escape(l)}</option>`).join('')}</select></label>`;
const toggle = (id: string, label: string, checked: boolean) =>
  `<label class="toggle-field"><span>${label}</span><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}/><span class="switch"></span></label>`;
const section = (title: string, content: string) =>
  `<section class="control-section"><h3>${title}</h3>${content}</section>`;
const metres = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 3 });
const terrainMetrics = (resolution: number, size: number) =>
  `${resolution} × ${resolution} cells · ${metres(size)} × ${metres(size)} m · ${metres(size / resolution)} m/cell`;
const terrainSizeInput = (id: string) =>
  `<label class="field"><span>Terrain width / depth (m)</span><input id="${id}" type="number" min="8" max="10000" step="1" value="${project.size}"/></label>`;
function notify(message: string, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = 'visible' + (error ? ' error' : '');
  setTimeout(() => (toast.className = ''), 4500);
}
function cancelPreparation() {
  pendingWater = undefined;
  viewport.propTools.cancel();
  activePreparation?.abort();
  activePreparation = undefined;
  viewport.cancelLoad();
  $('#preparation-status').hidden = true;
}
async function prepareAction<T extends { dispose(): void }>(
  label: string,
  prepare: (signal: AbortSignal) => Promise<T>,
  apply: (prepared: T) => void,
) {
  viewport.finishStroke();
  cancelPreparation();
  erosionPanel?.close();
  const controller = new AbortController(),
    source = project,
    revision = ++documentRevision;
  activePreparation = controller;
  const status = $('#preparation-status');
  status.querySelector('span')!.textContent = label;
  status.hidden = false;
  let prepared: T | undefined;
  let applying = false;
  try {
    prepared = await prepare(controller.signal);
    checkSignal(controller.signal);
    if (
      activePreparation !== controller ||
      project !== source ||
      documentRevision !== revision
    )
      throw cancelled();
    activePreparation = undefined;
    status.hidden = true;
    applying = true;
    apply(prepared);
    return true;
  } catch (error) {
    if (
      !applying &&
      (controller.signal.aborted || activePreparation !== controller)
    )
      return false;
    throw error;
  } finally {
    prepared?.dispose();
    if (activePreparation === controller) {
      activePreparation = undefined;
      status.hidden = true;
    }
  }
}
function checkpoint() {
  viewport.finishStroke();
  cancelPreparation();
  erosionPanel?.close();
  documentRevision++;
  history.checkpoint(project);
  updateHistory();
}
function updateHistory() {
  const stats = history.stats;
  const detail =
    stats.undoCount +
    ' undo steps · ' +
    stats.redoCount +
    ' redo steps\n' +
    'History: about ' +
    (stats.retainedBytes / 1048576).toFixed(1) +
    ' MiB of ' +
    (stats.byteLimit / 1048576).toFixed(0) +
    ' MiB · up to ' +
    stats.limit +
    ' steps' +
    (stats.overBudget ? '\nOne oversized step retained.' : '') +
    (stats.evictedCount
      ? '\nOlder steps have expired to stay within the history limits.'
      : '');
  const undo = $<HTMLButtonElement>('#undo'),
    redo = $<HTMLButtonElement>('#redo');
  undo.disabled = !history.canUndo;
  redo.disabled = !history.canRedo;
  undo.title = 'Undo · Ctrl+Z\n' + detail;
  redo.title = 'Redo · Ctrl+Shift+Z\n' + detail;
}
let autosaveRevision = 0;
function persist() {
  const revision = ++autosaveRevision;
  dirty = true;
  $('#save-state').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveLocal(activeStroke?.original ?? project)
      .then(() => {
        if (revision !== autosaveRevision) return;
        $('#save-state').textContent = 'Saved locally';
        dirty = false;
      })
      .catch(() => {
        if (revision !== autosaveRevision) return;
        $('#save-state').textContent = 'Save to file';
        notify(
          'Browser storage is unavailable. Use Save project to keep your changes.',
          true,
        );
      });
  }, 600);
  updateScene();
  updateHistory();
}
function resetStroke() {
  clearTimeout(rebuildTimer);
  pendingRegion = undefined;
  pendingFoliage = false;
  strokeRegion = undefined;
  strokeChanged = strokeGeometry = strokeProps = false;
  const hint = document.querySelector('#active-tool kbd');
  if (hint) hint.textContent = 'LMB';
}
function beginBrushStroke() {
  cancelPreparation();
  documentRevision++;
  const original = project;
  // Brushes mutate these buffers and the population array; embedded assets stay shared.
  const candidate: TerrainProject = {
    ...original,
    heights: original.heights.slice(),
    holes: original.holes.slice(),
    paint: original.paint.slice(),
    foliage: original.foliage.slice(),
    ...(original.sculpt
      ? {
          sculpt: {
            ...original.sculpt,
            ...(original.sculpt.brush
              ? { brush: { ...original.sculpt.brush } }
              : {}),
          },
        }
      : {}),
  };
  const view = viewport.beginEdit(candidate);
  activeStroke = { original, view, seed: strokeSeed };
  project = candidate;
  const hint = document.querySelector('#active-tool kbd');
  if (hint) hint.textContent = 'Esc cancels';
}
function rollbackBrushStroke(error?: unknown) {
  const stroke = activeStroke;
  activeStroke = undefined;
  resetStroke();
  viewport.cancelStroke();
  if (stroke) {
    project = stroke.original;
    strokeSeed = stroke.seed;
    stroke.view.rollback();
    documentRevision++;
    updateHistory();
    updateScene();
  }
  if (error)
    notify(
      'Stroke could not be applied. The previous terrain was restored: ' +
        String(error),
      true,
    );
}
function flushBrush() {
  clearTimeout(rebuildTimer);
  try {
    viewport.project = project;
    if (pendingRegion) {
      viewport.rebuildTerrain(pendingRegion, !!activeStroke);
      viewport.content.reanchorFoliage(pendingRegion);
      strokeProps =
        viewport.content.reanchorProps(pendingRegion) || strokeProps;
    }
    if (pendingFoliage) viewport.rebuildFoliage();
    pendingRegion = undefined;
    pendingFoliage = false;
    return true;
  } catch (error) {
    rollbackBrushStroke(error);
    return false;
  }
}
function finishBrushStroke() {
  const stroke = activeStroke;
  if (!stroke) return;
  let colliders: PreparedColliders | undefined;
  try {
    if (!flushBrush()) return;
    if (!strokeChanged) {
      rollbackBrushStroke();
      return;
    }
    if (strokeGeometry)
      colliders = viewport.physics?.prepare(
        project,
        strokeRegion,
        strokeProps ? viewport.content.collisionMeshes(true, false) : undefined,
      );
    if (colliders) viewport.physics!.assertPrepared(colliders);
    // Connectivity can change beyond the brush. Resolve it once before committing;
    // a spill/allocation/history failure still rolls back the complete live preview.
    if (strokeRegion) viewport.content.finalizeWaterPreview();
    history.checkpoint(stroke.original);
    if (colliders) viewport.physics!.apply(colliders);
    stroke.view.commit();
    activeStroke = undefined;
    resetStroke();
    viewport.lighting.fitShadow(project);
    persist();
  } catch (error) {
    rollbackBrushStroke(error);
  } finally {
    colliders?.dispose();
  }
}
function delayedTerrain(stroke: BrushStroke) {
  const foliageOnly = stroke.tool === 'foliage' || stroke.tool === 'erase';
  if (!foliageOnly) {
    const extent =
      stroke.radius *
      (stroke.tool === 'stamp'
        ? Math.abs(Math.cos(stroke.rotation ?? 0)) +
          Math.abs(Math.sin(stroke.rotation ?? 0))
        : 1);
    pendingRegion = mergeRegion(pendingRegion, {
      minX: stroke.x - extent,
      maxX: stroke.x + extent,
      minZ: stroke.z - extent,
      maxZ: stroke.z + extent,
    });
    strokeGeometry ||= stroke.tool !== 'material';
    strokeRegion = mergeRegion(strokeRegion, {
      minX: stroke.x - extent,
      maxX: stroke.x + extent,
      minZ: stroke.z - extent,
      maxZ: stroke.z + extent,
    });
  }
  if (foliageOnly || stroke.tool === 'hole' || stroke.tool === 'fill')
    pendingFoliage = true;
  strokeChanged = true;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(flushBrush, 20);
}
type WorldSettings = Pick<TerrainProject, 'wind' | 'interaction' | 'view'>;
async function editWater(change: (water: WaterSettings) => void) {
  try {
    const water = structuredClone(
      pendingWater ?? project.water ?? defaultWaterSettings(project),
    );
    change(water);
    const candidate = {
      ...project,
      water: parseWaterSettings(water),
      view: {
        ...project.view,
        water: water.ocean.enabled,
        waterLevel: water.seaLevel,
      },
    };
    const preparation = prepareAction(
      'Preparing water…',
      async (signal) => {
        let prepared: PreparedWater | undefined;
        try {
          if (!viewport.content.waterSystem.canUpdateSettings(candidate)) {
            prepared = viewport.content.waterSystem.prepare(candidate);
            viewport.lighting.prepareWater();
            await viewport.content.waterSystem.prepareGPU(
              prepared,
              viewport.renderer,
              viewport.camera,
              viewport.scene,
            );
          }
          checkSignal(signal);
          return {
            prepared,
            dispose() {
              prepared?.dispose();
            },
          };
        } catch (error) {
          prepared?.dispose();
          throw error;
        }
      },
      ({ prepared }) => {
        history.checkpoint(project);
        project.water = candidate.water;
        project.view = candidate.view;
        if (prepared) viewport.content.waterSystem.apply(prepared);
        else viewport.content.waterSystem.updateSettings(project);
        viewport.content.refreshView();
        viewport.lighting.invalidateHistory();
        documentRevision++;
        if (
          selectedWater !== 'ocean' &&
          !water.bodies.some((b) => b.id === selectedWater)
        )
          selectedWater = 'ocean';
        refreshed();
      },
    );
    // Native GPU validation yields. Preserve earlier requested water edits when
    // another control changes before the candidate is committed.
    pendingWater = candidate.water;
    try {
      return await preparation;
    } finally {
      if (pendingWater === candidate.water) pendingWater = undefined;
    }
  } catch (error) {
    renderInspector();
    updateHistory();
    notify(
      'Water change could not be applied. The previous water was kept: ' +
        String(error),
      true,
    );
    return false;
  }
}
function setWaterPlacement(kind: typeof waterPlacement) {
  waterPlacement = kind;
  waterDraftProject = kind ? project : undefined;
  waterPoints = [];
  viewport.showBrush = !!kind;
  viewport.brushRadius =
    kind === 'ellipse' ? Math.min(12, project.size * 0.1) : 1;
  renderInspector();
}
async function finishWaterOutline() {
  if (waterPlacement !== 'polygon' || waterPoints.length < 3) {
    notify('Click at least three points to draw a lake outline.');
    return;
  }
  const id = crypto.randomUUID(),
    previous = selectedWater;
  selectedWater = id;
  if (
    await editWater((w) =>
      w.bodies.push({
        id,
        name: 'Lake ' + (w.bodies.length + 1),
        enabled: true,
        elevation: Math.min(...waterPoints.map((p) => p.y)) + 0.5,
        extent: {
          kind: 'polygon',
          points: waterPoints.map(({ x, z }) => ({ x, z })),
        },
        surface: waterPreset('lake'),
      }),
    )
  )
    setWaterPlacement(null);
  else {
    selectedWater = previous;
    renderInspector();
  }
}
function editWorld(change: (settings: WorldSettings) => void) {
  viewport.finishStroke();
  cancelPreparation();
  erosionPanel?.close();
  let candidate: WorldSettings;
  try {
    candidate = {
      wind: { ...project.wind },
      interaction: { ...project.interaction },
      view: { ...project.view },
    };
    change(candidate);
    history.checkpoint(project);
  } catch (error) {
    renderInspector();
    updateHistory();
    notify(
      'World change could not be applied. The previous settings were kept: ' +
        String(error),
      true,
    );
    return;
  }
  documentRevision++;
  // Foliage reads these records through the retained project on its next frame.
  project.wind = candidate.wind;
  project.interaction = candidate.interaction;
  project.view = candidate.view;
  viewport.content.refreshView();
  persist();
  renderInspector();
}
/** Stage small authoring settings without copying terrain or custom alpha buffers. */
function editSculpt(
  change: (
    settings: SculptSettings,
    erosion: ReturnType<typeof defaultErosionSettings>,
  ) => void,
) {
  viewport.finishStroke();
  cancelPreparation();
  erosionPanel?.close();
  let settings: SculptSettings,
    erosion: ReturnType<typeof defaultErosionSettings>;
  try {
    settings = {
      ...sculptSettings(),
      brush: { ...(sculptSettings().brush ?? defaultSculptBrushSettings()) },
    };
    erosion = { ...(project.erosion ?? defaultErosionSettings()) };
    change(settings, erosion);
    history.checkpoint(project);
  } catch (error) {
    renderInspector();
    updateHistory();
    notify(
      'Brush change could not be applied. The previous settings were kept: ' +
        String(error),
      true,
    );
    return;
  }
  documentRevision++;
  project.sculpt = settings;
  project.erosion = erosion;
  syncSculptInput();
  persist();
  renderInspector();
}
function applyTerrainReplacement(
  prepared: PreparedViewport,
  clearSelection = false,
) {
  viewport.assertPrepared(prepared);
  history.checkpoint(project);
  documentRevision++;
  viewport.applyPrepared(prepared);
  project = viewport.project;
  if (clearSelection) selectedProp = null;
  refreshed();
}
function refreshed() {
  if (waterDraftProject && waterDraftProject !== project) {
    waterPlacement = null;
    waterPoints = [];
    waterDraftProject = undefined;
  }
  restoreSculptBrush();
  renderInspector();
  updateScene();
  updateHistory();
  $<HTMLInputElement>('#project-name').value = project.name;
  persist();
}
function bindRange(
  id: string,
  callback: (value: number) => void,
  undo = false,
) {
  const input = $<HTMLInputElement>('#' + id);
  input.addEventListener('input', () => {
    $('#out-' + id).textContent = Number(input.value).toFixed(
      Number(input.step) >= 1 ? 0 : 2,
    );
  });
  input.addEventListener('change', () => {
    if (undo) checkpoint();
    callback(Number(input.value));
  });
}
function setTool(t: SculptTool, remember = true) {
  viewport.finishStroke();
  viewport.propTools.cancel();
  tool = t;
  updateInspectorTool($('#inspector-content'), t);
  dropMode = false;
  if (viewport.physics)
    $('#physics').innerHTML = icon('circle') + 'Drop test body';
  document
    .querySelectorAll('[data-tool]')
    .forEach((el) =>
      el.classList.toggle('active', (el as HTMLElement).dataset.tool === t),
    );
  const name =
    tools.find((x) => x.id === t)?.name ??
    {
      material: 'Paint surface',
      foliage: 'Paint foliage',
      erase: 'Erase foliage',
      prop: 'Place prop',
      select: 'Select prop',
    }[t as string] ??
    t;
  $('#active-tool').innerHTML =
    icon(t === 'foliage' ? 'trees' : 'brush') +
    '<span>' +
    name +
    '</span><kbd>LMB</kbd>';
  viewport.showBrush = t !== 'select';
  syncPropTools();
  syncSculptInput();
  if (remember) rememberSculptBrush();
  refreshIcons();
}
function changeTab(next: string) {
  viewport.finishStroke();
  waterPlacement = null;
  waterPoints = [];
  tab = next;
  document
    .querySelectorAll('[data-tab]')
    .forEach((el) =>
      el.classList.toggle('active', (el as HTMLElement).dataset.tab === tab),
    );
  if (tab === 'sculpt') restoreSculptBrush();
  setTool(
    tab === 'sculpt'
      ? (sculptSettings().brush ?? defaultSculptBrushSettings()).tool
      : tab === 'materials'
        ? 'material'
        : tab === 'foliage'
          ? 'foliage'
          : tab === 'props'
            ? 'prop'
            : 'select',
    false,
  );
  renderInspector();
}
/** A modal import owns its revision and can retry failed preparations safely. */
function importSession() {
  viewport.finishStroke();
  cancelPreparation();
  const source = project;
  let revision = documentRevision;
  return async <T extends { dispose(): void }>(
    label: string,
    signal: AbortSignal,
    prepare: (signal: AbortSignal) => Promise<T>,
    apply: (prepared: T) => void,
  ) => {
    checkSignal(signal);
    if (project !== source || revision !== documentRevision)
      throw new Error(
        'The document changed. Close and reopen this import panel.',
      );
    signal.addEventListener('abort', cancelPreparation, { once: true });
    const action = prepareAction(label, prepare, apply);
    const requestRevision = documentRevision;
    try {
      return await action;
    } finally {
      signal.removeEventListener('abort', cancelPreparation);
      if (project === source && documentRevision === requestRevision)
        revision = requestRevision;
      updateHistory();
    }
  };
}
function openMaterialImport() {
  const run = importSession(),
    index = materialIndex;
  showMaterialImport(
    project.materials[index],
    project.view.textureResolution ?? 512,
    async (result, signal) => {
      const applied = await run(
        'Importing terrain material…',
        signal,
        async (preparationSignal) => {
          const next = surfaceDraft();
          next.materials[index] = structuredClone(result.layer);
          next.view.textureResolution = result.resolution;
          assertProjectCapacity(next);
          return viewport.prepareSurface(next, false, preparationSignal);
        },
        applySurface,
      );
      if (applied)
        notify('Material imported. Undo restores the previous surface.');
      return applied;
    },
  );
}
function openFoliageImport() {
  const run = importSession();
  showFoliageImport(
    project,
    brushIndex,
    foliageModelIndex,
    async (plants, options, signal) => {
      let destination = brushIndex;
      const applied = await run(
        'Importing foliage…',
        signal,
        async (preparationSignal) => {
          const draft = foliageImportDraft(project, plants, options);
          destination = draft.brushIndex;
          return viewport.prepareLoad(draft.project, false, preparationSignal);
        },
        (prepared) => {
          viewport.assertPrepared(prepared);
          // Capture can fail. Advance the import revision only after it succeeds,
          // so the same review panel can retry without losing its prepared inputs.
          history.checkpoint(project);
          documentRevision++;
          updateHistory();
          viewport.applyPrepared(prepared);
          project = viewport.project;
          brushIndex = destination;
          foliageModelIndex =
            options.mode === 'replace'
              ? options.targetModel
              : options.mode === 'add'
                ? foliageModels(project.brushes[destination]).length -
                  plants.length
                : 0;
          refreshed();
        },
      );
      if (applied)
        notify(
          'Foliage imported. Paint a test patch or adjust the brush settings.',
        );
      return applied;
    },
  );
}
function openOrm() {
  if (ormPanel) return;
  cancelPreparation();
  const source = project,
    index = materialIndex;
  let revision = documentRevision;
  ormPanel = showOrmPanel(project.view.textureResolution ?? 512, {
    apply: async (png, useMapValues) => {
      if (project !== source || documentRevision !== revision)
        throw new Error(
          'The document changed. Close this panel and build the map again.',
        );
      let data = '';
      const roughness = useMapValues.roughness
        ? 1
        : source.materials[index].roughness;
      const metalness = useMapValues.metalness
        ? 1
        : source.materials[index].metalness;
      const action = prepareAction(
        'Preparing ORM map…',
        async (signal) => {
          data = await readDataUrl(
            new File([png], 'terrain-orm.png', { type: 'image/png' }),
          );
          checkSignal(signal);
          const next = surfaceDraft();
          Object.assign(next.materials[index], {
            roughness,
            metalness,
            textures: { ...next.materials[index].textures, orm: data },
          });
          assertProjectCapacity(next);
          return viewport.prepareSurface(next, false, signal);
        },
        applySurface,
      );
      const requestRevision = documentRevision;
      try {
        const applied = await action;
        if (applied)
          notify('ORM map applied. Undo restores the previous surface.');
        return applied;
      } finally {
        // A failed preparation advances the request revision but does not edit the document.
        // Permit this panel to retry only if nothing else changed in the meantime.
        if (project === source && documentRevision === requestRevision)
          revision = requestRevision;
      }
    },
    close: () => {
      ormPanel = undefined;
      cancelPreparation();
    },
  });
}
function openErosion() {
  if (erosionPanel) return;
  viewport.finishStroke();
  cancelPreparation();
  const source = project,
    revision = documentRevision,
    brushVisible = viewport.showBrush;
  const blocked = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.topbar,.rail,.inspector,.scene-panel,.viewport-actions',
    ),
  );
  for (const element of blocked) element.inert = true;
  const previousToolLabel = $('#active-tool').innerHTML;
  $('#active-tool').innerHTML =
    '<span>Erosion preview</span><kbd>RMB orbit</kbd>';
  viewport.showBrush = false;
  viewport.clearBalls();
  let previewEdit: EditTransaction | undefined,
    previewProject: TerrainProject | undefined;
  const restorePreview = () => {
    previewEdit?.rollback();
    previewEdit = undefined;
    previewProject = undefined;
  };
  const preview = (candidate: TerrainProject) => {
    restorePreview();
    if (candidate === source) return;
    const edit = viewport.beginEdit(candidate);
    try {
      // beginEdit anchors candidate foliage and props; static collision stays committed.
      viewport.rebuildTerrain();
      previewEdit = edit;
      previewProject = candidate;
    } catch (error) {
      edit.rollback();
      throw error;
    }
  };
  erosionPanel = showErosionPanel(source, {
    preview,
    apply: (result, settings) => {
      let colliders: PreparedColliders | undefined;
      try {
        if (source !== project || revision !== documentRevision)
          throw new Error(
            'The terrain changed. Close and calculate a new preview.',
          );
        if (previewProject?.heights !== result.heights)
          preview({ ...source, heights: result.heights });
        const candidate = previewProject!;
        candidate.erosion = { ...settings };
        colliders = viewport.physics?.prepare(
          candidate,
          undefined,
          viewport.content.collisionMeshes(true, false),
        );
        if (colliders) viewport.physics!.assertPrepared(colliders);
        history.checkpoint(source);
        if (colliders) viewport.physics!.apply(colliders);
        previewEdit!.commit();
        previewEdit = undefined;
        previewProject = undefined;
        project = candidate;
        documentRevision++;
        erosionPanel?.close();
        persist();
        renderInspector();
        notify('Erosion applied. Undo restores the previous landscape.');
      } catch (error) {
        restorePreview();
        throw error;
      } finally {
        colliders?.dispose();
      }
    },
    close: () => {
      erosionPanel = undefined;
      for (const element of blocked) element.inert = false;
      viewport.showBrush = brushVisible;
      $('#active-tool').innerHTML = previousToolLabel;
      restorePreview();
      document.querySelector<HTMLButtonElement>('#weather-landscape')?.focus();
    },
  });
}
/** Prepare brush/population edits before publishing settings, IDs or draw buffers. */
function editFoliage(
  change: (
    candidate: TerrainProject,
    brush: FoliageBrush,
  ) => { brush?: number; model?: number } | void,
  redraw = true,
) {
  viewport.finishStroke();
  cancelPreparation();
  erosionPanel?.close();
  documentRevision++;
  const original = project;
  let prepared: PreparedFoliage | undefined;
  try {
    const candidate: TerrainProject = {
      ...original,
      brushes: structuredClone(original.brushes),
      // Legacy model editing also assigns modelId to existing instances.
      foliage: original.foliage.map((instance) => ({ ...instance })),
    };
    const selection = change(candidate, candidate.brushes[brushIndex]);
    if (redraw) {
      prepared = viewport.foliage.prepare(candidate);
      prepared.assert(viewport.foliage);
    }
    history.checkpoint(original);
    if (prepared) {
      viewport.foliage.apply(prepared);
      project = candidate;
      viewport.project = candidate;
    } else {
      // Future-placement settings need no new draw buffers. Preserve the project
      // reference used by the existing draw state, then publish the copied records.
      original.brushes = candidate.brushes;
      original.foliage = candidate.foliage;
      original.nextId = candidate.nextId;
    }
    if (selection?.brush !== undefined) brushIndex = selection.brush;
    if (selection?.model !== undefined) foliageModelIndex = selection.model;
  } catch (error) {
    renderInspector();
    updateHistory();
    notify(
      'Foliage change could not be applied. The previous plants and settings were kept: ' +
        String(error),
      true,
    );
    return false;
  } finally {
    prepared?.dispose();
  }
  persist();
  renderInspector();
  return true;
}
/** Prop records, cutouts, drawing, picking and collision commit as one edit. */
function editProps(
  change: (candidate: TerrainProject) => number | null | void,
) {
  viewport.finishStroke();
  cancelPreparation();
  erosionPanel?.close();
  documentRevision++;
  const original = project;
  let view: EditTransaction | undefined,
    colliders: PreparedColliders | undefined;
  try {
    const candidate: TerrainProject = {
      ...original,
      props: original.props.map((prop) => ({
        ...prop,
        ...(prop.cutout ? { cutout: { ...prop.cutout } } : {}),
      })),
    };
    const selection = change(candidate);
    view = viewport.beginEdit(candidate);
    viewport.rebuildTerrain();
    colliders = viewport.physics?.prepare(
      candidate,
      undefined,
      viewport.content.collisionMeshes(true, false),
    );
    if (colliders) viewport.physics!.assertPrepared(colliders);
    history.checkpoint(original);
    if (colliders) viewport.physics!.apply(colliders);
    view.commit();
    project = candidate;
    if (selection !== undefined) selectedProp = selection;
    persist();
    renderInspector();
    return true;
  } catch (error) {
    view?.rollback();
    renderInspector();
    updateScene();
    notify(
      'Prop change could not be applied. The previous scene was restored: ' +
        String(error),
      true,
    );
    return false;
  } finally {
    colliders?.dispose();
    view?.dispose();
  }
}
function editProp(id: number, change: (prop: PropInstance) => void) {
  return editProps((candidate) => {
    const prop = candidate.props.find((value) => value.id === id);
    if (!prop) throw new Error('The selected prop no longer exists.');
    change(prop);
  });
}
function modelFootprint(model: string, scale: number) {
  const bounds = viewport.library.bounds(model);
  return fitPropCutout(
    {
      minX: bounds.min.x,
      maxX: bounds.max.x,
      minZ: bounds.min.z,
      maxZ: bounds.max.z,
    },
    Math.max(0.01, project.size / project.resolution / scale),
  );
}
function syncPropTools() {
  const prop = project.props.find((value) => value.id === selectedProp);
  viewport.selectionEnabled = tool === 'select' && !dropMode;
  const enabled =
    tab === 'props' &&
    tool === 'select' &&
    !!prop &&
    !dropMode &&
    !viewport.navigationActive;
  viewport.propTools.select(
    project,
    prop,
    viewport.props.children.find(
      (object) => object.userData.propId === selectedProp,
    ),
    enabled,
  );
  $('#prop-transform-tools').hidden = !enabled;
  $('#toast').style.bottom = enabled ? '180px' : '';
  document
    .querySelectorAll<HTMLButtonElement>('[data-prop-transform]')
    .forEach((button) =>
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.propTransform === propTransformMode),
      ),
    );
}
function renderInspector() {
  brushIndex = Math.min(brushIndex, project.brushes.length - 1);
  const brush = project.brushes[brushIndex] ?? project.brushes[0],
    mat = project.materials[materialIndex];
  let html = '';
  if (tab === 'sculpt')
    html = `<div class="inspector-heading"><span class="eyebrow">TERRAIN EDITING</span><h1>Sculpt</h1><p>From first landform to final detail.</p></div><div class="tool-grid">${tools.map((t) => `<button data-tool="${t.id}" class="tool-button ${t.id === tool ? 'active' : ''}" title="${t.hint}">${icon(t.icon)}<span>${t.name}</span></button>`).join('')}</div>${section('Brush settings', range('radius', 'Radius', radius, 1, 50, 0.5, ' m') + range('strength', 'Strength', strength, 0.05, 5, 0.05) + range('falloff', 'Falloff', falloff, 0.05, 1, 0.05) + range('target', 'Target / terrace step', targetHeight, Math.min(-20, targetHeight), Math.max(60, targetHeight), 0.5, ' m') + range('erode-talus', 'Erode · stable slope', (project.erosion ?? defaultErosionSettings()).talus, 0, 80, 1, '°'))}<div class="brush-preview"><div class="brush-gradient"></div><span>Soft radial falloff</span><span class="shortcut">[ &nbsp; ]</span></div>${section(
      'Generate terrain',
      select(
        'preset',
        'Landform',
        [
          ['alpine', 'Alpine ridges'],
          ['dunes', 'Dune field'],
          ['islands', 'Island chain'],
          ['flat', 'Flat canvas'],
        ],
        'alpine',
      ) +
        select(
          'resolution',
          'Grid resolution (cells)',
          [
            ['32', '32 × 32 · low poly'],
            ['64', '64 × 64'],
            ['128', '128 × 128'],
            ['256', '256 × 256'],
            ['512', '512 × 512'],
          ],
          String(project.resolution),
        ) +
        terrainSizeInput('generate-size') +
        '<p class="field-note" id="generation-metrics">' +
        terrainMetrics(project.resolution, project.size) +
        '</p>' +
        '<label class="field"><span>Seed</span><input id="seed" type="number" step="1" value="' +
        project.seed +
        '"/></label><button id="generate" class="full-button">' +
        icon('mountain') +
        'Generate landscape</button><p class="field-note">Replaces terrain, paint, placed foliage, and props. Keeps surfaces, brush definitions, assets, and world settings. Undo restores your previous scene.</p>',
    )}`;
  if (tab === 'sculpt') {
    html += section(
      'Reference landscape',
      '<button id="open-upland" class="full-button">Open upland meadow</button><p class="field-note">Editable grasses, limestone props, and layered surfaces with generated color textures. Replaces this scene; Undo restores it. About 20 MiB.</p><a class="reference-preview" href="./runtime.html?sample=upland" target="_blank" rel="noopener">Preview the reference scene ↗</a>',
    );
    html = html.replace(
      '<section class="control-section">',
      '<div class="erosion-entry"><button id="weather-landscape" class="full-button">' +
        icon('waves') +
        'Weather landscape</button><p class="field-note">Hydraulic channels and thermal settling, with a before/after preview.</p></div><section class="control-section">',
    );
    const settings = sculptSettings();
    const presetControls = section(
      'Sculpt presets',
      '<label class="field"><span>Preset name</span><input id="sculpt-preset-name" maxlength="120" value="' +
        escape(settings.brush?.name ?? 'Sculpt brush') +
        '"/></label><div class="button-row"><button id="import-sculpt-preset">' +
        icon('upload') +
        'Load preset</button><button id="export-sculpt-preset">' +
        icon('download') +
        'Save preset</button></div><p class="field-note">Reuse this tool, its brush settings, and custom alpha in another terrain. Loading a preset is undoable.</p>',
    );
    const alphaChoices: [string, string][] = [
      ['none', 'Soft radial'],
      ['round', 'Rounded hill'],
      ['ridge', 'Ridged peak'],
      ['crater', 'Crater rim'],
    ];
    if (settings.alpha)
      alphaChoices.push(['custom', settings.alphaName ?? 'Custom alpha']);
    const stampControls = section(
      'Alpha & stamps',
      select('alpha-kind', 'Brush shape', alphaChoices, settings.alphaKind) +
        '<div class="alpha-preview"><canvas id="alpha-preview" width="128" height="128" aria-label="Selected sculpt alpha"></canvas><span>White has strongest effect</span></div>' +
        '<button id="import-alpha" class="full-button">' +
        icon('upload') +
        'Import alpha PNG</button>' +
        range(
          'alpha-rotation',
          'Alpha rotation',
          settings.rotation,
          -180,
          180,
          1,
          '°',
        ) +
        select(
          'stamp-mode',
          'Stamp operation',
          [
            ['add', 'Add elevation'],
            ['subtract', 'Subtract elevation'],
            ['set', 'Set elevation'],
          ],
          settings.stampMode,
        ) +
        range(
          'stamp-height',
          'Stamp height',
          settings.stampHeight,
          0,
          Math.max(60, settings.stampHeight),
          0.5,
          ' m',
        ) +
        range(
          'stamp-base',
          'Set-mode base',
          settings.stampBase,
          Math.min(-project.size, settings.stampBase),
          Math.max(project.size, settings.stampBase),
          0.5,
          ' m',
        ) +
        toggle(
          'pen-pressure',
          'Pen pressure controls strength',
          settings.pressure,
        ) +
        '<p class="field-note">Stamp places once per press; radius is half its width. Other sculpt brushes apply the selected alpha continuously. Strength scales the effect; falloff softens its edge.</p>',
    );
    html = html.replace(
      '<div class="brush-preview">',
      presetControls + stampControls + '<div class="brush-preview">',
    );
    heightmapMinimum = Math.max(-project.size, heightmapMinimum);
    heightmapMaximum = Math.min(project.size, heightmapMaximum);
    html += section(
      'Heightmap exchange',
      '<label class="field"><span>Black elevation (m)</span><input id="heightmap-min" type="number" step="0.01" value="' +
        heightmapMinimum +
        '"/></label>' +
        '<label class="field"><span>White elevation (m)</span><input id="heightmap-max" type="number" step="0.01" value="' +
        heightmapMaximum +
        '"/></label>' +
        '<button id="heightmap-fit" class="text-button">Fit range to terrain</button>' +
        toggle('heightmap-flip', 'Flip image rows on import', heightmapFlip) +
        '<div class="button-row"><button id="import-heightmap">' +
        icon('upload') +
        'Import</button><button id="export-heightmap">' +
        icon('download') +
        'Export PNG16</button></div>' +
        '<p class="field-note">PNG imports preserve 16-bit samples and resample to the current ' +
        (project.resolution + 1) +
        ' × ' +
        (project.resolution + 1) +
        ' vertex grid. Replaces heights; keeps holes, surfaces, foliage, and props. Undo is available. Export clips heights outside the chosen range.</p>' +
        '<details><summary>RAW16 options</summary><label class="field"><span>Source width (pixels)</span><input id="raw-width" type="number" min="1" max="8192" value="' +
        rawWidth +
        '"/></label>' +
        '<label class="field"><span>Source height (pixels)</span><input id="raw-height" type="number" min="1" max="8192" value="' +
        rawHeight +
        '"/></label>' +
        select(
          'raw-order',
          'Byte order',
          [
            ['le', 'Little endian'],
            ['be', 'Big endian'],
          ],
          rawLittleEndian ? 'le' : 'be',
        ) +
        '<button id="export-raw" class="full-button">Export RAW16</button></details>',
    );
  }
  if (tab === 'materials')
    html = `<div class="inspector-heading"><span class="eyebrow">SURFACE AUTHORING</span><h1>Materials</h1><p>Layer surfaces with natural transitions.</p></div><div class="material-tabs">${project.materials.map((m, i) => `<button data-material="${i}" class="material-tab ${i === materialIndex ? 'active' : ''}"><span style="background:${m.color}"></span>${escape(m.name)}</button>`).join('')}</div><button id="import-material-set" class="primary full-button import-launch">${icon('upload')}Import PBR material</button><p class="field-note import-launch-note">Drop a whole texture set, review maps, and preview before applying.</p>${section(
      'Physical surface',
      '<label class="field"><span>Layer name</span><input maxlength="120" id="mat-name" value="' +
        escape(mat.name) +
        '"/></label><label class="color-field"><span>Base tint</span><input type="color" id="mat-color" value="' +
        mat.color +
        '"/></label>' +
        range(
          'normal-strength',
          'Normal strength',
          mat.normalStrength ?? 1,
          0,
          4,
          0.05,
        ) +
        select(
          'normal-convention',
          'Normal map convention',
          [
            ['opengl', 'OpenGL (+Y)'],
            ['directx', 'DirectX (−Y)'],
          ],
          mat.normalConvention ?? 'opengl',
        ) +
        range('roughness', 'Roughness', mat.roughness, 0, 1, 0.01) +
        range('metalness', 'Metalness', mat.metalness, 0, 1, 0.01) +
        range('tile', 'Texture scale', mat.tileSize, 0.5, 40, 0.5, ' m') +
        toggle(
          'reduce-tiling',
          'Reduce texture repetition',
          mat.reduceTiling ?? false,
        ) +
        '<p class="field-note">Blend offset patches for natural ground textures. Uses more texture samples and can soften detail; leave off for structured patterns.</p>' +
        range('blend', 'Height blend', mat.blendHeight, 0, 1, 0.01),
    )}${section('Automatic placement', range('min-height', 'Minimum altitude', mat.minHeight, -50, 100, 1, ' m') + range('max-height', 'Maximum altitude', mat.maxHeight, -50, 100, 1, ' m') + range('min-slope', 'Minimum slope', mat.minSlope, 0, 90, 1, '°') + range('max-slope', 'Maximum slope', mat.maxSlope, 0, 90, 1, '°') + range('feather', 'Rule feather', mat.feather, 0.1, 25, 0.1))}${section(
      'PBR texture maps',
      select(
        'texture-resolution',
        'Texture resolution',
        [
          ['256', '256² · 5 MiB'],
          ['512', '512² · 21 MiB'],
          ['1024', '1024² · 85 MiB'],
          ['2048', '2048² · 341 MiB'],
        ],
        String(project.view.textureResolution ?? 512),
      ) +
        '<div class="texture-grid">' +
        (['albedo', 'normal', 'orm', 'height'] as const)
          .map(
            (k) =>
              '<div class="texture-entry"><button data-texture="' +
              k +
              '" class="texture-slot" title="' +
              (mat.textures[k] ? 'Replace ' : 'Import ') +
              k +
              ' map">' +
              (mat.textures[k]
                ? '<img data-map-thumbnail="' + k + '" alt="' + k + ' map"/>'
                : icon('image-plus')) +
              '<span>' +
              k.toUpperCase() +
              '</span></button>' +
              (mat.textures[k]
                ? '<button data-clear-texture="' +
                  k +
                  '" class="clear-texture" aria-label="Remove ' +
                  k +
                  ' map" title="Remove ' +
                  k +
                  ' map">×</button>'
                : '') +
              '</div>',
          )
          .join('') +
        '</div><p class="field-note">PNG, JPG, WebP. ORM = occlusion / roughness / metalness. Imported maps are embedded in the project and sampled at the selected resolution. Memory estimates include all four layers and mipmaps.</p><button id="build-orm" class="full-button">Build ORM from separate maps</button><button id="reset-maps" class="text-button">Reset layer to procedural maps</button>',
    )}${section('Surface preset', '<div class="button-row"><button id="load-surface-preset">' + icon('upload') + 'Load surface</button><button id="save-surface-preset">' + icon('download') + 'Save surface</button></div>' + toggle('surface-preset-rules', 'Load saved placement rules', surfacePresetRules) + '<p class="field-note">Reuse this layer’s maps and shading in another project. Loading keeps this layer’s painted coverage and foliage references. Enable rules to also load its altitude, slope, and feather settings.</p>')}${section('Paint override', range('radius', 'Radius', radius, 1, 50, 0.5) + range('strength', 'Strength', strength, 0.05, 5, 0.05) + '<button id="clear-paint" class="full-button">Clear all painted overrides</button>')}`;
  if (tab === 'foliage') {
    const entries = foliageModels(brush);
    foliageModelIndex = Math.min(foliageModelIndex, entries.length - 1);
    const entry = entries[foliageModelIndex];
    const total = entries.reduce((sum, m) => sum + m.weight, 0);
    const modelChoices: [string, string][] = [
      ['pine', 'Alpine pine'],
      ['pine-low', 'Alpine pine · low detail'],
      ['grass-low', 'Meadow tuft · low detail'],
      ['grass', 'Meadow tuft'],
      ['boulder', 'Scatter rocks'],
      ['platform', 'Stone platform'],
      ['portal', 'Portal frame'],
      ...Object.entries(project.assets).map(
        ([id, a]) => [id, a.name] as [string, string],
      ),
    ];
    html =
      '<div class="inspector-heading"><span class="eyebrow">ECOSYSTEM</span><h1>Foliage</h1><p>Paint a varied community of plants and rocks.</p></div>' +
      '<button id="import-foliage" class="primary full-button import-launch">' +
      icon('upload') +
      'Import foliage assets</button><p class="field-note import-launch-note">Preview GLB or glTF models and create a brush in one step.</p>' +
      select(
        'brush-select',
        'Active brush',
        project.brushes.map((b, i) => [String(i), b.name]),
        String(brushIndex),
      ) +
      '<div class="button-row"><button id="add-brush">' +
      icon('plus') +
      'Duplicate brush</button><button id="erase-foliage">' +
      icon('eraser') +
      'Erase</button></div>' +
      '<div class="button-row"><button id="save-brush">' +
      icon('download') +
      'Save brush</button><button id="load-brush">' +
      icon('upload') +
      'Load brush</button></div>' +
      section(
        'Default brushes',
        select(
          'default-foliage',
          'Photoreal plants',
          defaultFoliageChoices.map(([id, name]) => [id, name]),
          'pine',
        ) +
          '<button id="add-default-foliage" class="full-button">Add default brush</button>' +
          '<p class="field-note">CC0 foliage by Rico Cilliers and Rob Tuytel, via Poly Haven. <a href="' +
          foliageCreditsURL +
          '" target="_blank" rel="noopener">Asset credits</a></p>',
      ) +
      section(
        'Brush composition',
        '<label class="field"><span>Brush name</span><input maxlength="120" id="brush-name" maxlength="120" value="' +
          escape(brush.name) +
          '"/></label>' +
          select(
            'model-entry',
            'Model in mixture',
            entries.map((m, i) => [
              String(i),
              i +
                1 +
                '. ' +
                (modelChoices.find(([id]) => id === m.model)?.[1] ?? m.model) +
                ' · ' +
                (total ? Math.round((m.weight / total) * 100) : 0) +
                '%',
            ]),
            String(foliageModelIndex),
          ) +
          '<div class="button-row"><button id="add-model" ' +
          (entries.length >= 32 ? 'disabled' : '') +
          '>' +
          icon('plus') +
          'Add model</button><button id="remove-model" ' +
          (entries.length === 1 ? 'disabled' : '') +
          '>' +
          icon('trash-2') +
          'Remove model</button></div><p class="field-note">Removing a model also removes its placed instances. Undo restores them.</p>',
      ) +
      section(
        'Selected model',
        select('foliage-model', 'Asset', modelChoices, entry.model) +
          '<button id="import-model" class="text-button">' +
          icon('upload') +
          'Import static GLB</button>' +
          range(
            'model-weight',
            'Relative probability',
            entry.weight,
            0,
            Math.max(10, entry.weight),
            0.1,
          ) +
          range(
            'min-scale',
            'Minimum scale',
            entry.minScale,
            0.01,
            Math.max(5, entry.maxScale),
            0.01,
          ) +
          range(
            'max-scale',
            'Maximum scale',
            entry.maxScale,
            0.01,
            Math.max(5, entry.maxScale),
            0.01,
          ) +
          range(
            'min-rotation',
            'Minimum yaw',
            entry.minRotation,
            -180,
            180,
            1,
            '°',
          ) +
          range(
            'max-rotation',
            'Maximum yaw',
            entry.maxRotation,
            -180,
            180,
            1,
            '°',
          ) +
          toggle('align', 'Align to surface', entry.alignToNormal) +
          range(
            'brush-wind',
            'Wind flexibility',
            entry.wind,
            0,
            Math.max(2, entry.wind),
            0.05,
          ) +
          '<p class="field-note">Probability, scale, and yaw apply to new placements. Populate rebuilds this brush using the current ranges. Zero probability pauses new placement of that model.</p>',
      ) +
      section(
        'Asset contact interaction',
        toggle(
          'crush-enabled',
          'Respond to contact',
          entry.interaction?.enabled ??
            (project.interaction.enabled && entry.crush > 0),
        ) +
          range(
            'brush-crush',
            'Compression',
            entry.interaction
              ? entry.crush
              : entry.crush * project.interaction.strength,
            0,
            1,
            0.05,
          ) +
          range(
            'crush-radius',
            'Contact radius',
            entry.interaction?.radius ?? project.interaction.radius,
            0.1,
            12,
            0.1,
            ' m',
          ) +
          range(
            'recovery',
            'Recovery time',
            entry.interaction?.recovery ?? project.interaction.recovery,
            0.1,
            20,
            0.1,
            ' s',
          ) +
          '<p class="field-note">Applies only to this model in this brush. Enable for grass; leave off for trees or rocks. Wind is independent. Physics preview bodies trigger compression and recovery.</p>',
      ) +
      foliageShadingControls(entry, viewport.library) +
      foliageFlexibilityControls(entry, viewport.library) +
      foliageDetailControls(entry, modelChoices) +
      section(
        'Placement',
        range(
          'density',
          'Attempts / m²',
          brush.density,
          0,
          Math.max(1, brush.density),
          0.005,
        ) +
          range(
            'foliage-spacing',
            'Minimum spacing',
            brush.spacing ?? 0,
            0,
            Math.max(15, brush.spacing ?? 0),
            0.1,
            ' m',
          ) +
          range(
            'max-foliage-slope',
            'Slope limit',
            brush.maxSlope,
            0,
            90,
            1,
            '°',
          ) +
          range('radius', 'Paint radius', radius, 1, 50, 0.5, ' m') +
          '<p class="field-note">Spacing applies between centres in this brush, across models, repeated strokes, and population tiles. Surface and spacing rules can reduce the final count.</p>',
      ) +
      section(
        'Allowed surfaces',
        '<div class="allowed-surfaces">' +
          project.materials
            .map(
              (m) =>
                '<label><input type="checkbox" data-allowed="' +
                m.id +
                '" ' +
                (brush.materials.includes(m.id) ? 'checked' : '') +
                '/>' +
                escape(m.name) +
                '</label>',
            )
            .join('') +
          '</div>' +
          range(
            'min-weight',
            'Minimum surface weight',
            brush.minWeight,
            0.05,
            1,
            0.05,
          ) +
          '<button id="populate" class="primary full-button">' +
          icon('sprout') +
          'Populate allowed surfaces</button><button id="clear-brush" class="full-button" ' +
          (project.foliage.some((instance) => instance.brushId === brush.id)
            ? ''
            : 'disabled') +
          '>Clear this brush’s plants</button><p class="field-note">Populate replaces this brush with the terrain seed. Clear removes only this brush’s plants. Both support Undo. Maximum 50,000 total instances.</p>',
      );
  }
  if (tab === 'props') {
    if (
      ![
        'boulder',
        'platform',
        'portal',
        ...Object.keys(project.assets),
      ].includes(propModel)
    )
      propModel = 'boulder';
    const prop = project.props.find((p) => p.id === selectedProp);
    html = `<div class="inspector-heading"><span class="eyebrow">SCENE ASSEMBLY</span><h1>Props</h1><p>Place meshes directly on the landscape.</p></div>${section('Placement', select('prop-model', 'Model', [['boulder', 'Weathered boulder'], ['platform', 'Stone platform'], ['portal', 'Portal frame'], ...Object.entries(project.assets).map(([id, a]) => [id, a.name] as [string, string])], propModel) + '<button id="import-model" class="text-button">' + icon('upload') + 'Import static GLB</button>' + toggle('prop-cut', 'Cut terrain below prop', propCut) + placementFootprintControls(propFootprintMode, propWidth, propDepth) + (propFootprintMode === 'circle' ? range('prop-radius', 'Cutout radius', propRadius, 1, 20, 0.5) : '') + '<div class="button-row"><button id="place-prop">' + icon('plus') + 'Place</button><button id="select-prop">' + icon('mouse-pointer-2') + 'Select</button></div><p class="field-note">Click terrain to place, then use the handles to transform it. Click a prop mesh or scene row to select it. Cutouts remove surface and collision.</p>')}${prop ? section('Selected prop #' + prop.id, range('prop-x', 'Position X', prop.x, -project.size / 2, project.size / 2, 0.5) + range('prop-z', 'Position Z', prop.z, -project.size / 2, project.size / 2, 0.5) + range('prop-y', 'Height offset', prop.yOffset, Math.min(-15, prop.yOffset), Math.max(30, prop.yOffset), 0.1) + range('prop-scale', 'Scale', prop.scale, Math.min(0.1, prop.scale), Math.max(5, prop.scale), 0.05) + range('prop-rotation', 'Rotation', (prop.rotation * 180) / Math.PI, -180, 180, 1) + toggle('selected-cut', 'Cut terrain', prop.cutHole) + propCutoutControls(prop) + (!prop.cutout ? range('selected-radius', 'Cut radius', prop.holeRadius, 1, Math.max(20, prop.holeRadius), 0.5) : '') + '<button id="delete-prop" class="full-button danger">' + icon('trash-2') + 'Remove prop</button>') : '<div class="empty-state">' + icon('box') + '<p>Select a placed prop to edit its transform.</p></div>'}`;
  }
  if (tab === 'light')
    html =
      '<div class="inspector-heading"><span class="eyebrow">ENVIRONMENT</span><h1>Light</h1><p>Shape the sun, sky, atmosphere and exposure.</p></div>' +
      environmentControls(project.environment) +
      section(
        'Viewport shading',
        toggle('low-poly', 'Flat / low-poly shading', project.view.lowPoly) +
          toggle('wireframe', 'Wireframe', project.view.wireframe),
      );
  if (tab === 'wind')
    html =
      '<div class="inspector-heading"><span class="eyebrow">ENVIRONMENT</span><h1>Wind</h1><p>Set the breeze across your landscape.</p></div>' +
      section(
        'Wind',
        toggle('wind-enabled', 'Enable wind', project.wind.enabled) +
          range(
            'wind-strength',
            'Strength',
            project.wind.strength,
            0,
            3,
            0.05,
          ) +
          range(
            'wind-direction',
            'Direction',
            project.wind.direction,
            0,
            360,
            1,
            '°',
          ) +
          range('wind-speed', 'Speed', project.wind.speed, 0.1, 4, 0.05) +
          range('wind-gust', 'Gust variation', project.wind.gust, 0, 1, 0.05) +
          '<p class="field-note">Each foliage asset has its own wind flexibility. Set it in Foliage → Selected model.</p>',
      );
  if (tab === 'water')
    html = waterControls(
      pendingWater ?? project.water ?? defaultWaterSettings(project),
      selectedWater,
      waterPlacement,
      waterPoints.length,
    );
  if (tab === 'project')
    html =
      '<div class="inspector-heading"><span class="eyebrow">PROJECT SETTINGS</span><h1>Project</h1><p>Set the scale of your world. One unit is one metre.</p></div>' +
      section(
        'Project files',
        '<p class="field-note" id="project-file-location">Keep your main <strong>.terrain</strong> file in the project folder’s root. Open that file to resume work; it includes your terrain and embedded assets.</p><p class="field-note" id="project-folder-layout"><strong>prepared/</strong> — ready-to-import art<br/><strong>sources/</strong> — original downloads<br/><strong>scenes/</strong> — alternate scenes and revisions<br/><strong>exports/</strong> — GLBs and delivery files</p><p class="field-note" id="project-save-location">Save project downloads a file. Save or move it to the project root. Browser autosave is a recovery copy, and does not update that file automatically.</p>',
      ) +
      section(
        'First person',
        '<label class="field"><span>Eye height (m)</span><input id="eye-height" type="number" min="0.1" max="100" step="0.05" value="' +
          parseEyeHeight(project.view.eyeHeight) +
          '"/></label><p class="field-note">Camera height above the terrain. Default: 1.8 m. Saved with this project and used by the walk preview and movement.</p>',
      ) +
      section(
        'Terrain size',
        terrainSizeInput('terrain-size') +
          '<p class="field-note" id="terrain-size-preview">' +
          terrainMetrics(project.resolution, project.size) +
          '</p>' +
          toggle('scale-elevation', 'Scale elevation with size', true) +
          '<button id="resize-terrain" class="full-button">Resize existing terrain</button><p class="field-note">Keeps sculpting, paint, holes and grid resolution. Plants and props keep their own size and relative positions. Scaling elevation also scales the water level; surface rules stay in metres. Undo restores the previous size.</p>',
      );
  if (tab === 'props' || tab === 'foliage') {
    const unused = unusedModelAssetIds(project);
    html += section(
      'Project assets',
      '<p class="field-note" id="asset-usage">' +
        (projectAssetBytes(project) / 1048576).toFixed(1) +
        ' / 384 MiB embedded · ' +
        unused.length +
        ' unused models</p><button id="prune-assets" class="full-button" ' +
        (!unused.length ? 'disabled' : '') +
        '>Remove unused models</button><p class="field-note">Keeps models referenced by props, foliage brushes, and their LODs. Undo restores removed assets.</p>',
    );
  }
  const inspector = $('#inspector-content');
  renderCompactInspector(inspector, html, tab, tool);
  if (tab === 'water')
    $('#active-tool').innerHTML =
      icon('waves') +
      '<span>' +
      (waterPlacement === 'polygon'
        ? 'Draw lake outline'
        : waterPlacement === 'basin'
          ? 'Fill basin'
          : waterPlacement === 'ellipse'
            ? 'Place pond'
            : 'Water') +
      '</span>' +
      (waterPlacement ? '<kbd>LMB · Esc cancels</kbd>' : '');
  document
    .querySelectorAll<HTMLImageElement>('[data-map-thumbnail]')
    .forEach((image) => {
      image.src =
        project.materials[materialIndex].textures[
          image.dataset.mapThumbnail as keyof MaterialLayer['textures']
        ]!;
    });
  refreshIcons();
  bindInspector();
  syncPropTools();
  syncSculptInput();
  const preview = document.querySelector<HTMLCanvasElement>('#alpha-preview');
  if (preview) {
    const context = preview.getContext('2d')!,
      pixels = context.createImageData(128, 128),
      alpha = activeAlpha(true)!;
    const angle = (sculptSettings().rotation * Math.PI) / 180;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const nx = (x / 127) * 2 - 1,
          nz = (y / 127) * 2 - 1;
        const u = (Math.cos(angle) * nx - Math.sin(angle) * nz + 1) / 2;
        const v = (Math.sin(angle) * nx + Math.cos(angle) * nz + 1) / 2;
        const value =
          u < 0 || u > 1 || v < 0 || v > 1
            ? 0
            : Math.round(sampleHeightmap(alpha, u, v) * 255);
        pixels.data.set([value, value, value, 255], (y * 128 + x) * 4);
      }
    context.putImageData(pixels, 0, 0);
  }
}
function surfaceDraft(): TerrainProject {
  return {
    ...project,
    materials: structuredClone(project.materials),
    view: { ...project.view },
  };
}
function applySurface(prepared: PreparedSurface) {
  viewport.assertSurface(prepared);
  history.checkpoint(project);
  documentRevision++;
  viewport.applySurface(prepared);
  persist();
  renderInspector();
}
async function editSurface(
  change: (candidate: TerrainProject, layer: MaterialLayer) => void,
  placementRules = false,
) {
  const index = materialIndex;
  try {
    const applied = await prepareAction(
      'Preparing surface…',
      async (signal) => {
        const candidate = surfaceDraft();
        change(candidate, candidate.materials[index]);
        return viewport.prepareSurface(candidate, placementRules, signal);
      },
      applySurface,
    );
    if (!applied && !activePreparation) renderInspector();
  } catch (error) {
    renderInspector();
    updateHistory();
    notify(
      'Surface change could not be applied. The previous surface and paint were kept: ' +
        String(error),
      true,
    );
  }
}
function bindInspector() {
  document
    .querySelectorAll('[data-tool]')
    .forEach((el) =>
      el.addEventListener('click', () =>
        setTool((el as HTMLElement).dataset.tool as SculptTool),
      ),
    );
  if (document.querySelector('#radius'))
    bindRange(
      'radius',
      (v) => {
        radius = v;
        viewport.brushRadius = v;
        rememberSculptBrush();
      },
      false,
    );
  if (document.querySelector('#strength'))
    bindRange(
      'strength',
      (v) => {
        strength = v;
        rememberSculptBrush();
      },
      false,
    );
  if (tab === 'sculpt') {
    $('#import-sculpt-preset').onclick = () => $('#sculpt-preset-open').click();
    $('#sculpt-preset-name').onchange = () => {
      const input = $<HTMLInputElement>('#sculpt-preset-name');
      const name = input.value.trim().slice(0, 120) || 'Sculpt brush';
      editSculpt((settings) => {
        settings.brush!.name = name;
      });
    };
    $('#export-sculpt-preset').onclick = () => {
      try {
        const settings = sculptSettings();
        download(
          serializeSculptPreset(
            settings,
            (project.erosion ?? defaultErosionSettings()).talus,
          ),
          (settings.brush?.name ?? 'Sculpt brush').replace(
            /[^a-z0-9-_]/gi,
            '-',
          ) + '.sculpt.json',
          'application/json',
        );
        notify('Sculpt preset downloaded.');
      } catch (error) {
        notify('Could not save sculpt preset: ' + String(error), true);
      }
    };
    $('#weather-landscape').onclick = openErosion;
    bindRange('erode-talus', (v) =>
      editSculpt((_settings, erosion) => {
        erosion.talus = v;
      }),
    );
    bindRange(
      'falloff',
      (v) => {
        falloff = v;
        rememberSculptBrush();
      },
      false,
    );
    bindRange(
      'target',
      (v) => {
        targetHeight = v;
        rememberSculptBrush();
      },
      false,
    );
    $('#alpha-kind').onchange = () => {
      const kind = $<HTMLSelectElement>('#alpha-kind')
        .value as SculptSettings['alphaKind'];
      editSculpt((settings) => {
        settings.alphaKind = kind;
      });
    };
    $('#import-alpha').onclick = () => $('#alpha-open').click();
    for (const [id, key] of Object.entries({
      'alpha-rotation': 'rotation',
      'stamp-height': 'stampHeight',
      'stamp-base': 'stampBase',
    }))
      bindRange(id, (v) =>
        editSculpt((settings) => {
          settings[key as 'rotation' | 'stampHeight' | 'stampBase'] = v;
        }),
      );
    $('#stamp-mode').onchange = () => {
      const mode = $<HTMLSelectElement>('#stamp-mode')
        .value as SculptSettings['stampMode'];
      editSculpt((settings) => {
        settings.stampMode = mode;
      });
    };
    $('#pen-pressure').onchange = () => {
      const pressure = $<HTMLInputElement>('#pen-pressure').checked;
      editSculpt((settings) => {
        settings.pressure = pressure;
      });
    };
    $('#heightmap-min').onchange = () => {
      heightmapMinimum = $<HTMLInputElement>('#heightmap-min').valueAsNumber;
    };
    $('#heightmap-max').onchange = () => {
      heightmapMaximum = $<HTMLInputElement>('#heightmap-max').valueAsNumber;
    };
    $('#heightmap-flip').onchange = () => {
      heightmapFlip = $<HTMLInputElement>('#heightmap-flip').checked;
    };
    $('#raw-width').onchange = () => {
      rawWidth = $<HTMLInputElement>('#raw-width').valueAsNumber;
    };
    $('#raw-height').onchange = () => {
      rawHeight = $<HTMLInputElement>('#raw-height').valueAsNumber;
    };
    $('#raw-order').onchange = () => {
      rawLittleEndian = $<HTMLSelectElement>('#raw-order').value === 'le';
    };
    $('#heightmap-fit').onclick = () => {
      let minimum = Infinity,
        maximum = -Infinity;
      for (const height of project.heights) {
        minimum = Math.min(minimum, height);
        maximum = Math.max(maximum, height);
      }
      heightmapMinimum = Math.max(
        -project.size,
        Math.floor(minimum * 100) / 100,
      );
      heightmapMaximum = Math.min(project.size, Math.ceil(maximum * 100) / 100);
      if (heightmapMaximum <= heightmapMinimum) {
        if (heightmapMaximum < project.size)
          heightmapMaximum = Math.min(project.size, heightmapMinimum + 0.01);
        else heightmapMinimum -= 0.01;
      }
      renderInspector();
    };
    $('#import-heightmap').onclick = () => $('#heightmap-open').click();
    const exportHeightmap = async (png: boolean) => {
      try {
        const minimum = heightmapMinimum,
          maximum = heightmapMaximum;
        const map = terrainHeightmap(project, minimum, maximum);
        const name =
          project.name.replace(/[^a-z0-9-_]/gi, '-') +
          '.' +
          minimum +
          '-to-' +
          maximum +
          'm.' +
          map.width;
        const data = png
          ? await encodeHeightmapPNG(map)
          : encodeRaw16(map, rawLittleEndian);
        download(
          data,
          name + (png ? '.png' : '.r16'),
          png ? 'image/png' : 'application/octet-stream',
        );
        notify(
          'Heightmap exported: black ' +
            minimum +
            ' m, white ' +
            maximum +
            ' m.',
        );
      } catch (error) {
        notify('Could not export heightmap: ' + String(error), true);
      }
    };
    $('#export-heightmap').onclick = () => {
      void exportHeightmap(true);
    };
    $('#export-raw').onclick = () => {
      void exportHeightmap(false);
    };
    $('#open-upland').onclick = async () => {
      try {
        if (
          await openDocument(async (signal) => {
            const response = await fetch(
              './examples/upland/upland-meadow.terrain',
              { signal },
            );
            if (!response.ok)
              throw new Error(
                'The reference scene could not be downloaded (' +
                  response.status +
                  ').',
              );
            return response.blob();
          }, 'Opening upland meadow…')
        ) {
          viewport.frameTerrain();
          notify('Upland meadow loaded. Undo restores your previous scene.');
        }
      } catch (error) {
        notify('Could not open reference scene: ' + String(error), true);
      }
    };
    const updateGenerationMetrics = () => {
      const size = $<HTMLInputElement>('#generate-size').valueAsNumber;
      $('#generation-metrics').textContent =
        Number.isFinite(size) && size >= 8 && size <= 10000
          ? terrainMetrics(
              Number($<HTMLSelectElement>('#resolution').value),
              size,
            )
          : 'Enter a terrain size from 8 to 10000 metres.';
    };
    $('#resolution').onchange = updateGenerationMetrics;
    $('#generate-size').oninput = updateGenerationMetrics;
    $('#generate').onclick = async () => {
      const resolution = Number($<HTMLSelectElement>('#resolution').value),
        size = $<HTMLInputElement>('#generate-size').valueAsNumber,
        seed = $<HTMLInputElement>('#seed').valueAsNumber,
        preset = $<HTMLSelectElement>('#preset').value as
          'alpine' | 'dunes' | 'islands' | 'flat';
      try {
        const applied = await prepareAction(
          'Generating landscape…',
          async (signal) => {
            if (
              !Number.isInteger(seed) ||
              seed < -2147483648 ||
              seed > 2147483647
            )
              throw new Error(
                'Seed must be an integer from −2147483648 to 2147483647.',
              );
            const buffers = createProject(resolution, size, seed);
            // Regeneration replaces spatial content, not reusable brushes/assets or world settings.
            const candidate = {
              ...project,
              size,
              resolution,
              seed,
              heights: buffers.heights,
              holes: buffers.holes,
              paint: buffers.paint,
            };
            generateTerrain(candidate, preset);
            checkSignal(signal);
            return viewport.prepareLoad(candidate, false, signal);
          },
          (prepared) => applyTerrainReplacement(prepared, true),
        );
        if (applied) notify('Landscape generated. Undo is available.');
      } catch (error) {
        notify(
          'Could not generate landscape. The previous scene was kept: ' +
            String(error),
          true,
        );
      }
    };
  }
  if (tab === 'materials') {
    const mat = project.materials[materialIndex];
    $('#build-orm').onclick = openOrm;
    $('#import-material-set').onclick = openMaterialImport;
    document
      .querySelectorAll<HTMLButtonElement>('[data-clear-texture]')
      .forEach((button) => {
        button.onclick = () => {
          const slot = button.dataset
            .clearTexture as keyof MaterialLayer['textures'];
          void editSurface((_, layer) => {
            delete layer.textures[slot];
          });
        };
      });
    $('#load-surface-preset').onclick = () => $('#surface-preset-open').click();
    $('#surface-preset-rules').onchange = () => {
      surfacePresetRules = $<HTMLInputElement>('#surface-preset-rules').checked;
    };
    $('#save-surface-preset').onclick = () => {
      try {
        download(
          serializeMaterialPreset(project, mat.id),
          (mat.name.replace(/[^a-z0-9-_]/gi, '-') || 'surface') +
            '.surface.json',
          'application/json',
        );
        notify('Surface preset saved: ' + mat.name + '.');
      } catch (error) {
        notify('Could not save surface preset: ' + String(error), true);
      }
    };
    $('#reduce-tiling').onchange = () => {
      const value = $<HTMLInputElement>('#reduce-tiling').checked;
      void editSurface((_, layer) => {
        layer.reduceTiling = value;
      });
    };
    $('#normal-convention').onchange = () => {
      const value = $<HTMLSelectElement>('#normal-convention').value as
        'opengl' | 'directx';
      void editSurface((_, layer) => {
        layer.normalConvention = value;
      });
    };
    document.querySelectorAll('[data-material]').forEach((el) =>
      el.addEventListener('click', () => {
        cancelPreparation();
        materialIndex = Number((el as HTMLElement).dataset.material);
        renderInspector();
      }),
    );
    for (const [id, key] of Object.entries({
      roughness: 'roughness',
      'normal-strength': 'normalStrength',
      metalness: 'metalness',
      tile: 'tileSize',
      blend: 'blendHeight',
      'min-height': 'minHeight',
      'max-height': 'maxHeight',
      'min-slope': 'minSlope',
      'max-slope': 'maxSlope',
      feather: 'feather',
    }))
      bindRange(
        id,
        (v) => {
          void editSurface((_, layer) => {
            (layer as unknown as Record<string, unknown>)[key] = v;
            if (key === 'minHeight')
              layer.maxHeight = Math.max(layer.minHeight, layer.maxHeight);
            if (key === 'maxHeight')
              layer.minHeight = Math.min(layer.minHeight, layer.maxHeight);
            if (key === 'minSlope')
              layer.maxSlope = Math.max(layer.minSlope, layer.maxSlope);
            if (key === 'maxSlope')
              layer.minSlope = Math.min(layer.minSlope, layer.maxSlope);
          }, ['minHeight', 'maxHeight', 'minSlope', 'maxSlope', 'feather'].includes(key));
        },
        false,
      );
    $('#texture-resolution').onchange = () => {
      const value = Number(
        $<HTMLSelectElement>('#texture-resolution').value,
      ) as 256 | 512 | 1024 | 2048;
      void editSurface((candidate) => {
        candidate.view.textureResolution = value;
      });
    };
    $('#mat-name').onchange = () => {
      const value = $<HTMLInputElement>('#mat-name').value.trim().slice(0, 120);
      void editSurface((_, layer) => {
        layer.name = value || layer.name;
      });
    };
    $('#mat-color').onchange = () => {
      const value = $<HTMLInputElement>('#mat-color').value;
      void editSurface((_, layer) => {
        layer.color = value;
      });
    };
    document.querySelectorAll('[data-texture]').forEach((el) =>
      el.addEventListener('click', () => {
        textureSlot = (el as HTMLElement).dataset.texture as typeof textureSlot;
        $('#texture-open').click();
      }),
    );
    $('#reset-maps').onclick = () => {
      void editSurface((_, layer) => {
        layer.textures = {};
      });
    };
    $('#clear-paint').onclick = () => {
      void editSurface((candidate) => {
        candidate.paint = new Float32Array(candidate.paint.length);
      }, true);
    };
  }
  if (tab === 'foliage') {
    const brush = project.brushes[brushIndex];
    $('#brush-select').onchange = () => {
      brushIndex = Number($<HTMLSelectElement>('#brush-select').value);
      foliageModelIndex = 0;
      setTool('foliage');
      renderInspector();
    };
    $('#add-brush').onclick = () => {
      if (project.brushes.length >= 256)
        return notify('Maximum 256 brushes.', true);
      editFoliage((candidate, selected) => {
        candidate.brushes.push({
          ...structuredClone(selected),
          id: 'brush-' + candidate.nextId++,
          name: 'New foliage brush',
        });
        return { brush: candidate.brushes.length - 1 };
      }, false);
    };
    $('#erase-foliage').onclick = () =>
      setTool(tool === 'erase' ? 'foliage' : 'erase');
    $('#brush-name').onchange = () => {
      const name =
        $<HTMLInputElement>('#brush-name').value.trim().slice(0, 120) ||
        brush.name;
      editFoliage((_candidate, selected) => {
        selected.name = name;
      }, false);
    };
    $('#save-brush').onclick = () => {
      try {
        download(
          serializeFoliageBrush(project, brush.id),
          brush.name.replace(/[^a-z0-9-_]/gi, '-') + '.foliage.json',
          'application/json',
        );
        notify('Reusable foliage brush downloaded with its model assets.');
      } catch (error) {
        notify('Could not save brush: ' + String(error), true);
      }
    };
    $('#load-brush').onclick = () => $('#brush-open').click();
    $('#import-foliage').onclick = openFoliageImport;
    $('#add-default-foliage').onclick = async () => {
      const kind = $<HTMLSelectElement>('#default-foliage')
        .value as DefaultFoliageKind;
      try {
        const applied = await prepareAction(
          'Preparing photoreal foliage…',
          async (signal) => {
            const next = await addDefaultFoliage(project, [kind], signal);
            assertProjectCapacity(next);
            return viewport.prepareLoad(next, false, signal);
          },
          (prepared) => {
            viewport.assertPrepared(prepared);
            checkpoint();
            viewport.applyPrepared(prepared);
            project = viewport.project;
            brushIndex = project.brushes.length - 1;
            foliageModelIndex = 0;
            refreshed();
          },
        );
        if (applied)
          notify(
            'Photoreal brush added. Paint or populate its allowed surfaces.',
          );
      } catch (error) {
        notify('Could not add default brush: ' + String(error), true);
      }
    };
    const selectedModel = (candidate: TerrainProject, selected: FoliageBrush) =>
      editFoliageModels(selected, candidate.foliage)[foliageModelIndex];
    const contactModel = (
      candidate: TerrainProject,
      selected: FoliageBrush,
    ) => {
      const model = selectedModel(candidate, selected);
      if (!model.interaction) {
        model.interaction = {
          enabled: candidate.interaction.enabled && model.crush > 0,
          radius: candidate.interaction.radius,
          recovery: candidate.interaction.recovery,
        };
        model.crush *= candidate.interaction.strength;
      }
      return model;
    };
    $('#crush-enabled').onchange = () => {
      const enabled = $<HTMLInputElement>('#crush-enabled').checked;
      editFoliage((candidate, selected) => {
        const model = contactModel(candidate, selected);
        model.interaction!.enabled = enabled;
        if (enabled && model.crush === 0) model.crush = 0.6;
      });
    };
    for (const [id, key] of [
      ['brush-crush', 'compression'],
      ['crush-radius', 'radius'],
      ['recovery', 'recovery'],
    ] as const)
      bindRange(
        id,
        (value) => {
          editFoliage((candidate, selected) => {
            const model = contactModel(candidate, selected);
            if (key === 'compression') model.crush = value;
            else model.interaction![key] = value;
          });
        },
        false,
      );
    bindFoliageShadingControls(
      foliageModels(brush)[foliageModelIndex],
      viewport.library,
      (settings) => {
        editFoliage((candidate, selected) => {
          selectedModel(candidate, selected).subsurface = settings;
        });
      },
      (message) => notify(message, true),
    );
    bindFoliageFlexibilityControls(
      foliageModels(brush)[foliageModelIndex],
      (mask) => {
        editFoliage((candidate, selected) => {
          selectedModel(candidate, selected).flexibility = mask;
        });
      },
      (message) => notify(message),
    );
    bindFoliageDetailControls(
      foliageModels(brush)[foliageModelIndex],
      (detail) => {
        editFoliage((candidate, selected) => {
          Object.assign(selectedModel(candidate, selected), detail);
        });
      },
      (message) => notify(message),
      (index) => {
        assetLodIndex = index;
        $('#asset-open').click();
      },
    );
    $('#model-entry').onchange = () => {
      foliageModelIndex = Number($<HTMLSelectElement>('#model-entry').value);
      renderInspector();
    };
    $('#add-model').onclick = () => {
      if (foliageModels(brush).length >= 32) return;
      editFoliage((candidate, selected) => {
        const models = editFoliageModels(selected, candidate.foliage);
        models.push({
          ...structuredClone(models[foliageModelIndex]),
          id: 'model-' + candidate.nextId++,
          model: 'grass',
          interaction: { enabled: true, radius: 4, recovery: 2.5 },
          flexibility: undefined,
          lods: undefined,
          cullDistance: undefined,
          lodHysteresis: undefined,
          lodFadeDuration: undefined,
          wind: 1.2,
          crush: 1,
          minScale: 0.6,
          maxScale: 1.4,
          color: '#85965a',
          alignToNormal: true,
        });
        return { model: models.length - 1 };
      }, false);
    };
    $('#remove-model').onclick = () => {
      if (foliageModels(brush).length <= 1) return;
      editFoliage((candidate, selected) => {
        const models = editFoliageModels(selected, candidate.foliage);
        const removed = models.splice(foliageModelIndex, 1)[0];
        candidate.foliage = candidate.foliage.filter(
          (instance) =>
            instance.brushId !== selected.id || instance.modelId !== removed.id,
        );
        return { model: Math.min(foliageModelIndex, models.length - 1) };
      });
    };
    $('#foliage-model').onchange = () => {
      const model = $<HTMLSelectElement>('#foliage-model').value;
      editFoliage((candidate, selected) => {
        selectedModel(candidate, selected).model = model;
      });
    };
    for (const [id, key] of Object.entries({
      density: 'density',
      'foliage-spacing': 'spacing',
      'max-foliage-slope': 'maxSlope',
      'min-weight': 'minWeight',
    }))
      bindRange(
        id,
        (value) => {
          editFoliage((_candidate, selected) => {
            (selected as unknown as Record<string, unknown>)[key] = value;
          }, false);
        },
        false,
      );
    for (const [id, key] of Object.entries({
      'model-weight': 'weight',
      'min-scale': 'minScale',
      'max-scale': 'maxScale',
      'min-rotation': 'minRotation',
      'max-rotation': 'maxRotation',
      'brush-wind': 'wind',
    }))
      bindRange(
        id,
        (value) => {
          editFoliage((candidate, selected) => {
            const model = selectedModel(candidate, selected);
            (model as unknown as Record<string, unknown>)[key] = value;
            if (key === 'minScale')
              model.maxScale = Math.max(model.minScale, model.maxScale);
            if (key === 'maxScale')
              model.minScale = Math.min(model.minScale, model.maxScale);
            if (key === 'minRotation')
              model.maxRotation = Math.max(
                model.minRotation,
                model.maxRotation,
              );
            if (key === 'maxRotation')
              model.minRotation = Math.min(
                model.minRotation,
                model.maxRotation,
              );
          }, key === 'wind');
        },
        false,
      );
    $('#align').onchange = () => {
      const align = $<HTMLInputElement>('#align').checked;
      editFoliage((candidate, selected) => {
        selectedModel(candidate, selected).alignToNormal = align;
      });
    };
    document.querySelectorAll<HTMLInputElement>('[data-allowed]').forEach(
      (element) =>
        (element.onchange = () => {
          const materials = Array.from(
            document.querySelectorAll<HTMLInputElement>(
              '[data-allowed]:checked',
            ),
          ).map((input) => input.dataset.allowed!);
          editFoliage((_candidate, selected) => {
            selected.materials = materials;
          }, false);
        }),
    );
    $('#populate').onclick = () => {
      let count = 0;
      if (
        editFoliage((candidate, selected) => {
          count = populateFoliage(candidate, selected.id);
        })
      )
        notify(
          count.toLocaleString() + ' instances placed on allowed surfaces.',
        );
    };
    $('#clear-brush').onclick = () => {
      if (
        editFoliage((candidate, selected) => {
          candidate.foliage = candidate.foliage.filter(
            (instance) => instance.brushId !== selected.id,
          );
        })
      )
        notify('This brush’s plants were cleared. Undo restores them.');
    };
  }
  if (tab === 'props') {
    const prop = project.props.find((p) => p.id === selectedProp);
    $('#prop-model').onchange = () =>
      (propModel = $<HTMLSelectElement>('#prop-model').value);
    $('#prop-cut').onchange = () =>
      (propCut = $<HTMLInputElement>('#prop-cut').checked);
    $('#prop-footprint').onchange = () => {
      propFootprintMode = $<HTMLSelectElement>('#prop-footprint')
        .value as typeof propFootprintMode;
      renderInspector();
    };
    if (document.querySelector('#prop-radius'))
      bindRange('prop-radius', (v) => (propRadius = v), false);
    for (const id of ['prop-width', 'prop-depth']) {
      const input = document.querySelector<HTMLInputElement>('#' + id);
      if (input)
        input.onchange = () => {
          const value = Number(input.value);
          if (!Number.isFinite(value) || value < 0.01 || value > 20000) {
            notify(
              'Enter a footprint dimension from 0.01 to 20000 metres.',
              true,
            );
            renderInspector();
            return;
          }
          if (id === 'prop-width') propWidth = value;
          else propDepth = value;
        };
    }
    $('#place-prop').onclick = () => setTool('prop');
    $('#select-prop').onclick = () => setTool('select');
    if (prop) {
      for (const [id, key] of Object.entries({
        'prop-x': 'x',
        'prop-z': 'z',
        'prop-y': 'yOffset',
        'prop-scale': 'scale',
        'prop-rotation': 'rotation',
      }))
        bindRange(
          id,
          (value) => {
            editProp(prop.id, (next) => {
              (next as unknown as Record<string, unknown>)[key] =
                key === 'rotation' ? (value * Math.PI) / 180 : value;
            });
          },
          false,
        );
      if (document.querySelector('#selected-radius'))
        bindRange(
          'selected-radius',
          (value) => {
            editProp(prop.id, (next) => {
              next.holeRadius = value;
            });
          },
          false,
        );
      bindPropCutoutControls(
        prop,
        (cutout) => {
          editProp(prop.id, (next) => {
            if (cutout) next.cutout = cutout;
            else delete next.cutout;
          });
        },
        () => modelFootprint(prop.model, prop.scale),
        (message) => notify(message, true),
      );
      $('#selected-cut').onchange = () => {
        const cutHole = $<HTMLInputElement>('#selected-cut').checked;
        editProp(prop.id, (next) => {
          next.cutHole = cutHole;
        });
      };
      $('#delete-prop').onclick = () => {
        editProps((candidate) => {
          candidate.props = candidate.props.filter(
            (value) => value.id !== prop.id,
          );
          return null;
        });
      };
    }
  }
  if (tab === 'light') {
    bindEnvironmentControls(
      () => project.environment,
      changeEnvironment,
      () => $('#environment-open').click(),
      (message) => {
        renderInspector();
        notify('Could not update lighting: ' + message, true);
      },
      () => viewport.lighting.solarHour,
    );
  }
  if (tab === 'wind') {
    for (const [id, key] of Object.entries({
      'wind-strength': 'strength',
      'wind-direction': 'direction',
      'wind-gust': 'gust',
      'wind-speed': 'speed',
    }))
      bindRange(
        id,
        (v) =>
          editWorld((settings) => {
            settings.wind[key as 'strength' | 'direction' | 'gust' | 'speed'] =
              v;
          }),
        false,
      );
  }
  if (['light', 'wind', 'water'].includes(tab)) {
    for (const [id, group, key] of [
      ['wind-enabled', 'wind', 'enabled'],
      ['low-poly', 'view', 'lowPoly'],
      ['wireframe', 'view', 'wireframe'],
    ] as const)
      if (document.getElementById(id))
        $('#' + id).onchange = () => {
          const checked = $<HTMLInputElement>('#' + id).checked;
          editWorld((settings) => {
            (settings[group] as unknown as Record<string, unknown>)[key] =
              checked;
          });
        };
  }
  if (tab === 'water') {
    bindWaterControls(
      pendingWater ?? project.water ?? defaultWaterSettings(project),
      selectedWater,
      editWater,
      (id) => {
        selectedWater = id;
        renderInspector();
      },
      setWaterPlacement,
      finishWaterOutline,
    );
  }
  if (tab === 'project') {
    $('#eye-height').onchange = () => {
      const value = $<HTMLInputElement>('#eye-height').valueAsNumber;
      if (value === parseEyeHeight(project.view.eyeHeight)) return;
      editWorld((settings) => {
        settings.view.eyeHeight = parseEyeHeight(value);
      });
    };
    $('#terrain-size').oninput = () => {
      const size = $<HTMLInputElement>('#terrain-size').valueAsNumber;
      $('#terrain-size-preview').textContent =
        Number.isFinite(size) && size >= 8 && size <= 10000
          ? terrainMetrics(project.resolution, size)
          : 'Enter a terrain size from 8 to 10000 metres.';
    };
    $('#resize-terrain').onclick = async () => {
      const size = $<HTMLInputElement>('#terrain-size').valueAsNumber;
      if (size === project.size) return;
      const elevation = $<HTMLInputElement>('#scale-elevation').checked;
      try {
        const applied = await prepareAction(
          'Resizing terrain…',
          (signal) =>
            viewport.prepareLoad(
              resizeTerrain(project, size, elevation),
              false,
              signal,
            ),
          applyTerrainReplacement,
        );
        if (applied) {
          viewport.frameTerrain();
          notify('Terrain resized. Undo restores the previous size.');
        }
      } catch (error) {
        notify(
          'Could not resize terrain. The previous scene was kept: ' +
            String(error),
          true,
        );
      }
    };
  }
  const cleanup = document.querySelector<HTMLButtonElement>('#prune-assets');
  if (cleanup)
    cleanup.onclick = async () => {
      try {
        const applied = await prepareAction(
          'Removing unused models…',
          async (signal) => {
            const candidate = structuredClone(project);
            for (const id of unusedModelAssetIds(candidate))
              delete candidate.assets[id];
            return viewport.prepareLoad(candidate, false, signal);
          },
          (prepared) => {
            viewport.assertPrepared(prepared);
            checkpoint();
            viewport.applyPrepared(prepared);
            project = viewport.project;
            refreshed();
          },
        );
        if (applied) notify('Unused model assets removed.');
      } catch (error) {
        notify('Could not remove assets: ' + String(error), true);
      }
    };
  if (document.querySelector('#import-model'))
    $('#import-model').onclick = () => {
      assetLodIndex = null;
      $('#asset-open').click();
    };
}
function updateScene() {
  $('#foliage-count').textContent = project.foliage.length.toLocaleString();
  const clearBrush = document.querySelector<HTMLButtonElement>('#clear-brush');
  if (clearBrush)
    clearBrush.disabled = !project.foliage.some(
      (instance) => instance.brushId === project.brushes[brushIndex]?.id,
    );
  $('#scene-count').textContent = String(1 + project.props.length).padStart(
    2,
    '0',
  );
  $('#size-label').textContent = project.size + ' × ' + project.size + ' m';
  $('#resolution-label').textContent =
    project.resolution + ' × ' + project.resolution;
  $('#spacing-label').textContent =
    metres(project.size / project.resolution) + ' m';
  $('#shading-label').textContent = project.view.lowPoly ? 'Flat' : 'Smooth';
  $('#water-toggle').textContent = project.view.water ? 'On' : 'Off';
  $('#layer-list').innerHTML = project.materials
    .map(
      (m, i) =>
        '<button data-scene-material="' +
        i +
        '" class="layer-row"><span class="layer-swatch" style="background:' +
        m.color +
        '"></span><span>' +
        escape(m.name) +
        '</span><span class="layer-index">0' +
        (i + 1) +
        '</span></button>',
    )
    .join('');
  document.querySelectorAll('[data-scene-material]').forEach((el) =>
    el.addEventListener('click', () => {
      materialIndex = Number((el as HTMLElement).dataset.sceneMaterial);
      changeTab('materials');
    }),
  );
  $('#prop-list').innerHTML = project.props
    .map(
      (p) =>
        '<button data-prop="' +
        p.id +
        '" class="scene-item ' +
        (p.id === selectedProp ? 'selected' : '') +
        '">' +
        icon('box') +
        '<span>' +
        escape(
          p.model.startsWith('asset-')
            ? (project.assets[p.model]?.name ?? p.model)
            : p.model,
        ) +
        ' ' +
        p.id +
        '</span>' +
        (p.cutHole ? '<span class="tag">CUT</span>' : '') +
        '</button>',
    )
    .join('');
  document.querySelectorAll('[data-prop]').forEach((el) =>
    el.addEventListener('click', () => {
      selectedProp = Number((el as HTMLElement).dataset.prop);
      changeTab('props');
      setTool('select');
      updateScene();
    }),
  );
  refreshIcons();
  syncPropTools();
}
viewport.onSelectProp = (id) => {
  selectedProp = id;
  renderInspector();
  updateScene();
};
viewport.onTerrainClick = (point) => {
  if (tab !== 'water') return false;
  if (!point || !waterPlacement) return true;
  if (waterPlacement === 'polygon') {
    if (waterPoints.length >= 128) {
      notify('An outline supports up to 128 points.');
      return true;
    }
    waterPoints.push({ x: point.x, y: point.y, z: point.z });
    renderInspector();
    return true;
  }
  const id = crypto.randomUUID(),
    kind = waterPlacement,
    previous = selectedWater;
  selectedWater = id;
  void editWater((w) =>
    w.bodies.push({
      id,
      name: (kind === 'basin' ? 'Lake ' : 'Pond ') + (w.bodies.length + 1),
      enabled: true,
      elevation: point.y + 0.8,
      extent:
        kind === 'basin'
          ? { kind, x: point.x, z: point.z }
          : {
              kind,
              x: point.x,
              z: point.z,
              radiusX: Math.min(12, project.size * 0.1),
              radiusZ: Math.min(8, project.size * 0.07),
              rotation: 0,
            },
      surface: waterPreset('lake'),
    }),
  ).then((applied) => {
    if (applied) setWaterPlacement(null);
    else {
      selectedWater = previous;
      renderInspector();
    }
  });
  return true;
};
viewport.propTools.onBegin = () => {
  cancelPreparation();
  documentRevision++;
  viewport.clearBalls();
};
viewport.propTools.onPreview = (active) => {
  $('#prop-transform-hint').textContent = active
    ? 'Release to apply · Esc cancels'
    : 'Drag a handle · Esc cancels';
};
viewport.propTools.onCommit = (before, after) => {
  editProp(before.id, (prop) => {
    Object.assign(prop, after);
  });
};
document.querySelectorAll<HTMLButtonElement>('[data-prop-transform]').forEach(
  (button) =>
    (button.onclick = () => {
      propTransformMode = button.dataset.propTransform as TransformControlsMode;
      viewport.propTools.setMode(propTransformMode);
      setTool('select');
    }),
);
$('#prop-snap').onchange = () => {
  propSnap = $<HTMLInputElement>('#prop-snap').checked;
  viewport.propTools.setSnapping(propSnap);
};
viewport.onStamp = (point, first, dose) => {
  if (erosionPanel) return;
  if (dropMode) {
    if (first) viewport.dropBall(point);
    return;
  }
  if (tool === 'select') return;
  if (tool === 'prop') {
    if (!first) return;
    const prop: PropInstance = {
      id: project.nextId,
      model: propModel,
      x: point.x,
      z: point.z,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: propCut,
      holeRadius: propRadius,
    };
    try {
      if (propFootprintMode === 'model')
        prop.cutout = modelFootprint(propModel, 1);
      else if (propFootprintMode === 'rectangle')
        prop.cutout = {
          shape: 'rectangle',
          width: propWidth,
          depth: propDepth,
          offsetX: 0,
          offsetZ: 0,
        };
    } catch (error) {
      notify('Could not fit model bounds: ' + String(error), true);
      return;
    }
    if (
      editProps((candidate) => {
        candidate.nextId++;
        candidate.props.push(prop);
        return prop.id;
      })
    )
      setTool('select');
    return;
  }
  try {
    if (first) {
      beginBrushStroke();
      strokeSeed++;
    }
    if (!activeStroke) return;
    const stroke: BrushStroke = {
      tool,
      x: point.x,
      z: point.z,
      radius,
      strength: strength * dose,
      falloff,
      alpha:
        tab === 'sculpt' && tool !== 'hole' && tool !== 'fill'
          ? activeAlpha(tool === 'stamp')
          : undefined,
      rotation: (sculptSettings().rotation * Math.PI) / 180,
      talus: (project.erosion ?? defaultErosionSettings()).talus,
      stampMode: sculptSettings().stampMode,
      stampBase: sculptSettings().stampBase,
      target: tool === 'stamp' ? sculptSettings().stampHeight : targetHeight,
      material: materialIndex,
      brushId: project.brushes[brushIndex]?.id ?? project.brushes[0].id,
      seed: project.seed + strokeSeed++,
    };
    applyBrush(project, stroke);
    delayedTerrain(stroke);
  } catch (error) {
    rollbackBrushStroke(error);
  }
};
viewport.onStrokeEnd = finishBrushStroke;
viewport.onStrokeCancel = () => rollbackBrushStroke();
viewport.onHover = (point) => {
  const guide: { x: number; y: number; z: number }[] = [];
  if (tab === 'water' && !viewport.navigationActive) {
    if (waterPlacement === 'polygon')
      guide.push(...waterPoints, ...(point ? [point] : []));
    else if (!waterPlacement) {
      const body = project.water?.bodies.find((b) => b.id === selectedWater);
      if (body?.extent.kind === 'polygon')
        for (const p of body.extent.points)
          guide.push({
            ...p,
            y: Math.max(body.elevation, heightAt(project, p.x, p.z)),
          });
      if (body?.extent.kind === 'ellipse') {
        const e = body.extent,
          a = (e.rotation * Math.PI) / 180;
        for (let i = 0; i < 64; i++) {
          const t = (i / 64) * Math.PI * 2,
            dx = Math.cos(t) * e.radiusX,
            dz = Math.sin(t) * e.radiusZ;
          const x = e.x + dx * Math.cos(a) - dz * Math.sin(a),
            z = e.z + dx * Math.sin(a) + dz * Math.cos(a);
          guide.push({
            x,
            z,
            y: Math.max(body.elevation, heightAt(project, x, z)),
          });
        }
      }
    }
  }
  viewport.setWaterGuide(guide);
  if (point)
    $('#coordinates').textContent =
      'X ' +
      point.x.toFixed(1) +
      '   Y ' +
      point.y.toFixed(1) +
      '   Z ' +
      point.z.toFixed(1);
};
$('#fps').title = 'Rendering on ' + viewport.gpuRenderer;
$('.gpu-dot').title = viewport.gpuRenderer;
viewport.onStats = (fps, triangles) => {
  if (tab === 'light')
    updateDaylightReadout(
      project.environment,
      viewport.lighting.solarHour,
      viewport.lighting.animationError,
    );
  $('#fps').textContent = fps + ' FPS';
  $('#triangle-count').textContent = triangles.toLocaleString() + ' triangles';
  const detailStats = document.getElementById('foliage-detail-stats');
  if (detailStats) {
    const stats = viewport.content.foliage.viewStats;
    detailStats.textContent =
      stats.instances.toLocaleString() +
      ' plants selected · ' +
      stats.culled.toLocaleString() +
      ' hidden by distance/density · ' +
      stats.triangles.toLocaleString() +
      ' foliage triangles before frustum culling' +
      (stats.transitioning
        ? ' · ' + stats.transitioning.toLocaleString() + ' plants cross-fading'
        : '');
  }
};
viewport.brushRadius = radius;
document
  .querySelectorAll('[data-tab]')
  .forEach((el) =>
    el.addEventListener('click', () =>
      changeTab((el as HTMLElement).dataset.tab!),
    ),
  );
for (const direction of ['undo', 'redo'] as const)
  $('#' + direction).onclick = async () => {
    let restore: ReturnType<History['prepareUndo']>;
    try {
      viewport.finishStroke();
      restore =
        direction === 'undo' ? history.prepareUndo() : history.prepareRedo();
      if (!restore) return;
      const candidate = restore;
      await prepareAction(
        'Restoring ' + direction + '…',
        (signal) => viewport.prepareLoad(candidate.project, true, signal),
        (prepared) => {
          viewport.assertPrepared(prepared);
          project = candidate.commit(project);
          viewport.applyPrepared(prepared);
          refreshed();
        },
      );
    } catch (error) {
      notify('Could not restore history: ' + String(error), true);
    } finally {
      restore?.dispose();
    }
  };
$('#cancel-preparation').onclick = () => {
  cancelPreparation();
  if (tab === 'light') renderInspector();
  notify('Preparation cancelled.');
};
$('#project-name').onchange = () => {
  const name =
    $<HTMLInputElement>('#project-name').value.trim().slice(0, 120) ||
    'Untitled terrain';
  try {
    checkpoint();
    project.name = name;
  } catch (error) {
    $<HTMLInputElement>('#project-name').value = project.name;
    notify('Could not rename the project: ' + String(error), true);
    return;
  }
  $<HTMLInputElement>('#project-name').value = project.name;
  persist();
};
$('#frame').onclick = () => viewport.frameTerrain();
$('#wire').onclick = () =>
  editWorld((settings) => {
    settings.view.wireframe = !settings.view.wireframe;
  });
$('#water-toggle').onclick = () =>
  editWater((w) => {
    w.ocean.enabled = !w.ocean.enabled;
  });
$('#terrain-select').onclick = () => changeTab('sculpt');
$('#save').onclick = async () => {
  viewport.finishStroke();
  viewport.propTools.cancel();
  const button = $<HTMLButtonElement>('#save');
  const label = button.innerHTML;
  const name = project.name.replace(/[^a-z0-9-_]/gi, '-') + '.terrain';
  button.disabled = true;
  button.textContent = 'Preparing file…';
  try {
    const data = await projectDownload(project);
    download(data, name);
    void saveLocal(project).catch((error) =>
      notify(
        'File downloaded, but local autosave failed: ' + String(error),
        true,
      ),
    );
    notify(
      'Project downloaded. Keep the .terrain file in your project folder’s root.',
    );
  } catch (error) {
    notify('Could not save project: ' + String(error), true);
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
};
async function changeEnvironment(value: EnvironmentSettings) {
  const settings = parseEnvironmentSettings(value);
  assertProjectCapacity({ ...project, environment: settings });
  await prepareAction(
    'Preparing lighting…',
    async (signal) => {
      const prepared = viewport.lighting.matchesSource(settings)
        ? undefined
        : await viewport.lighting.prepare(settings);
      let canopy:
        | Awaited<ReturnType<typeof viewport.content.canopyLighting.prepare>>
        | undefined;
      let applied = false;
      try {
        canopy = await viewport.content.canopyLighting.prepare(
          project,
          settings,
          undefined,
          signal,
        );
        await viewport.content.canopyLighting.prepareGPU(
          canopy,
          viewport.renderer,
        );
        return {
          apply() {
            canopy!.assert(viewport.content.canopyLighting);
            history.checkpoint(project);
            if (prepared) viewport.lighting.apply(prepared, project);
            else viewport.lighting.set(settings, project);
            applied = true;
            project.environment = settings;
            viewport.content.canopyLighting.apply(canopy!);
            persist();
            renderInspector();
          },
          dispose() {
            if (!applied) prepared?.dispose();
            canopy?.dispose();
          },
        };
      } catch (error) {
        prepared?.dispose();
        canopy?.dispose();
        throw error;
      }
    },
    (prepared) => prepared.apply(),
  );
}
$<HTMLInputElement>('#environment-open').onchange = async (event) => {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  cancelPreparation();
  const source = project,
    revision = ++documentRevision;
  try {
    if (file.size > MAX_ENVIRONMENT_BYTES)
      throw new Error('HDR/EXR environment must be under 32 MB.');
    const data = await readDataUrl(
      new File([file], file.name, { type: 'application/octet-stream' }),
    );
    if (project !== source || revision !== documentRevision)
      throw new Error('The document changed during import. Try again.');
    await changeEnvironment({
      ...(project.environment ?? defaultEnvironmentSettings()),
      mode: 'image',
      ...(project.environment?.timeOfDay
        ? {
            timeOfDay: {
              ...project.environment.timeOfDay,
              enabled: false,
              playing: false,
            },
          }
        : {}),
      image: { name: file.name.slice(0, 120), data },
    });
    notify('Environment imported.');
  } catch (error) {
    notify('Could not import environment: ' + String(error), true);
  }
  input.value = '';
};
async function openDocument(
  read: (signal: AbortSignal) => Promise<Blob>,
  label = 'Opening project…',
) {
  return prepareAction(
    label,
    async (signal) => {
      const file = await read(signal);
      checkSignal(signal);
      const next = await readProjectFile(file);
      assertProjectCapacity(next);
      checkSignal(signal);
      return viewport.prepareLoad(next, true, signal);
    },
    (prepared) => {
      viewport.assertPrepared(prepared);
      checkpoint();
      viewport.applyPrepared(prepared);
      project = viewport.project;
      selectedProp = null;
      brushIndex = 0;
      foliageModelIndex = 0;
      refreshed();
    },
  );
}
$('#open').onclick = () => $('#file-open').click();
$<HTMLInputElement>('#file-open').onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  try {
    const applied = await openDocument(async () => file);
    if (applied) notify('Project loaded.');
  } catch (error) {
    notify('Could not open project: ' + String(error), true);
  }
  input.value = '';
};
$('#export').onclick = async () => {
  if (exportController) return;
  viewport.finishStroke();
  flushBrush();
  cancelPreparation();
  const controller = (exportController = new AbortController());
  const mode = $<HTMLSelectElement>('#export-mode').value;
  const dialog = document.createElement('dialog');
  dialog.id = 'export-dialog';
  dialog.className = 'export-panel';
  dialog.setAttribute('aria-labelledby', 'export-title');
  dialog.innerHTML =
    '<span class="eyebrow">SCENE EXPORT</span><h1 id="export-title">Preparing your scene</h1><p id="export-progress" role="status" aria-live="polite">Preparing project…</p><p class="field-note">The editor resumes when export finishes. PBR mode bakes the visible surface into a fixed-resolution terrain atlas; the full editable project is included.</p><button id="cancel-export">Cancel export</button>';
  document.body.append(dialog);
  const progress = dialog.querySelector<HTMLElement>('#export-progress')!;
  const cancel = () => {
    controller.abort();
    progress.textContent = 'Cancelling export…';
    dialog.querySelector<HTMLButtonElement>('#cancel-export')!.disabled = true;
  };
  dialog.querySelector<HTMLButtonElement>('#cancel-export')!.onclick = cancel;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel();
  });
  dialog.showModal();
  try {
    const result = await viewport.exportGLB({
      surface: mode === 'colors' ? 'colors' : 'pbr',
      ...(mode === 'colors'
        ? {}
        : { resolution: Number(mode.slice(4)) as TerrainBakeResolution }),
      signal: controller.signal,
      onProgress: (message) => {
        if (!controller.signal.aborted) progress.textContent = message;
      },
    });
    checkSignal(controller.signal);
    download(result, 'terrain-scene.glb');
    notify(
      mode === 'colors'
        ? 'Scene exported with foliage, props, and the complete editable project.'
        : 'Scene exported with baked PBR maps and the complete editable project.',
    );
  } catch (error) {
    if (controller.signal.aborted) notify('Scene export cancelled.');
    else notify('Export failed: ' + String(error), true);
  } finally {
    dialog.close();
    dialog.remove();
    exportController = undefined;
    $('#export').focus();
  }
};
$('#screenshot').onclick = async () => {
  try {
    download(await viewport.capturePNG(), 'terrain-studio.png', 'image/png');
  } catch (error) {
    notify('Screenshot failed: ' + String(error), true);
  }
};
$('#help').onclick = () => $<HTMLDialogElement>('#guide').showModal();
$('#close-guide').onclick = () => $<HTMLDialogElement>('#guide').close();
$('#physics').onclick = async () => {
  viewport.finishStroke();
  const button = $<HTMLButtonElement>('#physics');
  button.disabled = true;
  try {
    await viewport.enablePhysics();
    dropMode = !dropMode;
    button.innerHTML =
      icon('circle') +
      (dropMode ? 'Click terrain to drop a body' : 'Drop test body');
    $('#physics-state').textContent = 'Terrain collision active';
    syncPropTools();
    if (dropMode) {
      $('#active-tool').innerHTML =
        icon('circle') + '<span>Drop physics body</span><kbd>LMB</kbd>';
      notify(
        'Click terrain to drop a body. Select any editing tool to return.',
      );
    } else {
      setTool(tool, false);
      notify('Physics body placement stopped.');
    }
    refreshIcons();
  } catch (e) {
    notify('Physics could not start: ' + String(e), true);
  }
  button.disabled = false;
};
$('#clear-balls').onclick = () => viewport.clearBalls();
let textureSlot: 'albedo' | 'normal' | 'orm' | 'height' = 'albedo';
$<HTMLInputElement>('#texture-open').onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  const index = materialIndex,
    slot = textureSlot;
  let data = '';
  try {
    const applied = await prepareAction(
      'Importing surface texture…',
      async (signal) => {
        data = await readTextureDataUrl(file, signal);
        checkSignal(signal);
        const candidate = surfaceDraft();
        candidate.materials[index].textures[slot] = data;
        assertProjectCapacity(candidate);
        return viewport.prepareSurface(candidate, false, signal);
      },
      applySurface,
    );
    if (applied) notify('Texture imported.');
    renderInspector();
  } catch (error) {
    notify(String(error), true);
  }
  input.value = '';
};
$<HTMLInputElement>('#sculpt-preset-open').onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  cancelPreparation();
  const source = project,
    revision = ++documentRevision;
  try {
    if (file.size > MAX_SCULPT_PRESET_BYTES)
      throw new Error('Sculpt preset must be under 8 MiB.');
    const preset = parseSculptPreset(await file.text());
    if (project !== source || revision !== documentRevision)
      throw new Error(
        'The document changed during import; load the preset again.',
      );
    checkpoint();
    project.sculpt = preset.settings;
    (project.erosion ??= defaultErosionSettings()).talus = preset.talus;
    changeTab('sculpt');
    persist();
    notify('Sculpt preset loaded: ' + preset.settings.brush.name + '.');
  } catch (error) {
    notify('Could not load sculpt preset: ' + String(error), true);
  }
  input.value = '';
};
$<HTMLInputElement>('#alpha-open').onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  cancelPreparation();
  const sourceProject = project,
    revision = ++documentRevision;
  try {
    if (file.size > 64_000_000) throw new Error('PNG must be under 64 MB.');
    let alpha = await decodeHeightmapPNG(await file.arrayBuffer(), true);
    if (alpha.width > 512 || alpha.height > 512) {
      const ratio = 512 / Math.max(alpha.width, alpha.height);
      alpha = resampleHeightmap(
        alpha,
        Math.max(1, Math.round(alpha.width * ratio)),
        Math.max(1, Math.round(alpha.height * ratio)),
      );
    }
    if (project !== sourceProject || revision !== documentRevision)
      throw new Error(
        'The document changed during import; import again to apply this alpha.',
      );
    checkpoint();
    Object.assign(editSculptSettings(), {
      alpha,
      alphaKind: 'custom',
      alphaName: file.name.slice(0, 120),
    });
    renderInspector();
    persist();
    notify('Alpha imported: ' + alpha.width + ' × ' + alpha.height + '.');
  } catch (error) {
    notify('Could not import alpha: ' + String(error), true);
  }
  input.value = '';
};
$<HTMLInputElement>('#heightmap-open').onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  const minimum = heightmapMinimum,
    maximum = heightmapMaximum,
    flip = heightmapFlip,
    width = rawWidth,
    height = rawHeight,
    littleEndian = rawLittleEndian;
  let sourceDimensions = '';
  try {
    const applied = await prepareAction(
      'Importing heightmap…',
      async (signal) => {
        if (file.size > 64_000_000)
          throw new Error('Heightmap must be under 64 MB.');
        const data = await file.arrayBuffer();
        checkSignal(signal);
        const map = file.name.toLowerCase().endsWith('.png')
          ? await decodeHeightmapPNG(data)
          : decodeRaw16(data, width, height, littleEndian);
        checkSignal(signal);
        sourceDimensions = map.width + ' × ' + map.height;
        const candidate = { ...project };
        applyHeightmap(candidate, map, minimum, maximum, flip);
        return viewport.prepareLoad(candidate, false, signal);
      },
      (prepared) => applyTerrainReplacement(prepared),
    );
    if (applied)
      notify(
        'Heightmap imported: ' +
          sourceDimensions +
          ', resampled to ' +
          (project.resolution + 1) +
          ' × ' +
          (project.resolution + 1) +
          '.',
      );
  } catch (error) {
    notify(
      'Could not import heightmap. The previous scene was kept: ' +
        String(error),
      true,
    );
  }
  input.value = '';
};
$<HTMLInputElement>('#surface-preset-open').onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  const index = materialIndex,
    target = project.materials[index],
    applyPlacementRules = surfacePresetRules;
  try {
    const applied = await prepareAction(
      'Loading surface preset…',
      async (signal) => {
        if (file.size > MAX_MATERIAL_PRESET_BYTES)
          throw new Error('Surface preset must be under 128 MiB.');
        const text = await file.text();
        checkSignal(signal);
        const next = surfaceDraft();
        next.materials[index] = applyMaterialPreset(
          target,
          parseMaterialPreset(text),
          {
            applyPlacementRules,
          },
        );
        assertProjectCapacity(next);
        return viewport.prepareSurface(next, applyPlacementRules, signal);
      },
      applySurface,
    );
    if (applied)
      notify('Surface preset loaded. Undo restores the previous layer.');
  } catch (error) {
    notify('Could not load surface preset: ' + String(error), true);
  }
  input.value = '';
};
$<HTMLInputElement>('#brush-open').onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  try {
    const applied = await prepareAction(
      'Importing foliage brush…',
      async (signal) => {
        if (file.size > 100_000_000)
          throw new Error('Brush must be under 100 MB.');
        const text = await file.text();
        checkSignal(signal);
        const next = importFoliageBrush(project, text);
        assertProjectCapacity(next);
        return viewport.prepareLoad(next, false, signal);
      },
      (prepared) => {
        viewport.assertPrepared(prepared);
        checkpoint();
        viewport.applyPrepared(prepared);
        project = viewport.project;
        brushIndex = project.brushes.length - 1;
        foliageModelIndex = 0;
        changeTab('foliage');
        refreshed();
      },
    );
    if (applied)
      notify(
        'Brush imported. Surfaces matched by ID, then by layer position; review allowed surfaces.',
      );
  } catch (error) {
    notify('Could not import brush: ' + String(error), true);
  }
  input.value = '';
};
$<HTMLInputElement>('#asset-open').onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  const targetTab = tab,
    targetBrush = brushIndex,
    targetModel = foliageModelIndex,
    targetLod = assetLodIndex;
  assetLodIndex = null;
  let importedId = '';
  try {
    const applied = await prepareAction(
      'Importing model…',
      async (signal) => {
        checkModelFileSize(file.size, file.name);
        if (Object.keys(project.assets).length >= 256)
          throw new Error('Maximum 256 model assets.');
        const data = await readDataUrl(file, signal, (fraction) => {
          if (!signal.aborted)
            $('#preparation-status span').textContent =
              `Reading ${file.name} · ${Math.round(fraction * 100)}%…`;
        });
        checkSignal(signal);
        $('#preparation-status span').textContent =
          `Preparing geometry and textures for ${file.name}…`;
        const next = structuredClone(project);
        importedId = 'asset-' + next.nextId++;
        next.assets[importedId] = { name: file.name.slice(0, 120), data };
        assertProjectCapacity(next);
        if (targetTab === 'foliage') {
          const model = editFoliageModels(
            next.brushes[targetBrush],
            next.foliage,
          )[targetModel];
          if (targetLod !== null) model.lods![targetLod].model = importedId;
          else model.model = importedId;
        }
        return viewport.prepareLoad(next, false, signal);
      },
      (prepared) => {
        viewport.assertPrepared(prepared);
        checkpoint();
        viewport.applyPrepared(prepared);
        project = viewport.project;
        if (targetTab !== 'foliage') propModel = importedId;
        refreshed();
      },
    );
    if (applied) notify('Model imported.');
  } catch (error) {
    notify('Import failed: ' + String(error), true);
  }
  input.value = '';
};
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || $('#app').inert) return;
  if (
    waterPlacement &&
    !(
      e.target instanceof HTMLElement &&
      e.target.closest('input,select,textarea')
    )
  ) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setWaterPlacement(null);
      return;
    }
    if (e.key === 'Enter' && waterPlacement === 'polygon') {
      e.preventDefault();
      finishWaterOutline();
      return;
    }
  }
  if (e.key === 'Escape' && viewport.cancelStroke()) {
    e.preventDefault();
    notify('Stroke cancelled.');
    return;
  }
  if (exportController) {
    if (e.key === 'Escape') {
      e.preventDefault();
      document.querySelector<HTMLButtonElement>('#cancel-export')?.click();
    }
    return;
  }
  if (ormPanel) {
    if (e.key === 'Escape') {
      e.preventDefault();
      ormPanel.close();
    }
    return;
  }
  if (erosionPanel) {
    if (e.key === 'Escape') {
      e.preventDefault();
      erosionPanel.close();
    }
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  if (
    e.target instanceof HTMLElement &&
    (e.target.isContentEditable ||
      e.target.closest('input,select,textarea,[role="textbox"]'))
  )
    return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    $('#' + (e.shiftKey ? 'redo' : 'undo')).click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    $('#save').click();
  }
  if (
    e.key.toLowerCase() === 'f' &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey
  )
    viewport.frameTerrain();
  if (e.key === '[' || e.key === ']') {
    radius = Math.max(1, Math.min(50, radius + (e.key === '[' ? -1 : 1)));
    viewport.brushRadius = radius;
    rememberSculptBrush();
    renderInspector();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (dirty || activeStroke) {
    e.preventDefault();
  }
});
async function start() {
  const app = $('#app');
  app.inert = true;
  const warnings: string[] = [];
  const stages: Record<ViewportLoadStage, [number, string]> = {
    lighting: [3, 'Preparing sky and lighting…'],
    terrain: [4, 'Building terrain and foliage…'],
    shaders: [5, 'Preparing scene rendering…'],
    water: [6, 'Preparing water…'],
  };
  const progress = (stage: ViewportLoadStage) =>
    startupLoading.stage(...stages[stage]);
  await startupLoading.stage(1, 'Checking your locally saved project…');
  let saved: TerrainProject | null = null;
  try {
    saved = await loadLocal();
  } catch {
    warnings.push('Local save unavailable; file save is still available.');
  }
  if (saved) {
    await startupLoading.stage(2, 'Opening your saved terrain…');
    await viewport.load(saved, true, undefined, progress);
    project = saved;
  } else {
    try {
      await startupLoading.stage(2, 'Loading default brushes…');
      const next = await addDefaultFoliage(
        { ...project, brushes: [] },
        defaultFoliageChoices.map(([id]) => id),
        undefined,
        (completed, total) =>
          startupLoading.update(
            2,
            `Loading default brushes · ${completed} of ${total}`,
            completed / total,
          ),
      );
      populateFoliage(next, next.brushes[0].id);
      await viewport.load(next, true, undefined, progress);
      project = next;
    } catch (error) {
      await startupLoading.stage(2, 'Opening basic brushes…');
      populateFoliage(project, 'pine');
      await viewport.load(project, true, undefined, progress);
      warnings.push(
        'Default foliage unavailable; opened basic brushes. Retry from Foliage → Default brushes. ' +
          String(error),
      );
    }
  }
  await startupLoading.stage(7, 'Rendering the first view…');
  viewport.frameTerrain();
  restoreSculptBrush();
  renderInspector();
  updateScene();
  updateHistory();
  $<HTMLInputElement>('#project-name').value = project.name;
  refreshIcons();
  await viewport.present();
  await startupLoading.stage(8, 'Your world is ready');
  startupLoading.close();
  app.inert = false;
  if (warnings.length) notify(warnings.join(' '), true);
}
void start().catch((e) => {
  if (!document.querySelector('.renderer-notice'))
    startupLoading.fail(String(e), downloadLocalProject);
  console.error(e);
});
