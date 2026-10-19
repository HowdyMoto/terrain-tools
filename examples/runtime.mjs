import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createProject,
  generateTerrain,
  populateFoliage,
  applyBrush,
  serializeProject,
  heightAt,
} from 'terrain-tools';
import { loadTerrain, TerrainEnvironment } from 'terrain-tools/three';

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
const container = document.querySelector('#stage');
container.append(renderer.domElement);
renderer.domElement.setAttribute('aria-label', 'Standalone runtime viewport');
const scene = new THREE.Scene();
const lighting = new TerrainEnvironment(scene, renderer);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 3000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
const clock = new THREE.Clock();
let terrain, physics;
let bodies = [];
let pulses = [];
let loading = 0;
let loadController;
let viewpoints;
const referenceRoot = './examples/upland/';
function setView(name) {
  const view = viewpoints?.[name];
  if (!view) return;
  controls.target.fromArray(view.target);
  camera.position.fromArray(view.position);
  controls.update();
}
async function openSample(mode) {
  return open(
    mode === 'upland'
      ? async (signal) => {
          const response = await fetch(
            referenceRoot + 'upland-meadow.terrain',
            { signal },
          );
          if (!response.ok)
            throw new Error(
              'Reference scene download failed (' + response.status + ').',
            );
          return response.blob();
        }
      : sample(mode),
    mode === 'upland',
  );
}
const status = document.querySelector('#status');
function clearBodies() {
  for (const b of bodies) {
    physics?.remove(b.body);
    scene.remove(b.mesh);
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
  }
  bodies = [];
}
async function open(input, reference = false) {
  const ticket = ++loading;
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  try {
    status.textContent = 'Loading authored scene…';
    let nextViews;
    if (reference) {
      const response = await fetch(referenceRoot + 'manifest.json', {
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error('Reference viewpoints could not be loaded.');
      nextViews = (await response.json()).viewpoints;
    }
    const source =
      typeof input === 'function' ? await input(controller.signal) : input;
    if (controller.signal.aborted) return;
    const next = await loadTerrain(source, { signal: controller.signal });
    let environment;
    try {
      environment = await lighting.prepare(next.project.environment);
    } catch (error) {
      next.dispose();
      throw error;
    }
    if (ticket !== loading || controller.signal.aborted) {
      next.dispose();
      environment.dispose();
      return;
    }
    clearBodies();
    if (terrain) {
      scene.remove(terrain);
      terrain.dispose();
    }
    lighting.apply(environment, next.project);
    terrain = next;
    scene.add(terrain);
    physics?.rebuild(terrain.project);
    physics?.setPropMeshes(terrain.collisionMeshes(true, false));
    const authored = environment.settings;
    document.querySelector('#lighting').textContent =
      (authored.timeOfDay?.enabled
        ? 'Dynamic sky'
        : authored.mode === 'image'
          ? 'HDRI'
          : authored.mode === 'sky'
            ? 'Sky'
            : 'Ambient') +
      ' · ' +
      (authored.toneMapping === 'neutral' ? 'Neutral' : 'ACES') +
      ' · exposure ' +
      authored.exposure.toFixed(2);
    const size = terrain.project.size;
    controls.target.set(0, 6, 0);
    camera.position.set(size * 1.05, size * 0.95, size * 1.05);
    viewpoints = nextViews;
    document.querySelector('#reference-view').hidden = !viewpoints;
    document.querySelector('#reference-download').hidden = !viewpoints;
    document.querySelector('#reference-note').hidden = !viewpoints;
    if (viewpoints) {
      document.querySelector('#reference-view').value = 'trail';
      setView('trail');
    }
    document.querySelector('#wind').textContent = terrain.project.wind.enabled
      ? 'Wind on'
      : 'Wind off';
    status.textContent =
      terrain.project.name +
      ' · ' +
      terrain.project.foliage.length.toLocaleString() +
      ' foliage instances · ' +
      terrain.project.props.length +
      ' props';
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (loadController === controller) loadController = undefined;
  }
}
function sample(mode) {
  const p = createProject(mode === 'stylized' ? 32 : 128, 128);
  p.name =
    mode === 'stylized'
      ? 'Low-poly islands'
      : mode === 'simulation'
        ? 'Collision sample'
        : 'Detailed terrain';
  p.view.lowPoly = mode === 'stylized';
  if (mode === 'stylized') generateTerrain(p, 'islands');
  if (mode === 'simulation') {
    generateTerrain(p, 'flat');
    p.view.water = false;
    applyBrush(p, {
      tool: 'hole',
      x: 0,
      z: 0,
      radius: 5,
      strength: 1,
      falloff: 0.5,
      target: 0,
      material: 0,
      brushId: 'grass',
      seed: 1,
    });
    p.props.push({
      id: p.nextId++,
      model: 'platform',
      x: 12,
      z: 0,
      yOffset: 0,
      scale: 1,
      rotation: 0,
      cutHole: true,
      holeRadius: 4,
    });
  }
  populateFoliage(p, 'pine');
  p.brushes[1].density = 0.1;
  p.brushes[1].materials = p.materials.map((m) => m.id);
  p.brushes[1].maxSlope = 70;
  populateFoliage(p, 'grass');
  return serializeProject(p);
}
function showError(error) {
  status.textContent = 'Could not load: ' + error.message;
  console.error(error);
}
document.querySelector('#sample').onchange = (e) => {
  void openSample(e.target.value).catch(showError);
};
document.querySelector('#reference-view').onchange = (e) =>
  setView(e.target.value);
document.querySelector('#open-project').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await open(file);
  } catch (error) {
    showError(error);
  }
  e.target.value = '';
};
document.querySelector('#wind').onclick = () => {
  if (!terrain) return;
  terrain.project.wind.enabled = !terrain.project.wind.enabled;
  document.querySelector('#wind').textContent = terrain.project.wind.enabled
    ? 'Wind on'
    : 'Wind off';
};
document.querySelector('#contact').onclick = () => {
  const candidates = terrain?.project.foliage ?? [];
  const plant = viewpoints
    ? candidates.reduce((best, f) => {
        const distance = (item) =>
          Math.hypot(item.x - controls.target.x, item.z - controls.target.z);
        return !best || distance(f) < distance(best) ? f : best;
      }, null)
    : (candidates.find((f) => f.brushId === 'grass') ?? candidates[0]);
  if (plant)
    pulses.push({
      x: plant.x,
      z: plant.z,
      radius: terrain.project.interaction.radius,
      strength: 1,
    });
};
document.querySelector('#physics').onclick = async () => {
  if (physics) return;
  try {
    const { TerrainPhysics } = await import('terrain-tools/rapier');
    const ready = new TerrainPhysics();
    await ready.init();
    ready.rebuild(terrain.project);
    ready.setPropMeshes(terrain.collisionMeshes(true, false));
    physics = ready;
    document.querySelector('#physics').textContent = 'Physics active';
  } catch (error) {
    showError(error);
  }
};
document.querySelector('#drop').onclick = () => {
  if (!physics || !terrain) {
    status.textContent = 'Enable physics before dropping a body.';
    return;
  }
  const p = terrain.project;
  const x = p.props[0]?.x ?? 0,
    z = p.props[0]?.z ?? 0;
  const body = physics.drop(x, heightAt(p, x, z) + 12, z, 1),
    mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 12),
      new THREE.MeshStandardMaterial({
        color: '#e2a45c',
        metalness: 0.5,
        roughness: 0.3,
      }),
    );
  mesh.castShadow = true;
  scene.add(mesh);
  bodies.push({ body, mesh });
};
new ResizeObserver(() => {
  const { width, height } = container.getBoundingClientRect();
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}).observe(container);
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  controls.update();
  const contacts = pulses;
  pulses = [];
  if (physics) {
    physics.step(dt);
    for (const b of bodies) {
      b.mesh.position.copy(b.body.translation());
      b.mesh.quaternion.copy(b.body.rotation());
      if (physics.touchesTerrain(b.body))
        contacts.push({
          x: b.mesh.position.x,
          z: b.mesh.position.z,
          radius: terrain.project.interaction.radius,
          strength: 1,
        });
    }
  }
  terrain?.update(dt, contacts, camera);
  lighting.tick(dt);
  document.querySelector('#contacts').textContent =
    contacts.length + ' ground contacts';
  if (terrain) {
    const stats = terrain.foliage.viewStats;
    document.querySelector('#foliage-rendering').textContent =
      stats.instances.toLocaleString() +
      ' plants selected' +
      (stats.transitioning
        ? ' · ' + stats.transitioning.toLocaleString() + ' cross-fading'
        : '');
  }
  lighting.render(camera);
});
const initialSample =
  new URLSearchParams(location.search).get('sample') === 'upland'
    ? 'upland'
    : 'detailed';
document.querySelector('#sample').value = initialSample;
void openSample(initialSample).catch(showError);
window.addEventListener('pagehide', () => {
  loadController?.abort();
  renderer.setAnimationLoop(null);
  clearBodies();
  physics?.dispose();
  terrain?.dispose();
  lighting.dispose();
  controls.dispose();
  renderer.dispose();
});
