// 3D gradient noise with analytic derivatives on a lattice that is periodic with period 289.
// Because the lattice is periodic, any input may be reduced modulo 289 without changing the
// result. The CPU exploits this: for octave k it uploads (cameraPosition * f_k) mod 289 in
// double precision, and the GPU only adds the (small, precise) camera-relative offset.
// This gives float-exact noise at arbitrarily high frequencies ("infinite" detail).
//
// The JS mirror lives in src/core/noise.js and must stay bit-compatible in structure.
export const NOISE_GLSL = /* glsl */ `
float mod289(float x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 perm(vec2 x) { return mod289((x * 34.0 + 1.0) * x); }
vec4 perm(vec4 x) { return mod289((x * 34.0 + 1.0) * x); }
float perm(float x) { return mod289((x * 34.0 + 1.0) * x); }

// returns vec4(value, d/dx, d/dy, d/dz); value roughly in [-1, 1]
vec4 gnoised(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  i = mod289(i);
  vec3 i1 = mod289(i + 1.0);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 px = perm(vec2(i.x, i1.x));
  vec4 pxy = perm(vec4(px.x + i.y, px.y + i.y, px.x + i1.y, px.y + i1.y));
  vec4 h0 = perm(pxy + i.z);
  vec4 h1 = perm(pxy + i1.z);
  vec4 hy0 = perm(h0 + 7.0), hy1 = perm(h1 + 7.0);
  vec4 hz0 = perm(hy0 + 13.0), hz1 = perm(hy1 + 13.0);
  const float s = 1.0 / 144.0;
  vec4 gx0 = h0 * s - 1.0, gy0 = hy0 * s - 1.0, gz0 = hz0 * s - 1.0;
  vec4 gx1 = h1 * s - 1.0, gy1 = hy1 * s - 1.0, gz1 = hz1 * s - 1.0;
  vec4 fx = vec4(f.x, f.x - 1.0, f.x, f.x - 1.0);
  vec4 fy = vec4(f.y, f.y, f.y - 1.0, f.y - 1.0);
  vec4 n0 = gx0 * fx + gy0 * fy + gz0 * f.z;
  vec4 n1 = gx1 * fx + gy1 * fy + gz1 * (f.z - 1.0);
  // corners: a=000 b=100 c=010 d=110 e=001 f=101 g=011 h=111
  float va = n0.x, vb = n0.y, vc = n0.z, vd = n0.w, ve = n1.x, vf = n1.y, vg = n1.z, vh = n1.w;
  vec3 ga = vec3(gx0.x, gy0.x, gz0.x), gb = vec3(gx0.y, gy0.y, gz0.y), gc = vec3(gx0.z, gy0.z, gz0.z), gd = vec3(gx0.w, gy0.w, gz0.w);
  vec3 ge = vec3(gx1.x, gy1.x, gz1.x), gf = vec3(gx1.y, gy1.y, gz1.y), gg = vec3(gx1.z, gy1.z, gz1.z), gh = vec3(gx1.w, gy1.w, gz1.w);
  float k0 = va, k1 = vb - va, k2 = vc - va, k3 = ve - va;
  float k4 = va - vb - vc + vd, k5 = va - vc - ve + vg, k6 = va - vb - ve + vf;
  float k7 = -va + vb + vc - vd + ve - vf - vg + vh;
  float v = k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  vec3 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga)
    + u.x * u.y * (ga - gb - gc + gd) + u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf)
    + u.x * u.y * u.z * (-ga + gb + gc - gd + ge - gf - gg + gh)
    + du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
                k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
                k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4(v, g);
}

float gnoise(vec3 x) { return gnoised(x).x; }

// three pseudo-random numbers in [0,1) for an integer lattice cell
vec3 hash3(vec3 c) {
  c = mod289(c);
  float h = perm(perm(perm(c.x) + c.y) + c.z);
  float h2 = perm(h + 3.0);
  float h3 = perm(h2 + 5.0);
  return vec3(h, h2, h3) * (1.0 / 289.0);
}

// Cheap 3D value noise (for fine colour detail where derivatives are not needed)
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  i = mod289(i); vec3 i1 = mod289(i + 1.0);
  vec2 px = perm(vec2(i.x, i1.x));
  vec4 pxy = perm(vec4(px.x + i.y, px.y + i.y, px.x + i1.y, px.y + i1.y));
  vec4 a = perm(pxy + i.z) * (1.0 / 289.0);
  vec4 b = perm(pxy + i1.z) * (1.0 / 289.0);
  vec4 m = mix(a, b, f.z);
  vec2 n = mix(m.xz, m.yw, f.x);
  return mix(n.x, n.y, f.y) * 2.0 - 1.0;
}

float fbm3(vec3 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 8; k++) { if (k >= oct) break; s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
`;
