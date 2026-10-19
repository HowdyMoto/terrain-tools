import { referenceTile } from './world-source';
self.onmessage = (
  event: MessageEvent<{ id: number; x: number; z: number }>,
) => {
  try {
    const p = referenceTile(event.data.x, event.data.z);
    self.postMessage(
      { id: event.data.id, project: p },
      { transfer: [p.heights.buffer, p.paint.buffer, p.holes.buffer] },
    );
  } catch (error) {
    self.postMessage({ id: event.data.id, error: String(error) });
  }
};
