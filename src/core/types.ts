import type { EnvironmentSettings } from './environment';
import type { WaterSettings } from './water';
import type { ErosionSettings } from './erosion';
import type { Heightmap } from './heightmap';
import type { FoliageSubsurface } from './foliage-shading';
export type SculptTool =
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  | 'terrace'
  | 'noise'
  | 'erode'
  | 'stamp'
  | 'hole'
  | 'fill'
  | 'material'
  | 'foliage'
  | 'erase'
  | 'prop'
  | 'select';
export interface MaterialLayer {
  id: string;
  name: string;
  color: string;
  roughness: number;
  metalness: number;
  minHeight: number;
  maxHeight: number;
  minSlope: number;
  maxSlope: number;
  feather: number;
  tileSize: number;
  /** Blend offset texture patches to reduce repetition. Omitted or false preserves regular tiling. */
  reduceTiling?: boolean;
  blendHeight: number;
  normalStrength?: number;
  /** Tangent-space normal Y convention; omitted preserves OpenGL (+Y). */
  normalConvention?: 'opengl' | 'directx';
  /** Procedural fallback variant; omitted uses this material's original layer slot. */
  proceduralVariant?: 0 | 1 | 2 | 3;
  textures: { albedo?: string; normal?: string; orm?: string; height?: string };
}
export interface FoliageLOD {
  /** Static model with the same origin, orientation and dimensions as the primary. */
  model: string;
  /** Start distance in terrain-local metres. */
  distance: number;
  /** Stable retained fraction, from 0 to 1. */
  density: number;
}
/** Per-vertex response shared by wind and contact. Zero is rigid; one is flexible. */
export interface FoliageFlexibility {
  source: 'height' | 'red' | 'green' | 'blue' | 'alpha' | 'attribute';
  /** Remap a normalized source value. end must exceed start by at least 0.001. */
  start: number;
  end: number;
  /** 1 is linear; larger values keep more of the plant rigid. Range 1–8. */
  exponent: number;
}
/** A weighted member of a foliage brush. Scale and yaw are sampled on placement. */
export interface FoliageModel {
  /** Omitted preserves standard PBR shading. Applies to this model and its LODs. */
  subsurface?: FoliageSubsurface;
  /** Per-asset contact behavior. Omitted uses legacy project interaction settings. */
  interaction?: {
    enabled: boolean;
    /** Influence radius from each contact center, in terrain metres. */
    radius: number;
    /** Exponential recovery time constant, in seconds. */
    recovery: number;
  };
  /** Omitted preserves whole-plant contact and the legacy height-based wind. */
  flexibility?: FoliageFlexibility;
  lods?: FoliageLOD[];
  /** 0 or omitted keeps foliage at unlimited distance. */
  cullDistance?: number;
  /** Fraction of each threshold used to avoid rapid switching; default 0.1. */
  lodHysteresis?: number;
  /** Seconds for dithered detail/density/cull transitions. 0 or omitted switches immediately. */
  lodFadeDuration?: number;
  id: string;
  model: string;
  weight: number;
  minScale: number;
  maxScale: number;
  minRotation: number;
  maxRotation: number;
  alignToNormal: boolean;
  wind: number;
  /** Contact compression multiplier, 0–1. Legacy project strength also applies when interaction is omitted. */
  crush: number;
  color: string;
}
export interface FoliageBrush {
  /** When present, these entries replace the legacy single-model settings. */
  models?: FoliageModel[];
  /** Minimum centre-to-centre distance in metres within this brush. */
  spacing?: number;
  id: string;
  name: string;
  model: string;
  materials: string[];
  minWeight: number;
  density: number;
  minScale: number;
  maxScale: number;
  rotation: number;
  alignToNormal: boolean;
  maxSlope: number;
  wind: number;
  crush: number;
  color: string;
}
export interface FoliageInstance {
  id: number;
  brushId: string;
  /** Stable model entry; omitted for legacy single-model instances. */
  modelId?: string;
  x: number;
  z: number;
  scale: number;
  rotation: number;
}
/** Local-space footprint: uniform prop scale and Y rotation also transform this rectangle. */
export interface PropCutout {
  shape: 'rectangle';
  width: number;
  depth: number;
  offsetX: number;
  offsetZ: number;
}
export interface PropInstance {
  /** Omitted preserves the legacy circular holeRadius footprint. */
  cutout?: PropCutout;
  id: number;
  model: string;
  x: number;
  z: number;
  yOffset: number;
  scale: number;
  rotation: number;
  cutHole: boolean;
  holeRadius: number;
}
/** Settings shared by sculpt tools; distances are metres and strength is per stroke dab. */
export interface SculptBrushSettings {
  name: string;
  tool: Extract<
    SculptTool,
    | 'raise'
    | 'lower'
    | 'smooth'
    | 'flatten'
    | 'terrace'
    | 'noise'
    | 'erode'
    | 'stamp'
    | 'hole'
    | 'fill'
  >;
  radius: number;
  strength: number;
  falloff: number;
  target: number;
}
export interface SculptSettings {
  /** Omitted in older documents; the editor uses default brush settings. */
  brush?: SculptBrushSettings;
  alphaKind: 'none' | 'round' | 'ridge' | 'crater' | 'custom';
  alpha?: Heightmap;
  alphaName?: string;
  rotation: number;
  stampHeight: number;
  stampBase: number;
  stampMode: 'add' | 'subtract' | 'set';
  pressure: boolean;
}
export interface TerrainProject {
  sculpt?: SculptSettings;
  erosion?: ErosionSettings;
  environment?: EnvironmentSettings;
  /** Omitted preserves the legacy plane. */
  water?: WaterSettings;
  version: 1;
  name: string;
  /** Square terrain side length in metres; independent of grid resolution. */
  size: number;
  /** Number of cells per side; the heightfield has (resolution + 1)² vertices. */
  resolution: number;
  seed: number;
  heights: Float32Array;
  holes: Uint8Array;
  paint: Float32Array;
  materials: MaterialLayer[];
  brushes: FoliageBrush[];
  foliage: FoliageInstance[];
  props: PropInstance[];
  assets: Record<string, { name: string; data: string }>;
  wind: {
    enabled: boolean;
    strength: number;
    direction: number;
    gust: number;
    speed: number;
  };
  /** Legacy contact defaults. Per-model interaction overrides these fields. */
  interaction: {
    enabled: boolean;
    radius: number;
    strength: number;
    recovery: number;
  };
  view: {
    /** First-person camera height above terrain in metres. Omitted means 1.8 m. */
    eyeHeight?: number;
    textureResolution?: 256 | 512 | 1024 | 2048;
    lowPoly: boolean;
    wireframe: boolean;
    water: boolean;
    waterLevel: number;
  };
  nextId: number;
}
export interface BrushStroke {
  /** Thermal erosion angle of repose, in degrees. Defaults to 35. */
  talus?: number;
  alpha?: Heightmap;
  /** Rotation around terrain Y, in radians. */
  rotation?: number;
  stampMode?: SculptSettings['stampMode'];
  stampBase?: number;
  tool: SculptTool;
  x: number;
  z: number;
  radius: number;
  strength: number;
  falloff: number;
  target: number;
  material: number;
  brushId: string;
  seed: number;
}
export interface TerrainMeshData {
  positions: Float32Array;
  indices: Uint32Array;
  weights: Float32Array;
}

export interface TerrainRegion {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
