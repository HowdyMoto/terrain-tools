import { cpus } from 'node:os';
import {
  createProject,
  runErosion,
  defaultErosionSettings,
  effectiveHoles,
} from '../lib/core.js';
const settings = defaultErosionSettings();
const measurements = [];
for (const resolution of [128, 256, 512]) {
  const project = createProject(resolution, 192, 42);
  const input = { ...project, holes: effectiveHoles(project) };
  const start = performance.now();
  const result = runErosion(input, settings);
  measurements.push({
    resolution,
    milliseconds: Math.round(performance.now() - start),
    maxChangeMetres: result.maxChange,
    erodedCubicMetres: result.erodedVolume,
    depositedCubicMetres: result.depositedVolume,
    drainedCubicMetres: result.drainedVolume,
  });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      cpu: cpus()[0]?.model,
      settings,
      measurements,
      scope:
        'One CPU authoring calculation per grid. Excludes worker startup, rendering, collision and editor refresh.',
    },
    null,
    2,
  ),
);
