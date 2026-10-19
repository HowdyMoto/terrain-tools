import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
/** Test the built public runtime without adding hooks to the editor. */
export async function runtimePackagePage(page) {
  const root = resolve('.');
  await page.route('**/__runtime_test/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(
      '/__runtime_test/'.length,
    );
    if (path === 'index.html')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Foliage deformation verification</title><script type="importmap">{"imports":{"three":"/__runtime_test/three/build/three.module.js","three/":"/__runtime_test/three/","three/addons/":"/__runtime_test/three/examples/jsm/"}}</script>',
      });
    const local = path.startsWith('lib/')
      ? resolve(root, path)
      : path.startsWith('three/')
        ? resolve(root, 'node_modules', path)
        : '';
    if (!local.startsWith(root + sep)) return route.abort();
    await route.fulfill({
      contentType: 'text/javascript',
      body: await readFile(local),
    });
  });
  await page.goto('/__runtime_test/index.html');
}
