// Shaders for all spherical bodies. One quadtree chunk = one instance of a (N+1)^2 grid.
// Everything is computed relative to the camera in the body-fixed frame, so there is no
// loss of precision at any distance or zoom level.
import { NOISE_GLSL } from './noise.js';
import { ATMOSPHERE_GLSL } from './atmosphere.js';

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
uniform float uPixelCut;      // octave fades out of shading below D * uPixelCut
uniform vec3 uCamPF;          // camera position in the body frame (m) - low precision use only
uniform int uSpecial;
uniform float uTime;

// terrain
uniform float uAmp, uHurst, uLamTop, uRidge, uLumpy;
uniform float uCraterStrength, uCraterDensity, uCraterRc;
uniform int uCraterK0;
uniform vec4 uFeatA[MAX_FEAT];
uniform vec4 uFeatB[MAX_FEAT];
uniform vec4 uFeatC[MAX_FEAT];
uniform int uFeatCount;
uniform sampler2D uTexA;      // earth: water mask | moon: albedo
uniform sampler2D uTexB;      // earth: topography
uniform sampler2D uTexC;      // earth: day colour
uniform sampler2D uTexD;      // earth: night lights
uniform sampler2D uTexE;      // earth: clouds
uniform vec3 uSeedVec;

${NOISE_GLSL}

vec2 dirToUV(vec3 d) {
  return vec2(atan(d.y, d.x) * (0.5 / PI) + 0.5, asin(clamp(d.z, -1.0, 1.0)) / PI + 0.5);
}

float octaveAmp(float lam) {
  float a = uAmp * pow(lam / 1.0e4, uHurst) / (1.0 + pow(lam / uLamTop, uHurst + 1.0));
  return max(a, uLumpy * lam * 0.35);
}

// Self-similar craters: at most one crater per lattice cell per octave.
void crater(vec3 x, float lam, float w, inout float h, inout vec3 g, inout float alb) {
  vec3 c = floor(x);
  vec3 r = hash3(c);
  if (r.x > uCraterDensity) return;
  vec3 r2 = hash3(c + 101.0);
  vec3 center = c + 0.25 + 0.5 * r2;
  float rad = 0.045 + 0.085 * r.y * r.y;
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
  if (k >= uCraterK0 && uCraterStrength > 0.0) crater(x + vec3(31.0, 57.0, 11.0), lam, w, h, g, alb);
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

float baseHeight(vec3 dir) {
  float h = featureHeight(dir);
#ifdef EARTH
  vec2 uv = dirToUV(dir);
  float land = 1.0 - textureLod(uTexA, uv, 0.0).r;
  float topo = textureLod(uTexB, uv, 0.0).r;
  h += (land - 0.5) * 1400.0 + pow(topo, 1.15) * 6300.0 * land;
#endif
  if (uSpecial == 2) { // Moon: maria are low basalt plains
    float a = textureLod(uTexA, dirToUV(dir), 0.0).r;
    h += (a - 0.5) * 2600.0;
  }
  return h;
}

// roughness modulation of the fractal detail by region
float regionAmp(vec3 dir, float lowOct) {
  float m = clamp(1.0 + 0.8 * lowOct, 0.25, 1.9);
#ifdef EARTH
  vec2 uv = dirToUV(dir);
  float land = 1.0 - textureLod(uTexA, uv, 0.0).r;
  float topo = textureLod(uTexB, uv, 0.0).r;
  m *= mix(0.35, min(0.12 + 5.0 * topo, 3.0), land);
#endif
  if (uSpecial == 2) m *= 0.6 + 0.8 * textureLod(uTexA, dirToUV(dir), 0.0).r;
  return m;
}

// exact (dir - dirC) for the tangent-adjusted cube-sphere mapping
void cubeSphere(int face, vec2 cUV, vec2 dLocal, out vec3 dir, out vec3 ddir) {
  vec3 N, U, V;
  if (face == 0) { N = vec3(1, 0, 0); U = vec3(0, 1, 0); V = vec3(0, 0, 1); }
  else if (face == 1) { N = vec3(-1, 0, 0); U = vec3(0, -1, 0); V = vec3(0, 0, 1); }
  else if (face == 2) { N = vec3(0, 1, 0); U = vec3(-1, 0, 0); V = vec3(0, 0, 1); }
  else if (face == 3) { N = vec3(0, -1, 0); U = vec3(1, 0, 0); V = vec3(0, 0, 1); }
  else if (face == 4) { N = vec3(0, 0, 1); U = vec3(1, 0, 0); V = vec3(0, 1, 0); }
  else { N = vec3(0, 0, -1); U = vec3(-1, 0, 0); V = vec3(0, 1, 0); }
  vec2 ac = cUV * (PI * 0.25);
  vec2 da = dLocal * (PI * 0.25);
  vec2 a = ac + da;
  vec2 tc = tan(ac);
  vec2 dt = sin(da) / (cos(a) * cos(ac));
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
in vec4 iChunk;    // face, centre u, centre v, half size (face units)
in float iSkirt;   // skirt depth (m)
uniform mat3 uRot; // body frame -> world

out vec3 vRelSurf;
out vec3 vRel;
out vec3 vDir;
out float vH;
out vec3 vGrad;
out float vAlb;
out float vLowOct;

#include <logdepthbuf_pars_vertex>

void main() {
  vec3 dir, ddir;
  cubeSphere(int(iChunk.x + 0.5), iChunk.yz, (position.xy - 0.5) * 2.0 * iChunk.w, dir, ddir);
  vec3 relSurf = iAnchor + uRadii * ddir;
  float D = length(relSurf);
  float H = 0.0;
  vec3 G = vec3(0.0);
  float alb = 0.0;
  float lowOct = 0.0;
#if defined(MODE_ROCK)
  // deterministic large-scale relief + finite-difference gradient
  float h0 = baseHeight(dir);
  vec3 t1 = normalize(cross(dir, abs(dir.z) < 0.9 ? vec3(0, 0, 1) : vec3(1, 0, 0)));
  vec3 t2 = cross(dir, t1);
  const float eps = 2.0e-4;
  float R = uRadii.x;
  G = (t1 * (baseHeight(normalize(dir + t1 * eps)) - h0) + t2 * (baseHeight(normalize(dir + t2 * eps)) - h0)) / (eps * R);
  H = h0;
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
  Hgeo = max(H, 0.0);
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
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const TERRAIN_FRAG = /* glsl */ `
${COMMON}
${ATMOSPHERE_GLSL}

uniform vec3 uSunDir;        // body frame, unit, towards the sun
uniform vec3 uSunPos;        // sun centre relative to body centre (km, body frame)
uniform float uSunRadius;    // km
uniform vec3 uSunIrr;        // solar irradiance at the body (display units)
uniform vec3 uColor0, uColor1, uColor2;
uniform float uAlbedoNoise;
uniform vec4 uPolarCap;      // rgb, latitude (deg); negative latitude => none
uniform float uPolarSoft;
uniform vec4 uOcc[MAX_OCC];  // occluder centre (km, body frame, rel. body centre), radius km
uniform vec3 uOccTint[MAX_OCC];
uniform int uOccCount;
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
in vec3 vGrad;
in float vAlb;
in float vLowOct;

#include <logdepthbuf_pars_fragment>

float muS_(vec3 d, vec3 L) { return dot(d, L); }

// visible fraction of the solar disc from point p (km, body frame)
vec3 sunVisibility(vec3 p) {
  vec3 vis = vec3(1.0);
  vec3 S = uSunPos - p;
  float ds = length(S);
  float as = uSunRadius / ds;
  for (int i = 0; i < MAX_OCC; i++) {
    if (i >= uOccCount) break;
    vec3 O = uOcc[i].xyz - p;
    float dO = length(O);
    if (dO > ds) continue;
    float ao = uOcc[i].w / dO;
    float sep = acos(clamp(dot(S, O) / (ds * dO), -1.0, 1.0));
    if (sep > as + ao) continue;
    float cover = min(1.0, (ao * ao) / (as * as));
    float f = clamp((as + ao - sep) / (2.0 * min(as, ao)), 0.0, 1.0);
    f = f * f * (3.0 - 2.0 * f);
    float occl = f * cover;
    vis *= mix(vec3(1.0), uOccTint[i], occl);
  }
  return vis;
}

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
    float a = texture(uTexA, dirToUV(dir)).r;
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
  if (uPolarCap.w > 0.0) {
    float capLat = uPolarCap.w * PI / 180.0;
    float soft = uPolarSoft * PI / 180.0;
    float cap = smoothstep(capLat, capLat + soft, abs(lat) + 0.04 * n3 + 0.03 * n2);
    c = mix(c, uPolarCap.rgb, cap);
  }
#ifdef EARTH
  vec2 uv = dirToUV(dir);
  float lod = clamp(log2(D * uPixelCut * 0.5 / 9800.0), 0.0, 12.0);
  vec3 tex = textureLod(uTexC, uv, lod).rgb;
  float waterTex = textureLod(uTexA, uv, 0.0).r;
  // land colour from the Blue Marble; where the fractal coast gains land, borrow a sandy tone
  vec3 land = mix(tex, vec3(0.32, 0.27, 0.19), smoothstep(0.3, 0.8, waterTex));
  float rock = smoothstep(0.35, 0.7, slope);
  land = mix(land, land * 0.6 + vec3(0.09, 0.08, 0.07), rock * 0.6);
  float snow = smoothstep(3800.0, 4800.0, H + 600.0 * n3 - 2500.0 * (1.0 - abs(dir.z))) * (1.0 - rock * 0.7);
  land = mix(land, vec3(0.8, 0.82, 0.86), snow);
  c = land * (0.9 + 0.35 * alb);
  if (H < 0.0) { // ocean
    float depth = clamp(-H / 900.0, 0.0, 1.0);
    c = mix(vec3(0.03, 0.12, 0.13), vec3(0.008, 0.025, 0.06), depth);
    c = mix(c, vec3(0.75, 0.8, 0.85), smoothstep(1.25, 1.35, abs(lat) + 0.05 * n2) * 0.9); // sea ice
    spec = 1.0;
  }
  lights = textureLod(uTexD, uv, lod).r;
  lights *= lights * (H >= 0.0 ? 1.0 : 0.0);
#endif
  return c;
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
  float D = length(vRelSurf);
  vec3 dir = normalize(vDir);
  vec3 nS = normalize(dir / (uRadii * uRadii));
  vec3 V = -normalize(vRel);
  vec3 L = uSunDir;
  vec3 pKm = (uCamPF + vRel) * 0.001;
  float R = uRadii.x;

#if defined(MODE_SUN)
  // granulation: cellular network at all scales, limb darkening
  float g = 0.0, amp = 1.0, lam = uLambda0;
  for (int k = 0; k < MAX_OCT; k++) {
    float w = clamp(log2(lam / (D * uPixelCut)), 0.0, 1.0);
    if (w <= 0.0) break;
    vec3 x = vRelSurf / lam + uCamOff[k];
    float v = 1.0 - abs(gnoise(x));
    g += w * amp * (v * v - 0.5);
    amp *= 0.62; lam *= 0.5;
  }
  float mu = clamp(dot(nS, V), 0.0, 1.0);
  vec3 limb = vec3(1.0) - vec3(0.4, 0.55, 0.75) * (1.0 - pow(mu, 0.8));
  float spots = smoothstep(0.62, 0.7, gnoise(dir * 5.0 + vec3(0.0, 0.0, uTime * 0.02))) * smoothstep(0.6, 0.15, abs(dir.z));
  vec3 col = vec3(1.0, 0.93, 0.82) * limb * (1.0 + 0.25 * g) * (1.0 - 0.75 * spots);
  gl_FragColor = vec4(col * uSunRadiance, 1.0);
  return;
#else

  float H = vH;
  vec3 Gr = vGrad;
  float alb = vAlb;
#if defined(MODE_ROCK)
  // shading-only octaves between the geometry cut-off and the pixel footprint
  {
    float kv = log2(uLambda0 / (2.0 * D * uVertexCut));
    int k0 = int(max(floor(kv), 0.0));
    float lam = uLambda0 * exp2(-float(k0));
    float baseMod = regionAmp(dir, 0.0);
    float modAmp = regionAmp(dir, vLowOct);
    for (int k = 0; k < MAX_OCT; k++) {
      if (k < k0) continue;
      float wv = clamp(log2(lam / (D * uVertexCut)), 0.0, 1.0);
      float wf = clamp(log2(lam / (D * uPixelCut)), 0.0, 1.0);
      if (wf <= 0.0) break;
      float w = wf - wv;
      if (w > 0.0) {
        vec3 x = vRelSurf / lam + uCamOff[k];
        terrainOctave(k, x, lam, w, k >= 3 ? modAmp : 0.6 * baseMod, H, Gr, alb);
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
  if (H < 0.0) {
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

  // ---------------------------------------------------------------- lighting
  vec3 sunVis = sunVisibility(pKm);
#ifdef RINGSHADOW
  sunVis *= ringShadow(pKm, L);
#endif
  vec3 irr = uSunIrr * sunVis;
#ifdef EARTH
  {
    vec3 cp = normalize(dir + L * (7.0 / 6371.0) / max(muS_(dir, L), 0.15));
    float cl = texture(uTexE, dirToUV(cp)).r;
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
    float clOver = texture(uTexE, dirToUV(dir)).r;
    radiance += vec3(1.0, 0.7, 0.38) * lights * night * 0.006 * uExposure * (1.0 - 0.8 * clOver);
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
      radiance = radiance * tr + ins * uSunIrr;
    }
  }
#endif
  gl_FragColor = vec4(radiance, alpha * uOpacity);
#endif
}
`;
