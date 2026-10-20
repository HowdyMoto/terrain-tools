import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import type { WebGPURenderer, ArrayNode, Node } from 'three/webgpu';
import {
  Fn,
  vec3,
  vec4,
  float,
  uv,
  texture,
  materialColor,
  materialOpacity,
  materialRoughness,
  materialMetalness,
  normalWorld,
  positionWorld,
  uniform,
  dot,
  attribute,
  varying,
  normalize,
  mat3,
  mat4,
  cameraPosition,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
  output,
  element,
  fract,
  floor,
  screenCoordinate,
  vec2,
  vertexColor,
} from 'three/tsl';
import { configureLeafNodes } from './foliage-nodes';
import type { FoliageSubsurface } from '../core/foliage-shading';
import type { ModelPart } from '../render/models';
import { checkSignal } from '../render/resources';
import { gpuDevice, validateGPU } from '../render/renderer';
import { foliageMatrixAttribute } from '../render/native-foliage';

export interface FoliageImpostorOptions {
  renderer: WebGPURenderer;
  signal?: AbortSignal;
  /** Pixels per view. All three atlases count against maxBytes. */
  resolution?: 128 | 256 | 512;
  azimuths?: 8 | 16;
  maxBytes?: number;
  /** Matches foliage's material-color tint. Re-bake when it changes. */
  tint?: string;
  /** Material selection used for the baked leaf/transmission mask. */
  subsurface?: FoliageSubsurface;
  onProgress?: (completed: number, total: number) => void;
}
interface View {
  direction: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
}
export interface FoliageImpostor {
  readonly parts: readonly ModelPart[];
  readonly views: number;
  readonly memoryBytes: number;
  readonly sourceTriangles: number;
  readonly triangles: number;
  /** Host owns this bake; dispose after every scene borrowing it is retired. */
  dispose(): void;
}
interface Capture {
  directions: View[];
  normalDepth: THREE.DataTexture;
  properties: THREE.DataTexture;
  radius: number;
  propertyNode?: Node<'vec4'>;
}
const captures = new WeakMap<ModelPart, Capture>();
const drawGraphs = new WeakMap<Capture, Map<object, Record<string, unknown>>>();
const noFade = {};
const baking = new WeakSet<WebGPURenderer>();

/** Bake rest-pose, relightable color/normal/depth/material views from existing
 * static meshes. No source geometry, textures or authored project are changed. */
export async function bakeFoliageImpostor(
  parts: readonly ModelPart[],
  options: FoliageImpostorOptions,
): Promise<FoliageImpostor> {
  const { renderer, signal } = options;
  checkSignal(signal);
  const resolution = options.resolution ?? 256,
    azimuths = options.azimuths ?? 8;
  if (![128, 256, 512].includes(resolution) || ![8, 16].includes(azimuths))
    throw new Error('Unsupported impostor capture resolution or view count.');
  const elevations = [-30, 0, 30, 60, 90];
  const width = azimuths * resolution,
    height = elevations.length * resolution;
  const memoryBytes = width * height * 4 * 3;
  if (!Number.isFinite(options.maxBytes ?? 1) || (options.maxBytes ?? 1) <= 0)
    throw new Error('Invalid impostor memory budget.');
  if (
    memoryBytes > (options.maxBytes ?? 64 * 1024 ** 2) ||
    Math.max(width, height) > gpuDevice(renderer).limits.maxTextureDimension2D
  )
    throw new Error('Impostor atlases exceed the capture budget.');
  if (baking.has(renderer))
    throw new Error('An impostor bake is already using this renderer.');
  if (!parts.length) throw new Error('An impostor needs loaded model parts.');
  const bounds = new THREE.Box3();
  for (const part of parts) {
    for (const source of Array.isArray(part.material)
      ? part.material
      : [part.material]) {
      if (
        !(source instanceof THREE.MeshStandardMaterial) ||
        source.transparent ||
        (source instanceof THREE.MeshPhysicalMaterial &&
          source.transmission > 0)
      )
        throw new Error(
          'Impostors currently support opaque and cutout PBR materials.',
        );
    }
    part.geometry.computeBoundingBox();
    bounds.union(part.geometry.boundingBox!.clone().applyMatrix4(part.matrix));
  }
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getSize(new THREE.Vector3()).length() * 0.505;
  if (!Number.isFinite(radius) || radius <= 0)
    throw new Error('Invalid impostor model bounds.');
  const scene = new THREE.Scene(),
    materials: MeshStandardNodeMaterial[] = [];
  const direction = uniform(new THREE.Vector3()),
    origin = uniform(center),
    span = uniform(radius * 2);
  const channel = uniform(0, 'int');
  const target = new THREE.RenderTarget(resolution, resolution, {
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    samples: 0,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  // Store albedo in sRGB8 so dark leaves retain the precision of source PBR
  // textures; normal/depth/material channels remain unencoded numeric data.
  const colorTarget = new THREE.RenderTarget(resolution, resolution, {
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    samples: 0,
  });
  colorTarget.texture.colorSpace = THREE.SRGBColorSpace;
  const atlases = [0, 1, 2].map(() => new Uint8Array(width * height * 4));
  const textures: THREE.DataTexture[] = [];
  const directions: View[] = [];
  let geometry: THREE.BufferGeometry | undefined,
    material: THREE.MeshStandardMaterial | undefined;
  let adopted = false;
  baking.add(renderer);
  try {
    for (const part of parts) {
      const converted = (
        Array.isArray(part.material) ? part.material : [part.material]
      ).map((source) => {
        const pbr = source as THREE.MeshStandardMaterial;
        const m = new MeshStandardNodeMaterial();
        m.color
          .copy(pbr.color)
          .lerp(new THREE.Color(options.tint ?? '#ffffff'), 0.3);
        m.map = pbr.map;
        m.alphaMap = pbr.alphaMap;
        m.opacity = pbr.opacity;
        m.normalMap = pbr.normalMap;
        m.normalScale.copy(pbr.normalScale);
        m.normalMapType = pbr.normalMapType;
        m.bumpMap = pbr.bumpMap;
        m.bumpScale = pbr.bumpScale;
        m.flatShading = pbr.flatShading;
        m.roughness = pbr.roughness;
        m.roughnessMap = pbr.roughnessMap;
        m.metalness = pbr.metalness;
        m.metalnessMap = pbr.metalnessMap;
        m.side = pbr.side;
        m.vertexColors = pbr.vertexColors;
        m.toneMapped = false;
        m.fragmentNode = Fn(() => {
          const color = (materialColor.convert('vec4') as Node<'vec4'>).toVar();
          if (pbr.vertexColors && part.geometry.hasAttribute('color'))
            color.mulAssign(vertexColor());
          color.a.mulAssign(materialOpacity);
          color.a.lessThanEqual(Math.max(pbr.alphaTest, 0.001)).discard();
          const result = vec4(color.rgb, 1);
          // Atlas normals are in model space; depth is signed distance from the card.
          const n = normalWorld.mul(0.5).add(0.5);
          const depth = dot(positionWorld.sub(origin), direction)
            .div(span)
            .add(0.5);
          // Explicit nodes avoid baking sun, exposure or display transforms into art.
          return channel
            .equal(1)
            .select(
              vec4(n, depth),
              channel
                .equal(2)
                .select(
                  vec4(
                    materialRoughness,
                    materialMetalness,
                    (!options.subsurface?.materials ||
                      options.subsurface.materials.includes(pbr.name)) &&
                      (options.subsurface?.mode === 'all' || pbr.alphaTest > 0)
                      ? 1
                      : 0,
                    1,
                  ),
                  result,
                ),
            );
        })();
        materials.push(m);
        return m;
      });
      const mesh = new THREE.Mesh(
        part.geometry,
        Array.isArray(part.material) ? converted : converted[0],
      );
      mesh.matrix.copy(part.matrix);
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
    }
    const camera = new THREE.OrthographicCamera(
      -radius,
      radius,
      radius,
      -radius,
      0.01,
      radius * 6,
    );
    const total = azimuths * elevations.length * 3;
    let completed = 0;
    for (let row = 0; row < elevations.length; row++)
      for (let col = 0; col < azimuths; col++) {
        const yaw = (col * Math.PI * 2) / azimuths,
          pitch = THREE.MathUtils.degToRad(elevations[row]);
        const d = new THREE.Vector3(
          Math.sin(yaw) * Math.cos(pitch),
          Math.sin(pitch),
          Math.cos(yaw) * Math.cos(pitch),
        );
        camera.up.set(
          -Math.sin(yaw) * Math.sin(pitch),
          Math.cos(pitch),
          -Math.cos(yaw) * Math.sin(pitch),
        );
        camera.position.copy(center).addScaledVector(d, radius * 3);
        camera.lookAt(center);
        camera.updateMatrixWorld(true);
        const right = new THREE.Vector3().setFromMatrixColumn(
          camera.matrixWorld,
          0,
        );
        const up = new THREE.Vector3().setFromMatrixColumn(
          camera.matrixWorld,
          1,
        );
        directions.push({ direction: d, right, up });
        direction.value.copy(d);
        for (let map = 0; map < 3; map++) {
          checkSignal(signal);
          channel.value = map;
          const captureTarget = map === 0 ? colorTarget : target;
          // Restore state before every await: the host may render the editor between views.
          const previous = renderer.getRenderTarget(),
            mrt = renderer.getMRT();
          const clear = renderer.getClearColor(new THREE.Color()),
            alpha = renderer.getClearAlpha();
          const autoClear = renderer.autoClear;
          try {
            renderer.setMRT(null);
            renderer.setRenderTarget(captureTarget);
            renderer.setClearColor(0, 0);
            renderer.autoClear = true;
            renderer.render(scene, camera);
          } finally {
            renderer.setRenderTarget(previous);
            renderer.setMRT(mrt);
            renderer.setClearColor(clear, alpha);
            renderer.autoClear = autoClear;
          }
          const pixels = await renderer.readRenderTargetPixelsAsync(
            captureTarget,
            0,
            0,
            resolution,
            resolution,
          );
          checkSignal(signal);
          for (let y = 0; y < resolution; y++)
            atlases[map].set(
              pixels.subarray(y * resolution * 4, (y + 1) * resolution * 4),
              ((row * resolution + y) * width + col * resolution) * 4,
            );
          options.onProgress?.(++completed, total);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    for (const pixels of atlases) {
      const t = new THREE.DataTexture(pixels, width, height);
      t.colorSpace =
        textures.length === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.generateMipmaps = false;
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      textures.push(t);
    }
    const positions: number[] = [],
      normals: number[] = [],
      texcoords: number[] = [],
      ids: number[] = [],
      indices: number[] = [];
    directions.forEach((v, index) => {
      const row = Math.floor(index / azimuths),
        col = index % azimuths;
      for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const p = center
          .clone()
          .addScaledVector(v.right, x * radius)
          .addScaledVector(v.up, y * radius);
        positions.push(p.x, p.y, p.z);
        normals.push(v.direction.x, v.direction.y, v.direction.z);
        // Half-texel gutters keep bilinear sampling inside this view.
        texcoords.push(
          (col * resolution + 0.5 + (x + 1) * 0.5 * (resolution - 1)) / width,
          (row * resolution + 0.5 + (1 - y) * 0.5 * (resolution - 1)) / height,
        );
        ids.push(index);
      }
      const n = index * 4;
      indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
    });
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(normals, 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(texcoords, 2));
    geometry.setAttribute(
      'terrainImpostorView',
      new THREE.Float32BufferAttribute(ids, 1),
    );
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    material = new THREE.MeshStandardMaterial({
      map: textures[0],
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 1,
    });
    material.name = 'Generated foliage impostor';
    const part: ModelPart = { geometry, material, matrix: new THREE.Matrix4() };
    captures.set(part, {
      directions,
      normalDepth: textures[1],
      properties: textures[2],
      radius,
    });
    await validateGPU(renderer, () => {
      for (const t of textures) renderer.initTexture(t);
    });
    checkSignal(signal);
    let closed = false;
    const ownedGeometry = geometry,
      ownedMaterial = material;
    const result: FoliageImpostor = {
      get parts() {
        if (closed) throw new Error('Foliage impostor has been disposed.');
        return [part];
      },
      views: directions.length,
      memoryBytes,
      triangles: indices.length / 3,
      sourceTriangles: parts.reduce(
        (sum, p) =>
          sum +
          (p.geometry.index?.count ??
            p.geometry.getAttribute('position').count) /
            3,
        0,
      ),
      dispose() {
        if (closed) return;
        closed = true;
        captures.delete(part);
        ownedGeometry.dispose();
        ownedMaterial.dispose();
        textures.forEach((t) => t.dispose());
      },
    };
    adopted = true;
    return result;
  } finally {
    baking.delete(renderer);
    target.dispose();
    colorTarget.dispose();
    materials.forEach((m) => m.dispose());
    if (!adopted) {
      geometry?.dispose();
      material?.dispose();
      textures.forEach((t) => t.dispose());
    }
  }
}

/** Attach view selection and relighting after the ordinary wind/fade/leaf graph. */
export function configureImpostorMaterial(
  material: THREE.Material,
  part: ModelPart,
  subsurface?: FoliageSubsurface,
) {
  const capture = captures.get(part);
  if (!capture) return;
  if (material instanceof THREE.MeshStandardMaterial)
    material.color.set('#ffffff');
  const previousMask = (
    material as THREE.Material & { maskNode?: Node<'bool'> }
  ).maskNode;
  let graphs = drawGraphs.get(capture);
  if (!graphs) drawGraphs.set(capture, (graphs = new Map()));
  const key = previousMask ?? noFade;
  const cached = graphs.get(key);
  const properties = (capture.propertyNode ??= texture(
    capture.properties,
    uv(),
  ));
  if (cached) {
    Object.assign(material, cached);
    if (subsurface) configureLeafNodes(material, subsurface, properties.b);
    return;
  }
  const column = (i: number) => attribute(foliageMatrixAttribute + i, 'vec4');
  const matrix = mat4(column(0), column(1), column(2), column(3));
  const world = modelWorldMatrix.mul(matrix);
  const direction = normalize(
    cameraPosition.sub(world.mul(vec4(0, 0, 0, 1)).xyz),
  );
  const basis = mat3(world);
  const localDirection = normalize(
    vec3(
      dot(element(world as unknown as ArrayNode<'vec4'>, 0).xyz, direction),
      dot(element(world as unknown as ArrayNode<'vec4'>, 1).xyz, direction),
      dot(element(world as unknown as ArrayNode<'vec4'>, 2).xyz, direction),
    ),
  );
  const selected = Fn(() => {
    const best = float(-2).toVar(),
      second = float(-2).toVar(),
      index = float(0).toVar(),
      nextIndex = float(0).toVar();
    capture.directions.forEach((v, i) => {
      const score = dot(localDirection, vec3(v.direction));
      const first = score.greaterThan(best).toVar();
      const runnerUp = score.greaterThan(second).toVar();
      nextIndex.assign(
        first.select(index, runnerUp.select(float(i), nextIndex)),
      );
      second.assign(first.select(best, second.max(score)));
      index.assign(first.select(float(i), index));
      best.assign(best.max(score));
    });
    const weight = float(1)
      .sub(second)
      .div(float(2).sub(best).sub(second).max(0.00001))
      .clamp(0, 1);
    return vec3(index, nextIndex, weight);
  })();
  const view = varying(selected);
  const id = varying(attribute('terrainImpostorView', 'float'));
  const noise = fract(
    fract(dot(floor(screenCoordinate.xy), vec2(0.06711056, 0.00583715))).mul(
      52.9829189,
    ),
  );
  const mask = id
    .equal(view.x)
    .and(noise.lessThan(view.z))
    .or(id.equal(view.y).and(noise.greaterThanEqual(view.z)));
  const normalDepth = texture(capture.normalDepth, uv());
  const n = normalize(basis.mul(normalDepth.xyz.mul(2).sub(1)));
  const graph = {
    maskNode: previousMask ? mask.and(previousMask) : mask,
    normalNode: normalize(cameraViewMatrix.mul(vec4(n, 0)).xyz),
    roughnessNode: properties.r,
    metalnessNode: properties.g,
    // Card-view changes do not have geometry motion vectors. Reject old coverage.
    outputNode: vec4(output.rgb, output.a.mul(0.1)),
  };
  // Depth is reconstructed along each baked view ray, including shadow cameras.
  const reconstructed = positionWorld.add(
    basis
      .mul(varying(attribute('normal', 'vec3')))
      .mul(normalDepth.a.sub(0.5).mul(capture.radius * 2)),
  );
  const clip = cameraProjectionMatrix
    .mul(cameraViewMatrix)
    .mul(vec4(reconstructed, 1));
  const result = { ...graph, depthNode: clip.z.div(clip.w) };
  graphs.set(key, result);
  Object.assign(material, result);
  if (subsurface) configureLeafNodes(material, subsurface, properties.b);
}
