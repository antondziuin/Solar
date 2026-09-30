// Procedural, time-dependent cloud cover for the Earth: the CPU half.
//
// The cloud field (terrain.js, cloudCover) is fractal noise on the sphere, shaped by a seasonal
// climatology, carried by the zonal winds and slowly evolving. Pure advection by a sheared wind
// would stretch the pattern without limit, so two copies of it are advected over overlapping
// periods and cross-faded (the classic flow-map scheme): each copy lives PERIOD, is weighted by a
// triangle that peaks when its advection offset is zero, and is replaced by a fresh pattern
// (new seed) while its weight is zero. Cyclones are vortices that twist the field; their tracks
// are deterministic functions of time, so any date shows the same weather.
import * as THREE from 'three';

export const MAX_VORTEX = 16;
const PERIOD = 4 * 86400; // s
const DEG = Math.PI / 180;

/** deterministic hash -> [0, 1) */
function hash(a, b, c = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const unit = (lat, lon, out) => out.set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));

/**
 * Cyclone slots. Extratropical: born along the storm tracks (35-55 deg), drift east and poleward,
 * live ~5 days. Tropical: born over the warm oceans in their hemisphere's season, move west and
 * recurve poleward, ~8 days, compact with an eye.
 */
const SLOTS = [];
for (let i = 0; i < 12; i++) SLOTS.push({ kind: 'et', hemi: i % 2 ? -1 : 1, life: 5 + (i % 3) * 0.7, phase: i / 12 });
const BASINS = [ // |lat|, lon (deg), hemisphere: N Atlantic, W Pacific, E Pacific, S Indian Ocean
  [14, -45, 1], [15, 135, 1], [13, -105, 1], [13, 75, -1],
];
BASINS.forEach(([lat, lon, hemi], i) => SLOTS.push({ kind: 'tc', hemi, lat, lon, life: 8, phase: i / 4 + 0.13 }));

export class CloudWeather {
  constructor() {
    this.phase = new THREE.Vector4();
    this.seeds = [new THREE.Vector3(), new THREE.Vector3()];
    this.vortA = Array.from({ length: MAX_VORTEX }, () => new THREE.Vector4());
    this.vortB = Array.from({ length: MAX_VORTEX }, () => new THREE.Vector4());
    this.count = 0;
    this._c = new THREE.Vector3();
  }

  /**
   * @param ut      simulated time, days since J2000 (UT)
   * @param sinDecl sine of the Sun's declination (season)
   */
  update(ut, sinDecl) {
    const t = ut * 86400;
    // two advected copies of the pattern, half a period apart
    for (let j = 0; j < 2; j++) {
      const s = t / PERIOD + 0.5 * j;
      const cycle = Math.floor(s);
      const f = s - cycle;
      const age = (f - 0.5) * PERIOD; // advection time, zero when the weight peaks
      const seed = this.seeds[j];
      // a fresh pattern each cycle; the pattern also evolves slowly through the noise's 3rd axis
      seed.set(hash(cycle, j, 1) * 200 + 20, hash(cycle, j, 2) * 200 + 20, hash(cycle, j, 3) * 200 + 20 + (age / PERIOD) * 0.9);
      if (j === 0) { this.phase.x = age; this.phase.z = 1 - Math.abs(2 * f - 1); } else this.phase.y = age;
    }
    this.phase.w = sinDecl;

    // cyclones
    let n = 0;
    const days = ut;
    for (let i = 0; i < SLOTS.length && n < MAX_VORTEX; i++) {
      const sl = SLOTS[i];
      const s = days / sl.life + sl.phase;
      const cycle = Math.floor(s);
      const a = s - cycle; // 0..1 through its life
      const r1 = hash(i, cycle, 11), r2 = hash(i, cycle, 12), r3 = hash(i, cycle, 13), r4 = hash(i, cycle, 14);
      const env = Math.pow(Math.sin(Math.PI * a), 0.8);
      let lat, lon, radius, twist, boost, eye;
      if (sl.kind === 'et') {
        // stronger and more frequent in the winter hemisphere
        const winter = Math.max(0, -sl.hemi * sinDecl) / 0.4;
        if (r4 > 0.75 + 0.2 * winter) continue;
        lat = sl.hemi * (36 + 16 * r1 + 10 * a) * DEG;
        lon = (r2 * 360 + 11 * sl.life * a) * DEG;
        radius = (4.5 + 3 * r3) * DEG;
        twist = sl.hemi * (2.2 + 1.5 * r3) * env * (0.8 + 0.4 * winter);
        boost = 0.18 * env;
        eye = 0;
      } else {
        // tropical cyclones: in the hemisphere's season, which lags the Sun by ~2.5 months (the ocean
        // is warmest in late summer: peak around 10 September in the north), not every cycle
        const doy = (((ut + 0.5) % 365.25) + 365.25) % 365.25;
        const season = sl.hemi * Math.sin((2 * Math.PI * (doy - 162)) / 365.25);
        if (season < 0.3 || r4 > 0.3 + 0.5 * season) continue;
        const west = 5 * sl.life * a, pole = 1.5 * sl.life * a * a * 1.6;
        lat = sl.hemi * (sl.lat + 6 * (r1 - 0.5) + pole) * DEG;
        lon = (sl.lon + 20 * (r2 - 0.5) - west + 8 * a * a * sl.life) * DEG;
        radius = (3 + 2 * r3) * DEG;
        twist = sl.hemi * (4 + 2 * r3) * env;
        boost = 0.55 * env;
        eye = 0.08 * radius * env;
      }
      unit(lat, lon, this._c);
      this.vortA[n].set(this._c.x, this._c.y, this._c.z, twist);
      this.vortB[n].set(radius, boost, eye, 0);
      n++;
    }
    this.count = n;
  }

  /** copy the state into a material's uniforms */
  apply(U) {
    U.uCloudPhase.value.copy(this.phase);
    U.uCloudSeed.value[0].copy(this.seeds[0]);
    U.uCloudSeed.value[1].copy(this.seeds[1]);
    for (let i = 0; i < MAX_VORTEX; i++) { U.uVortexA.value[i].copy(this.vortA[i]); U.uVortexB.value[i].copy(this.vortB[i]); }
    U.uVortexCount.value = this.count;
  }
}
