/** Offline derivatives of the unmodified Poly Haven collection. See docs/FOLIAGE-ASSETS.md. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import * as THREE from 'three';
import { MeshoptSimplifier as simplify } from 'meshoptimizer';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = path.join(root, 'assets/cc0-foliage');
const destination = path.join(root, 'public/foliage/photoreal');
await fs.mkdir(destination, { recursive: true });
await simplify.ready;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assets = {};
const manifest = {
  license: 'CC0-1.0',
  generator: 'scripts/build-photoreal-foliage.mjs',
  sources: {},
  models: {},
};
const alphaManifest = JSON.parse(
  await fs.readFile(path.join(sourceRoot, 'alpha-maps/manifest.json'), 'utf8'),
);

function accessorData(gltf, binary, index) {
  const a = gltf.accessors[index],
    v = gltf.bufferViews[a.bufferView];
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const Type = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array }[
    a.componentType
  ];
  if (!Type || !components || v.byteStride || a.sparse || a.normalized)
    throw new Error('Unexpected source accessor');
  const start = binary.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return {
    array: new Type(binary.buffer, start, a.count * components),
    components,
  };
}

async function source(id) {
  const folder = path.join(sourceRoot, 'poly-haven', id, 'gltf-2k');
  const bytes = await fs.readFile(path.join(folder, id + '_2k.gltf'));
  const gltf = JSON.parse(bytes);
  const binary = await fs.readFile(path.join(folder, gltf.buffers[0].uri));
  const alphaFile = alphaManifest.files.find((f) => f.asset === id);
  const alpha = await fs.readFile(
    path.join(sourceRoot, 'alpha-maps', alphaFile.file),
  );
  if (sha256(alpha) !== alphaFile.sha256)
    throw new Error('Alpha source hash mismatch');
  const credits =
    id === 'shrub_sorrel_01'
      ? 'Rico Cilliers (author)'
      : 'Rico Cilliers (modeling); Rob Tuytel (' +
        (id === 'fern_02' ? 'scanning' : 'photography') +
        ')';
  const metadata = {
    source: 'https://polyhaven.com/a/' + id,
    credits,
    license: 'CC0-1.0',
    gltfSha256: sha256(bytes),
    binarySha256: sha256(binary),
    alpha: alphaFile,
  };
  manifest.sources[id] = metadata;
  return { id, folder, gltf, binary, alpha, metadata, images: new Map() };
}

/** Replace tiny disconnected needles with the author's twig cutout, at sampled source positions. */
function pineCanopy(attributes, indices, level) {
  const positions = attributes.POSITION.array,
    count = positions.length / 3;
  const parent = Uint32Array.from({ length: count }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = find(indices[i]);
    parent[find(indices[i + 1])] = a;
    parent[find(indices[i + 2])] = a;
  }
  const counts = new Uint32Array(count);
  for (let i = 0; i < count; i++) counts[find(i)]++;
  const groups = new Map();
  const random = (i) => {
    let v = Math.imul(i ^ (i >>> 16), 0x45d9f3b);
    v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++)
    if (
      counts[i] >= 9 &&
      counts[i] <= 22 &&
      random(i) < 1 / (level === 2 ? 128 : 64)
    )
      groups.set(i, { center: new THREE.Vector3(), count: counts[i] });
  for (let i = 0; i < count; i++) {
    const g = groups.get(parent[i]);
    if (g) g.center.add(new THREE.Vector3().fromArray(positions, i * 3));
  }
  const p = [],
    n = [],
    uv = [],
    faces = [];
  for (const [id, group] of groups) {
    const center = group.center.divideScalar(group.count);
    const direction = new THREE.Vector3(
      center.x,
      0.6 + random(id + 5),
      center.z,
    ).normalize();
    const side = new THREE.Vector3()
      .crossVectors(direction, new THREE.Vector3(0, 1, 0))
      .normalize();
    const length = (level === 2 ? 0.48 : 0.36) * (0.8 + random(id + 7) * 0.4);
    for (let plane = 0; plane < (level === 0 ? 2 : 1); plane++) {
      const right = side
        .clone()
        .applyAxisAngle(
          direction,
          random(id + 9) * Math.PI + (plane * Math.PI) / 2,
        );
      const normal = new THREE.Vector3()
        .crossVectors(right, direction)
        .normalize();
      const start = p.length / 3;
      for (const [x, y, u, v] of [
        [-0.5, -0.5, 0.005, 0.45],
        [0.5, -0.5, 0.24, 0.45],
        [0.5, 0.5, 0.24, 0.005],
        [-0.5, 0.5, 0.005, 0.005],
      ]) {
        p.push(
          ...center
            .clone()
            .addScaledVector(right, x * length * 0.54)
            .addScaledVector(direction, y * length)
            .toArray(),
        );
        n.push(...normal.toArray());
        uv.push(u, v);
      }
      faces.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  }
  return {
    attributes: {
      POSITION: { array: new Float32Array(p), components: 3 },
      NORMAL: { array: new Float32Array(n), components: 3 },
      TEXCOORD_0: { array: new Float32Array(uv), components: 2 },
    },
    indices: new Uint32Array(faces),
  };
}

async function buildModel(s, nodeIndex, name, level, budgets) {
  const node = s.gltf.nodes[nodeIndex],
    mesh = s.gltf.meshes[node.mesh];
  if (node.rotation || node.scale || node.matrix)
    throw new Error('Unexpected source node transform');
  // Display-layout translations are deliberately removed; the source root stays at x=z=0.
  const ground = Math.min(
    ...mesh.primitives.map(
      (p) => s.gltf.accessors[p.attributes.POSITION].min[1],
    ),
  );
  const json = {
    asset: {
      version: '2.0',
      generator: manifest.generator,
      copyright: s.metadata.credits + '; Poly Haven; CC0 1.0',
      extras: {
        ...s.metadata,
        sourceNode: node.name,
        modifications:
          'Remove display offset; ground pivot; compact geometry; simplified LODs; resized PBR maps; restore source alpha.' +
          (s.id === 'pine_tree_01'
            ? ' Replace needle geometry with source twig-photo cutout cards sampled across the original canopy; approximate coverage at each LOD.'
            : ''),
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{ primitives: [] }],
    materials: [],
    textures: [],
    images: [],
    samplers: s.gltf.samplers,
    extensionsUsed: s.gltf.extensionsUsed,
    extensionsRequired: s.gltf.extensionsRequired,
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
  function accessor(array, size, extra = {}) {
    const bufferView = view(
      Buffer.from(array.buffer, array.byteOffset, array.byteLength),
      size === 1 ? 34963 : 34962,
    );
    const index = json.accessors.length;
    json.accessors.push({
      bufferView,
      componentType: array instanceof Float32Array ? 5126 : 5125,
      count: array.length / size,
      type: { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' }[size],
      ...extra,
    });
    return index;
  }
  const textureMap = new Map(),
    imageMap = new Map(),
    materialMap = new Map();
  async function texture(info) {
    if (!info) return;
    const old = info.index;
    if (!textureMap.has(old)) {
      const t = structuredClone(s.gltf.textures[old]),
        image = s.gltf.images[t.source];
      if (!imageMap.has(t.source)) {
        const cutout =
          /diff/.test(image.uri) &&
          (s.id !== 'pine_tree_01' || /twig/.test(image.uri));
        // 1K maps for near/middle, 512px maps for far detail. Embed all dependencies.
        const dimension = level > 0 ? 512 : 1024,
          key = image.uri + ':' + dimension;
        if (!s.images.has(key)) {
          const sourceBytes = await fs.readFile(path.join(s.folder, image.uri));
          const rgb = sharp(sourceBytes).resize({
            width: dimension,
            height: dimension,
            fit: 'inside',
          });
          let bytes;
          if (cutout) {
            const { data, info: size } = await rgb
              .removeAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            const mask = await sharp(s.alpha)
              .resize(size.width, size.height)
              .removeAlpha()
              .greyscale()
              .raw()
              .toBuffer();
            bytes = await sharp(data, { raw: size })
              .joinChannel(mask, {
                raw: { width: size.width, height: size.height, channels: 1 },
              })
              .png()
              .toBuffer();
          } else bytes = await rgb.jpeg({ quality: 88 }).toBuffer();
          s.images.set(key, bytes);
        }
        imageMap.set(t.source, json.images.length);
        json.images.push({
          name: image.uri,
          mimeType: cutout ? 'image/png' : 'image/jpeg',
          bufferView: view(s.images.get(key)),
        });
      }
      t.source = imageMap.get(t.source);
      textureMap.set(old, json.textures.length);
      json.textures.push(t);
    }
    info.index = textureMap.get(old);
  }
  let triangles = 0,
    vertices = 0;
  for (const [partIndex, primitive] of mesh.primitives.entries()) {
    let attributes = Object.fromEntries(
      Object.entries(primitive.attributes)
        .filter(([name]) => ['POSITION', 'NORMAL', 'TEXCOORD_0'].includes(name))
        .map(([name, index]) => [name, accessorData(s.gltf, s.binary, index)]),
    );
    let indices = Uint32Array.from(
      accessorData(s.gltf, s.binary, primitive.indices).array,
    );
    const canopy = s.id === 'pine_tree_01' && partIndex === 2;
    if (canopy)
      ({ attributes, indices } = pineCanopy(attributes, indices, level));
    const position = attributes.POSITION.array;
    const target =
      budgets?.[partIndex] ??
      Math.floor((indices.length / 3) * (level === 0 ? 1 : 0.45));
    let error = 0;
    if (!canopy && target * 3 < indices.length) {
      [indices, error] = simplify.simplifyWithAttributes(
        indices,
        position,
        3,
        attributes.TEXCOORD_0.array,
        2,
        [0.1, 0.1],
        null,
        target * 3,
        0.05,
        ['Permissive'],
      );
    }
    if (!indices.length)
      throw new Error('Simplification removed a complete part');
    const [remap, count] = simplify.compactMesh(indices);
    const output = { attributes: {}, indices: accessor(indices, 1) };
    for (const [name, attribute] of Object.entries(attributes)) {
      const data = new Float32Array(count * attribute.components);
      for (let old = 0; old < remap.length; old++) {
        const next = remap[old];
        if (next === 0xffffffff) continue;
        for (let c = 0; c < attribute.components; c++)
          data[next * attribute.components + c] =
            attribute.array[old * attribute.components + c] -
            (name === 'POSITION' && c === 1 ? ground : 0);
      }
      const bounds = {};
      if (name === 'POSITION') {
        bounds.min = [Infinity, Infinity, Infinity];
        bounds.max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < data.length; i++) {
          const c = i % 3;
          bounds.min[c] = Math.min(bounds.min[c], data[i]);
          bounds.max[c] = Math.max(bounds.max[c], data[i]);
        }
      }
      output.attributes[name] = accessor(data, attribute.components, bounds);
    }
    if (!materialMap.has(primitive.material)) {
      const material = structuredClone(s.gltf.materials[primitive.material]);
      const base = material.pbrMetallicRoughness;
      const diffuse =
        s.gltf.images[s.gltf.textures[base.baseColorTexture.index].source].uri;
      if (s.id !== 'pine_tree_01' || /twig/.test(diffuse)) {
        material.alphaMode = 'MASK';
        material.alphaCutoff = 0.4;
        material.doubleSided = true;
      }
      for (const info of [
        base.baseColorTexture,
        base.metallicRoughnessTexture,
        material.normalTexture,
        material.occlusionTexture,
      ])
        await texture(info);
      materialMap.set(primitive.material, json.materials.length);
      json.materials.push(material);
    }
    output.material = materialMap.get(primitive.material);
    json.meshes[0].primitives.push(output);
    triangles += indices.length / 3;
    vertices += count;
    console.log(
      name,
      'part',
      partIndex,
      indices.length / 3,
      'triangles; relative error',
      error.toFixed(5),
    );
  }
  json.buffers.push({ byteLength: offset });
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([
      text,
      Buffer.alloc((4 - (text.length % 4)) % 4, 32),
    ]),
    bin = Buffer.concat(chunks);
  const bytes = Buffer.alloc(28 + padded.length + bin.length);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(bytes, 20);
  bytes.writeUInt32LE(bin.length, 20 + padded.length);
  bytes.writeUInt32LE(0x004e4942, 24 + padded.length);
  bin.copy(bytes, 28 + padded.length);
  if (bytes.length > 30_000_000)
    throw new Error('Model exceeds editor size limit');
  await fs.writeFile(path.join(destination, name + '.glb'), bytes);
  assets[name] = {
    name: name
      .replace('ph-', '')
      .replace('-mid', ' · medium detail')
      .replace('-low', ' · low detail')
      .replaceAll('-', ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    file: name + '.glb',
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
  manifest.models[name] = {
    source: s.id,
    node: node.name,
    triangles,
    vertices,
    ...assets[name],
  };
}

for (const [id, variants] of [
  [
    'fern_02',
    [
      [0, 'ph-fern-b'],
      [2, 'ph-fern-a'],
    ],
  ],
  [
    'shrub_sorrel_01',
    [
      [1, 'ph-sorrel-b'],
      [4, 'ph-sorrel-d'],
    ],
  ],
  [
    'grass_medium_01',
    [
      [4, 'ph-grass-tall-a'],
      [3, 'ph-grass-tall-b'],
    ],
  ],
]) {
  const s = await source(id);
  for (const [node, name] of variants)
    for (let level = 0; level < 2; level++)
      await buildModel(s, node, name + (level ? '-low' : ''), level);
}
const pine = await source('pine_tree_01');
for (const [level, suffix, budgets] of [
  [0, '', [3500, 6000, 75000, 1000]],
  [1, '-mid', [1000, 1800, 12000, 300]],
  [2, '-low', [300, 500, 2500, 120]],
])
  await buildModel(pine, 1, 'ph-pine-b' + suffix, level, budgets);
await fs.writeFile(
  path.join(destination, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
await fs.writeFile(
  path.join(destination, 'assets.json'),
  JSON.stringify(assets, null, 2) + '\n',
);
const credits = (
  await fs.readFile(path.join(sourceRoot, 'CREDITS.md'), 'utf8')
).split('The additional ambientCG')[0];
await fs.writeFile(
  path.join(destination, 'CREDITS.txt'),
  credits +
    '\nTerrain Studio brush derivatives\n\nThese GLBs are modified from the source models: selected individual variants, grounded pivots, smaller embedded PBR textures with original alpha maps, and simplified distance levels. Pine needle geometry is replaced with the source twig photograph on cutout cards sampled across its original canopy. These changes are by the Terrain Studio asset builder, not the original authors. The unmodified archives remain in assets/cc0-foliage. Source URLs, author credits, CC0 license and modification notes are also embedded in each GLB.\n',
);
console.log(
  'Built',
  Object.keys(assets).length,
  'models:',
  Object.values(assets).reduce((n, a) => n + a.bytes, 0),
  'bytes total',
);
