import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { runtimePackagePage } from './runtime-package-page.mjs';
import { maskedPlantGlb } from './fixtures.mjs';

test('renders rigid and flexible parts with matching wind/contact shadows and a verified deformation Jacobian', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await runtimePackagePage(page);
  const result = await page.evaluate(
    async (data) => {
      const THREE = await import('three');
      const { TerrainScene } = await import('/__runtime_test/lib/runtime.js');
      const { createProject, editFoliageModels } =
        await import('/__runtime_test/lib/core.js');
      const project = createProject(32, 64);
      project.heights.fill(0);
      project.foliage = [];
      project.props = [];
      project.assets = { plant: { name: 'Painted plant.glb', data } };
      const model = editFoliageModels(project.brushes[0], [])[0];
      Object.assign(model, {
        model: 'plant',
        wind: 1,
        crush: 1,
        alignToNormal: false,
        flexibility: { source: 'attribute', start: 0, end: 1, exponent: 1 },
      });
      project.foliage = [
        {
          id: 1,
          brushId: project.brushes[0].id,
          modelId: model.id,
          x: 0,
          z: 0,
          scale: 1,
          rotation: 0,
        },
      ];
      project.nextId = 2;
      Object.assign(project.wind, {
        enabled: false,
        strength: 2,
        direction: 0,
        speed: 1,
        gust: 0,
      });
      Object.assign(project.interaction, {
        enabled: true,
        strength: 1,
        recovery: 0.2,
      });
      const terrain = new TerrainScene(project);
      await terrain.library.loadAssets(project);
      terrain.rebuildFoliage();
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x101820);
      scene.add(terrain.foliage, new THREE.AmbientLight(0xffffff, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2);
      light.position.set(0, 6, 8);
      light.target.position.set(0, 2, 0);
      light.castShadow = true;
      light.shadow.mapSize.set(256, 256);
      Object.assign(light.shadow.camera, {
        left: -6,
        right: 6,
        top: 6,
        bottom: -6,
        near: 0.1,
        far: 30,
      });
      light.shadow.camera.updateProjectionMatrix();
      scene.add(light, light.target);
      const point = new THREE.PointLight(0xffffff, 2, 30);
      point.position.set(0, 5, 6);
      point.castShadow = true;
      point.shadow.mapSize.set(128, 128);
      scene.add(point);
      const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
      camera.position.set(0, 2, 12);
      camera.lookAt(0, 2, 0);
      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        preserveDrawingBuffer: true,
      });
      renderer.setSize(400, 400);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.BasicShadowMap;
      document.body.style.cssText =
        'margin:0;background:#101820;color:white;font:16px system-ui;display:flex;flex-wrap:wrap';
      const target = new THREE.WebGLRenderTarget(400, 400);
      const readShadow = (light) => {
        const map = light.shadow.map;
        const pixels = new Uint8Array(map.width * map.height * 4);
        renderer.readRenderTargetPixels(
          map,
          0,
          0,
          map.width,
          map.height,
          pixels,
        );
        return pixels;
      };
      const snapshot = (label) => {
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(400 * 400 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 400, 400, pixels);
        const shadows = [readShadow(light), readShadow(point)];
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        const figure = document.createElement('figure');
        figure.style.margin = '12px';
        const caption = document.createElement('figcaption');
        caption.textContent = label + ' · left rigid / right flexible';
        const image = document.createElement('img');
        image.src = renderer.domElement.toDataURL();
        image.width = 400;
        image.height = 400;
        figure.append(caption, image);
        document.body.append(figure);
        return { pixels, shadows };
      };
      const differences = (a, b, left = 0, right = 400, width = 400) => {
        let count = 0;
        for (let i = 0; i < a.length; i += 4) {
          const x = (i / 4) % width;
          if (
            x >= left &&
            x < right &&
            Math.abs(a[i] - b[i]) +
              Math.abs(a[i + 1] - b[i + 1]) +
              Math.abs(a[i + 2] - b[i + 2]) >
              0
          )
            count++;
        }
        return count;
      };
      terrain.update(0);
      const rest = snapshot('Rest');
      project.wind.enabled = true;
      terrain.update(0.75);
      const wind = snapshot('Wind');
      project.wind.enabled = false;
      terrain.clearInteractions();
      terrain.update(0.1, [{ x: 0, z: 0, radius: 3, strength: 1 }]);
      const crushed = snapshot('Contact');
      terrain.update(10);
      const recovered = snapshot('Recovered');
      const stats = {
        windRigid: differences(rest.pixels, wind.pixels, 0, 200),
        windFlexible: differences(rest.pixels, wind.pixels, 200, 400),
        contactRigid: differences(rest.pixels, crushed.pixels, 0, 200),
        contactFlexible: differences(rest.pixels, crushed.pixels, 200, 400),
        recovery: differences(rest.pixels, recovered.pixels),
        windShadows: rest.shadows.map((p, i) =>
          differences(
            p,
            wind.shadows[i],
            0,
            Infinity,
            i ? point.shadow.map.width : light.shadow.map.width,
          ),
        ),
        contactShadows: rest.shadows.map((p, i) =>
          differences(
            p,
            crushed.shadows[i],
            0,
            Infinity,
            i ? point.shadow.map.width : light.shadow.map.width,
          ),
        ),
      };

      // Compile the production shader helper in WebGL2 transform feedback. Compare its
      // analytic Jacobian with independent finite differences of actual GPU positions.
      const mesh = terrain.foliage.children[0];
      const declaration = (material) => {
        const shader = {
          uniforms: {},
          vertexShader:
            '#include <beginnormal_vertex>\n#include <begin_vertex>',
        };
        material.onBeforeCompile(shader, renderer);
        return shader.vertexShader.slice(
          0,
          shader.vertexShader.indexOf('#include'),
        );
      };
      const source = declaration(mesh.material);
      stats.identicalPasses =
        source === declaration(mesh.customDepthMaterial) &&
        source === declaration(mesh.customDistanceMaterial);
      const canvas = document.createElement('canvas'),
        gl = canvas.getContext('webgl2');
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader));
        return shader;
      };
      const vertex = compile(
        gl.VERTEX_SHADER,
        '#version 300 es\nprecision highp float;\nuniform mat4 instanceMatrix;\n' +
          source.replaceAll('attribute ', 'in ') +
          '\nuniform vec3 samplePosition;out vec3 result;out vec3 j0;out vec3 j1;out vec3 j2;void main(){mat3 j;foliageDeformation(samplePosition,result,j);j0=j[0];j1=j[1];j2=j[2];gl_Position=vec4(0.0,0.0,0.0,1.0);gl_PointSize=1.0;}',
      );
      const fragment = compile(
        gl.FRAGMENT_SHADER,
        '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1.0);}',
      );
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.transformFeedbackVaryings(
        program,
        ['result', 'j0', 'j1', 'j2'],
        gl.INTERLEAVED_ATTRIBS,
      );
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const uniform = (name) => gl.getUniformLocation(program, name);
      const matrix = new THREE.Matrix4()
        .makeRotationY(0.4)
        .scale(new THREE.Vector3(1.7, 1.7, 1.7))
        .setPosition(3, 0, -2);
      gl.uniformMatrix4fv(uniform('instanceMatrix'), false, matrix.elements);
      for (const [name, value] of Object.entries({
        uTime: 1.234,
        uStrength: 2.4,
        uGust: 0.8,
        uSpeed: 2,
      }))
        gl.uniform1f(uniform(name), value);
      gl.uniform2f(uniform('uDirection'), 1, 0.3);
      const attribute = gl.getAttribLocation(program, 'terrainFlexibility'),
        contact = gl.getAttribLocation(program, 'terrainContact');
      gl.vertexAttrib1f(contact, 0.8);
      const buffer = gl.createBuffer(),
        feedback = gl.createTransformFeedback(),
        vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
      gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, 48, gl.STREAM_READ);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
      gl.enable(gl.RASTERIZER_DISCARD);
      const gradient = [0.1, 0.2, -0.1],
        center = [0.7, 2.2, 0.3];
      const evaluate = (position) => {
        const mask =
          0.45 +
          gradient.reduce(
            (sum, g, i) => sum + g * (position[i] - center[i]),
            0,
          );
        gl.vertexAttrib4f(attribute, mask, ...gradient);
        gl.uniform3fv(uniform('samplePosition'), position);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, 1);
        gl.endTransformFeedback();
        const output = new Float32Array(12);
        gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
        return output;
      };
      const value = evaluate(center),
        epsilon = 0.001;
      let derivativeError = 0;
      for (let axis = 0; axis < 3; axis++) {
        const plus = [...center],
          minus = [...center];
        plus[axis] += epsilon;
        minus[axis] -= epsilon;
        const a = evaluate(plus),
          b = evaluate(minus);
        for (let component = 0; component < 3; component++)
          derivativeError = Math.max(
            derivativeError,
            Math.abs(
              (a[component] - b[component]) / (2 * epsilon) -
                value[3 + axis * 3 + component],
            ),
          );
      }
      stats.derivativeError = derivativeError;
      stats.glError = gl.getError();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.deleteTransformFeedback(feedback);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      target.dispose();
      terrain.dispose();
      light.shadow.map.dispose();
      point.shadow.map.dispose();
      renderer.dispose();
      return stats;
    },
    'data:model/gltf-binary;base64,' + maskedPlantGlb().toString('base64'),
  );
  expect(errors).toEqual([]);
  expect(result.windRigid).toBe(0);
  expect(result.contactRigid).toBe(0);
  expect(result.windFlexible).toBeGreaterThan(100);
  expect(result.contactFlexible).toBeGreaterThan(100);
  expect(result.recovery).toBe(0);
  expect(result.windShadows.every((value) => value > 20)).toBe(true);
  expect(result.contactShadows.every((value) => value > 20)).toBe(true);
  expect(result.identicalPasses).toBe(true);
  expect(result.derivativeError).toBeLessThan(0.003);
  expect(result.glError).toBe(0);
  const metricsPath = testInfo.outputPath('deformation-metrics.json');
  await writeFile(metricsPath, JSON.stringify(result, null, 2));
  await testInfo.attach('deformation-metrics', {
    path: metricsPath,
    contentType: 'application/json',
  });
  await page.screenshot({
    path: testInfo.outputPath('foliage-flexibility-render.png'),
    fullPage: true,
  });
});
