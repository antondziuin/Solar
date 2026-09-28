// Real Earth elevation (land and sea floor) from the AWS Open Data "Terrain Tiles"
// (Tilezen/Mapzen Terrarium: SRTM, GMTED2010, ETOPO1, GEBCO, NED, ...).
//
// * A static global base map (4096 x 2048, ~10 km) ships with the app (scripts/build_earth_dem.py).
// * Around the camera, a clipmap of equirectangular windows is filled at runtime from
//   Web-Mercator tiles down to zoom 13 (~19 m/px), each level half the size of the previous.
//
// The same data is kept on the CPU so that collision uses exactly the heights the GPU draws.
import * as THREE from 'three';

export const DEM_LEVELS = 8;
export const DEM_SIZE = 512;
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const MAX_ZOOM = 13;
const LEVEL0_DEG = 16;
const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;

const wrap180 = (x) => ((((x + 180) % 360) + 360) % 360) - 180;

async function decodeElevation(blob, w, h) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cw = w || bmp.width, ch = h || bmp.height;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch) : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, cw, ch).data;
  return { px, w: cw, h: ch };
}

export class EarthDEM {
  constructor() {
    this.base = null; // Float32Array W*H
    this.baseW = 0; this.baseH = 0;
    this.levels = [];
    for (let l = 0; l < DEM_LEVELS; l++) {
      const size = LEVEL0_DEG / 2 ** l;
      const texelDeg = size / DEM_SIZE;
      const zoom = Math.min(MAX_ZOOM, Math.ceil(Math.log2(360 / (256 * texelDeg))));
      this.levels.push({
        size, texelDeg, texelM: texelDeg * DEG * EARTH_R, zoom,
        lonC: 0, latC: 0, valid: false, active: false, dirty: false,
        data: new Float32Array(DEM_SIZE * DEM_SIZE),
      });
    }
    this.tiles = new Map(); // key -> { data: Float32Array | null, promise, used }
    this.inflight = 0;
    this.maxInflight = 8;
    this.queue = [];
    this.enabled = true;
    this.failed = 0;
    this.winUniform = Array.from({ length: DEM_LEVELS }, () => new THREE.Vector4(0, 0, 1, 0));
    this.levelTex = new THREE.DataArrayTexture(new Float32Array(DEM_SIZE * DEM_SIZE * DEM_LEVELS), DEM_SIZE, DEM_SIZE, DEM_LEVELS);
    this.levelTex.format = THREE.RedFormat;
    this.levelTex.type = THREE.FloatType;
    this.levelTex.minFilter = this.levelTex.magFilter = THREE.NearestFilter;
    this.levelTex.needsUpdate = true;
    this._dirtyQueue = [];
  }

  async loadBase(url) {
    const blob = await fetch(url).then((r) => r.blob());
    const { px, w, h } = await decodeElevation(blob);
    const a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = px[i * 4] * 256 + px[i * 4 + 1] - 32768;
    this.base = a; this.baseW = w; this.baseH = h;
    this.baseTex = new THREE.DataTexture(a, w, h, THREE.RedFormat, THREE.FloatType);
    this.baseTex.minFilter = this.baseTex.magFilter = THREE.NearestFilter;
    this.baseTex.needsUpdate = true;
  }

  /** Bilinear sample of the base map (rows +90..-90, columns -180..180). */
  sampleBase(lat, lon) {
    const W = this.baseW, H = this.baseH;
    const x = ((lon + 180) / 360) * W - 0.5;
    const y = ((90 - lat) / 180) * H - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const X = (i) => ((i % W) + W) % W;
    const Y = (j) => Math.min(H - 1, Math.max(0, j));
    const b = this.base;
    const r0 = Y(y0) * W, r1 = Y(y0 + 1) * W;
    const a00 = b[r0 + X(x0)], a10 = b[r0 + X(x0 + 1)], a01 = b[r1 + X(x0)], a11 = b[r1 + X(x0 + 1)];
    return (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy;
  }

  _sampleLevel(L, u, v) {
    const N = DEM_SIZE;
    const x = u * N - 0.5, y = v * N - 0.5;
    const x0 = Math.max(0, Math.min(N - 2, Math.floor(x))), y0 = Math.max(0, Math.min(N - 2, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
    const d = L.data;
    const i = y0 * N + x0;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + N] * (1 - fx) + d[i + N + 1] * fx) * fy;
  }

  /** Elevation (m) at lat/lon (deg) for a sampling footprint `need` (m); mirrors the GLSL. */
  height(lat, lon, need) {
    this.lastRes = 9800;
    if (!this.base) return 0;
    let h = this.sampleBase(lat, lon);
    for (let l = 0; l < DEM_LEVELS; l++) {
      const L = this.levels[l];
      const w = this.winUniform[l];
      if (w.w <= 0) break;
      const u = wrap180(lon - w.x) / w.z + 0.5;
      const v = (lat - w.y) / w.z + 0.5;
      const edge = Math.min(u, 1 - u, v, 1 - v);
      if (edge <= 0.02) break;
      const fe = Math.min(1, (edge - 0.02) / 0.06);
      const fr = Math.min(1, Math.max(0, Math.log2(w.w / need) + 1));
      if (fr <= 0) break;
      h += (this._sampleLevel(L, u, v) - h) * fe * fr;
      this.lastRes += (w.w - this.lastRes) * fe * fr;
    }
    return h;
  }

  // ------------------------------------------------------------ tiles
  _key(z, x, y) { return `${z}/${x}/${y}`; }

  _request(z, x, y) {
    const key = this._key(z, x, y);
    let t = this.tiles.get(key);
    if (t) { t.used = performance.now(); return t; }
    t = { z, x, y, data: null, used: performance.now(), state: 'queued' };
    this.tiles.set(key, t);
    this.queue.push(t);
    return t;
  }

  _pump() {
    this.queue.sort((a, b) => a.z - b.z);
    while (this.inflight < this.maxInflight && this.queue.length) {
      const t = this.queue.shift();
      this.inflight++;
      t.state = 'loading';
      const url = TILE_URL.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
      fetch(url, { mode: 'cors' })
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then((b) => decodeElevation(b, 256, 256))
        .then(({ px }) => {
          const a = new Float32Array(65536);
          for (let i = 0; i < 65536; i++) a[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
          t.data = a;
          t.state = 'ready';
          for (const L of this.levels) if (L.active && L.zoom === t.z) L.dirty = true;
        })
        .catch(() => { t.state = 'failed'; this.failed++; if (this.failed > 40) this.enabled = false; })
        .finally(() => { this.inflight--; });
    }
    // evict least recently used tiles
    if (this.tiles.size > 260) {
      const arr = [...this.tiles.values()].filter((t) => t.state === 'ready' || t.state === 'failed').sort((a, b) => a.used - b.used);
      for (let i = 0; i < arr.length - 220; i++) this.tiles.delete(this._key(arr[i].z, arr[i].x, arr[i].y));
    }
  }

  _mercTile(lat, lon, z) {
    const n = 2 ** z;
    const la = Math.max(-85.0511, Math.min(85.0511, lat)) * DEG;
    const x = ((lon + 180) / 360) * n;
    const y = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n;
    return [x, y];
  }

  /** Fill level L from the tile cache (falls back to the coarser data where tiles are missing). */
  _resample(l) {
    const L = this.levels[l];
    const N = DEM_SIZE, z = L.zoom, n = 2 ** z;
    const lon0 = L.lonC - L.size / 2, lat1 = L.latC + L.size / 2;
    const d = L.data;
    let missing = 0;
    let lastKey = '', last = null;
    const coarser = (lat, lon) => {
      // previous level or base map
      let h = this.sampleBase(lat, lon);
      for (let k = 0; k < l; k++) {
        const P = this.levels[k];
        if (!P.valid) break;
        const u = wrap180(lon - P.lonC) / P.size + 0.5, v = (lat - (P.latC - P.size / 2)) / P.size;
        if (u < 0 || u > 1 || v < 0 || v > 1) break;
        h = this._sampleLevel(P, u, v);
      }
      return h;
    };
    for (let j = 0; j < N; j++) {
      // row 0 = southern edge (texture v = 0)
      const lat = lat1 - L.size + (j + 0.5) * L.texelDeg;
      for (let i = 0; i < N; i++) {
        const lon = wrap180(lon0 + (i + 0.5) * L.texelDeg);
        if (Math.abs(lat) > 85.05) { d[j * N + i] = coarser(lat, lon); continue; }
        const [mx, my] = this._mercTile(lat, lon, z);
        const tx = Math.floor(mx), ty = Math.floor(my);
        const key = `${z}/${((tx % n) + n) % n}/${ty}`;
        let t = key === lastKey ? last : this.tiles.get(key);
        lastKey = key; last = t;
        if (!t || !t.data) { d[j * N + i] = coarser(lat, lon); missing++; continue; }
        const fx = (mx - tx) * 256 - 0.5, fy = (my - ty) * 256 - 0.5;
        const x0 = Math.max(0, Math.min(254, Math.floor(fx))), y0 = Math.max(0, Math.min(254, Math.floor(fy)));
        const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
        const a = t.data, k = y0 * 256 + x0;
        let hv = (a[k] * (1 - ax) + a[k + 1] * ax) * (1 - ay) + (a[k + 256] * (1 - ax) + a[k + 257] * ax) * ay;
        // tiles hold bedrock under the ice sheets; the base map carries the ice surface
        if (lat < -60 || (lat > 59.5 && lon > -74 && lon < -11 && !(lat < 67.5 && lon > -25.5))) hv = Math.max(hv, this.sampleBase(lat, lon));
        d[j * N + i] = hv;
      }
    }
    L.valid = true;
    L.complete = missing === 0;
    this.levelTex.image.data.set(d, l * N * N);
    this.levelTex.addLayerUpdate(l);
    this.levelTex.needsUpdate = true;
    this.winUniform[l].set(L.lonC, L.latC, L.size, L.texelM);
  }

  /**
   * Keep the clipmap centred under the camera.
   * @param lat, lon  sub-camera point (deg); @param alt camera altitude above ground (m)
   */
  update(lat, lon, alt, budgetMs = 6) {
    if (!this.base) return;
    const t0 = performance.now();
    for (let l = 0; l < DEM_LEVELS; l++) {
      const L = this.levels[l];
      const active = this.enabled && alt < 48 * L.texelM * 1.5;
      if (!active) {
        L.active = false;
        // deactivate this and all finer levels
        for (let k = l; k < DEM_LEVELS; k++) { this.levels[k].active = false; this.winUniform[k].w = 0; }
        break;
      }
      L.active = true;
      // snap the centre to a coarse grid so resampled texels line up between refreshes
      const snap = L.texelDeg * 32;
      const lonC = Math.round(lon / snap) * snap;
      const latC = Math.max(-90 + L.size / 2, Math.min(90 - L.size / 2, Math.round(lat / snap) * snap));
      const moved = Math.abs(wrap180(lonC - L.lonC)) > L.size * 0.2 || Math.abs(latC - L.latC) > L.size * 0.2;
      if (!L.valid || moved) { L.lonC = lonC; L.latC = latC; L.dirty = true; L.valid = false; }
      // request the tiles covering the window
      const [x0, y1] = this._mercTile(L.latC - L.size / 2, L.lonC - L.size / 2, L.zoom);
      const [x1, y0] = this._mercTile(L.latC + L.size / 2, L.lonC + L.size / 2, L.zoom);
      const n = 2 ** L.zoom;
      for (let ty = Math.floor(y0); ty <= Math.floor(y1); ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = Math.floor(x0); tx <= Math.floor(x1); tx++) this._request(L.zoom, ((tx % n) + n) % n, ty);
      }
      if (L.dirty && performance.now() - t0 < budgetMs) {
        L.dirty = false;
        this._resample(l);
        // finer levels fall back to this one, so refresh them too
        for (let k = l + 1; k < DEM_LEVELS; k++) if (this.levels[k].valid) this.levels[k].dirty = true;
      }
    }
    this._pump();
  }
}
