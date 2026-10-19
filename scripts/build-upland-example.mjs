/** Rebuild the editable reference scene from the checked-in, unmodified PNGs. */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import {
  createProject,
  fbm,
  random,
  smoothstep,
  populateFoliage,
  heightAt,
  slopeAt,
  materialWeights,
  serializeProjectPackage,
  parseProjectFile,
  environmentPreset,
} from 'terrain-tools';

const destination = fileURLToPath(
  new URL('../public/examples/upland/', import.meta.url),
);
const ground = await fs.readFile(destination + 'meadow-albedo.png');
const grass = await fs.readFile(destination + 'grass-cutout.png');
const stone = await fs.readFile(destination + 'limestone-albedo.png');
const dataURL = (bytes, type) =>
  'data:' + type + ';base64,' + bytes.toString('base64');

/** Small static glTF writer keeps source PNG bytes intact, including alpha. */
function glb(geometry, png, name, cutout = false) {
  geometry.computeBoundingBox();
  const json = {
    asset: {
      version: '2.0',
      generator: 'Terrain Studio upland reference builder',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
    materials: [
      {
        name,
        doubleSided: cutout,
        ...(cutout ? { alphaMode: 'MASK', alphaCutoff: 0.45 } : {}),
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: cutout ? 0.96 : 0.88,
        },
      },
    ],
    textures: [{ sampler: 0, source: 0 }],
    samplers: [
      { magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 },
    ],
    images: [],
    buffers: [],
    bufferViews: [],
    accessors: [],
  };
  const chunks = [];
  let offset = 0;
  function view(bytes, target) {
    const index = json.bufferViews.length;
    json.bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.length,
      ...(target ? { target } : {}),
    });
    const padding = Buffer.alloc((4 - (bytes.length % 4)) % 4);
    chunks.push(bytes, padding);
    offset += bytes.length + padding.length;
    return index;
  }
  function accessor(array, size, extra = {}, target = 34962) {
    const bufferView = view(
      Buffer.from(array.buffer, array.byteOffset, array.byteLength),
      target,
    );
    const index = json.accessors.length;
    json.accessors.push({
      bufferView,
      componentType:
        array instanceof Float32Array
          ? 5126
          : array instanceof Uint16Array
            ? 5123
            : 5125,
      count: array.length / size,
      type: { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3' }[size],
      ...extra,
    });
    return index;
  }
  const primitive = json.meshes[0].primitives[0];
  for (const [name, semantic] of [
    ['position', 'POSITION'],
    ['normal', 'NORMAL'],
    ['uv', 'TEXCOORD_0'],
  ]) {
    const attribute = geometry.getAttribute(name);
    primitive.attributes[semantic] = accessor(
      attribute.array,
      attribute.itemSize,
      name === 'position'
        ? {
            min: geometry.boundingBox.min.toArray(),
            max: geometry.boundingBox.max.toArray(),
          }
        : {},
    );
  }
  if (geometry.index)
    primitive.indices = accessor(geometry.index.array, 1, {}, 34963);
  json.images.push({ bufferView: view(png), mimeType: 'image/png' });
  json.buffers.push({ byteLength: offset });
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([
    text,
    Buffer.alloc((4 - (text.length % 4)) % 4, 32),
  ]);
  const bin = Buffer.concat(chunks);
  const output = Buffer.alloc(28 + padded.length + bin.length);
  output.write('glTF');
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(output, 20);
  output.writeUInt32LE(bin.length, 20 + padded.length);
  output.writeUInt32LE(0x004e4942, 24 + padded.length);
  bin.copy(output, 28 + padded.length);
  return output;
}
function grassGeometry(cards, segments, bend = 0) {
  const positions = [],
    normals = [],
    uv = [],
    indices = [];
  const columns = 4;
  for (let card = 0; card < cards; card++) {
    const angle = (card * Math.PI) / cards,
      c = Math.cos(angle),
      s = Math.sin(angle);
    const base = positions.length / 3;
    for (let y = 0; y <= segments; y++)
      for (let x = 0; x <= columns; x++) {
        const u = x / columns,
          v = y / segments;
        const sideways = (u - 0.5) * 1.35 + bend * v * v;
        const depth = 0.14 * Math.sin(u * Math.PI) * v;
        positions.push(
          c * sideways - s * depth,
          v * 1.05 - 0.105,
          s * sideways + c * depth,
        );
        // Up-biased card normals soften the visible intersections, a common grass-card convention.
        const normal = new THREE.Vector3(-s * 0.35, 0.94, c * 0.35).normalize();
        normals.push(...normal.toArray());
        // glTF uses the top-left image origin; the ground is at v ~= 0.9 in the PNG.
        uv.push(u, 1 - v);
        if (x < columns && y < segments) {
          const a = base + y * (columns + 1) + x,
            b = a + 1,
            d = a + columns + 1;
          indices.push(a, b, d, b, d + 1, d);
        }
      }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  return geometry;
}
const modelBytes = {},
  modelStats = {};
function addModel(id, geometry, image, cutout = false) {
  modelBytes[id] = glb(geometry, image, id, cutout);
  modelStats[id] = {
    triangles:
      (geometry.index?.count ?? geometry.attributes.position.count) / 3,
    bytes: modelBytes[id].length,
  };
  geometry.dispose();
}
addModel('upland-tuft', grassGeometry(3, 8), grass, true);
addModel('upland-lean', grassGeometry(2, 8, 0.18), grass, true);
addModel('upland-distant', grassGeometry(2, 2), grass, true);
const rock = new THREE.IcosahedronGeometry(1, 3);
const rp = rock.attributes.position;
for (let i = 0; i < rp.count; i++) {
  const x = rp.getX(i),
    y = rp.getY(i),
    z = rp.getZ(i);
  const variation = 0.85 + 0.24 * fbm(x * 3 + y, z * 3 - y, 418);
  rp.setXYZ(
    i,
    x * variation * 1.7,
    y * variation * 0.92 + 0.62,
    z * variation * 1.25,
  );
}
rock.computeVertexNormals();
addModel('upland-limestone', rock, stone);

const p = createProject(128, 96, 714);
p.name = 'Upland meadow';
p.view = {
  lowPoly: false,
  wireframe: false,
  water: false,
  waterLevel: 0,
  textureResolution: 1024,
};
const pathX = (z) => Math.sin(z * 0.065) * 8 + 3;
for (let z = 0; z <= p.resolution; z++)
  for (let x = 0; x <= p.resolution; x++) {
    const wx = (x / p.resolution) * p.size - p.size / 2;
    const wz = (z / p.resolution) * p.size - p.size / 2;
    const hill = (cx, cz, width, amplitude) =>
      amplitude * Math.exp(-((wx - cx) ** 2 + (wz - cz) ** 2) / width ** 2);
    const track = 1 - smoothstep(1.2, 3.1, Math.abs(wx - pathX(wz)));
    const height =
      1.4 +
      hill(-22, -19, 20, 16) +
      hill(26, -30, 17, 23) +
      hill(-31, 25, 18, 6) +
      2 * fbm(wx * 0.1, wz * 0.1, 714) +
      0.35 * fbm(wx * 0.6, wz * 0.6, 713) -
      track * 0.25;
    const index = z * (p.resolution + 1) + x;
    p.heights[index] = height;
    p.paint[index * 4 + 2] = track * 0.94;
  }
const albedo = dataURL(ground, 'image/png'),
  rockAlbedo = dataURL(stone, 'image/png');
Object.assign(p.materials[0], {
  name: 'Dry meadow',
  color: '#ffffff',
  minHeight: -100,
  maxHeight: 100,
  maxSlope: 29,
  feather: 3,
  tileSize: 2.6,
  normalStrength: 0.22,
  roughness: 0.96,
  textures: { albedo },
});
Object.assign(p.materials[1], {
  name: 'Limestone faces',
  color: '#d5d0c3',
  minHeight: -100,
  maxHeight: 100,
  minSlope: 28,
  maxSlope: 90,
  feather: 3,
  tileSize: 3.8,
  normalStrength: 0.38,
  textures: { albedo: rockAlbedo },
});
Object.assign(p.materials[2], {
  name: 'Worn footpath',
  color: '#a99d84',
  minHeight: -100,
  maxHeight: -20,
  feather: 2,
  tileSize: 1.8,
  normalStrength: 0.12,
  textures: { albedo: rockAlbedo },
});
Object.assign(p.materials[3], {
  name: 'Summit scree',
  color: '#c3bca8',
  minHeight: 17,
  maxHeight: 100,
  minSlope: 0,
  maxSlope: 45,
  feather: 2.5,
  tileSize: 2.5,
  normalStrength: 0.25,
  roughness: 0.93,
  textures: { albedo: rockAlbedo },
});
p.environment = {
  ...environmentPreset('daylight'),
  sunAzimuth: 235,
  sunElevation: 27,
  sunColor: '#fff1d4',
  sunIntensity: 2.4,
  environmentIntensity: 0.85,
  exposure: 0.95,
  fogEnabled: true,
  fogColor: '#c3c9c6',
  fogNear: 180,
  fogFar: 420,
  shadowNormalBias: 0.035,
  shadowPadding: 6,
};
p.wind = {
  enabled: true,
  strength: 0.34,
  direction: 65,
  gust: 0.45,
  speed: 0.9,
};
p.interaction = { enabled: true, radius: 1.8, strength: 0.9, recovery: 2.4 };
for (const [id, bytes] of Object.entries(modelBytes))
  p.assets[id] = {
    name: id + '.glb',
    data: dataURL(bytes, 'model/gltf-binary'),
  };
const model = (id, asset, weight, minScale, maxScale) => ({
  id,
  model: asset,
  weight,
  minScale,
  maxScale,
  minRotation: -180,
  maxRotation: 180,
  alignToNormal: true,
  wind: 0.7,
  crush: 0.95,
  color: '#ffffff',
  flexibility: { source: 'height', start: 0.1, end: 0.95, exponent: 1.6 },
  lods: [{ model: 'upland-distant', distance: 24, density: 0.7 }],
  cullDistance: 260,
  lodHysteresis: 0.12,
  lodFadeDuration: 0.35,
});
p.brushes = [
  {
    ...p.brushes[1],
    name: 'Upland grasses',
    color: '#ffffff',
    materials: ['grass'],
    minWeight: 0.65,
    density: 1.35,
    spacing: 0.48,
    maxSlope: 32,
    models: [
      model('tuft', 'upland-tuft', 3, 0.65, 1.1),
      model('lean', 'upland-lean', 1, 0.95, 1.5),
    ],
  },
];
populateFoliage(p, 'grass');
const rng = random(153);
for (let i = 0; i < 400 && p.props.length < 34; i++) {
  const z = -39 + rng() * 72;
  const x = (i % 2 ? -1 : 1) * (12 + rng() * 24);
  if (slopeAt(p, x, z) > 16) continue;
  const scale = 0.45 + rng() ** 2 * 1.7;
  p.props.push({
    id: p.nextId++,
    model: 'upland-limestone',
    x,
    z,
    scale,
    rotation: rng() * Math.PI * 2,
    yOffset: -0.32 * scale,
    cutHole: false,
    holeRadius: 0,
  });
}
// Keep grass out of the visible boulders; this is an authored clearing, not a new population rule.
p.foliage = p.foliage.filter((f) =>
  p.props.every(
    (rock) => Math.hypot(f.x - rock.x, f.z - rock.z) > rock.scale * 1.25,
  ),
);
const packageBlob = serializeProjectPackage(p);
const packageBytes = Buffer.from(await packageBlob.arrayBuffer());
const restored = parseProjectFile(
  packageBytes.buffer.slice(
    packageBytes.byteOffset,
    packageBytes.byteOffset + packageBytes.byteLength,
  ),
);
if (
  restored.foliage.length !== p.foliage.length ||
  restored.heights.length !== p.heights.length
)
  throw new Error('Reference scene did not survive package validation.');
for (const f of p.foliage)
  if (materialWeights(p, f.x, f.z)[0] < p.brushes[0].minWeight)
    throw new Error('Reference foliage escaped its material rule.');
for (const [id, bytes] of Object.entries(modelBytes))
  await fs.writeFile(destination + id + '.glb', bytes);
await fs.writeFile(destination + 'upland-meadow.terrain', packageBytes);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = {
  name: p.name,
  seed: p.seed,
  sizeMetres: p.size,
  resolution: p.resolution,
  foliage: p.foliage.length,
  props: p.props.length,
  models: modelStats,
  packageBytes: packageBytes.length,
  packageSha256: sha256(packageBytes),
  textures: Object.fromEntries(
    [
      ['meadow-albedo.png', ground],
      ['grass-cutout.png', grass],
      ['limestone-albedo.png', stone],
    ].map(([name, bytes]) => [
      name,
      {
        bytes: bytes.length,
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        sha256: sha256(bytes),
      },
    ]),
  ),
  viewpoints: {
    trail: {
      position: [8, heightAt(p, 8, 29) + 2.2, 29],
      target: [-2, 8, -15],
    },
    overview: { position: [63, 58, 76], target: [0, 8, -5] },
    grass: {
      position: [-7, heightAt(p, -7, 21) + 1.05, 21],
      target: [-11, heightAt(p, -11, 14) + 0.6, 14],
    },
  },
  provenance:
    'AI-generated color PNGs; deterministic meshes and terrain; artist-selected, uncalibrated surface values.',
};
await fs.writeFile(
  destination + 'manifest.json',
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(JSON.stringify(manifest, null, 2));
