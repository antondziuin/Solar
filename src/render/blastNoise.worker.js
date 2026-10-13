import { computeBlastNoise } from './blastNoise.js';

self.onmessage = (e) => {
  const data = computeBlastNoise(e.data.size);
  self.postMessage({ size: e.data.size, data }, [data.buffer]);
};
