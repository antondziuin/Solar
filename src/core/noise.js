// JavaScript mirror of src/render/glsl/noise.js (same lattice, same hashing), evaluated in
// double precision. Used for terrain collision and picking.

const mod289 = (x) => x - Math.floor(x * (1 / 289)) * 289;
const perm = (x) => mod289((x * 34 + 1) * x);

const out4 = new Float64Array(4);

/** Gradient noise with derivatives; returns [value, dx, dy, dz] (shared buffer). */
export function gnoised(x, y, z) {
  let ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  ix = mod289(ix); iy = mod289(iy); iz = mod289(iz);
  const ix1 = mod289(ix + 1), iy1 = mod289(iy + 1), iz1 = mod289(iz + 1);
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const duz = 30 * fz * fz * (fz * (fz - 2) + 1);
  const px0 = perm(ix), px1 = perm(ix1);
  const pxy = [perm(px0 + iy), perm(px1 + iy), perm(px0 + iy1), perm(px1 + iy1)];
  const s = 1 / 144;
  const g = new Array(8);
  const v = new Array(8);
  const cx = [fx, fx - 1, fx, fx - 1];
  const cy = [fy, fy, fy - 1, fy - 1];
  for (let zi = 0; zi < 2; zi++) {
    const izz = zi ? iz1 : iz;
    const cz = zi ? fz - 1 : fz;
    for (let c = 0; c < 4; c++) {
      const h = perm(pxy[c] + izz);
      const hy = perm(h + 7);
      const hz = perm(hy + 13);
      const gx = h * s - 1, gy = hy * s - 1, gz = hz * s - 1;
      g[zi * 4 + c] = [gx, gy, gz];
      v[zi * 4 + c] = gx * cx[c] + gy * cy[c] + gz * cz;
    }
  }
  const [va, vb, vc, vd, ve, vf, vg, vh] = v;
  const [ga, gb, gc, gd, ge, gf, gg, gh] = g;
  const k1 = vb - va, k2 = vc - va, k3 = ve - va;
  const k4 = va - vb - vc + vd, k5 = va - vc - ve + vg, k6 = va - vb - ve + vf;
  const k7 = -va + vb + vc - vd + ve - vf - vg + vh;
  out4[0] = va + k1 * ux + k2 * uy + k3 * uz + k4 * ux * uy + k5 * uy * uz + k6 * uz * ux + k7 * ux * uy * uz;
  const d = [k1 + k4 * uy + k6 * uz + k7 * uy * uz, k2 + k5 * uz + k4 * ux + k7 * uz * ux, k3 + k6 * ux + k5 * uy + k7 * ux * uy];
  const du = [dux, duy, duz];
  for (let i = 0; i < 3; i++) {
    out4[1 + i] = ga[i] + ux * (gb[i] - ga[i]) + uy * (gc[i] - ga[i]) + uz * (ge[i] - ga[i])
      + ux * uy * (ga[i] - gb[i] - gc[i] + gd[i]) + uy * uz * (ga[i] - gc[i] - ge[i] + gg[i])
      + uz * ux * (ga[i] - gb[i] - ge[i] + gf[i])
      + ux * uy * uz * (-ga[i] + gb[i] + gc[i] - gd[i] + ge[i] - gf[i] - gg[i] + gh[i])
      + du[i] * d[i];
  }
  return out4;
}

export function gnoise(x, y, z) {
  return gnoised(x, y, z)[0];
}

export function hash3(cx, cy, cz) {
  cx = mod289(cx); cy = mod289(cy); cz = mod289(cz);
  const h = perm(perm(perm(cx) + cy) + cz);
  const h2 = perm(h + 3);
  const h3 = perm(h2 + 5);
  return [h / 289, h2 / 289, h3 / 289];
}

export { mod289 };
