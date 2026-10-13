// Tileable 3D cloud noise for the explosion clouds, computed once in a worker.
//  r: Perlin-Worley (billowy, cauliflower-like puffs)   g: Worley fbm (medium)
//  b: Worley fbm (fine)                                 a: Perlin fbm

function hash(x, y, z, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** periodic gradient noise with period P cells: gradient table, value ~[-1, 1] */
function makePerlin(P, seed) {
  const g = new Float32Array(P * P * P * 3);
  for (let i = 0; i < P * P * P; i++) {
    const th = hash(i, P, 3, seed) * Math.PI * 2, z = 2 * hash(i, P, 7, seed) - 1, r = Math.sqrt(1 - z * z);
    g[i * 3] = r * Math.cos(th); g[i * 3 + 1] = r * Math.sin(th); g[i * 3 + 2] = z;
  }
  return (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    let res = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const k = ((((iz + dz) % P) * P + ((iy + dy) % P)) * P + ((ix + dx) % P)) * 3;
      const d = g[k] * (fx - dx) + g[k + 1] * (fy - dy) + g[k + 2] * (fz - dz);
      res += d * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    }
    return res * 1.6;
  };
}

/** periodic Worley noise with period P cells: 1 - distance to the nearest feature point */
function makeWorley(P, seed) {
  const f = new Float32Array(P * P * P * 3);
  for (let i = 0; i < P * P * P; i++) for (let c = 0; c < 3; c++) f[i * 3 + c] = hash(i, c, P, seed);
  return (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let best = 9;
    for (let k = -1; k <= 1; k++) {
      const cz = iz + k, hz = (cz + P) % P;
      for (let j = -1; j <= 1; j++) {
        const cy = iy + j, hy = (cy + P) % P;
        for (let i = -1; i <= 1; i++) {
          const cx = ix + i, n = ((hz * P + hy) * P + (cx + P) % P) * 3;
          const ddx = cx + f[n] - x, ddy = cy + f[n + 1] - y, ddz = cz + f[n + 2] - z;
          const d = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d < best) best = d;
        }
      }
    }
    return Math.max(0, 1 - Math.sqrt(best));
  };
}

function worleyFbm(f, s) {
  const a = makeWorley(f, s), b = makeWorley(f * 2, s + 1), c = makeWorley(f * 4, s + 2);
  return (x, y, z) => 0.625 * a(x * f, y * f, z * f) + 0.25 * b(x * f * 2, y * f * 2, z * f * 2) + 0.125 * c(x * f * 4, y * f * 4, z * f * 4);
}
function perlinFbm(f, s) {
  const oct = [0, 1, 2, 3].map((o) => makePerlin(f << o, s + o));
  return (x, y, z) => {
    let a = 1, sum = 0, norm = 0, ff = f;
    for (let o = 0; o < 4; o++) { sum += a * oct[o](x * ff, y * ff, z * ff); norm += a; a *= 0.5; ff *= 2; }
    return sum / norm;
  };
}

/** RGBA8 voxels, N^3 */
export function computeBlastNoise(N = 64) {
  const data = new Uint8Array(N * N * N * 4);
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const p4 = perlinFbm(4, 1), w4 = worleyFbm(4, 11), w8 = worleyFbm(8, 23), w16 = worleyFbm(16, 37), p8 = perlinFbm(8, 51);
  let o = 0;
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = i / N, y = j / N, z = k / N;
    const p = p4(x, y, z) * 0.5 + 0.5;
    const wf = w4(x, y, z);
    data[o++] = cl(0.6 * p + 0.75 * wf - 0.3);
    data[o++] = cl(w8(x, y, z));
    data[o++] = cl(w16(x, y, z));
    data[o++] = cl(p8(x, y, z) * 0.5 + 0.5);
  }
  return data;
}
