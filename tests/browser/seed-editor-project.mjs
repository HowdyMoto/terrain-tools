import { createProject, serializeProject } from 'terrain-tools';

/** Start focused editor checks from a small real autosave. Default-scene and
 * full reference-world loading remain separate dedicated-GPU checks. */
export async function seedEditorProject(page) {
  const project = createProject(32, 64);
  project.name = 'Saved editor fixture';
  project.view.textureResolution = 256;
  project.view.water = false;
  project.wind.enabled = false;
  project.foliage = [
    { id: 1, brushId: 'pine', x: 0, z: 0, scale: 1, rotation: 0 },
  ];
  project.nextId = 2;
  await page.route('**/__editor_test/start.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
  );
  await page.goto('/__editor_test/start.html');
  await page.evaluate(async (serialized) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('terrain-studio', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('projects');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').put(serialized, 'autosave');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () =>
          reject(tx.error ?? new Error('Fixture save aborted.'));
      });
    } finally {
      db.close();
    }
  }, serializeProject(project));
}
