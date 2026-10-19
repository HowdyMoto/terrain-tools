import {
  createProject,
  populateFoliage,
  parseProjectFile,
  serializeProject,
} from 'terrain-tools';
import { deflateSync } from 'node:zlib';
/** Explicit legacy single-model fixture for promotion/LOD authoring scenarios. */
export async function loadProceduralProject(page) {
  const project = createProject();
  populateFoliage(project, 'pine');
  await page.locator('#file-open').setInputFiles({
    name: 'Procedural legacy fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeProject(project)),
  });
  await page.getByText('Project loaded.', { exact: true }).waitFor();
}
export function triangleGlb({ height = 4, images = [], translation } = {}) {
  const model = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.7, 0.3, 0.1, 1],
          metallicFactor: 0,
          roughnessFactor: 0.8,
        },
        doubleSided: true,
      },
    ],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-2, 0, 0],
        max: [2, height, 0],
      },
    ],
  };
  if (translation) model.nodes[0].translation = translation;
  if (images.length) {
    model.images = images.map((uri) => ({ uri }));
    model.textures = images.map((_, source) => ({ source }));
    model.materials = images.map((_, index) => ({
      pbrMetallicRoughness: { baseColorTexture: { index }, metallicFactor: 0 },
      doubleSided: true,
    }));
    model.meshes[0].primitives = images.map((_, material) => ({
      attributes: { POSITION: 0 },
      material,
    }));
  }
  const json = JSON.stringify(model);
  const padded = json.padEnd(Math.ceil(json.length / 4) * 4, ' '),
    positions = new Float32Array([-2, 0, 0, 2, 0, 0, 0, height, 0]),
    bin = Buffer.from(positions.buffer),
    buffer = Buffer.alloc(12 + 8 + padded.length + 8 + bin.length);
  buffer.write('glTF', 0);
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(buffer.length, 8);
  buffer.writeUInt32LE(padded.length, 12);
  buffer.writeUInt32LE(0x4e4f534a, 16);
  buffer.write(padded, 20);
  const at = 20 + padded.length;
  buffer.writeUInt32LE(bin.length, at);
  buffer.writeUInt32LE(0x004e4942, at + 4);
  bin.copy(buffer, at + 8);
  return buffer;
}

export function solidPng(r, g, b) {
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) {
      c ^= byte;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const header = Buffer.from(name),
      out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    header.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([header, data])), data.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc(4 * 17);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) pixels.set([r, g, b, 255], y * 17 + 1 + x * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function decodeDocument(data) {
  if (typeof data === 'string') return JSON.parse(data);
  const bytes = Buffer.from(data);
  const signature = bytes.length >= 4 ? bytes.readUInt32LE(0) : 0;
  if (signature === 0x504e5254 || signature === 0x46546c67)
    return JSON.parse(
      serializeProject(
        parseProjectFile(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        ),
      ),
    );
  return JSON.parse(bytes.toString('utf8'));
}

/** Two segmented leaves: a rigid left mesh with no mask, and a painted right mesh. */
export function maskedPlantGlb() {
  const positions = [],
    mask = [];
  for (const center of [-2, 2]) {
    for (let segment = 0; segment < 8; segment++) {
      const y = segment / 2,
        top = y + 0.5;
      positions.push(
        center - 0.2,
        y,
        0,
        center + 0.2,
        y,
        0,
        center - 0.2,
        top,
        0,
        center + 0.2,
        y,
        0,
        center + 0.2,
        top,
        0,
        center - 0.2,
        top,
        0,
      );
      if (center > 0) mask.push(y / 4, y / 4, top / 4, y / 4, top / 4, top / 4);
    }
  }
  const vertices = new Float32Array(positions),
    values = new Float32Array(mask);
  const binary = Buffer.concat([
    Buffer.from(vertices.buffer),
    Buffer.from(values.buffer),
  ]);
  const half = vertices.byteLength / 2;
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0 }, material: 0 },
          { attributes: { POSITION: 1, _TERRAIN_FLEXIBILITY: 2 }, material: 0 },
        ],
      },
    ],
    materials: [
      {
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [0.25, 0.65, 0.15, 1],
          roughnessFactor: 0.8,
          metallicFactor: 0,
        },
      },
    ],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteLength: half },
      { buffer: 0, byteOffset: half, byteLength: half },
      {
        buffer: 0,
        byteOffset: vertices.byteLength,
        byteLength: values.byteLength,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 48,
        type: 'VEC3',
        min: [-2.2, 0, 0],
        max: [-1.8, 4, 0],
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: 48,
        type: 'VEC3',
        min: [1.8, 0, 0],
        max: [2.2, 4, 0],
      },
      { bufferView: 2, componentType: 5126, count: 48, type: 'SCALAR' },
    ],
  });
  const text = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4));
  const result = Buffer.alloc(28 + text.length + binary.length);
  result.write('glTF');
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(text.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  text.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + text.length);
  result.writeUInt32LE(0x004e4942, 24 + text.length);
  binary.copy(result, 28 + text.length);
  return result;
}
