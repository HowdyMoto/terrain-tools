/** Serializable browser fixture shared by visual checks and the standalone
 * benchmark. Assets are checked-in CC0 derivatives; source projects are untouched. */
export async function foliageMotionScene({
  runtimeURL = '/__runtime_test/lib/',
  width = 1920,
  height = 1080,
} = {}) {
  const THREE = await import('three');
  const {
    createProject,
    editFoliageModels,
    environmentPreset,
    defaultWaterSettings,
  } = await import(runtimeURL + 'core.js');
  const {
    TerrainScene,
    TerrainEnvironment,
    createTerrainRenderer,
    rendererDescription,
  } = await import(runtimeURL + 'runtime.js');
  const project = createProject(16, 40);
  project.heights.fill(0);
  project.foliage = [];
  project.view.textureResolution = 256;
  const ids = ['ph-fern-a', 'ph-fern-a-low'];
  for (const id of ids) {
    const data = new Uint8Array(
      await (await fetch('/foliage/photoreal/' + id + '.glb')).arrayBuffer(),
    );
    project.assets[id] = {
      name: id,
      data: 'data:model/gltf-binary;base64,' + data.toBase64(),
    };
  }
  const model = editFoliageModels(project.brushes[0], [])[0];
  Object.assign(model, {
    model: ids[0],
    wind: 0.8,
    color: '#ffffff',
    crush: 0.5,
    flexibility: { source: 'height', start: 0.08, end: 1, exponent: 1.5 },
    lods: [{ model: ids[1], distance: 10, density: 1 }],
    lodFadeDuration: 0.4,
    lodHysteresis: 0.08,
    cullDistance: 50,
  });
  Object.assign(project.wind, {
    enabled: true,
    strength: 2,
    speed: 1.4,
    gust: 0.5,
    direction: 20,
  });
  for (let z = -7; z < 7; z += 0.7)
    for (let x = -7; x < 7; x += 0.7)
      project.foliage.push({
        id: project.nextId++,
        brushId: project.brushes[0].id,
        modelId: model.id,
        x,
        z,
        scale: 1.8 + Math.sin(x * 17 + z * 11) * 0.2,
        rotation: x * 3 + z * 5,
      });
  project.environment = environmentPreset('natural');
  Object.assign(project.environment, {
    shadows: true,
    shadowResolution: 1024,
    shadowDistance: 45,
    temporalAA: true,
    temporalSharpness: 0,
    fogEnabled: false,
  });
  project.environment.timeOfDay.playing = false;
  project.environment.ambientOcclusion.enabled = true;
  project.water = defaultWaterSettings(project);
  project.water.seaLevel = -0.2;
  project.water.ocean.enabled = true;
  const renderer = await createTerrainRenderer({ timestamps: true });
  renderer.setSize(width, height);
  document.body.style.cssText = 'margin:0;background:#101810';
  document.body.replaceChildren(renderer.domElement);
  const errors = [];
  renderer.backend.device.addEventListener('uncapturederror', (event) =>
    errors.push(event.error.message),
  );
  const terrain = new TerrainScene(project);
  await terrain.load();
  const scene = new THREE.Scene();
  scene.add(terrain);
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200);
  camera.position.set(0, 1.7, 7.5);
  camera.lookAt(0, 0.7, -4);
  const environment = new TerrainEnvironment(scene, renderer);
  await environment.load(project.environment, project);
  let lastTarget;
  const render = renderer.render;
  renderer.render = function (scene, camera) {
    const result = render.call(this, scene, camera);
    const target = renderer.getRenderTarget();
    if (renderer.getMRT()?.has('velocity') && target?.textures[3]) {
      lastTarget = target;
    }
    return result;
  };
  let elapsed = 0;
  const step = (dt = 1 / 30, move = true) => {
    elapsed += dt;
    if (move) {
      camera.position.x = Math.sin(elapsed * 0.5) * 1.2;
      camera.position.z = 7.5 + Math.sin(elapsed * 0.35) * 3;
      camera.lookAt(0, 0.7, -4);
    }
    terrain.update(dt, [], camera);
    environment.tick(dt);
    environment.render(camera);
  };
  const pixels = async () => {
    const device = renderer.backend.device;
    await device.queue.onSubmittedWorkDone();
    step(0, false);
    // Copy the submitted display texture before presentation. Switching final
    // render-target formats for a readback changes the postprocessing graph.
    const texture = renderer.domElement
      .getContext('webgpu')
      .getCurrentTexture();
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture },
        { buffer, bytesPerRow, rowsPerImage: height },
        { width, height },
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange());
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++)
        data.set(
          mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4),
          y * width * 4,
        );
      if (texture.format === 'bgra8unorm')
        for (let i = 0; i < data.length; i += 4)
          [data[i], data[i + 2]] = [data[i + 2], data[i]];
      return data;
    } finally {
      buffer.destroy();
    }
  };
  const api = {
    renderer,
    terrain,
    environment,
    camera,
    project,
    step,
    pixels,
    get target() {
      return lastTarget;
    },
    get elapsed() {
      return elapsed;
    },
    errors,
    adapter: rendererDescription(renderer),
    async dispose() {
      terrain.dispose();
      environment.dispose();
      await renderer.dispose();
      return renderer.info.memory.total;
    },
  };
  window.foliageMotionScene = api;
  return {
    adapter: api.adapter,
    plants: project.foliage.length,
    width,
    height,
  };
}
