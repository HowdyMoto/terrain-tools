import { spawn } from 'node:child_process';
import { benchmarkPower } from './benchmark-power.mjs';

// Modern Standby can suspend GPU work even in headless Chrome. Hold only for
// this command; the helper releases its thread request when stdin closes.
const session = await benchmarkPower();
let child;
const stop = () => child?.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  child = spawn(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await session.close();
}
