/** Deterministic, offline derivatives. Ordinary builds use the checked-in results. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import {
  meshopt,
  getBounds,
  listTextureSlots,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { NodeBasisEncoder } from 'ktx2-encoder';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, process.argv[2] ?? 'public/runtime-assets');
await fs.mkdir(output, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceRoot = path.join(root, 'public/foliage/photoreal');
const sources = JSON.parse(
  await fs.readFile(path.join(sourceRoot, 'manifest.json')),
);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder,
  });
await MeshoptEncoder.ready;
const encoder = new NodeBasisEncoder();
const basis = await encoder.init();
const started = performance.now();
const manifest = {
  version: 1,
  generator: 'build-runtime-assets.mjs/1',
  toolchain: {
    gltfTransform: '4.5.1',
    ktx2Encoder: '0.6.0',
    meshoptimizer: '1.1.0',
    sharp: '0.35.5',
  },
  encoding: { format: 'UASTC', quality: 3, rdo: false, mipmaps: true },
  sources: sources.sources,
  models: {},
  materials: null,
};
const report = { models: {}, materials: {}, totalMilliseconds: 0 };
const write = async (name, bytes) => {
  await fs.writeFile(path.join(output, name), bytes);
  return { file: name, bytes: bytes.length, sha256: hash(bytes) };
};
const decodeImage = async (buffer) => {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};
for (const id of [
  'ph-pine-b',
  'ph-pine-b-mid',
  'ph-pine-b-low',
  'ph-fern-a',
  'ph-fern-a-low',
]) {
  const t = performance.now(),
    source = sources.models[id];
  const input = await fs.readFile(path.join(sourceRoot, source.file));
  if (hash(input) !== source.sha256) throw new Error('Source changed: ' + id);
  const document = await io.readBinary(input);
  let textureCpuBytes = 0,
    textureGpuBytesBC7 = 0;
  for (const texture of document.getRoot().listTextures()) {
    const slots = listTextureSlots(texture);
    const normal = slots.includes('normalTexture');
    const srgb = slots.some(
      (s) => s === 'baseColorTexture' || s === 'emissiveTexture',
    );
    if (
      srgb &&
      slots.some((s) => s !== 'baseColorTexture' && s !== 'emissiveTexture')
    )
      throw new Error(
        'A texture is used in both linear and color slots: ' + id,
      );
    const [w, h] = texture.getSize();
    for (let x = w, y = h; ; x = Math.max(1, x >> 1), y = Math.max(1, y >> 1)) {
      textureGpuBytesBC7 += Math.ceil(x / 4) * Math.ceil(y / 4) * 16;
      if (x === 1 && y === 1) break;
    }
    const encoded = await encoder.encode(texture.getImage(), {
      isUASTC: true,
      uastcLDRQualityLevel: 3,
      enableRDO: false,
      needSupercompression: true,
      isNormalMap: normal,
      isPerceptual: srgb,
      isSetKTX2SRGBTransferFunc: srgb,
      generateMipmap: true,
      imageDecoder: decodeImage,
    });
    textureCpuBytes += w * h * 4; // source RGBA decoding during offline preparation
    texture.setImage(encoded).setMimeType('image/ktx2');
  }
  document.createExtension(KHRTextureBasisu).setRequired(true);
  const bounds = getBounds(document.getRoot().listScenes()[0]);
  await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  const binary = await io.writeBinary(document);
  const entry = {
    ...(await write(id + '.glb', binary)),
    sourceFile: source.file,
    sourceSha256: source.sha256,
    source: source.source,
    triangles: source.triangles,
    bounds,
    collisionInput: id.startsWith('ph-pine')
      ? 'ph-pine-b-low.glb'
      : 'ph-fern-a-low.glb',
    estimatedTextureGpuBytesBC7: textureGpuBytesBC7,
  };
  manifest.models[id] = entry;
  report.models[id] = {
    sourceBytes: input.length,
    downloadBytes: binary.length,
    sourceTextureRgbaBytes: textureCpuBytes,
    estimatedTextureGpuBytesBC7: textureGpuBytesBC7,
    milliseconds: Math.round(performance.now() - t),
  };
  console.log(id + ': ' + input.length + ' -> ' + binary.length + ' bytes');
}

// Eight reusable terrain layers; four are selected by each tile. Ground color is
// the separately credited Upland reference; analytic normal/height fixtures make
// linear-channel correctness measurable without distributing another art pack.
// They are not authored ground detail: keep their shading influence disabled in
// the reference world, otherwise aerial views show a regular waffle pattern.
const size = 512,
  layers = [],
  slices = { albedo: [], normal: [], orm: [], height: [] };
const albedos = ['meadow-albedo.png', 'limestone-albedo.png'];
const materialSources = [];
for (const name of albedos) {
  const bytes = await fs.readFile(
    path.join(root, 'public/examples/upland', name),
  );
  materialSources.push({
    file: 'examples/upland/' + name,
    sha256: hash(bytes),
    credits:
      'Terrain Studio Upland reference: AI-generated color texture; see public/examples/upland/README.md.',
  });
}
for (let i = 0; i < 8; i++) {
  const color = await sharp(
    path.join(root, 'public/examples/upland', albedos[i % 2]),
  )
    .resize(size, size)
    .modulate({ brightness: 0.8 + 0.06 * i, saturation: 0.7 + 0.04 * i })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const maps = {
    albedo: color,
    normal: Buffer.alloc(size * size * 4),
    orm: Buffer.alloc(size * size * 4),
    height: Buffer.alloc(size * size * 4),
  };
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      const o = (z * size + x) * 4,
        f = (2 * Math.PI * (4 + i)) / size;
      const h = 0.5 + 0.2 * Math.sin(x * f) * Math.cos(z * f);
      const nx = -0.3 * Math.cos(x * f) * Math.cos(z * f),
        ny = 0.3 * Math.sin(x * f) * Math.sin(z * f),
        l = Math.hypot(nx, ny, 1);
      maps.normal.set(
        [
          Math.round(((nx / l) * 0.5 + 0.5) * 255),
          Math.round(((ny / l) * 0.5 + 0.5) * 255),
          Math.round(((1 / l) * 0.5 + 0.5) * 255),
          255,
        ],
        o,
      );
      maps.orm.set([255, 180 + i * 7, 0, 255], o);
      maps.height.set([h * 255, h * 255, h * 255, 255], o);
    }
  layers.push({
    id: 'world-ground-' + i,
    name: 'World ground ' + (i + 1),
    color: '#ffffff',
    roughness: 1,
    metalness: 0,
    minHeight: -1000,
    maxHeight: 1000,
    minSlope: 0,
    maxSlope: 90,
    feather: 1,
    tileSize: 8,
    blendHeight: 0,
    normalStrength: 0,
    normalConvention: 'opengl',
    textures: {},
    proceduralVariant: 0,
  });
  for (const key of Object.keys(slices)) slices[key].push(maps[key]);
}
const maps = {};
for (const [key, images] of Object.entries(slices)) {
  const t = performance.now(),
    enc = new basis.BasisEncoder();
  try {
    enc.setCreateKTX2File(true);
    enc.setUASTC(true);
    enc.setTexType(1);
    enc.setKTX2UASTCSupercompression(true);
    enc.setMipGen(true);
    enc.setPackUASTCFlags(3);
    const srgb = key === 'albedo';
    (enc.setKTX2AndBasisSRGBTransferFunc ?? enc.setKTX2SRGBTransferFunc).call(
      enc,
      srgb,
    );
    enc.setPerceptual(srgb);
    if (key === 'normal')
      (enc.setNormalMapPreset ?? enc.setNormalMap).call(enc);
    for (let i = 0; i < images.length; i++)
      enc.setSliceSourceImage(i, images[i], size, size, 0);
    const buffer = new Uint8Array(size * size * 4 * images.length * 2 + 65536);
    const length = enc.encode(buffer);
    if (!length) throw new Error('KTX2 array encoding failed: ' + key);
    maps[key] = await write(
      'terrain-' + key + '.ktx2',
      buffer.subarray(0, length),
    );
    report.materials[key] = {
      downloadBytes: length,
      sourceRgbaBytes: size * size * 4 * layers.length,
      milliseconds: Math.round(performance.now() - t),
    };
    // A small source fixture is retained for renderer-side quality comparison.
    await write(
      'reference-' + key + '.png',
      await sharp(images[0], {
        raw: { width: size, height: size, channels: 4 },
      })
        .png()
        .toBuffer(),
    );
  } finally {
    enc.delete();
  }
  console.log('terrain-' + key + ': ' + maps[key].bytes + ' bytes');
}
manifest.materials = { size, layers, maps, sources: materialSources };
await write(
  'manifest.json',
  Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
);
report.totalMilliseconds = Math.round(performance.now() - started);
await fs.mkdir(path.join(root, '.qa'), { recursive: true });
await fs.writeFile(
  path.join(root, '.qa/runtime-assets-preparation.json'),
  JSON.stringify(report, null, 2) + '\n',
);
// Version-matched browser transcoder, with the upstream licensing notice.
await fs.mkdir(path.join(root, 'public/basis'), { recursive: true });
for (const name of [
  'basis_transcoder.js',
  'basis_transcoder.wasm',
  'README.md',
])
  await fs.copyFile(
    path.join(root, 'node_modules/three/examples/jsm/libs/basis', name),
    path.join(root, 'public/basis', name),
  );
console.log('Prepared runtime pack in ' + path.relative(root, output));
