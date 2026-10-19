import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Select this workstation's dedicated adapter in the temporary test browser.
 * LUIDs change after reboot, so enumerate each process instead of saving one.
 * Does not write driver, registry or user-profile settings. Other hosts retain
 * Chromium's normal high-performance request. Benchmarks must verify the result.
 * Switch source: https://chromium.googlesource.com/chromium/src/+/main/ui/gl/gl_switches.cc
 */
export function chromeGPUArgs() {
  const args = ['--force-high-performance-gpu'];
  if (process.platform !== 'win32') return [];
  try {
    const result = JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          fileURLToPath(new URL('./windows-gpu.ps1', import.meta.url)),
        ],
        { encoding: 'utf8', timeout: 15000, windowsHide: true },
      ),
    );
    const adapter = (Array.isArray(result) ? result : [result]).find((gpu) =>
      /RTX 5060/i.test(gpu.Name),
    );
    if (
      adapter &&
      Number.isInteger(adapter.High) &&
      Number.isInteger(adapter.Low)
    )
      args.push(
        '--use-angle=d3d11',
        `--use-adapter-luid=${adapter.High},${adapter.Low}`,
      );
  } catch (error) {
    console.warn(
      'Could not enumerate test GPU; using the high-performance request:',
      error.message,
    );
  }
  return args;
}
