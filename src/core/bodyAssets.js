// Real global data of planets and moons (see scripts/build_body_maps.py): elevation models
// (USGS: LOLA/Kaguya, MOLA, MESSENGER, New Horizons, Cassini, HRSC) and surface maps.
import * as THREE from 'three';
import { decodeAsset, absUrl } from '../workers/assetPool.js';
import { uploadProgressive } from '../render/Uploader.js';

/** Elevation model: GPU texture (RG float: height, coverage) + bilinear CPU sampler. */
export async function loadBodyDem(base, entry) {
  // fetch + decode + convert in a worker, then upload a slice per frame
  const { data: a, W, H, min, max } = await decodeAsset('dem', { url: absUrl(base + entry.file), scale: entry.scale || 1 });
  const tex = new THREE.DataTexture(a, W, H, THREE.RGFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  await uploadProgressive(tex);
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
  const { data, W, H, mean, p99, gray } = await decodeAsset('map', { url: absUrl(base + entry.file) });
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  await uploadProgressive(tex);
  // single-band mosaics (stored as gray RGB) get the body's colours in the shader
  return { tex, mean, p99, gray };
}
