// Real global data of planets and moons (see scripts/build_body_maps.py): elevation models
// (USGS: LOLA/Kaguya, MOLA, MESSENGER, New Horizons, Cassini, HRSC) and surface maps.
import * as THREE from 'three';

async function decode(url) {
  const blob = await fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); });
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}

/** Elevation model: GPU texture (RG float: height, coverage) + bilinear CPU sampler. */
export async function loadBodyDem(base, entry) {
  const img = await decode(base + entry.file);
  const { width: W, height: H, data: px } = img;
  const a = new Float32Array(W * H * 2);
  let min = Infinity, max = -Infinity;
  const k = entry.scale || 1; // metres per unit (large relief of small irregular moons)
  for (let i = 0; i < W * H; i++) {
    const valid = px[i * 4 + 2] > 127 ? 1 : 0;
    const h = valid ? (px[i * 4] * 256 + px[i * 4 + 1] - 32768) * k : 0;
    a[i * 2] = h;
    a[i * 2 + 1] = valid;
    if (valid) { if (h < min) min = h; if (h > max) max = h; }
  }
  const tex = new THREE.DataTexture(a, W, H, THREE.RGFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  const radius = entry.radius;
  return {
    tex, radius, min, max, W, H,
    texelM: (2 * Math.PI * radius) / W,
    /** [height, coverage] at latitude/longitude in degrees (mirrors bodyDemAt in GLSL) */
    sample(lat, lon) {
      const x = ((lon + 180) / 360) * W - 0.5, y = ((90 - lat) / 180) * H - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const X = (i) => ((i % W) + W) % W, Y = (j) => Math.min(H - 1, Math.max(0, j));
      let hs = 0, ws = 0;
      const acc = (i, j, w) => { const k = (Y(j) * W + X(i)) * 2; hs += a[k] * a[k + 1] * w; ws += a[k + 1] * w; };
      acc(x0, y0, (1 - fx) * (1 - fy)); acc(x0 + 1, y0, fx * (1 - fy)); acc(x0, y0 + 1, (1 - fx) * fy); acc(x0 + 1, y0 + 1, fx * fy);
      return [ws > 1e-4 ? hs / ws : 0, ws];
    },
  };
}

/** Surface colour map (sRGB), with its mean linear luminance over the covered area. */
export async function loadBodyMap(base, entry) {
  const tex = await new THREE.TextureLoader().loadAsync(base + entry.file);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  // mean luminance (on a small copy)
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(tex.image, 0, 0, 256, 128);
  const d = g.getImageData(0, 0, 256, 128).data;
  let s = 0, n = 0;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const all = [];
  let sat = 0;
  for (let i = 0; i < d.length; i += 4) {
    sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    const l = 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
    if (l > 0.0006) { s += l; n++; all.push(Math.max(lin(d[i]), lin(d[i + 1]), lin(d[i + 2]))); }
  }
  all.sort((x, y) => x - y);
  const p99 = all.length ? all[Math.floor(all.length * 0.99)] : 1;
  // single-band mosaics (stored as gray RGB) get the body's colours in the shader
  const gray = sat / (d.length / 4) < 1.5;
  return { tex, mean: n ? s / n : 0.5, p99, gray };
}
