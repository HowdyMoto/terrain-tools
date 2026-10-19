import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { DecodedModel } from '../render/model-loader';
import { createModelDecoder } from '../render/model-loader';

/** Neutral, isolated asset inspection. Caller owns model resources and surface textures. */
export class ImportPreview {
  private renderer: THREE.WebGLRenderer;
  private decoder: ReturnType<typeof createModelDecoder>;
  decodeModel(data: string, signal?: AbortSignal) {
    return this.decoder.decode(data, signal);
  }
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private observer: ResizeObserver;
  private owned: { dispose(): void }[] = [];
  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.decoder = createModelDecoder(
      this.renderer,
      import.meta.env.BASE_URL + 'basis/',
    );
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor('#202b28');
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Interactive asset preview. Drag to orbit and scroll to zoom.',
    );
    this.host.replaceChildren(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', this.draw);
    this.scene.add(new THREE.HemisphereLight(0xe7f0ff, 0x51564b, 2.5));
    const key = new THREE.DirectionalLight(0xfff1db, 3);
    key.position.set(3, 5, 4);
    const fill = new THREE.DirectionalLight(0xc6ddff, 1.5);
    fill.position.set(-3, 2, -2);
    this.scene.add(key, fill, this.group);
    this.observer = new ResizeObserver(this.draw);
    this.observer.observe(host);
  }
  private draw = () => {
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  };
  private reset() {
    this.group.clear();
    this.owned.forEach((item) => item.dispose());
    this.owned = [];
  }
  model(model: DecodedModel, scale = 1, ground = true) {
    this.reset();
    const object = new THREE.Group();
    model.parts.forEach((part) => {
      const mesh = new THREE.Mesh(part.geometry, part.material);
      mesh.applyMatrix4(part.matrix);
      object.add(mesh);
    });
    const bounds = new THREE.Box3().setFromObject(object);
    if (ground)
      object.position
        .set(
          -(bounds.min.x + bounds.max.x) / 2,
          -bounds.min.y,
          -(bounds.min.z + bounds.max.z) / 2,
        )
        .multiplyScalar(scale);
    object.scale.setScalar(scale);
    this.group.add(object);
    const extent = bounds.getSize(new THREE.Vector3()).multiplyScalar(scale);
    const grid = new THREE.GridHelper(
      Math.max(extent.x, extent.y, extent.z, 0.1) * 1.5,
      10,
      0x81967c,
      0x394c40,
    );
    const axes = new THREE.AxesHelper(
      Math.max(extent.x, extent.y, extent.z, 0.1) * 0.2,
    );
    this.group.add(grid, axes);
    this.owned.push(
      grid.geometry,
      ...(Array.isArray(grid.material) ? grid.material : [grid.material]),
      axes.geometry,
      ...(Array.isArray(axes.material) ? axes.material : [axes.material]),
    );
    this.frame(new THREE.Box3().setFromObject(object));
  }
  surface(material: THREE.MeshStandardMaterial, repeats: number) {
    this.reset();
    const sphere = new THREE.SphereGeometry(1, 64, 40);
    const plane = new THREE.PlaneGeometry(4, 4, 1, 1);
    const uv = plane.getAttribute('uv');
    for (let i = 0; i < uv.count; i++)
      uv.setXY(i, uv.getX(i) * repeats, uv.getY(i) * repeats);
    const ball = new THREE.Mesh(sphere, material);
    ball.position.y = 1.05;
    const ground = new THREE.Mesh(plane, material);
    ground.rotation.x = -Math.PI / 2;
    this.owned.push(sphere, plane);
    this.group.add(ground, ball);
    this.frame();
  }
  private frame(bounds = new THREE.Box3().setFromObject(this.group)) {
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.01);
    this.controls.target.copy(center);
    this.camera.position
      .copy(center)
      .add(new THREE.Vector3(1.3, 0.8, 1.5).multiplyScalar(radius));
    this.camera.near = Math.max(0.0001, radius / 1000);
    this.camera.far = Math.max(100, radius * 30);
    this.controls.minDistance = radius * 0.15;
    this.controls.maxDistance = radius * 10;
    this.controls.update();
    this.draw();
  }
  dispose() {
    this.decoder.dispose();
    this.observer.disconnect();
    this.controls.dispose();
    this.reset();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.host.replaceChildren();
  }
}
