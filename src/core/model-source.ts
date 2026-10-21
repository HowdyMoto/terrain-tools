/** Project-root-relative source and the import transform retained across art revisions. */
export interface ModelSource {
  path: string;
  scale: number;
  offset: [number, number, number];
  /** Sources extracted from an existing document already contain their import transform. */
  prepared?: boolean;
}

export function projectRelativePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    /[\\:]/.test(value) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Asset paths must stay inside the project folder.');
  return value;
}

export function parseModelSource(value: unknown): ModelSource {
  const source = value as ModelSource;
  if (
    !source ||
    typeof source !== 'object' ||
    !Number.isFinite(source.scale) ||
    source.scale <= 0 ||
    source.scale > 10000 ||
    !Array.isArray(source.offset) ||
    source.offset.length !== 3 ||
    !source.offset.every((v) => Number.isFinite(v) && Math.abs(v) <= 1e6)
  )
    throw new Error('Invalid linked model import settings.');
  const path = projectRelativePath(source.path);
  if (!/\.glb$/i.test(path))
    throw new Error('Linked models must be self-contained GLB files.');
  if (source.prepared !== undefined && typeof source.prepared !== 'boolean')
    throw new Error('Invalid linked model preparation flag.');
  if (
    source.prepared &&
    (source.scale !== 1 || source.offset.some((value) => value !== 0))
  )
    throw new Error(
      'Prepared model sources must use their existing transform.',
    );
  return {
    path,
    scale: source.scale,
    offset: [...source.offset],
    ...(source.prepared !== undefined ? { prepared: source.prepared } : {}),
  };
}
