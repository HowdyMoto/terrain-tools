/** Renderer-independent world metadata. Sources are opaque locators resolved by a host. */
export interface WorldTile {
  /** Integer grid coordinates. Tile (0, 0) covers [0, tileSize) on X and Z. */
  readonly x: number;
  readonly z: number;
  readonly source: string;
}
export interface TerrainWorld {
  readonly kind: 'terrain-world';
  readonly version: 1;
  /** Square tile width in metres. A renderer places tile-local origins independently. */
  readonly tileSize: number;
  readonly tiles: readonly WorldTile[];
}
export interface WorldPosition {
  x: number;
  z: number;
}
export interface WorldTileSelection {
  readonly key: string;
  readonly tile: WorldTile;
  /** Squared horizontal distance in metres from the view to the closest tile edge. */
  readonly distanceSquared: number;
}
export const worldTileKey = (x: number, z: number) => `${x},${z}`;
const coordinate = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  Math.abs(value) <= 1_000_000;

/** Validate/copy metadata before exposing it to asynchronous loaders. No assets are fetched. */
export function validateTerrainWorld(input: unknown): TerrainWorld {
  if (!input || typeof input !== 'object')
    throw new Error('Invalid terrain world.');
  const value = input as Partial<TerrainWorld>;
  if (value.kind !== 'terrain-world' || value.version !== 1)
    throw new Error('Unsupported terrain world kind or version.');
  if (
    typeof value.tileSize !== 'number' ||
    !Number.isFinite(value.tileSize) ||
    value.tileSize < 1 ||
    value.tileSize > 10000
  )
    throw new Error('World tile size must be 1–10000 metres.');
  if (!Array.isArray(value.tiles) || value.tiles.length > 65536)
    throw new Error('A world supports at most 65536 tile descriptors.');
  const keys = new Set<string>();
  const tiles = value.tiles.map((tile: WorldTile) => {
    if (
      !tile ||
      !coordinate(tile.x) ||
      !coordinate(tile.z) ||
      typeof tile.source !== 'string' ||
      !tile.source.trim() ||
      tile.source.length > 2048
    )
      throw new Error('Invalid world tile coordinates or source.');
    const key = worldTileKey(tile.x, tile.z);
    if (keys.has(key))
      throw new Error('World tile coordinates must be unique.');
    keys.add(key);
    return Object.freeze({ x: tile.x, z: tile.z, source: tile.source });
  });
  return Object.freeze({
    kind: 'terrain-world',
    version: 1,
    tileSize: value.tileSize,
    tiles: Object.freeze(tiles),
  });
}

/** Spatial lookup visits nearby grid cells, not every authored tile on each view update. */
export class WorldTileIndex {
  readonly world: TerrainWorld;
  private readonly tiles = new Map<string, WorldTile>();
  constructor(world: TerrainWorld) {
    this.world = validateTerrainWorld(world);
    for (const tile of this.world.tiles)
      this.tiles.set(worldTileKey(tile.x, tile.z), tile);
  }
  select(
    position: WorldPosition,
    radius: number,
    maximum = 64,
  ): WorldTileSelection[] {
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.z) ||
      !Number.isFinite(radius) ||
      radius < 0 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 4096
    )
      throw new Error('Invalid world view, radius or tile limit.');
    const size = this.world.tileSize;
    // A zero-radius query picks the containing half-open cell. Positive radii
    // include cells touching either side of the circle, including exact edges.
    const minX = radius
        ? Math.ceil((position.x - radius) / size) - 1
        : Math.floor(position.x / size),
      maxX = Math.floor((position.x + radius) / size);
    const minZ = radius
        ? Math.ceil((position.z - radius) / size) - 1
        : Math.floor(position.z / size),
      maxZ = Math.floor((position.z + radius) / size);
    if (
      ![minX, maxX, minZ, maxZ].every(Number.isSafeInteger) ||
      (maxX - minX + 1) * (maxZ - minZ + 1) > 65536
    )
      throw new Error('World view exceeds the bounded spatial lookup range.');
    const selected: WorldTileSelection[] = [];
    for (let z = minZ; z <= maxZ; z++)
      for (let x = minX; x <= maxX; x++) {
        const key = worldTileKey(x, z),
          tile = this.tiles.get(key);
        if (!tile) continue;
        const dx = Math.max(
          x * size - position.x,
          0,
          position.x - (x + 1) * size,
        );
        const dz = Math.max(
          z * size - position.z,
          0,
          position.z - (z + 1) * size,
        );
        const distanceSquared = dx * dx + dz * dz;
        if (distanceSquared <= radius * radius)
          selected.push({ key, tile, distanceSquared });
      }
    selected.sort(
      (a, b) =>
        a.distanceSquared - b.distanceSquared ||
        a.tile.z - b.tile.z ||
        a.tile.x - b.tile.x,
    );
    return selected.slice(0, maximum);
  }
}
