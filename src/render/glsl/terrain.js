// Shaders for all spherical bodies. One quadtree chunk = one instance of a (N+1)^2 grid.
// Everything is computed relative to the camera in the body-fixed frame, so there is no
// loss of precision at any distance or zoom level.
import { NOISE_GLSL } from './noise.js';
import { ATMOSPHERE_GLSL } from './atmosphere.js';
import { ECLIPSE_GLSL } from './eclipse.js';

export const MAX_OCTAVES = 44;
export const MAX_FEATURES = 12;
export const MAX_OCCLUDERS = 4;

const COMMON = /* glsl */ `
#include <common>
#define MAX_OCT ${MAX_OCTAVES}
#define MAX_FEAT ${MAX_FEATURES}
#define MAX_OCC ${MAX_OCCLUDERS}

uniform vec3 uRadii;          // body-fixed ellipsoid radii (m)
uniform float uLambda0;       // wavelength of octave 0 (m)
uniform vec3 uCamOff[MAX_OCT];// (camera * f_k + seed) mod 289, per octave
uniform vec3 uNoiseStretch;   // anisotropic noise scaling (gas giants)
uniform float uVertexCut;     // octave fades out of the geometry below D * uVertexCut
uniform float uGroundH;       // terrain height below the camera (m)
uniform float uPixelCut;      // octave fades out of shading below D * uPixelCut
uniform vec3 uCamPF;          // camera position in the body frame (m) - low precision use only
uniform int uSpecial;
uniform float uTime;

// terrain
uniform float uAmp, uHurst, uLamTop, uRidge, uLumpy, uMicro;
uniform float uCraterStrength, uCraterDensity, uCraterRc;
uniform int uCraterK0;
uniform float uBoulders;          // fraction of lattice cells holding a boulder (rubble piles)
uniform int uBoulderK0;
uniform vec4 uFeatA[MAX_FEAT];
uniform vec4 uFeatB[MAX_FEAT];
uniform vec4 uFeatC[MAX_FEAT];
uniform int uFeatCount;
uniform sampler2D uTexA;      // earth: water mask | moon: albedo
uniform sampler2D uTexB;      // earth: topography
uniform sampler2D uTexC;      // earth: day colour
uniform sampler2D uTexD;      // earth: night lights
uniform sampler2D uTexE;      // earth: clouds
// real global data of other bodies (USGS / NASA), loaded on demand
uniform highp sampler2D uBodyDem; // RG float: height (m, rel. reference sphere), valid (0/1)
uniform float uHasDem;
uniform float uDemTexelM;         // DEM texel size at the equator (m)
uniform sampler2D uBodyMap;       // surface colour map (sRGB); black = no data
uniform float uHasMap;
uniform float uMapGain;           // scales the map to the body's measured albedo
uniform vec2 uMapGray;            // grayscale map: (tint strength, mean luminance of the map)
uniform vec3 uSeedVec;

${NOISE_GLSL}

vec2 dirToUV(vec3 d) {
  return vec2(atan(d.y, d.x) * (0.5 / PI) + 0.5, asin(clamp(d.z, -1.0, 1.0)) / PI + 0.5);
}

// Map lookup: when magnified, a cubic B-spline (4 bilinear taps) hides the texel grid and
// the JPEG block pattern that plain bilinear filtering would show as a regular tiling.
vec3 sampleSmooth(sampler2D t, vec2 uv, float lod) {
  if (lod > 0.75) return textureLod(t, uv, lod).rgb;
  vec2 sz = vec2(textureSize(t, 0));
  vec2 p = uv * sz - 0.5, f = fract(p), i = p - f;
  vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f * f - 3.0 * f * f * f) / 6.0;
  vec2 w3 = f * f * f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / sz, h1 = (i + 1.5 + w3 / g1) / sz;
  vec3 c = g0.y * (g0.x * textureLod(t, vec2(h0.x, h0.y), 0.0).rgb + g1.x * textureLod(t, vec2(h1.x, h0.y), 0.0).rgb)
         + g1.y * (g0.x * textureLod(t, vec2(h0.x, h1.y), 0.0).rgb + g1.x * textureLod(t, vec2(h1.x, h1.y), 0.0).rgb);
  return mix(c, textureLod(t, uv, max(lod, 0.0)).rgb, smoothstep(0.25, 0.75, lod));
}
vec3 sampleMap(vec2 uv, float lod) { return sampleSmooth(uBodyMap, uv, lod); }

// fractal detail is tapered above gLamTop (where real elevation data takes over)
float gLamTop = 1.0;
// sampling footprint (m) of the height function at the current vertex
float gNeed = 1.0;

float octaveAmp(float lam) {
  float a = uAmp * pow(lam / 1.0e4, uHurst) / (1.0 + pow(lam / gLamTop, uHurst + 1.0));
  // self-similar micro-roughness (regolith, scree): constant RMS slope at small scales
  return max(max(a, uLumpy * lam * 0.35), uMicro * lam / (1.0 + lam * lam / 40000.0));
}

// Self-similar craters: at most one crater per lattice cell per octave.
void crater(vec3 x, float lam, float w, inout float h, inout vec3 g, inout float alb) {
  vec3 c = floor(x);
  vec3 r = hash3(c);
  if (r.x > uCraterDensity) return;
  vec3 r2 = hash3(c + 101.0);
  vec3 center = c + 0.35 + 0.3 * r2;
  float rad = 0.05 + 0.13 * r.y * r.y;
  vec3 q = x - center;
  float d = length(q);
  float t = d / rad;
  if (t > 1.9) return;
  float rm = rad * lam;
  float depthRatio = 0.42 * min(1.0, pow(uCraterRc / rm, 0.55));
  float fresh = 1.0 - r.z;
  float depth = rm * depthRatio * uCraterStrength * (0.2 + 0.8 * fresh * fresh);
  float floorLvl = -1.0 + 0.55 * smoothstep(0.5, 3.0, rm / uCraterRc);
  float bowl = t * t - 1.0, dbowl = 2.0 * t;
  if (bowl < floorLvl) { bowl = floorLvl; dbowl = 0.0; }
  if (t > 1.0) { bowl = 0.0; dbowl = 0.0; }
  float e = (t - 1.0) / 0.28;
  float rim = (0.16 + 0.1 * fresh) * exp(-e * e);
  float drim = rim * (-2.0 * e / 0.28);
  // central peak for large (complex) craters
  float big = smoothstep(1.0, 3.0, rm / uCraterRc);
  float pk = big * 0.35 * exp(-t * t * 40.0);
  float dpk = pk * (-80.0 * t);
  float win = 1.0 - smoothstep(1.45, 1.9, t);
  float prof = (bowl + rim + pk) * win;
  float dprof = (dbowl + drim + dpk) * win;
  h += w * depth * prof;
  g += w * depth * dprof * (q / max(d, 1e-7)) / (rad * lam);
  alb += w * fresh * fresh * fresh * 0.45 * exp(-t * t * 0.9) * (0.4 + 0.6 * smoothstep(0.7, 1.0, t));
}

// Self-similar boulders (rubble-pile asteroids): at most one per lattice cell per octave, a
// flattened, irregular dome whose footprint is the intersection of the surface with a ball.
void boulder(vec3 x, float lam, float w, inout float h, inout vec3 g, inout float alb) {
  vec3 c = floor(x);
  vec3 r = hash3(c + 211.0);
  if (r.x > uBoulders) return;
  vec3 r2 = hash3(c + 307.0);
  vec3 r3 = hash3(c + 401.0) - 0.5;
  vec3 q = x - (c + 0.3 + 0.4 * r2);
  float d = length(q);
  vec3 qn = q / max(d, 1e-7);
  float rad0 = 0.06 + 0.2 * r.y * r.y;
  if (d > rad0 * 1.8) return;
  // angular outline: elongation plus a noise-modulated rim
  float rad = rad0 * (1.0 + 0.45 * dot(qn, r3) + 0.3 * gnoise(qn * 1.9 + r2 * 40.0));
  float t = d / rad;
  if (t >= 1.0) return;
  // flat-topped, steep-sided block
  float H = rad * lam * (0.4 + 0.35 * r.z);
  float t25 = pow(t, 2.5);
  float s = sqrt(max(1.0 - t25, 0.0));
  h += w * H * s;
  g += w * H * (-1.25 * t25 / max(t, 1e-4) / max(s, 0.2)) * qn / (rad * lam);
  alb += w * (r.z - 0.5) * 0.25;
}

// One octave of terrain.
void terrainOctave(int k, vec3 x, float lam, float w, float modAmp, inout float h, inout vec3 g, inout float alb) {
  float A = octaveAmp(lam) * modAmp;
  vec4 n = gnoised(x);
  float rv = 1.0 - abs(n.x);
  vec3 rg = -sign(n.x) * n.yzw;
  float val = mix(n.x, rv * rv - 0.45, uRidge);
  vec3 grd = mix(n.yzw, 2.0 * rv * rg, uRidge);
  h += w * A * val;
  g += w * A * grd / lam;
  alb += w * 0.06 * n.x;
  if (k >= uCraterK0 && uCraterStrength > 0.0) {
    crater(x + vec3(31.0, 57.0, 11.0), lam, w, h, g, alb);
    crater(x + vec3(113.5, 7.5, 71.5), lam, w, h, g, alb); // second, offset lattice
  }
  if (uBoulders > 0.0 && k >= uBoulderK0) {
    boulder(x + vec3(71.0, 13.0, 5.0), lam, w, h, g, alb);
    boulder(x + vec3(17.5, 93.5, 41.5), lam, w, h, g, alb);
  }
}

// Large-scale, deterministic relief (textures and named landmarks). dir: unit vector, body frame.
float featureHeight(vec3 dir) {
  float h = 0.0;
  for (int i = 0; i < MAX_FEAT; i++) {
    if (i >= uFeatCount) break;
    vec4 A = uFeatA[i], B = uFeatB[i], C = uFeatC[i];
    int type = int(A.w + 0.5);
    if (type == 7) { // hemispheric dichotomy (Mars)
      float s = dir.z + 0.12 * gnoise(dir * 2.5 + 7.0) + 0.05 * gnoise(dir * 7.0 + 3.0);
      h -= B.y * smoothstep(-0.15, 0.35, s);
      continue;
    }
    if (type == 6) { // equatorial ridge (Iapetus)
      float lat = asin(clamp(dir.z, -1.0, 1.0));
      float lon = atan(dir.y, dir.x);
      float segs = 0.6 + 0.4 * gnoise(vec3(lon * 3.0, 1.0, 2.0));
      h += B.y * exp(-lat * lat / (B.x * B.x)) * segs * smoothstep(-0.2, 0.5, -sin(lon));
      continue;
    }
    float r;
    if (type == 5) { // trough along a great-circle arc
      vec3 n = normalize(cross(A.xyz, C.xyz));
      float dperp = asin(clamp(dot(dir, n), -1.0, 1.0));
      vec3 pp = normalize(dir - n * dot(dir, n));
      float ang = atan(dot(cross(A.xyz, pp), n), dot(A.xyz, pp));
      float arc = acos(clamp(dot(A.xyz, C.xyz), -1.0, 1.0));
      float along = ang < 0.0 ? -ang : max(ang - arc, 0.0);
      float wob = 1.0 + 0.35 * gnoise(dir * 40.0);
      r = sqrt(dperp * dperp + along * along) / (B.x * wob);
      h -= B.y * (1.0 - smoothstep(0.35, 1.0, r));
      continue;
    }
    r = length(dir - A.xyz) / B.x;
    if (r > 3.0) continue;
    if (type == 1) { // shield volcano with caldera
      h += B.y * (pow(max(0.0, 1.0 - r), 1.5) * (1.0 - 0.18 * smoothstep(0.09, 0.0, r)) + 0.02 * exp(-r * r));
    } else if (type == 2) { // broad dome
      h += B.y * exp(-r * r * 2.2);
    } else { // basin (3) / crater (4)
      float bowl = type == 3 ? -(1.0 - smoothstep(0.0, 1.0, r)) : max(min(r * r - 1.0, 0.0), -0.85);
      float e = (r - 1.0) / 0.16;
      float rim = 0.2 * exp(-e * e);
      if (C.w > 0.5) rim += 0.08 * sin(r * 12.0) * exp(-max(r - 1.0, 0.0) * 1.5) * step(1.0, r); // rings
      if (C.x > 0.5) bowl += 0.35 * exp(-r * r * 40.0); // central peak
      h += B.y * (bowl + rim);
    }
  }
  return h;
}

float gH0 = 0.0; // height from the elevation data alone (no fractal)
#ifdef EARTH
// ---- real elevation: global base map + camera-centred clipmap of streamed tiles
uniform highp sampler2D uDemBase;
uniform highp sampler2DArray uDemLevels;
uniform vec4 uDemWin[8];     // centre lon, centre lat, size (deg), texel size (m); w = 0: inactive

float demBaseAt(vec2 ll) {
  ivec2 sz = textureSize(uDemBase, 0);
  float x = (ll.y + 180.0) / 360.0 * float(sz.x) - 0.5;
  float y = (90.0 - ll.x) / 180.0 * float(sz.y) - 0.5;
  int x0 = int(floor(x)), y0 = int(floor(y));
  float fx = x - float(x0), fy = y - float(y0);
  int x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0) x0 += sz.x; if (x1 >= sz.x) x1 -= sz.x;
  y0 = clamp(y0, 0, sz.y - 1); y1 = clamp(y1, 0, sz.y - 1);
  float a = texelFetch(uDemBase, ivec2(x0, y0), 0).r, b = texelFetch(uDemBase, ivec2(x1, y0), 0).r;
  float c = texelFetch(uDemBase, ivec2(x0, y1), 0).r, d = texelFetch(uDemBase, ivec2(x1, y1), 0).r;
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}

// cubic B-spline over the base map (16 taps): a smooth field whose contours do not show the
// ~10 km texel grid (used for the colour of shallow water)
float demBaseSmooth(vec2 ll) {
  ivec2 sz = textureSize(uDemBase, 0);
  float x = (ll.y + 180.0) / 360.0 * float(sz.x) - 0.5;
  float y = (90.0 - ll.x) / 180.0 * float(sz.y) - 0.5;
  int x0 = int(floor(x)), y0 = int(floor(y));
  vec2 f = vec2(x - float(x0), y - float(y0));
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
  float h = 0.0;
  for (int j = 0; j < 4; j++) {
    int yy = clamp(y0 - 1 + j, 0, sz.y - 1);
    float wy = j == 0 ? w0.y : j == 1 ? w1.y : j == 2 ? w2.y : w3.y;
    for (int i = 0; i < 4; i++) {
      int xx = x0 - 1 + i;
      xx = xx < 0 ? xx + sz.x : xx >= sz.x ? xx - sz.x : xx;
      float wx = i == 0 ? w0.x : i == 1 ? w1.x : i == 2 ? w2.x : w3.x;
      h += wx * wy * texelFetch(uDemBase, ivec2(xx, yy), 0).r;
    }
  }
  return h;
}

float demLevelAt(int l, vec2 uv) {
  float N = 512.0;
  float x = uv.x * N - 0.5, y = uv.y * N - 0.5;
  int x0 = clamp(int(floor(x)), 0, 510), y0 = clamp(int(floor(y)), 0, 510);
  float fx = clamp(x - float(x0), 0.0, 1.0), fy = clamp(y - float(y0), 0.0, 1.0);
  float a = texelFetch(uDemLevels, ivec3(x0, y0, l), 0).r, b = texelFetch(uDemLevels, ivec3(x0 + 1, y0, l), 0).r;
  float c = texelFetch(uDemLevels, ivec3(x0, y0 + 1, l), 0).r, d = texelFetch(uDemLevels, ivec3(x0 + 1, y0 + 1, l), 0).r;
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}

// elevation (m) for a sampling footprint 'need' (m); also returns the data resolution used
float demHeight(vec3 dir, float need, out float res) {
  vec2 ll = vec2(asin(clamp(dir.z, -1.0, 1.0)), atan(dir.y, dir.x)) * (180.0 / PI);
  float h = demBaseAt(ll);
  res = 9800.0;
  for (int l = 0; l < 8; l++) {
    vec4 w = uDemWin[l];
    if (w.w <= 0.0) break;
    float dl = mod(ll.y - w.x + 540.0, 360.0) - 180.0;
    vec2 uv = vec2(dl / w.z + 0.5, (ll.x - w.y) / w.z + 0.5);
    float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    if (edge <= 0.02) break;
    float fe = min(1.0, (edge - 0.02) / 0.06);
    float fr = clamp(log2(w.w / need) + 1.0, 0.0, 1.0);
    if (fr <= 0.0) break;
    float f = fe * fr;
    h = mix(h, demLevelAt(l, uv), f);
    res = mix(res, w.w, f);
  }
  return h;
}

#endif

float gDataRes = 1.0;
float gDemValid = 0.0;

#ifdef EARTH
// Sea and lakes (earth_coast.png, scripts/build_earth_coast.py): signed distances to the sea and
// lake shores (m, positive on land), so that the shore is smooth at any magnification, and the
// index of the lake whose surface level is looked up in uLakeLevels.
uniform sampler2D uLakeLevels;
const float COAST_TEXEL_M = PI * 6371000.0 / 4096.0;
float gSeaDist = 1e9, gLakeDist = 1e9, gWaterLevel = 0.0, gLakeLevel = -1e9;
int gWater = 0;

// Shoreline detail below the map's resolution: a zero-mean fractal displacement of the shore
// (m), wavelengths from ~4 km down to 'cut' (the geometry or pixel footprint)
float shoreNoise(vec3 relSurf, float cut) {
  float p = 0.0;
  int k0 = int(ceil(log2(uLambda0 / 4000.0)));
  float lam = uLambda0 * exp2(-float(k0));
  for (int i = 0; i < 16; i++) {
    int k = k0 + i;
    if (k >= MAX_OCT) break;
    float w = clamp(log2(lam / cut), 0.0, 1.0);
    if (w <= 0.0) break;
    p += w * 0.35 * lam * gnoise(relSurf / lam + uCamOff[k] + 17.0);
    lam *= 0.5;
  }
  return p;
}

// 0: land, 1: sea, 2: lake (level in gWaterLevel). lod: map level for the footprint 'cut' (m).
int waterAt(vec3 dir, float H, vec3 relSurf, float cut) {
  vec2 uv = dirToUV(dir);
  vec2 c = textureLod(uTexA, uv, max(log2(cut / COAST_TEXEL_M), 0.0)).rg;
  gSeaDist = (c.r * 255.0 - 128.0) / 16.0 * COAST_TEXEL_M;
  gLakeDist = (c.g * 255.0 - 128.0) / 16.0 * COAST_TEXEL_M;
  ivec2 sz = textureSize(uTexA, 0);
  ivec2 ip = clamp(ivec2(uv * vec2(sz)), ivec2(0), sz - 1);
  int idx = int(texelFetch(uTexA, ip, 0).b * 255.0 + 0.5);
  gLakeLevel = idx > 0 ? texelFetch(uLakeLevels, ivec2(idx, 0), 0).r : -1e9;
  float near = min(gSeaDist, gLakeDist);
  float p = near < 3000.0 && near > -3000.0 ? shoreNoise(relSurf, cut) : 0.0;
  // where the elevation data are fine (near the camera), their own shoreline is more accurate
  float coarse = smoothstep(400.0, 1500.0, gDataRes);
  if (gSeaDist < 500.0 && mix(H, gSeaDist + p, coarse) < 0.0) { gWaterLevel = 0.0; return 1; }
  if (gLakeDist + p < 0.0) {
    gWaterLevel = idx > 0 ? gLakeLevel : gH0;
    return 2;
  }
  return 0;
}

// geometry height: flat water surfaces; coastal lowlands no lower than the water next to them
float surfaceHeight(float H, int w) {
  if (w == 1) return 0.0;
  if (w == 2) return gWaterLevel;
  if (gSeaDist < 20000.0) H = max(H, 0.3);
  if (gLakeDist < 10000.0 && gLakeLevel > -1e8) H = max(H, gLakeLevel + 0.3);
  return H;
}
#endif

// bilinear height from the body's DEM (x = height, y = coverage)
vec2 bodyDemAt(vec3 dir) {
  ivec2 sz = textureSize(uBodyDem, 0);
  vec2 ll = vec2(asin(clamp(dir.z, -1.0, 1.0)), atan(dir.y, dir.x)) * (180.0 / PI);
  float x = (ll.y + 180.0) / 360.0 * float(sz.x) - 0.5;
  float y = (90.0 - ll.x) / 180.0 * float(sz.y) - 0.5;
  int x0 = int(floor(x)), y0 = int(floor(y));
  float fx = x - float(x0), fy = y - float(y0);
  int x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0) x0 += sz.x; if (x1 >= sz.x) x1 -= sz.x;
  y0 = clamp(y0, 0, sz.y - 1); y1 = clamp(y1, 0, sz.y - 1);
  vec2 a = texelFetch(uBodyDem, ivec2(x0, y0), 0).rg, b = texelFetch(uBodyDem, ivec2(x1, y0), 0).rg;
  vec2 c = texelFetch(uBodyDem, ivec2(x0, y1), 0).rg, d = texelFetch(uBodyDem, ivec2(x1, y1), 0).rg;
  // weight heights by coverage so no-data does not pull the surface to zero
  vec2 ha = vec2(a.x * a.y, a.y), hb = vec2(b.x * b.y, b.y), hc = vec2(c.x * c.y, c.y), hd = vec2(d.x * d.y, d.y);
  vec2 m = mix(mix(ha, hb, fx), mix(hc, hd, fx), fy);
  return vec2(m.y > 1e-4 ? m.x / m.y : 0.0, m.y);
}

float baseHeight(vec3 dir) {
  float h = featureHeight(dir);
#ifdef EARTH
  h += demHeight(dir, gNeed, gDataRes);
#endif
  if (uHasDem > 0.5) {
    vec2 dm = bodyDemAt(dir);
    h += dm.x * dm.y;
    gDemValid = dm.y;
  }
  if (uSpecial == 2 && uHasDem < 0.5) { // Moon without its DEM: maria are low basalt plains
    float a = textureLod(uTexA, dirToUV(dir), 0.0).r;
    h += (a - 0.5) * 2600.0;
  }
  return h;
}

// roughness modulation of the fractal detail by region
float regionAmp(vec3 dir, float lowOct) {
  float m = clamp(1.0 + 0.8 * lowOct, 0.25, 1.9);
#ifdef EARTH
  // rugged where the land is high (from the coarse elevation map), smooth plains and sea floor
  vec2 ll = vec2(asin(clamp(dir.z, -1.0, 1.0)), atan(dir.y, dir.x)) * (180.0 / PI);
  float e = max(demBaseAt(ll), 0.0);
  m *= min(0.25 + 1.3 * pow(e / 4000.0, 0.8), 1.6);
#endif
  if (uSpecial == 2) m *= 0.6 + 0.8 * textureLod(uTexA, dirToUV(dir), 0.0).r;
  return m;
}

// tan(x); a series for small angles: GPU sin/cos/tan are only accurate to ~1e-6 in absolute terms
// (D3D, most hardware), which for the tiny angles across a nearby chunk (1e-6 rad on a 5 m chunk)
// would scramble the vertices and tear the surface apart
vec2 tanSmall(vec2 x) {
  vec2 x2 = x * x;
  vec2 s = x * (1.0 + x2 * (1.0 / 3.0 + x2 * (2.0 / 15.0 + x2 * (17.0 / 315.0))));
  return mix(tan(x), s, step(abs(x), vec2(0.1)));
}

// exact (dir - dirC) for the tangent-adjusted cube-sphere mapping
// tc: tangents of the chunk centre's face angles (computed in double precision on the CPU)
// dLocal: offset from the centre in face units
void cubeSphere(int face, vec2 tc, vec2 dLocal, out vec3 dir, out vec3 ddir) {
  vec3 N, U, V;
  if (face == 0) { N = vec3(1, 0, 0); U = vec3(0, 1, 0); V = vec3(0, 0, 1); }
  else if (face == 1) { N = vec3(-1, 0, 0); U = vec3(0, -1, 0); V = vec3(0, 0, 1); }
  else if (face == 2) { N = vec3(0, 1, 0); U = vec3(-1, 0, 0); V = vec3(0, 0, 1); }
  else if (face == 3) { N = vec3(0, -1, 0); U = vec3(1, 0, 0); V = vec3(0, 0, 1); }
  else if (face == 4) { N = vec3(0, 0, 1); U = vec3(1, 0, 0); V = vec3(0, 1, 0); }
  else { N = vec3(0, 0, -1); U = vec3(-1, 0, 0); V = vec3(0, 1, 0); }
  // tan(ac + da) - tan(ac) = t (1 + tc^2) / (1 - tc t), t = tan(da)
  vec2 t = tanSmall(dLocal * (PI * 0.25));
  vec2 dt = t * (1.0 + tc * tc) / (1.0 - tc * t);
  vec3 pc = N + tc.x * U + tc.y * V;
  vec3 d = dt.x * U + dt.y * V;
  vec3 p = pc + d;
  float lpc = length(pc), lp = length(p);
  float dl = (2.0 * dot(pc, d) + dot(d, d)) / (lp + lpc);
  ddir = (d * lpc - pc * dl) / (lp * lpc);
  dir = p / lp;
}
`;

export const TERRAIN_VERT = /* glsl */ `
${COMMON}
in vec3 iAnchor;   // ellipsoid point at chunk centre, relative to camera (body frame)
in vec4 iChunk;    // face, tan of the centre's face angles (u, v), half size (face units)
in float iSkirt;   // skirt depth (m)
uniform mat3 uRot; // body frame -> world

out vec3 vRelSurf;
out vec3 vRel;
out vec3 vDir;
out float vH;
out float vH0;
out vec3 vGrad;
out float vAlb;
out float vLowOct;
out float vDataRes;
out vec3 vWorld;

#ifdef SHADOW_DEPTH
uniform mat4 uLightVP;       // camera-relative world -> light clip space (terrain shadow pass)
#else
#include <logdepthbuf_pars_vertex>
#endif

void main() {
  vec3 dir, ddir;
  cubeSphere(int(iChunk.x + 0.5), iChunk.yz, (position.xy - 0.5) * 2.0 * iChunk.w, dir, ddir);
  vec3 relSurf = iAnchor + uRadii * ddir;
  float D = length(relSurf);
  float H = 0.0;
  vec3 G = vec3(0.0);
  float alb = 0.0;
  float lowOct = 0.0;
  vDataRes = 1.0;
  vH0 = 0.0;
#if defined(MODE_ROCK)
  // deterministic large-scale relief + finite-difference gradient
  float R = uRadii.x;
  // octave cut-offs follow the distance to the terrain, not to the reference ellipsoid, which
  // can be kilometres above or below a camera standing on the ground: first estimate with the
  // ground height under the camera, then with the large-scale height of the vertex itself
  vec3 nrm0 = normalize(dir / (uRadii * uRadii));
  D = length(relSurf + nrm0 * uGroundH);
  gNeed = D * uVertexCut * 0.25;
  gLamTop = uLamTop;
  float h0 = baseHeight(dir);
  gH0 = h0;
  vH0 = h0;
  D = length(relSurf + nrm0 * h0);
  float dataRes = gDataRes;
#ifdef EARTH
  gLamTop = 2.0 * dataRes;
#else
  // fractal relief only below the resolution of the real DEM where it has data
  if (uHasDem > 0.5) gLamTop = mix(uLamTop, 2.0 * uDemTexelM, gDemValid);
#endif
  float lamTopV = gLamTop;
  vec3 t1 = normalize(cross(dir, abs(dir.z) < 0.9 ? vec3(0, 0, 1) : vec3(1, 0, 0)));
  vec3 t2 = cross(dir, t1);
  float eps = clamp(gNeed / R, 3.0e-6, 2.0e-4);
  G = (t1 * (baseHeight(normalize(dir + t1 * eps)) - h0) + t2 * (baseHeight(normalize(dir + t2 * eps)) - h0)) / (eps * R);
  H = h0;
  vDataRes = lamTopV;
  lowOct = gnoise(relSurf / (uLambda0 * 0.125) + uCamOff[3] + 50.0);
  float baseMod = regionAmp(dir, 0.0);
  float modAmp = regionAmp(dir, lowOct);
  float lam = uLambda0;
  for (int k = 0; k < MAX_OCT; k++) {
    float w = clamp(log2(lam / (D * uVertexCut)), 0.0, 1.0);
    if (w <= 0.0) break;
    vec3 x = relSurf / lam + uCamOff[k];
    terrainOctave(k, x, lam, w, k >= 3 ? modAmp : 0.6 * baseMod, H, G, alb);
    lam *= 0.5;
  }
#endif
  float Hgeo = H;
#ifdef EARTH
  gWater = waterAt(dir, H, relSurf, D * uVertexCut);
  Hgeo = surfaceHeight(H, gWater);
#endif
  Hgeo -= position.z * iSkirt;
  vec3 nrm = normalize(dir / (uRadii * uRadii));
  vec3 rel = relSurf + nrm * Hgeo;
  vRelSurf = relSurf;
  vRel = rel;
  vDir = dir;
  vH = H;
  vGrad = G;
  vAlb = alb;
  vLowOct = lowOct;
  vec3 world = uRot * rel;
  vWorld = world;
#ifdef SHADOW_DEPTH
  gl_Position = uLightVP * vec4(world, 1.0);
#else
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  #include <logdepthbuf_vertex>
#endif
}
`;

// depth-only fragment stage of the terrain shadow pass (plain, linear orthographic depth)
export const SHADOW_FRAG = /* glsl */ `
void main() { gl_FragColor = vec4(1.0); }
`;

export const TERRAIN_FRAG = /* glsl */ `
${COMMON}
${ATMOSPHERE_GLSL}
${ECLIPSE_GLSL}

uniform vec3 uSunDir;        // body frame, unit, towards the sun
uniform vec3 uSunIrr;        // solar irradiance at the body (display units)
uniform vec3 uColor0, uColor1, uColor2;
uniform float uAlbedoNoise;
uniform vec4 uPolarCap;      // rgb, latitude (deg); negative latitude => none
uniform float uPolarSoft;
uniform vec3 uShine;         // planetshine irradiance (body frame direction * intensity)
uniform vec3 uShineColor;
uniform float uAmbient;      // artistic minimum light
uniform float uExposure;     // for emissive sources (city lights)
uniform sampler2D uBandTex;  // gas giant latitude colour profile
uniform vec4 uStorms[6];     // lat, lon (rad), rx, ry (rad)
uniform vec4 uStormCol[6];   // rgb, strength
uniform int uStormCount;
uniform float uContrast, uTurbulence;
uniform sampler2D uRingTex;  // ring optical depth profile (a) + colour
uniform vec2 uRingRange;     // inner/outer ring radius (km)
uniform float uSunRadiance;  // for MODE_SUN
uniform float uOpacity;

in vec3 vRelSurf;
in vec3 vRel;
in vec3 vDir;
in float vH;
in float vH0;
in vec3 vGrad;
in float vAlb;
in float vLowOct;
in float vDataRes;
in vec3 vWorld;

// ---- cast shadows of the relief: cascaded orthographic depth maps rendered from the Sun
// (atlas of 3 square cascades side by side), percentage-closer soft shadows whose penumbra
// follows the Sun's angular size and the distance to the occluder
uniform mat3 uRot;
uniform highp sampler2D uShadowTex;
uniform mat4 uShadowVP[3];
uniform vec4 uShadowInfo[3];  // texel size (m), depth range (m), -, active
uniform float uShadowOn;
uniform float uShadowSize;    // texels per cascade side
uniform float uSunAngR;       // angular radius of the Sun seen from the body (rad)

const vec2 POISSON[16] = vec2[16](
  vec2(-0.94201624, -0.39906216), vec2(0.94558609, -0.76890725), vec2(-0.09418410, -0.92938870), vec2(0.34495938, 0.29387760),
  vec2(-0.91588581, 0.45771432), vec2(-0.81544232, -0.87912464), vec2(-0.38277543, 0.27676845), vec2(0.97484398, 0.75648379),
  vec2(0.44323325, -0.97511554), vec2(0.53742981, -0.47373420), vec2(-0.26496911, -0.41893023), vec2(0.79197514, 0.19090188),
  vec2(-0.24188840, 0.99706507), vec2(-0.81409955, 0.91437590), vec2(0.19984126, 0.78641367), vec2(0.14383161, -0.14100790));

float terrainShadow(vec3 wp, vec3 nW, vec3 LW) {
  if (uShadowOn < 0.5) return 1.0;
  vec2 duv = vec2(1.0 / (3.0 * uShadowSize), 1.0 / uShadowSize);
  float rot = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
  mat2 rm = mat2(cos(rot), sin(rot), -sin(rot), cos(rot));
  for (int i = 0; i < 3; i++) {
    vec4 info = uShadowInfo[i];
    if (info.w < 0.5) continue;
    float texel = info.x;
    // A small normal offset only: under grazing light one texel across the light spans many
    // texels of ground, so a larger lift would look the map up on terrain far towards the Sun.
    // Acne is handled by the slope-scaled depth bias below.
    float cosT = clamp(dot(nW, LW), 0.02, 1.0);
    vec3 p0 = wp + nW * texel * 0.5 + LW * texel;
    vec3 lp = (uShadowVP[i] * vec4(p0, 1.0)).xyz;
    vec2 a = abs(lp.xy);
    // outside the square, or beyond the depth slab (grazing light stretches the square along
    // the ground far past the slab): the next, larger cascade takes over
    if (max(a.x, a.y) > 0.97 || abs(lp.z) > 0.98) continue;
    vec2 uv = lp.xy * 0.5 + 0.5;
    uv.x = (uv.x + float(i)) / 3.0;
    float zr = lp.z * 0.5 + 0.5;
    // Penumbra from the solar disc: the nearest occluder (searched over a few texels only - under
    // grazing light a wider search always finds terrain far towards the Sun) sets the kernel
    // size, distance x angular radius. Near the shadow boundary, where the terrain barely
    // touches the rays, this gives partial light instead of an arbitrary lit/unlit decision.
    // Lookups r texels across the light land on ground r * tan(theta) texels nearer to the Sun,
    // so the depth bias grows with tan(theta) and with the kernel radius.
    float tanT = min(sqrt(1.0 - cosT * cosT) / cosT, 25.0);
    float bias0 = (1.5 + 4.0 * tanT) * texel / info.y;
    float dmin = 1e9;
    for (int k = 0; k < 9; k++) {
      vec2 o = k == 0 ? vec2(0.0) : rm * POISSON[k] * 3.0;
      float d = texture(uShadowTex, uv + o * duv).r;
      if (d < zr - bias0) dmin = min(dmin, (zr - d) * info.y);
    }
    float s = 1.0;
    if (dmin < 1e8) {
      float pen = clamp(dmin * uSunAngR / texel, 1.0, 12.0);
      float bias = (1.5 + (1.0 + pen) * tanT) * texel / info.y;
      float lit = 0.0;
      for (int k = 0; k < 16; k++) {
        float d = texture(uShadowTex, uv + rm * POISSON[k] * pen * duv).r;
        lit += d < zr - bias ? 0.0 : 1.0;
      }
      s = lit / 16.0;
    }
    // fade out towards the rim of the outermost active cascade
    float edge = smoothstep(0.97, 0.85, max(a.x, a.y));
    bool last = i == 2 || uShadowInfo[min(i + 1, 2)].w < 0.5;
    return last ? mix(1.0, s, edge) : s;
  }
  return 1.0;
}

#include <logdepthbuf_pars_fragment>

float muS_(vec3 d, vec3 L) { return dot(d, L); }

float ringShadow(vec3 pKm, vec3 L) {
  if (uRingRange.y <= 0.0 || abs(L.z) < 1e-4) return 1.0;
  float t = -pKm.z / L.z;
  if (t <= 0.0) return 1.0;
  vec2 hit = pKm.xy + L.xy * t;
  float r = length(hit);
  if (r < uRingRange.x || r > uRingRange.y) return 1.0;
  float tau = texture(uRingTex, vec2((r - uRingRange.x) / (uRingRange.y - uRingRange.x), 0.5)).a;
  return exp(-tau / abs(L.z));
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// ---------------------------------------------------------------- rock albedo
vec3 rockAlbedo(vec3 dir, float H, float alb, float slope, float D, out float spec, out float lights) {
  spec = 0.0; lights = 0.0;
  float lat = asin(clamp(dir.z, -1.0, 1.0));
  float lon = atan(dir.y, dir.x);
  float n1 = gnoise(dir * 3.1 + uSeedVec);
  float n2 = gnoise(dir * 9.7 + 13.0);
  float n3 = gnoise(dir * 27.0 + 5.0);
  float t = 0.5 + uAlbedoNoise * (0.55 * n1 + 0.3 * n2 + 0.15 * n3) + alb;
  vec3 c = mix(uColor0, uColor1, clamp(t, 0.0, 1.0));
  if (uSpecial == 2) { // Moon: albedo map + maria tint
    float a = textureLod(uTexA, dirToUV(dir), 0.0).r;
    float m = smoothstep(0.25, 0.62, a + 0.08 * n3 + alb * 0.5);
    c = mix(uColor0 * vec3(0.92, 0.95, 1.02), uColor1, m);
  } else if (uSpecial == 3) { // Mars: dark albedo features (Syrtis, Acidalia...) + dust
    float dark = smoothstep(0.1, 0.45, 0.6 * n1 + 0.4 * gnoise(dir * 5.3 + 2.0) - 0.15 * dir.z);
    c = mix(uColor1, uColor0, dark * 0.85) * (0.85 + 0.3 * alb);
  } else if (uSpecial == 4) { // Io: sulfur, SO2 frost, lava
    float v = gnoise(dir * 6.0 + 3.0) + 0.5 * gnoise(dir * 17.0);
    c = mix(vec3(0.83, 0.72, 0.28), vec3(0.93, 0.9, 0.7), smoothstep(-0.2, 0.5, v));
    c = mix(c, vec3(0.6, 0.35, 0.12), smoothstep(0.35, 0.75, gnoise(dir * 4.0 + 9.0)) * 0.8);
    float spots = smoothstep(0.93, 0.97, 0.5 + 0.5 * gnoise(dir * 22.0 + 1.0));
    float pele = exp(-pow((length(dir - normalize(vec3(-0.08, -0.99, -0.33))) - 0.12) / 0.02, 2.0));
    c = mix(c, vec3(0.03, 0.02, 0.02), spots);
    c = mix(c, vec3(0.55, 0.18, 0.06), pele * 0.8);
    c = mix(c, vec3(0.55, 0.5, 0.35), smoothstep(0.7, 1.2, abs(lat)) * 0.6);
  } else if (uSpecial == 5) { // Europa: lineae
    float lin = 0.0;
    float fr = 6.0;
    for (int i = 0; i < 5; i++) {
      float v = gnoise(dir * fr + float(i) * 7.3);
      lin = max(lin, pow(1.0 - abs(v), 40.0 / (1.0 + float(i))) * (1.0 - 0.15 * float(i)));
      fr *= 2.1;
    }
    float chaos = smoothstep(0.25, 0.6, gnoise(dir * 4.0 + 11.0));
    c = mix(c, vec3(0.55, 0.36, 0.22), clamp(lin * 0.8 + chaos * 0.45, 0.0, 1.0));
  } else if (uSpecial == 6) { // Ganymede: dark regio + bright grooved terrain
    float dark = smoothstep(0.0, 0.25, gnoise(dir * 2.2 + 4.0) + 0.3 * n2);
    float groove = pow(1.0 - abs(gnoise(dir * vec3(40.0, 40.0, 6.0))), 6.0);
    c = mix(uColor1 * (0.9 + 0.2 * groove), uColor0, dark);
  } else if (uSpecial == 7) { // Enceladus: tiger stripes
    float s = 0.0;
    if (lat < -1.1) {
      float u = dir.x * 0.8 + dir.y * 0.6;
      s = pow(max(0.0, cos(u * 90.0)), 12.0) * smoothstep(-1.1, -1.3, lat);
    }
    c = mix(c, vec3(0.55, 0.68, 0.72), s);
  } else if (uSpecial == 8) { // Dione / Rhea: wispy bright trailing hemisphere
    float trailing = smoothstep(-0.2, 0.6, dir.y);
    float wisps = pow(1.0 - abs(gnoise(dir * vec3(9.0, 3.0, 9.0) + 2.0)), 10.0);
    c = mix(c, uColor0 * 0.9, trailing * 0.45);
    c = mix(c, uColor1 * 1.05, trailing * wisps);
  } else if (uSpecial == 9) { // Titan: dunes (dark), Xanadu (bright), polar lakes
    float xan = smoothstep(0.55, 0.9, dot(dir, normalize(vec3(-0.17, -0.97, -0.26))));
    float dunes = smoothstep(0.45, 0.2, abs(lat)) * smoothstep(0.1, 0.4, n1 + 0.4);
    c = mix(c, uColor0 * 0.6, dunes);
    c = mix(c, uColor1 * 1.2, xan);
    float lakes = step(1.15, abs(lat)) * smoothstep(0.2, 0.35, gnoise(dir * 14.0));
    c = mix(c, vec3(0.02, 0.02, 0.025), lakes);
    spec = lakes;
  } else if (uSpecial == 10) { // Iapetus: dark leading hemisphere (apex at -y)
    float lead = dot(dir, vec3(0.0, -1.0, 0.0));
    float edge = lead + 0.12 * n2 + 0.08 * n3 + 0.2 * abs(dir.z) * abs(dir.z);
    c = mix(uColor1, uColor0, smoothstep(0.05, 0.25, edge));
  } else if (uSpecial == 11) { // Miranda: coronae
    float cor = smoothstep(0.2, 0.3, gnoise(dir * 1.8 + 3.0));
    float bands = 0.5 + 0.5 * sin(40.0 * gnoise(dir * 1.8 + 3.0));
    c = mix(c, mix(uColor0, uColor1, bands), cor);
  } else if (uSpecial == 12) { // Triton: pinkish south polar cap with dark streaks
    float cap = smoothstep(-0.15, -0.45, dir.z + 0.08 * n2);
    float streak = smoothstep(0.75, 0.9, gnoise(dir * vec3(30.0, 30.0, 4.0))) * cap;
    c = mix(mix(uColor1 * vec3(0.95, 0.97, 1.0), vec3(0.62, 0.66, 0.6), smoothstep(0.1, 0.5, n2)), vec3(0.93, 0.83, 0.78), cap);
    c = mix(c, vec3(0.25, 0.2, 0.18), streak);
  } else if (uSpecial == 13) { // Pluto: Tombaugh Regio "heart", Cthulhu Macula
    float heart = smoothstep(0.35, 0.22, length(dir - normalize(vec3(-0.9, 0.05, 0.34))) + 0.05 * n3)
                + smoothstep(0.28, 0.16, length(dir - normalize(vec3(-0.78, -0.45, 0.2))) + 0.05 * n3);
    float cth = smoothstep(0.35, 0.1, abs(lat + 0.1 + 0.12 * n2)) * smoothstep(0.2, 0.6, sin(lon - 0.2) + 0.2 * n1) * (1.0 - clamp(heart, 0.0, 1.0));
    c = mix(vec3(0.72, 0.58, 0.46), vec3(0.95, 0.9, 0.84), smoothstep(-0.3, 0.4, n1));
    c = mix(c, vec3(0.97, 0.95, 0.92), clamp(heart, 0.0, 1.0));
    c = mix(c, vec3(0.22, 0.1, 0.06), cth * 0.9);
    c = mix(c, vec3(0.8, 0.72, 0.62), smoothstep(1.1, 1.4, lat));
  } else if (uSpecial == 14) { // Charon: Mordor Macula
    c = mix(c, vec3(0.3, 0.17, 0.12), smoothstep(1.05, 1.3, lat + 0.1 * n2));
  }
  // real surface map: replaces the procedural colours where it has data, keeps the fractal
  // brightness variations (craters, rays, grain) below its resolution
  float mapValid = 0.0;
  if (uHasMap > 0.5) {
    float lodM = clamp(log2(D * uPixelCut * float(textureSize(uBodyMap, 0).x) / (6.2832 * uRadii.x)), 0.0, 10.0);
    vec3 m = sampleMap(dirToUV(dir), lodM);
    float ml = dot(m, vec3(0.3333));
    mapValid = smoothstep(0.0006, 0.003, ml);
    if (uMapGray.x > 0.0) {
      // single-band mosaic: colour it with the body's palette (dark terrain -> uColor0 hue,
      // bright -> uColor1 hue), keeping the measured brightness
      vec3 t0 = uColor0 / max(dot(uColor0, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
      vec3 t1 = uColor1 / max(dot(uColor1, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
      vec3 tint = mix(t0, t1, smoothstep(0.3, 1.0, ml / uMapGray.y));
      m = ml * mix(vec3(1.0), tint, uMapGray.x);
    }
    vec3 mc = m * uMapGain * (0.8 + 0.4 * clamp(0.5 + alb * 2.0, 0.0, 1.0));
    c = mix(c, mc, mapValid);
  }
  if (uPolarCap.w > 0.0 && mapValid < 0.5) {
    float capLat = uPolarCap.w * PI / 180.0;
    float soft = uPolarSoft * PI / 180.0;
    float cap = smoothstep(capLat, capLat + soft, abs(lat) + 0.04 * n3 + 0.03 * n2);
    c = mix(c, uPolarCap.rgb, cap);
  }
#ifdef EARTH
  vec2 uv = dirToUV(dir);
  float lodRaw = log2(D * uPixelCut * 0.5 / 9800.0);
  float lod = clamp(lodRaw, 0.0, 12.0);
  // land colour from the Blue Marble (~10 km). Its texels along a shore mix land and water, so
  // near the shore the colour is taken a little inland, down the gradient of the shore distance.
  float shore = min(gSeaDist, gLakeDist);
  vec2 uvT = uv;
  if (shore > -12000.0 && shore < 12000.0) {
    float lodA = max(log2(D * uPixelCut / COAST_TEXEL_M), 0.0);
    vec2 st = exp2(floor(lodA)) / vec2(textureSize(uTexA, 0));
    vec2 cx = textureLod(uTexA, uv + vec2(st.x, 0.0), lodA).rg, cy = textureLod(uTexA, uv + vec2(0.0, st.y), lodA).rg;
    vec2 gr = gSeaDist < gLakeDist ? vec2(cx.r, cy.r) : vec2(cx.g, cy.g);
    gr = (gr * 255.0 - 128.0) / 16.0 * COAST_TEXEL_M - shore;   // change over one step
    float gl = length(gr);
    if (gl > 1.0) uvT += (gr / gl) / vec2(textureSize(uTexA, 0)) * (clamp(12000.0 - shore, 0.0, 12000.0) / COAST_TEXEL_M) * 0.8;
  }
  vec3 tex = sampleSmooth(uTexC, uvT, min(lodRaw, 12.0));
  bool ocean = gWater > 0;
  // where the fractal shore gains land from the water, a sandy/muddy tone
  vec3 land = mix(tex, vec3(0.32, 0.27, 0.19), 0.6 * smoothstep(0.0, -300.0, shore));
  // materials below the imagery resolution: bare rock on steep slopes, snow where the imagery
  // shows it (seasonal) or above a latitude-dependent snowline, broken up by slope and noise
  float latDeg = abs(lat) * 180.0 / PI;
  float texMin = min(tex.r, min(tex.g, tex.b));
  float fine = alb * 2.0;
  float rock = smoothstep(0.45, 0.85, slope + 0.1 * fine);
  vec3 rockCol = mix(vec3(0.16, 0.145, 0.13), vec3(0.3, 0.28, 0.26), clamp(0.5 + fine, 0.0, 1.0));
  land = mix(land, mix(land, rockCol, 0.7), rock);
  float snowline = 5800.0 * pow(1.0 - smoothstep(22.0, 72.0, latDeg), 1.3);
  float snowTex = smoothstep(0.45, 0.65, texMin);
  float snowAlt = smoothstep(snowline, snowline + 600.0, H + 350.0 * n3 + 150.0 * fine);
  float snow = max(snowTex, snowAlt) * (1.0 - smoothstep(0.6, 1.1, slope + 0.15 * fine));
  land = mix(land, vec3(0.82, 0.85, 0.9), snow);
  c = land * (0.9 + 0.35 * alb);
  if (ocean) { // ocean
    // the bottom shows through only the first tens of metres (e-folding ~25 m of coastal water,
    // light travels down and back); fractal bumps on a data-submerged shelf keep the data depth
    float dm;
    if (gWater == 1) {
      // coarse data: a smooth depth field (bilinear 10 km texels would outline them in turquoise)
      float coarse = smoothstep(400.0, 1500.0, gDataRes);
      float dFine = max(max(-H, -0.5 * gH0), 0.0);
      dm = coarse > 0.0 ? mix(dFine, max(-demBaseSmooth(vec2(lat, lon) * (180.0 / PI)), 0.0), coarse) : dFine;
    } else dm = max(gWaterLevel - H, -gLakeDist * 0.02); // lakes: data floor or shore slope
    float depth = 1.0 - exp(-dm / 25.0);
    c = mix(vec3(0.03, 0.12, 0.13), vec3(0.008, 0.025, 0.06), depth);
    c = mix(c, vec3(0.75, 0.8, 0.85), smoothstep(1.25, 1.35, abs(lat) + 0.05 * n2) * 0.9); // sea ice
    spec = 1.0;
  }
  lights = sampleSmooth(uTexD, uv, min(lodRaw, 12.0)).r;
  lights = pow(lights, 1.6) * (ocean ? 0.0 : 1.0);
#endif
  return c;
}

// ---------------------------------------------------------------- small-scale cast shadows
// The shadow maps only see the mesh (vertex-level relief, ~1/10 of the viewing distance). Below
// that, crater rims, boulders and ridges exist only in the fragment octaves; march a short ray
// towards the Sun through those octaves alone, over the vertex-level plane.
float gBandH[MAX_OCT];   // per-octave height of the fragment band at the shaded point

// height of the band octaves with wavelengths in [lamLo, lamHi] at another point
float bandHeight(vec3 relSurf, float D, int k0, float baseMod, float modAmp, float lamLo, float lamHi, out float hP) {
  float h = 0.0, a = 0.0;
  vec3 g = vec3(0.0);
  hP = 0.0;
  float lam = uLambda0 * exp2(-float(k0));
  for (int k = 0; k < MAX_OCT; k++) {
    if (k < k0) continue;
    float wv = clamp(log2(lam / (D * uVertexCut)), 0.0, 1.0);
    float wf = clamp(log2(lam / (D * uPixelCut)), 0.0, 1.0);
    if (wf <= 0.0 || lam < lamLo) break;
    float w = wf - wv;
    if (w > 0.0 && lam <= lamHi) {
      terrainOctave(k, relSurf / lam + uCamOff[k], lam, w, k >= 3 ? modAmp : 0.6 * baseMod, h, g, a);
      hP += gBandH[k];
    }
    lam *= 0.5;
  }
  return h;
}

float microShadow(vec3 relSurf, float D, vec3 nV, vec3 L, int k0, float baseMod, float modAmp) {
  float sinE = dot(nV, L);
  if (sinE <= 0.0 || sinE > 0.75) return 1.0;           // unlit, or Sun high: nothing to cast
  vec3 th = L - nV * sinE;
  float cosE = length(th);
  th /= cosE;
  float tanE = sinE / cosE;
  float pix = D * uPixelCut;
  float sMin = 4.0 * pix, sMax = 1.5 * D * uVertexCut;
  if (sMax <= sMin) return 1.0;
  float vis = 1.0;
  float s = sMin;
  float ratio = pow(sMax / sMin, 1.0 / 7.0);
  for (int i = 0; i < 8; i++) {
    // features much smaller than the step cannot shade over that distance (and would alias);
    // much larger ones only tilt the ground, which the lighting already accounts for
    float hp;
    float hq = bandHeight(relSurf + th * s, D, k0, baseMod, modAmp, s * 0.5, s * 16.0, hp);
    // clearance of the ray above the terrain, in units of the solar disc's size at that distance
    // (at least a couple of pixels, so the edge stays antialiased)
    float c = (hp + s * tanE - hq) / (s * max(uSunAngR, 0.002) * 2.0 + 2.0 * pix);
    vis = min(vis, clamp(0.5 + 0.5 * c, 0.0, 1.0));
    if (vis <= 0.0) break;
    s *= ratio;
  }
  return vis * vis * (3.0 - 2.0 * vis);
}

// ---------------------------------------------------------------- gas giant colour
vec3 gasColour(vec3 dir, vec3 nrmOut, float D, out vec3 grad) {
  float lat = asin(clamp(dir.z, -1.0, 1.0));
  float lon = atan(dir.y, dir.x);
  // fractal turbulence with octaves down to the pixel scale (camera-relative noise)
  float T = 0.0;
  grad = vec3(0.0);
  float lam = uLambda0;
  float amp = 1.0;
  for (int k = 0; k < MAX_OCT; k++) {
    float w = clamp(log2(lam / (D * uPixelCut)), 0.0, 1.0);
    if (w <= 0.0) break;
    vec3 x = uNoiseStretch * vRelSurf / lam + uCamOff[k];
    vec4 n = gnoised(x);
    if (k >= 2) { // domain warp by the previous octaves
      n = gnoised(x + vec3(T * 1.7, T * 0.9, 0.0));
    }
    T += w * amp * n.x;
    grad += w * amp * 0.35 * uNoiseStretch * n.yzw / lam * uRadii.x * 0.002;
    amp *= k < 3 ? 0.62 : 0.55;
    lam *= 0.5;
  }
  float latW = lat + uTurbulence * 0.035 * T;
  vec3 c = texture(uBandTex, vec2(0.5, latW / PI + 0.5)).rgb;
  if (uHasMap > 0.5) {
    // real cloud map, advected by the same turbulence
    vec2 uv = vec2((lon + uTurbulence * 0.02 * T) / (2.0 * PI) + 0.5, latW / PI + 0.5);
    // explicit LOD: the longitude seam would otherwise select the smallest mip along a line
    float lodG = clamp(log2(D * uPixelCut * float(textureSize(uBodyMap, 0).x) / (6.2832 * uRadii.x)), 0.0, 10.0);
    vec3 m = sampleMap(uv, lodG) * uMapGain;
    // single-band cloud map: its brightness structure on the colours of the band model
    if (uMapGray.x > 0.0) m = c * (dot(m, vec3(0.3333)) / max(dot(c, vec3(0.3333)), 1e-4));
    c = mix(c, m, smoothstep(0.0006, 0.004, dot(m, vec3(0.3333))));
  }
  c *= 1.0 + uContrast * 0.22 * T;
  // storms (ellipses in lat/lon with spiral structure)
  for (int i = 0; i < 6; i++) {
    if (i >= uStormCount) break;
    vec4 s = uStorms[i];
    float dl = lon - s.y; dl = mod(dl + PI, 2.0 * PI) - PI;
    vec2 q = vec2(dl * cos(s.x) / s.z, (lat - s.x) / s.w);
    float r = length(q);
    if (r > 2.0) continue;
    float ang = atan(q.y, q.x) + r * 5.0 + T * 0.8;
    float swirl = 0.5 + 0.5 * sin(ang * 2.0 + r * 9.0);
    float m = smoothstep(1.05, 0.55, r + 0.08 * T) * uStormCol[i].a;
    vec3 sc = mix(uStormCol[i].rgb, uStormCol[i].rgb * 1.25, swirl * 0.5);
    c = mix(c, sc, m);
    c = mix(c, c * 1.08, smoothstep(1.3, 1.05, r) * (1.0 - m) * 0.5); // collar
  }
  if (uSpecial == 2) { // Saturn's north polar hexagon
    float colat = PI * 0.5 - lat;
    float a = mod(lon + 0.3, PI / 3.0) - PI / 6.0;
    float dHex = colat * cos(a) / cos(PI / 6.0);
    float hex = smoothstep(0.235, 0.215, dHex + 0.004 * T);
    c = mix(c, vec3(0.42, 0.5, 0.56), hex * 0.6);
    c = mix(c, c * 0.8, smoothstep(0.23, 0.225, dHex) * smoothstep(0.205, 0.215, dHex));
    c = mix(c, vec3(0.35, 0.33, 0.3), smoothstep(0.05, 0.0, colat) * 0.6);
  } else if (uSpecial == 4) { // Neptune: bright methane cirrus
    float cir = smoothstep(0.55, 0.85, gnoise(uNoiseStretch * vRelSurf / (uLambda0 * 0.25) + uCamOff[2] * 2.0 + 9.0) + 0.3 * T);
    cir *= smoothstep(0.2, 0.35, abs(lat)) * smoothstep(0.9, 0.6, abs(lat));
    c = mix(c, vec3(0.92, 0.95, 1.0), cir * 0.8);
  } else if (uSpecial == 1) { // Jupiter: equatorial festoons & hot spots at +7 deg
    float fl = exp(-pow((lat - 0.12) / 0.02, 2.0)) * smoothstep(0.2, 0.7, sin(lon * 13.0 + T * 2.0));
    c = mix(c, vec3(0.35, 0.33, 0.36), fl * 0.6);
  }
  return c;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vDir);
  vec3 nS = normalize(dir / (uRadii * uRadii));
  // distance to the large-scale terrain (as in the vertex stage)
  float D = length(vRelSurf + nS * vH0);
  vec3 V = -normalize(vRel);
  vec3 L = uSunDir;
  vec3 pKm = (uCamPF + vRel) * 0.001;
  float R = uRadii.x;

#if defined(MODE_SUN)
  // granulation: cellular network at all scales, limb darkening
  // spectrum: granulation (~1 Mm) dominates, weaker supergranulation (~30 Mm), fine lanes below
  float g = 0.0, lam = uLambda0;
  for (int k = 0; k < MAX_OCT; k++) {
    float w = clamp(log2(lam / (D * uPixelCut)), 0.0, 1.0);
    if (w <= 0.0) break;
    float kf = log2(6.957e8 / lam);
    float amp = 0.9 * exp(-pow((kf - 9.5) / 1.6, 2.0)) + 0.25 * exp(-pow((kf - 4.5) / 1.2, 2.0)) + 0.15 * pow(0.8, max(kf - 10.0, 0.0)) * step(10.0, kf);
    vec3 x = vRelSurf / lam + uCamOff[k];
    float v = 1.0 - abs(gnoise(x));
    g += w * amp * (v * v - 0.5);
    lam *= 0.5;
  }
  float mu = clamp(dot(nS, V), 0.0, 1.0);
  vec3 limb = vec3(1.0) - vec3(0.4, 0.55, 0.75) * (1.0 - pow(mu, 0.8));
  float spots = smoothstep(0.62, 0.7, gnoise(dir * 5.0 + vec3(0.0, 0.0, uTime * 0.02))) * smoothstep(0.6, 0.15, abs(dir.z));
  vec3 col = vec3(1.0, 0.9, 0.76) * limb * (1.0 + 0.45 * g) * (1.0 - 0.75 * spots);
  gl_FragColor = vec4(col * uSunRadiance, 1.0);
  return;
#else

  float H = vH;
  gH0 = vH0;
  vec3 Gr = vGrad;
  float alb = vAlb;
  int bandK0 = 0;
  float bandBase = 1.0, bandMod = 1.0;
#if defined(MODE_ROCK)
  // shading-only octaves between the geometry cut-off and the pixel footprint
  {
    float kv = log2(uLambda0 / (2.0 * D * uVertexCut));
    int k0 = int(max(floor(kv), 0.0));
    bandK0 = k0;
    float lam = uLambda0 * exp2(-float(k0));
    gLamTop = vDataRes; // tapering wavelength chosen per vertex (real data resolution)
    float baseMod = regionAmp(dir, 0.0);
    float modAmp = regionAmp(dir, vLowOct);
    bandBase = baseMod; bandMod = modAmp;
    for (int k = 0; k < MAX_OCT; k++) {
      if (k < k0) continue;
      float wv = clamp(log2(lam / (D * uVertexCut)), 0.0, 1.0);
      float wf = clamp(log2(lam / (D * uPixelCut)), 0.0, 1.0);
      if (wf <= 0.0) break;
      float w = wf - wv;
      gBandH[k] = 0.0;
      if (w > 0.0) {
        vec3 x = vRelSurf / lam + uCamOff[k];
        float h0 = H;
        terrainOctave(k, x, lam, w, k >= 3 ? modAmp : 0.6 * baseMod, H, Gr, alb);
        gBandH[k] = H - h0;
      }
      lam *= 0.5;
    }
  }
#endif

  vec3 n;
  vec3 albedo;
  float spec = 0.0, lights = 0.0;
  float alpha = 1.0;
#if defined(MODE_GAS)
  vec3 gg;
  albedo = gasColour(dir, nS, D, gg);
  n = normalize(nS - (gg - nS * dot(gg, nS)));
#elif defined(MODE_CLOUDS)
  {
    n = nS;
    albedo = vec3(0.85);
    vec2 uv = dirToUV(dir);
    float lod = clamp(log2(D * uPixelCut * 0.5 / 9800.0), 0.0, 12.0);
    float cov = textureLod(uTexE, uv, lod).r;
    // fractal cloud detail below the 10 km texture resolution, down to the pixel footprint
    int kc = int(ceil(log2(uLambda0 / 40000.0)));
    float lam = uLambda0 * exp2(-float(kc));
    float det = 0.0, amp = 0.5;
    vec3 gsum = vec3(0.0);
    for (int k = 0; k < 24; k++) {
      int kk = kc + k;
      if (kk >= MAX_OCT) break;
      float wf = clamp(log2(lam / (D * uPixelCut)), 0.0, 1.0);
      if (wf <= 0.0) break;
      vec4 nn = gnoised(vRelSurf / lam + uCamOff[kk] + vec3(det * 0.6, 0.0, 0.0));
      det += wf * amp * nn.x;
      gsum += wf * amp * nn.yzw / lam;
      amp *= 0.56;
      lam *= 0.5;
    }
    float c = cov + det * 0.45 * (0.15 + cov * (1.0 - cov) * 3.0);
    alpha = clamp(c * 1.2 - 0.04, 0.0, 1.0);
    alpha = alpha * alpha * (3.0 - 2.0 * alpha);
    // puffy relief for lighting
    vec3 gt = gsum * 900.0; gt -= nS * dot(gt, nS);
    n = normalize(nS - gt * 0.5);
  }
#else
  vec3 Gt = Gr - nS * dot(Gr, nS);
#ifdef EARTH
  gDataRes = 0.5 * vDataRes;
  gWater = waterAt(dir, H, vRelSurf, D * uPixelCut);
  if (gWater > 0) {
    // ocean: gentle wave normals from the same fractal (small scales only)
    Gt = vec3(0.0);
    int kw = int(ceil(log2(uLambda0 / 200.0)));
    float lam = uLambda0 * exp2(-float(kw));
    for (int k = 0; k < 12; k++) {
      int kk = kw + k;
      if (kk >= MAX_OCT) break;
      float wf = clamp(log2(lam / (D * uPixelCut)), 0.0, 1.0);
      if (wf <= 0.0) break;
      vec4 wn = gnoised(vRelSurf / lam + uCamOff[kk] + vec3(0.0, 0.0, uTime * 0.05 * float(k + 1)));
      Gt += wf * 0.03 * wn.yzw;
      lam *= 0.5;
    }
    Gt = Gt - nS * dot(Gt, nS);
  }
#endif
  n = normalize(nS - Gt);
  float slope = length(Gt);
  albedo = rockAlbedo(dir, H, alb, slope, D, spec, lights);
#endif

  // The interpolated position lies on the flat triangle between vertices, which at coarse LOD
  // sits tens of km below a giant's cloud tops - comparable to the atmospheric scale height, so
  // haze and shadows would show the mesh grid. Use the point on the true (curved) surface instead.
  {
    float Hs = 0.0;
#if defined(MODE_ROCK)
    Hs = H;
#ifdef EARTH
    Hs = surfaceHeight(H, gWater);
#endif
#endif
    pKm = (uRadii * dir + nS * Hs) * 0.001;
  }

  // ---------------------------------------------------------------- lighting
  vec3 sunVis = sunVisibility(pKm);
#if defined(MODE_ROCK)
  if (uShadowOn > 0.5) {
    // uShadowOn: 1 = both layers; 2 / 3 = shadow maps / small-scale only (debugging)
    if (uShadowOn < 2.5) sunVis *= terrainShadow(vWorld, normalize(uRot * nS), normalize(uRot * L));
    // vertex-level plane: the interpolated mesh gradient
    vec3 Gv = vGrad - nS * dot(vGrad, nS);
    vec3 nV = normalize(nS - Gv);
    float micro = 1.0;
#ifdef EARTH
    if (gWater == 0)
#endif
    micro = microShadow(vRelSurf, D, nV, L, bandK0, bandBase, bandMod);
    if (uShadowOn < 1.5 || uShadowOn > 2.5) sunVis *= micro;
  }
#endif
#ifdef RINGSHADOW
  sunVis *= ringShadow(pKm, L);
#endif
  vec3 irr = uSunIrr * sunVis;
#ifdef EARTH
  {
    vec3 cp = normalize(dir + L * (7.0 / 6371.0) / max(muS_(dir, L), 0.15));
    float cl = sampleSmooth(uTexE, dirToUV(cp), min(log2(D * uPixelCut * 0.5 / 9800.0), 12.0)).r;
    irr *= 1.0 - 0.75 * cl * smoothstep(0.0, 2000.0, 7000.0 - max(H, 0.0));
  }
#endif
  float mu0 = dot(n, L);
  float muS = dot(nS, L);
  float mu = max(dot(n, V), 0.0);
  float terminator = smoothstep(-0.03, 0.05, muS);
  vec3 radiance;

#ifdef ATMO
  // sunlight reaching the surface is attenuated by the atmosphere
  vec3 LS = normalize(L * uAtmoScale);
  vec3 odSun = atmoOpticalDepthToSun(pKm * uAtmoScale, LS);
  irr *= exp(-atmoExtinction(odSun));
  vec3 sky = uSunIrr * sunVis * (uAtmoRayleigh / max(max(uAtmoRayleigh.r, uAtmoRayleigh.g), uAtmoRayleigh.b)) * 0.06 * smoothstep(-0.25, 0.3, muS);
#else
  vec3 sky = vec3(0.0);
#endif

#if defined(MODE_GAS)
  float k = 0.85; // Minnaert limb darkening
  float lit = pow(max(mu0, 0.0), k) * pow(max(mu, 0.02), k - 1.0);
  radiance = albedo / PI * irr * lit * terminator;
#elif defined(MODE_CLOUDS)
  radiance = albedo / PI * irr * (0.3 + 0.7 * max(mu0, 0.0)) * terminator + albedo * sky * 1.5;
#else
  // Lommel-Seeliger / Lambert blend with a small opposition surge for regolith
  float phase = acos(clamp(dot(L, V), -1.0, 1.0));
  float surge = 1.0 + 0.35 * exp(-phase / 0.08);
  float ls = 2.0 * max(mu0, 0.0) / (max(mu0, 0.0) + mu + 1e-3);
  float lam = max(mu0, 0.0);
  float regolith = uSpecial == 1 ? 0.0 : 0.65;
  float brdf = mix(lam, ls * 0.5, regolith) * surge;
  radiance = albedo / PI * irr * brdf * terminator;
  if (spec > 0.0) { // GGX sun glint on water
    vec3 Hh = normalize(L + V);
    float nh = max(dot(n, Hh), 0.0);
    float a2 = 0.02;
    float dd = nh * nh * (a2 - 1.0) + 1.0;
    float Dg = a2 / (PI * dd * dd);
    float F = 0.02 + 0.98 * pow(1.0 - max(dot(Hh, V), 0.0), 5.0);
    radiance += irr * spec * Dg * F * max(mu0, 0.0) / max(4.0 * mu0 * mu + 1e-3, 1e-3) * terminator;
    radiance += sky * spec * (0.02 + 0.98 * pow(1.0 - mu, 5.0)) * 4.0;
  }
  // skylight
  radiance += albedo * sky * (0.5 + 0.5 * dot(n, nS));
#endif
  // planetshine (light reflected by the parent planet)
  radiance += albedo / PI * uShineColor * max(dot(n, uShine), 0.0);
  // city lights
#ifdef EARTH
  {
    float night = smoothstep(0.08, -0.12, muS);
    float clOver = textureLod(uTexE, dirToUV(dir), clamp(log2(D * uPixelCut * 0.5 / 9800.0), 0.0, 12.0)).r;
    radiance += vec3(1.0, 0.72, 0.42) * lights * night * 0.02 * uExposure * (1.0 - 0.75 * clOver);
  }
#endif
  radiance += albedo * uAmbient * 0.02;

#ifdef ATMO
  {
    vec3 ro = uCamPF * 0.001 * uAtmoScale;
    vec3 pe = pKm * uAtmoScale;
    vec3 rd = normalize(pe - ro);
    float tEnd = length(pe - ro);
    vec2 ts = raySphere(ro, rd, uAtmoShape.y);
    float t0 = max(ts.x, 0.0);
    if (ts.y > 0.0 && tEnd > t0) {
      vec3 tr;
      vec3 ins = atmoScatter(ro, rd, t0, tEnd, LS, tr);
      radiance = radiance * tr + ins * uSunIrr * sunVis;
    }
  }
#endif
  gl_FragColor = vec4(radiance, alpha * uOpacity);
#endif
}
`;
