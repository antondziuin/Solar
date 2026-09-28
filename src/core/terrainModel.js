// CPU-side description of a body's surface: shader parameters and a double-precision
// mirror of the GPU height function (src/render/glsl/terrain.js) for collision/picking.
import { Vector4 } from 'three';
import { DEG, KM } from './constants.js';
import { gnoise, gnoised, hash3 } from './noise.js';
import { MAX_FEATURES } from '../render/glsl/terrain.js';

export const ROCK_SPECIAL = { earth: 1, moon: 2, mars: 3, io: 4, europa: 5, ganymede: 6, enceladus: 7, dione: 8, titan: 9, iapetus: 10, miranda: 11, triton: 12, pluto: 13, charon: 14 };
export const GAS_SPECIAL = { jupiter: 1, saturn: 2, uranus: 3, neptune: 4 };
const FEATURE_TYPE = { volcano: 1, dome: 2, basin: 3, crater: 4, trough: 5, ridge: 6, dichotomy: 7 };

function latLonDir(lat, lon) {
  const la = lat * DEG, lo = lon * DEG;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

/** Bilinear sampler over an ImageData channel with repeat-x / clamp-y (like textureLod on an equirect map). */
export class EquirectSampler {
  constructor(imageData, channel = 0) {
    this.w = imageData.width; this.h = imageData.height;
    this.data = imageData.data; this.c = channel;
  }
  sample(u, v) {
    // three.js flipY: v = 1 is the top row of the image
    const x = u * this.w - 0.5, y = (1 - v) * this.h - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const W = this.w, H = this.h, d = this.data, c = this.c;
    const px = (xx) => ((xx % W) + W) % W;
    const py = (yy) => Math.min(H - 1, Math.max(0, yy));
    const at = (xx, yy) => d[(py(yy) * W + px(xx)) * 4 + c] / 255;
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  }
}

const dirToUV = (x, y, z) => [Math.atan2(y, x) * (0.5 / Math.PI) + 0.5, Math.asin(Math.max(-1, Math.min(1, z))) / Math.PI + 0.5];
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class TerrainModel {
  constructor(body) {
    const s = body.surface;
    this.body = body;
    this.kind = s.kind;
    const R = (body.radius + (body.renderRadiusOffset || 0)) * KM;
    if (body.shape) this.radii = body.shape.map((v) => v * KM);
    else this.radii = [R, R, (body.polarRadius ? body.polarRadius + (body.renderRadiusOffset || 0) : body.radius + (body.renderRadiusOffset || 0)) * KM];
    this.R = Math.max(...this.radii);
    this.lambda0 = this.R;
    this.special = s.kind === 'gas' ? (GAS_SPECIAL[s.special] || 0) : (ROCK_SPECIAL[s.special] || 0);
    this.amp = s.amp || 0;
    this.hurst = s.hurst ?? 0.85;
    this.lamTop = s.lamTop || (s.special === 'earth' ? 60e3 : s.special === 'moon' ? 300e3 : this.R * 0.3);
    this.ridge = s.ridge || 0;
    this.lumpy = s.lumpy || 0;
    const g = (body.GM * 1e9) / (body.radius * KM) ** 2;
    const crater = s.crater || 0;
    this.craterStrength = Math.min(crater, 1.3);
    this.craterDensity = clamp(0.3 + 0.3 * crater, 0, 0.75);
    this.craterRc = 9000 * (1.62 / g);
    this.craterK0 = crater > 0 ? Math.max(0, Math.ceil(Math.log2(this.lambda0 / (s.craterStart || this.R * 0.2)))) : 99;
    const seed = s.seed || 0;
    this.seedVec = [(seed * 37.13) % 289, (seed * 71.97) % 289, (seed * 13.37) % 289];
    this.noiseStretch = s.kind === 'gas' ? [1, 1, 4] : [1, 1, 1];

    // landmarks
    this.features = [];
    for (const f of s.features || []) {
      const type = FEATURE_TYPE[f.type];
      const A = new Vector4(), B = new Vector4(), C = new Vector4();
      if (type === 7) {
        A.set(0, 0, 1, type); B.set(0, f.depth * 1000, 0, 0);
      } else if (type === 6) {
        A.set(0, 0, 1, type); B.set((f.width * KM) / this.R, f.height * 1000, 0, 0);
      } else {
        const d = latLonDir(f.lat, f.lon);
        A.set(d[0], d[1], d[2], type);
        const mag = (f.height ?? f.depth) * 1000;
        B.set((f.radius * KM) / this.R, mag, 0, 0);
        if (type === 5) { const d2 = latLonDir(f.lat2, f.lon2); C.set(d2[0], d2[1], d2[2], 0); }
        else C.set(f.peak ? 1 : 0, 0, 0, f.rings ? 1 : 0);
      }
      this.features.push({ A, B, C, type });
    }
    this.features = this.features.slice(0, MAX_FEATURES);
    this.samplers = {};

    // conservative relief bound (m) for culling and skirts
    let relief = 0;
    let lam = this.lambda0;
    for (let k = 0; k < 40; k++) { relief += this._octaveAmp(lam) * 1.9 * 1.2; lam *= 0.5; }
    if (crater > 0) relief += 0.12 * (s.craterStart || this.R * 0.2) * this.craterStrength;
    for (const f of this.features) relief += Math.abs(f.B.y);
    if (this.special === 1) relief += 6500;
    if (this.special === 2) relief += 1500;
    this.maxRelief = s.kind === 'rock' ? relief : 0;
  }

  _octaveAmp(lam, lamTop = this.lamTop) {
    const a = (this.amp * Math.pow(lam / 1e4, this.hurst)) / (1 + Math.pow(lam / lamTop, this.hurst + 1));
    return Math.max(a, this.lumpy * lam * 0.35);
  }

  _featureHeight(x, y, z) {
    let h = 0;
    for (const f of this.features) {
      const { A, B, C, type } = f;
      if (type === 7) {
        const s = z + 0.12 * gnoise(x * 2.5 + 7, y * 2.5 + 7, z * 2.5 + 7) + 0.05 * gnoise(x * 7 + 3, y * 7 + 3, z * 7 + 3);
        h -= B.y * smoothstep(-0.15, 0.35, s);
        continue;
      }
      if (type === 6) {
        const lat = Math.asin(clamp(z, -1, 1));
        const lon = Math.atan2(y, x);
        const segs = 0.6 + 0.4 * gnoise(lon * 3, 1, 2);
        h += B.y * Math.exp(-(lat * lat) / (B.x * B.x)) * segs * smoothstep(-0.2, 0.5, -Math.sin(lon));
        continue;
      }
      if (type === 5) {
        let nx = A.y * C.z - A.z * C.y, ny = A.z * C.x - A.x * C.z, nz = A.x * C.y - A.y * C.x;
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        const dn = x * nx + y * ny + z * nz;
        const dperp = Math.asin(clamp(dn, -1, 1));
        let px = x - nx * dn, py = y - ny * dn, pz = z - nz * dn;
        const pl = Math.hypot(px, py, pz); px /= pl; py /= pl; pz /= pl;
        const cx = A.y * pz - A.z * py, cy = A.z * px - A.x * pz, cz = A.x * py - A.y * px;
        const ang = Math.atan2(cx * nx + cy * ny + cz * nz, A.x * px + A.y * py + A.z * pz);
        const arc = Math.acos(clamp(A.x * C.x + A.y * C.y + A.z * C.z, -1, 1));
        const along = ang < 0 ? -ang : Math.max(ang - arc, 0);
        const wob = 1 + 0.35 * gnoise(x * 40, y * 40, z * 40);
        const r = Math.hypot(dperp, along) / (B.x * wob);
        h -= B.y * (1 - smoothstep(0.35, 1, r));
        continue;
      }
      const r = Math.hypot(x - A.x, y - A.y, z - A.z) / B.x;
      if (r > 3) continue;
      if (type === 1) {
        h += B.y * (Math.pow(Math.max(0, 1 - r), 1.5) * (1 - 0.18 * smoothstep(0.09, 0, r)) + 0.02 * Math.exp(-r * r));
      } else if (type === 2) {
        h += B.y * Math.exp(-r * r * 2.2);
      } else {
        let bowl = type === 3 ? -(1 - smoothstep(0, 1, r)) : Math.max(Math.min(r * r - 1, 0), -0.85);
        const e = (r - 1) / 0.16;
        let rim = 0.2 * Math.exp(-e * e);
        if (C.w > 0.5 && r >= 1) rim += 0.08 * Math.sin(r * 12) * Math.exp(-Math.max(r - 1, 0) * 1.5);
        if (C.x > 0.5) bowl += 0.35 * Math.exp(-r * r * 40);
        h += B.y * (bowl + rim);
      }
    }
    return h;
  }

  _baseHeight(x, y, z, need = 1) {
    let h = this._featureHeight(x, y, z);
    this._res = 9800;
    if (this.special === 1 && this.dem) {
      const lat = Math.asin(clamp(z, -1, 1)) / DEG, lon = Math.atan2(y, x) / DEG;
      h += this.dem.height(lat, lon, need);
      this._res = this.dem.lastRes;
    }
    if (this.special === 2 && this.samplers.albedo) {
      const [u, v] = dirToUV(x, y, z);
      h += (this.samplers.albedo.sample(u, v) - 0.5) * 2600;
    }
    return h;
  }

  _regionAmp(x, y, z, lowOct) {
    let m = clamp(1 + 0.8 * lowOct, 0.25, 1.9);
    if (this.special === 1 && this.dem) {
      const e = Math.max(this.dem.sampleBase(Math.asin(clamp(z, -1, 1)) / DEG, Math.atan2(y, x) / DEG), 0);
      m *= Math.min(0.25 + 1.3 * Math.pow(e / 4000, 0.8), 1.6);
    }
    if (this.special === 2 && this.samplers.albedo) {
      const [u, v] = dirToUV(x, y, z);
      m *= 0.6 + 0.8 * this.samplers.albedo.sample(u, v);
    }
    return m;
  }

  _crater(x, y, z, lam, acc) {
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    const r = hash3(cx, cy, cz);
    if (r[0] > this.craterDensity) return;
    const r2 = hash3(cx + 101, cy + 101, cz + 101);
    const rad = 0.045 + 0.085 * r[1] * r[1];
    const qx = x - (cx + 0.25 + 0.5 * r2[0]), qy = y - (cy + 0.25 + 0.5 * r2[1]), qz = z - (cz + 0.25 + 0.5 * r2[2]);
    const t = Math.hypot(qx, qy, qz) / rad;
    if (t > 1.9) return;
    const rm = rad * lam;
    const depthRatio = 0.42 * Math.min(1, Math.pow(this.craterRc / rm, 0.55));
    const fresh = 1 - r[2];
    const depth = rm * depthRatio * this.craterStrength * (0.2 + 0.8 * fresh * fresh);
    const floorLvl = -1 + 0.55 * smoothstep(0.5, 3, rm / this.craterRc);
    let bowl = t * t - 1;
    if (bowl < floorLvl) bowl = floorLvl;
    if (t > 1) bowl = 0;
    const e = (t - 1) / 0.28;
    const rim = (0.16 + 0.1 * fresh) * Math.exp(-e * e);
    const big = smoothstep(1, 3, rm / this.craterRc);
    const pk = big * 0.35 * Math.exp(-t * t * 40);
    const win = 1 - smoothstep(1.45, 1.9, t);
    acc.h += depth * (bowl + rim + pk) * win;
  }

  /**
   * Terrain height (m) above the reference ellipsoid at unit direction (x,y,z), including
   * octaves down to `minLam` metres. For Earth this is the raw elevation (negative = sea floor).
   */
  height(x, y, z, minLam = 1) {
    if (this.kind !== 'rock') return 0;
    const [a, b, c] = this.radii;
    const Px = a * x, Py = b * y, Pz = c * z;
    const acc = { h: this._baseHeight(x, y, z, minLam * 0.25) };
    const lamTop = this.special === 1 ? 2 * this._res : this.lamTop;
    let lam = this.lambda0;
    const sv = this.seedVec;
    const lowOct = gnoise(Px / (this.lambda0 * 0.125) + sv[0] + 50, Py / (this.lambda0 * 0.125) + sv[1] + 50, Pz / (this.lambda0 * 0.125) + sv[2] + 50);
    const baseMod = this._regionAmp(x, y, z, 0);
    const modAmp = this._regionAmp(x, y, z, lowOct);
    for (let k = 0; k < 44; k++) {
      const w = clamp(Math.log2(lam / minLam), 0, 1);
      if (w <= 0) break;
      const nx = Px / lam + sv[0], ny = Py / lam + sv[1], nz = Pz / lam + sv[2];
      const A = this._octaveAmp(lam, lamTop) * (k >= 3 ? modAmp : 0.6 * baseMod);
      const n = gnoised(nx, ny, nz);
      const rv = 1 - Math.abs(n[0]);
      acc.h += w * A * ((1 - this.ridge) * n[0] + this.ridge * (rv * rv - 0.45));
      if (k >= this.craterK0 && this.craterStrength > 0) {
        const before = acc.h;
        this._crater(nx + 31, ny + 57, nz + 11, lam, acc);
        acc.h = before + (acc.h - before) * w;
      }
      lam *= 0.5;
    }
    return acc.h;
  }

  /** Surface height used for collision (sea level clamps for Earth). */
  groundHeight(x, y, z, minLam) {
    const h = this.height(x, y, z, minLam);
    if (this.special === 1 && h < 0 && this.samplers.water) {
      const [u, v] = dirToUV(x, y, z);
      if (this.samplers.water.sample(u, v) > 0.5 || h < -25) return 0;
    }
    return h;
  }

  /** Per-octave camera offsets (camera * f_k + seed) mod 289, packed for the uniform array. */
  camOffsets(camPF, count, out) {
    const st = this.noiseStretch;
    let f = 1 / this.lambda0;
    const sv = this.seedVec;
    for (let k = 0; k < count; k++) {
      const vx = st[0] * camPF.x * f + sv[0], vy = st[1] * camPF.y * f + sv[1], vz = st[2] * camPF.z * f + sv[2];
      out[k].set(((vx % 289) + 289) % 289, ((vy % 289) + 289) % 289, ((vz % 289) + 289) % 289);
      f *= 2;
    }
  }
}
