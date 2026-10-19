import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  addDefaultFoliage,
  defaultFoliageChoices,
} from '../src/editor/default-foliage';
import assets from '../public/foliage/photoreal/assets.json';
import { createProject } from '../src/core/terrain';
import {
  serializeFoliageBrush,
  importFoliageBrush,
} from '../src/core/foliage-preset';
import { validateProjectData } from '../src/core/serialization';

describe('bundled photoreal foliage', () => {
  it('ships bounded, self-contained GLBs with source credits, cutout alpha and decreasing LOD geometry', async () => {
    const triangles = new Map<string, number>();
    for (const [id, asset] of Object.entries(assets)) {
      const bytes = await readFile('public/foliage/photoreal/' + asset.file);
      expect(bytes.length).toBe(asset.bytes);
      expect(bytes.length).toBeLessThan(30_000_000);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        asset.sha256,
      );
      const gltf = JSON.parse(
        bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)),
      );
      expect(gltf.asset.copyright).toContain('Rico Cilliers');
      expect(gltf.asset.extras.license).toBe('CC0-1.0');
      expect(gltf.asset.extras.source).toMatch(/^https:\/\/polyhaven.com\/a\//);
      expect(gltf.buffers[0].uri).toBeUndefined();
      expect(gltf.nodes[0].translation).toBeUndefined();
      for (const image of gltf.images) {
        expect(image.uri).toBeUndefined();
        expect(gltf.bufferViews[image.bufferView].byteLength).toBeGreaterThan(
          0,
        );
      }
      const primitives = gltf.meshes[0].primitives;
      triangles.set(
        id,
        primitives.reduce(
          (n: number, p: { indices: number }) =>
            n + gltf.accessors[p.indices].count / 3,
          0,
        ),
      );
      // LOD simplification can remove the exact lowest vertex; retain the same source pivot.
      expect(
        Math.abs(
          Math.min(
            ...primitives.map(
              (p: { attributes: { POSITION: number } }) =>
                gltf.accessors[p.attributes.POSITION].min[1],
            ),
          ),
        ),
      ).toBeLessThan(0.02);
      expect(
        gltf.materials.some(
          (m: { alphaMode?: string }) => m.alphaMode === 'MASK',
        ),
      ).toBe(true);
      expect(
        gltf.images.some(
          (i: { mimeType: string }) => i.mimeType === 'image/png',
        ),
      ).toBe(true);
    }
    for (const [id, count] of triangles)
      if (id.endsWith('-low'))
        expect(count).toBeLessThan(triangles.get(id.replace('-low', ''))!);
    expect(triangles.get('ph-pine-b-low')).toBeLessThan(
      triangles.get('ph-pine-b-mid')!,
    );
    expect(triangles.get('ph-pine-b-mid')).toBeLessThan(
      triangles.get('ph-pine-b')!,
    );
  });
  it('keeps the source unchanged on download failure/cancellation, retries, and exports portable mixed brushes', async () => {
    const project = createProject(8, 16),
      original = structuredClone(project);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    try {
      await expect(addDefaultFoliage(project, ['fern'])).rejects.toThrow('503');
      expect(project).toEqual(original);
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ bad: { file: '../outside.glb' } })),
        ),
      );
      await expect(addDefaultFoliage(project, ['fern'])).rejects.toThrow(
        'catalog entry',
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          url.endsWith('assets.json')
            ? new Response(JSON.stringify(assets))
            : new Response('', { status: 503 }),
        ),
      );
      await expect(addDefaultFoliage(project, ['fern'])).rejects.toThrow('503');
      expect(project).toEqual(original);
      const controller = new AbortController();
      controller.abort();
      await expect(
        addDefaultFoliage(project, ['fern'], controller.signal),
      ).rejects.toThrow('cancelled');
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async (url: string) => new Response(await readFile('public' + url)),
        ),
      );
      const next = await addDefaultFoliage(
        project,
        defaultFoliageChoices.map(([id]) => id),
      );
      expect(project).toEqual(original);
      expect(next.brushes).toHaveLength(6);
      expect(Object.keys(next.assets)).toHaveLength(15);
      expect(() => validateProjectData(next)).not.toThrow();
      for (const brush of next.brushes.slice(2)) {
        expect(
          brush.models!.every(
            (m) => m.color === '#ffffff' && m.lods!.length > 0,
          ),
        ).toBe(true);
        const imported = importFoliageBrush(
          project,
          serializeFoliageBrush(next, brush.id),
        );
        expect(imported.brushes.at(-1)?.models).toEqual(brush.models);
        expect(Object.keys(imported.assets).length).toBeGreaterThan(1);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
