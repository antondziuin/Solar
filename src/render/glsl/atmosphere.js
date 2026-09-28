// Single-scattering atmosphere (Rayleigh + Mie + absorbing layer), planet-centred, units: km.
export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uAtmoRayleigh;  // Rayleigh scattering coefficient (1/km) at sea level
uniform vec3 uAtmoMie;       // Mie scattering (1/km)
uniform vec3 uAtmoMieExt;    // Mie extinction (1/km)
uniform vec3 uAtmoAbsorb;    // absorption (ozone / methane / haze) (1/km)
uniform vec4 uAtmoShape;     // x: ground radius, y: top radius, z: Hr, w: Hm  (km)
uniform vec4 uAtmoShape2;    // x: g, y: absorb centre (km, <0: exponential), z: absorb width, w: absorb scale height
uniform vec3 uAtmoScale;     // body-frame scaling that maps the oblate planet onto a sphere

// robust ray/sphere intersection for large |ro|
vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  vec3 q = ro - b * rd;
  float h = r * r - dot(q, q);
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

vec3 atmoDensity(float h) {
  float a = uAtmoShape2.y >= 0.0 ? max(0.0, 1.0 - abs(h - uAtmoShape2.y) / uAtmoShape2.z) : exp(-h / uAtmoShape2.w);
  return vec3(exp(-h / uAtmoShape.z), exp(-h / uAtmoShape.w), a);
}

vec3 atmoExtinction(vec3 od) {
  return uAtmoRayleigh * od.x + uAtmoMieExt * od.y + uAtmoAbsorb * od.z;
}

// optical depth from p towards the sun (L), large if the planet blocks the ray
vec3 atmoOpticalDepthToSun(vec3 p, vec3 L) {
  float r = length(p);
  float mu = dot(p, L) / r;
  // soft planet shadow: fade as the ray grazes the ground
  float horizon = -sqrt(max(0.0, 1.0 - (uAtmoShape.x * uAtmoShape.x) / (r * r)));
  vec2 t = raySphere(p, L, uAtmoShape.y);
  float len = max(t.y, 0.0);
  const int NL = 6;
  float ds = len / float(NL);
  vec3 od = vec3(0.0);
  for (int i = 0; i < NL; i++) {
    vec3 q = p + L * (ds * (float(i) + 0.5));
    od += atmoDensity(max(length(q) - uAtmoShape.x, 0.0)) * ds;
  }
  float shadow = smoothstep(horizon - 0.01, horizon + 0.01, mu);
  return od + (1.0 - shadow) * 1e6;
}

float phaseRayleigh(float c) { return 3.0 / (16.0 * 3.14159265) * (1.0 + c * c); }
float phaseMie(float c, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * 3.14159265) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// In-scattered radiance along ro + rd*t for t in [t0, t1]; also returns transmittance.
vec3 atmoScatter(vec3 ro, vec3 rd, float t0, float t1, vec3 L, out vec3 trans) {
  const int N = 14;
  float ds = (t1 - t0) / float(N);
  vec3 odView = vec3(0.0);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float t = t0 + ds * (float(i) + 0.5);
    vec3 p = ro + rd * t;
    float h = max(length(p) - uAtmoShape.x, 0.0);
    vec3 d = atmoDensity(h) * ds;
    odView += d;
    vec3 odSun = atmoOpticalDepthToSun(p, L);
    vec3 att = exp(-atmoExtinction(odView + odSun));
    sumR += d.x * att;
    sumM += d.y * att;
  }
  trans = exp(-atmoExtinction(odView));
  float c = dot(rd, L);
  // single scattering + a cheap isotropic estimate of higher orders
  vec3 sR = sumR * uAtmoRayleigh, sM = sumM * uAtmoMie;
  return sR * (phaseRayleigh(c) + 0.035) + sM * (phaseMie(c, uAtmoShape2.x) + 0.02);
}
`;
