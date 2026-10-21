import { checkModelFileSize } from './model-limits';
import { bytesToBase64 } from './base64';
import { parseModelSource } from './model-source';
import type { ModelSource } from './model-source';

type Gltf = {
  asset: { version: string; [key: string]: unknown };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: Record<string, unknown>[];
  buffers?: { uri?: string; byteLength: number }[];
  images?: { uri?: string }[];
  [key: string]: unknown;
};
export interface ModelDocument {
  json: Gltf;
  chunks: { type: number; bytes: Uint8Array }[];
}
export function readModelDocument(buffer: ArrayBuffer): ModelDocument {
  const view = new DataView(buffer);
  if (
    buffer.byteLength < 20 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== buffer.byteLength
  )
    throw new Error('Invalid GLB container. Export a glTF 2.0 binary model.');
  const chunks: ModelDocument['chunks'] = [];
  let json: Gltf | undefined;
  for (let at = 12; at < buffer.byteLength;) {
    if (at + 8 > buffer.byteLength) throw new Error('Truncated GLB chunk.');
    const length = view.getUint32(at, true),
      type = view.getUint32(at + 4, true);
    if (length % 4 || at + 8 + length > buffer.byteLength)
      throw new Error('Invalid GLB chunk length.');
    const bytes = new Uint8Array(buffer, at + 8, length);
    if (at === 12 && type === 0x4e4f534a)
      json = JSON.parse(new TextDecoder().decode(bytes));
    else {
      if (
        type === 0x4e4f534a ||
        (type === 0x004e4942 && chunks.some((chunk) => chunk.type === type))
      )
        throw new Error('GLB contains duplicate JSON or binary chunks.');
      chunks.push({ type, bytes });
    }
    at += 8 + length;
  }
  if (!json || json.asset?.version !== '2.0')
    throw new Error('Use a glTF 2.0 model.');
  return { json, chunks };
}
export function writeModelDocument(document: ModelDocument): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(document.json));
  const length = Math.ceil(json.length / 4) * 4;
  const size =
    20 +
    length +
    document.chunks.reduce((n, chunk) => n + 8 + chunk.bytes.length, 0);
  checkModelFileSize(size, 'Prepared model');
  const buffer = new ArrayBuffer(size),
    view = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, size, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + length);
  bytes.set(json, 20);
  let at = 20 + length;
  document.chunks.forEach((chunk) => {
    view.setUint32(at, chunk.bytes.length, true);
    view.setUint32(at + 4, chunk.type, true);
    bytes.set(chunk.bytes, at + 8);
    at += 8 + chunk.bytes.length;
  });
  return buffer;
}
export function modelDataURL(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  checkModelFileSize(bytes.byteLength);
  return 'data:model/gltf-binary;base64,' + bytesToBase64(bytes);
}
export function transformModel(
  document: ModelDocument,
  scale: number,
  offset: [number, number, number],
) {
  if (!Number.isFinite(scale) || scale <= 0 || !offset.every(Number.isFinite))
    throw new Error('Invalid model transform.');
  const json = structuredClone(document.json);
  const scene = json.scenes?.[json.scene ?? 0];
  if (!scene?.nodes?.length)
    throw new Error('The selected glTF scene contains no root nodes.');
  json.nodes ??= [];
  const root = json.nodes.length;
  json.nodes.push({
    name: 'Terrain Studio import transform',
    children: [...scene.nodes],
    scale: [scale, scale, scale],
    translation: offset.map((n) => n * scale),
  });
  scene.nodes = [root];
  return modelDataURL(writeModelDocument({ json, chunks: document.chunks }));
}

/** Resolve one self-contained GLB source with its retained artist import transform. */
export function prepareLinkedModel(
  buffer: ArrayBuffer,
  source: ModelSource,
): string {
  const settings = parseModelSource(source);
  checkModelFileSize(buffer.byteLength, settings.path);
  const document = readModelDocument(buffer);
  if (
    [...(document.json.buffers ?? []), ...(document.json.images ?? [])].some(
      (item) => item.uri && !item.uri.startsWith('data:'),
    )
  )
    throw new Error(
      'Linked GLBs must embed their buffers and textures: ' + settings.path,
    );
  return settings.prepared
    ? modelDataURL(buffer)
    : transformModel(document, settings.scale, settings.offset);
}
