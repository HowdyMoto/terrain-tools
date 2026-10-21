import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** A task-scoped request, released when stdin closes or the helper exits.
 * Does not edit Windows power settings. Other platforms report unknown power. */
export async function benchmarkPower(hold = true) {
  if (process.platform !== 'win32') return { power: null, close() {} };
  const helper = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      fileURLToPath(new URL('./windows-benchmark-power.ps1', import.meta.url)),
      ...(hold ? ['-Hold'] : []),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    const power = await new Promise((resolve, reject) => {
      let output = '',
        errors = '';
      const timeout = setTimeout(
        () => reject(new Error('Power helper timed out.')),
        15000,
      );
      const done = (error, value) => {
        clearTimeout(timeout);
        error ? reject(error) : resolve(value);
      };
      helper.on('error', (error) => done(error));
      helper.stderr.on('data', (data) => {
        errors += data;
      });
      helper.stdout.on('data', (data) => {
        output += data;
        if (output.includes('\n')) {
          try {
            done(null, JSON.parse(output.trim()));
          } catch (error) {
            done(error);
          }
        }
      });
      helper.on('exit', (code) => {
        if (code) done(new Error(errors || `Power helper exited ${code}.`));
      });
    });
    return {
      power,
      async close() {
        if (helper.exitCode !== null) return;
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            helper.kill();
            resolve();
          }, 5000);
          helper.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
          helper.stdin.end();
        });
      },
    };
  } catch (error) {
    helper.kill();
    throw error;
  }
}
