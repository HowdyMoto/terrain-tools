/** Internal immutable graph. Live projects never receive its arrays or objects. */
type Scalar = string | number | boolean | null | undefined;
type Value = Scalar | Snapshot;
interface Header {
  refs: number;
  bytes: number;
}
export type Snapshot = Header &
  (
    | {
        kind: 'record';
        values: Record<string, Value>;
        nullPrototype: boolean;
        scalarCount?: number;
      }
    | { kind: 'list'; values: Value[] }
    | {
        kind: 'typed';
        type: 'float32' | 'uint8';
        length: number;
        blocks: Snapshot[];
      }
    | { kind: 'block'; data: Uint8Array }
    | { kind: 'text'; text: string }
  );
const BLOCK_BYTES = 64 * 1024;
const isNode = (value: Value): value is Snapshot =>
  typeof value === 'object' && value !== null;
const inlineBytes = (value: Value) =>
  8 + (typeof value === 'string' ? 24 + value.length * 2 : 0);
const header = (bytes: number): Header => ({ refs: 0, bytes });
function eachChild(node: Snapshot, visit: (child: Snapshot) => void) {
  if (node.kind === 'typed') for (const block of node.blocks) visit(block);
  else if (node.kind === 'record') {
    for (const key in node.values) {
      const value = node.values[key];
      if (isNode(value)) visit(value);
    }
  } else if (node.kind === 'list') {
    for (const value of node.values) if (isNode(value)) visit(value);
  }
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  // Terrain blocks are aligned; unaligned Uint8 views still use the byte path.
  if (!(a.byteOffset % 4) && !(b.byteOffset % 4)) {
    const length = Math.floor(a.length / 4);
    const aa = new Uint32Array(a.buffer, a.byteOffset, length);
    const bb = new Uint32Array(b.buffer, b.byteOffset, length);
    for (let i = 0; i < length; i++) if (aa[i] !== bb[i]) return false;
    for (let i = length * 4; i < a.length; i++) if (a[i] !== b[i]) return false;
  } else for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function recordId(value: Value): string | number | undefined {
  if (!isNode(value) || value.kind !== 'record') return undefined;
  const id = value.values.id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}
/** Estimates retained CPU data; excludes live projects, restore candidates and GPU resources. */
export class SnapshotStore {
  bytes = 0;
  private texts = new Map<string, Snapshot>();
  capture(source: object, previous?: Snapshot): Snapshot {
    const seen = new WeakMap<object, Snapshot>();
    const visiting = new WeakSet<object>();
    const newTexts = new Map<string, Snapshot>();
    const encode = (input: unknown, base?: Value): Value => {
      if (typeof input === 'string' && input.length > 256) {
        if (isNode(base) && base.kind === 'text' && base.text === input)
          return base;
        let node = this.texts.get(input) ?? newTexts.get(input);
        if (!node) {
          node = {
            kind: 'text',
            text: input,
            ...header(64 + input.length * 2),
          };
          newTexts.set(input, node);
        }
        return node;
      }
      if (
        input === null ||
        input === undefined ||
        typeof input === 'string' ||
        typeof input === 'number' ||
        typeof input === 'boolean'
      )
        return input;
      if (typeof input !== 'object')
        throw new Error('Unsupported history value.');
      // Instance records contain only primitive fields. Verify them directly without
      // allocating traversal bookkeeping for every unchanged plant on every stroke.
      if (
        isNode(base) &&
        base.kind === 'record' &&
        base.scalarCount !== undefined &&
        Object.getPrototypeOf(input) ===
          (base.nullPrototype ? null : Object.prototype)
      ) {
        const keys = Object.keys(input);
        if (
          keys.length === base.scalarCount &&
          keys.every(
            (key) =>
              Object.hasOwn(base.values, key) &&
              Object.is(
                (input as Record<string, unknown>)[key],
                base.values[key],
              ),
          )
        )
          return base;
      }
      if (visiting.has(input))
        throw new Error('History projects must not contain cycles.');
      const cached = seen.get(input);
      if (cached) return cached;
      visiting.add(input);
      let result: Snapshot;
      if (input instanceof Float32Array || input instanceof Uint8Array) {
        const type = input instanceof Float32Array ? 'float32' : 'uint8';
        const before =
          isNode(base) && base.kind === 'typed' && base.type === type
            ? base
            : undefined;
        const bytes = new Uint8Array(
          input.buffer,
          input.byteOffset,
          input.byteLength,
        );
        const blocks: Snapshot[] = [];
        let same = before?.length === input.length;
        for (let offset = 0; offset < bytes.length; offset += BLOCK_BYTES) {
          const data = bytes.subarray(offset, offset + BLOCK_BYTES);
          const old = before?.blocks[blocks.length];
          if (old?.kind === 'block' && sameBytes(data, old.data))
            blocks.push(old);
          else {
            blocks.push({
              kind: 'block',
              data: data.slice(),
              ...header(80 + data.length),
            });
            same = false;
          }
        }
        result = same
          ? before!
          : {
              kind: 'typed',
              type,
              length: input.length,
              blocks,
              ...header(80 + blocks.length * 8),
            };
      } else if (Array.isArray(input)) {
        const before = isNode(base) && base.kind === 'list' ? base : undefined;
        let values: Value[] | undefined;
        let byId: Map<string | number, Value> | undefined;
        for (let i = 0; i < input.length; i++) {
          let old = before?.values[i];
          const id = input[i]?.id;
          // Erasing or reordering instances must not duplicate every following record.
          if (
            before &&
            (typeof id === 'number' || typeof id === 'string') &&
            recordId(old) !== id
          ) {
            if (!byId) {
              byId = new Map();
              for (const entry of before.values) {
                const key = recordId(entry);
                if (key !== undefined) byId.set(key, entry);
              }
            }
            old = byId.get(id);
          }
          const value = encode(input[i], old);
          if (!values && !Object.is(value, before?.values[i]))
            values = before
              ? before.values.slice(0, i)
              : Array(i).fill(undefined);
          if (values) values.push(value);
        }
        if (!values && before?.values.length === input.length) result = before;
        else {
          values ??= before
            ? before.values.slice(0, input.length)
            : Array(input.length).fill(undefined);
          while (values.length < input.length) values.push(undefined);
          result = {
            kind: 'list',
            values,
            ...header(
              64 +
                values.reduce<number>(
                  (sum, value) => sum + inlineBytes(value),
                  0,
                ),
            ),
          };
        }
      } else {
        const prototype = Object.getPrototypeOf(input);
        if (prototype !== Object.prototype && prototype !== null)
          throw new Error('Unsupported history object.');
        const nullPrototype = prototype === null;
        const before =
          isNode(base) &&
          base.kind === 'record' &&
          base.nullPrototype === nullPrototype
            ? base
            : undefined;
        const keys = Object.keys(input);
        let values: Record<string, Value> | undefined;
        for (const key of keys) {
          const value = encode(
            (input as Record<string, unknown>)[key],
            before?.values[key],
          );
          if (
            !values &&
            (!before ||
              !Object.hasOwn(before.values, key) ||
              !Object.is(value, before.values[key]))
          )
            values = Object.assign(Object.create(null), before?.values);
          if (values) values[key] = value;
        }
        if (
          before &&
          (values || Object.keys(before.values).length !== keys.length)
        ) {
          values ??= Object.assign(Object.create(null), before.values);
          for (const key of Object.keys(values!))
            if (!Object.hasOwn(input, key)) delete values![key];
        }
        result = values
          ? {
              kind: 'record',
              values,
              nullPrototype,
              scalarCount: keys.every((key) => !isNode(values![key]))
                ? keys.length
                : undefined,
              ...header(
                64 +
                  keys.reduce(
                    (sum, key) =>
                      sum + 24 + key.length * 2 + inlineBytes(values![key]),
                    0,
                  ),
              ),
            }
          : (before ?? {
              kind: 'record',
              values: Object.create(null),
              nullPrototype,
              scalarCount: 0,
              ...header(64),
            });
      }
      visiting.delete(input);
      seen.set(input, result);
      return result;
    };
    return encode(source, previous) as Snapshot;
  }
  retain(node: Snapshot) {
    if (node.refs++ !== 0) return;
    this.bytes += node.bytes;
    if (node.kind === 'text') this.texts.set(node.text, node);
    eachChild(node, (child) => this.retain(child));
  }
  release(node: Snapshot) {
    if (--node.refs !== 0) return;
    this.bytes -= node.bytes;
    if (node.kind === 'text') this.texts.delete(node.text);
    eachChild(node, (child) => this.release(child));
  }
  restore<T>(root: Snapshot): T {
    const decode = (value: Value): unknown => {
      if (!isNode(value)) return value;
      let result: unknown;
      switch (value.kind) {
        case 'text':
          return value.text;
        case 'block':
          throw new Error('History block is not a document value.');
        case 'typed': {
          const array =
            value.type === 'float32'
              ? new Float32Array(value.length)
              : new Uint8Array(value.length);
          const bytes = new Uint8Array(array.buffer);
          let offset = 0;
          for (const block of value.blocks) {
            if (block.kind !== 'block')
              throw new Error('Invalid history block.');
            bytes.set(block.data, offset);
            offset += block.data.length;
          }
          result = array;
          break;
        }
        case 'list':
          result = value.values.map(decode);
          break;
        case 'record': {
          if (value.scalarCount !== undefined) {
            result = value.nullPrototype
              ? Object.assign(Object.create(null), value.values)
              : { ...value.values };
            break;
          }
          const object = Object.create(
            value.nullPrototype ? null : Object.prototype,
          );
          for (const key of Object.keys(value.values))
            Object.defineProperty(object, key, {
              value: decode(value.values[key]),
              writable: true,
              enumerable: true,
              configurable: true,
            });
          result = object;
          break;
        }
      }
      return result;
    };
    return decode(root) as T;
  }
}
