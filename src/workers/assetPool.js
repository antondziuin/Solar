// A small pool of asset workers (fetch + decode + convert off the main thread).
const N = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
let pool = null;
let nextId = 1;
const pending = new Map();

function workers() {
  if (pool) return pool;
  pool = [];
  for (let i = 0; i < N; i++) {
    const w = new Worker(new URL('./asset.worker.js', import.meta.url), { type: 'module' });
    w.busy = 0;
    w.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      w.busy--;
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    pool.push(w);
  }
  return pool;
}

/** Run a decode job ('dem' | 'map' | 'elev16' | 'tile') on the least busy worker. */
export function decodeAsset(type, args) {
  const ws = workers();
  let w = ws[0];
  for (const x of ws) if (x.busy < w.busy) w = x;
  const id = nextId++;
  w.busy++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, args });
  });
}

/** Resolve a (possibly relative) asset path against the page, for use inside a worker. */
export const absUrl = (u) => new URL(u, document.baseURI).href;
