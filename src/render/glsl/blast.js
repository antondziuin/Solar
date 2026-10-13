// Volumetric nuclear explosions, ray-marched in a full-screen pass over the rendered scene.
//
// Each explosion lives in its own local frame (metres, z up from ground zero). Its parts are
// density fields: the head (fireball -> toroidal vortex ring -> cap), the stem, the dust raised
// by the blast wave along the ground, the Wilson condensation shell and, on airless bodies, the
// ballistic ejecta curtain. They scatter sunlight (with self-shadowing), are lit from inside by
// the hot core and emit as black bodies of their temperature. The fireball's light scattered by
// the surrounding air (an analytic point-light integral) makes the sky glow around the flash.
// The scene depth (log depth buffer) stops the rays at the terrain.
import { ATMOSPHERE_GLSL } from './atmosphere.js';

export const MAX_BLASTS = 4;

export const BLAST_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Converts the scene's logarithmic depth to view-space depth (m). */
export const DEPTH_COPY_FRAG = /* glsl */ `
uniform highp sampler2D uDepthTex;
uniform float uLogFar;   // log2(far + 1)
uniform vec2 uResolution;
uniform vec2 uPick;      // > 0: sample this pixel only (picking)
void main() {
  vec2 uv = uPick.x >= 0.0 ? uPick : gl_FragCoord.xy / uResolution;
  float d = texture2D(uDepthTex, uv).r;
  float w = d >= 1.0 ? 1e30 : exp2(d * uLogFar) - 1.0;
  gl_FragColor = vec4(w, d, 0.0, 1.0);
}
`;

export const BLAST_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
#define MAX_B ${MAX_BLASTS}
${ATMOSPHERE_GLSL}
uniform highp sampler2D uDepth;   // view-space depth of the scene (m)
uniform highp sampler3D uNoise;   // tileable cloud noise (r: perlin-worley, g/b: worley fbm, a: perlin)
uniform mat3 uRayBasis;
uniform vec2 uResolution;
uniform float uFrame;
uniform float uRadScale;          // display radiance of the solar disc (incl. exposure)
uniform int uCount;

uniform vec3 uRo[MAX_B];      // camera in the local frame (m)
uniform mat3 uM[MAX_B];       // world -> local
uniform vec4 uH[MAX_B];       // head: centre height, torus major radius a, minor radius b, vertical squash k
uniform vec4 uS[MAX_B];       // stem radius, stem top, stem density, head density
uniform vec4 uR[MAX_B];       // dust ring radius, height, density, shock radius
uniform vec4 uW[MAX_B];       // wilson density, burst height, core temperature (K), fireball density
uniform vec4 uE[MAX_B];       // ejecta: launch radius, g t^2/2, lowest / highest range in flight
uniform vec4 uE2[MAX_B];      // ejecta normalising range, ejecta density, age (s), condensation
uniform vec4 uWind[MAX_B];    // wind drift at the top (m), cloud top (m), bounding radius (m)
uniform vec4 uMisc[MAX_B];    // vortex roll angle, stem flow (m), noise seed, water (0/1)
uniform vec3 uSunL[MAX_B];    // direction to the sun (local)
uniform vec3 uSunT[MAX_B * 4];// sunlight (display) at heights 0, 1/3, 2/3, 1 x top
uniform vec3 uSky[MAX_B];     // skylight (display)
uniform vec3 uDust[MAX_B];    // dust albedo (linear)
uniform vec3 uGlowI[MAX_B];   // fireball luminous intensity (display x m^2), rgb
uniform vec4 uBeta[MAX_B];    // air scattering at the burst height: rayleigh rgb, mie (1/m)
uniform float uAtmo[MAX_B];   // 1: apply the aerial perspective of the bound atmosphere
uniform float uHumid[MAX_B];  // 1: water vapour condenses in the cloud (Earth)

// atmosphere of the body the camera looks at (aerial perspective in front of the clouds)
uniform mat3 uRotInvA;
uniform vec3 uCamA;        // camera, body frame (km)
uniform vec3 uSunDirA;     // body frame
uniform vec3 uSunIrrA;

// ------------------------------------------------------------------ per-blast globals
vec4 H, S, Rg, W, E, E2, Wd, Mi;
float gTop;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 planckRel(float T) {
  if (T < 400.0) return vec3(0.0);
  const vec3 lam = vec3(610e-9, 550e-9, 465e-9);
  vec3 x = 0.014388 / (lam * T);
  vec3 xs = 0.014388 / (lam * 5772.0);
  return (exp(xs) - 1.0) / (exp(min(x, vec3(80.0))) - 1.0);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// wind drift grows with height (bends the stem, shears the cap)
vec2 drift(float z) {
  float f = clamp(z / max(gTop, 1.0), 0.0, 1.2);
  return Wd.xy * f * sqrt(f);
}

float nz(vec3 p, int c) {
  vec4 n = texture(uNoise, p);
  return c == 0 ? n.r : c == 1 ? n.g : c == 2 ? n.b : n.a;
}

// head signed distance in the head frame (q relative to its centre); negative inside
float headSD(vec3 q) {
  float a = H.y, b = H.z, k = H.w;
  float rho = length(q.xy);
  float dt = length(vec2(rho - a, q.z / k)) - b;
  vec3 er = vec3(a + 0.8 * b, a + 0.8 * b, 0.85 * b * k);
  vec3 qe = q - vec3(0.0, 0.0, 0.25 * b * k);
  float de = (length(qe / er) - 1.0) * min(er.x, er.z);
  return smin(dt * min(k, 1.0), de, 0.25 * b);
}

// sun-shadowing densities: smooth shapes, no noise
float headShape(vec3 p) {
  vec3 q = p - vec3(drift(p.z), H.x);
  float x = -headSD(q) / (H.z * H.w);
  return smoothstep(-0.1, 0.35, x) * S.w;
}

float stemRadius(float z) {
  float top = max(S.y, 1.0);
  return S.x * (1.0 + 1.8 * exp(-z / (0.07 * top + 1.0))) * (1.0 + 0.9 * smoothstep(0.7, 1.05, z / top));
}

// full density: x head, y stem, z ground dust, w wilson / ejecta; emission temperature out
vec4 density(vec3 p, bool detail, out float temp, out float coreDist) {
  vec4 d = vec4(0.0);
  temp = 0.0;
  coreDist = 1e9;
  float age = E2.z;
  // ---- head
  if (S.w > 0.0 || W.w > 0.0) {
    vec3 q = p - vec3(drift(p.z), H.x);
    float a = H.y, b = H.z, k = H.w;
    float sd = headSD(q);
    if (sd < 0.45 * b) {
      float rho = length(q.xy);
      // roll the noise with the vortex ring: up through the middle, out over the top, down outside
      vec2 pc = vec2(rho - a, q.z);
      float rp = length(vec2(pc.x, pc.y / k)) / b;
      coreDist = rp;
      // (only once the ball has opened into a ring: rolling a ball would smear the noise into bands)
      float ang = Mi.x * (1.1 - 0.2 * clamp(rp, 0.0, 1.0)) * smoothstep(0.2, 0.6, a / max(b, 1.0));
      float ca = cos(ang), sa = sin(ang);
      pc = vec2(ca * pc.x - sa * pc.y, sa * pc.x + ca * pc.y);
      float az = atan(q.y, q.x);
      float rr = a + pc.x;
      vec3 np = vec3(cos(az) * rr, sin(az) * rr, pc.y) / (b * 1.6) + Mi.z;
      float boil = age * 0.6 / max(b, 1.0) * 40.0; // fireball surface boiling (fast while small)
      // billows (perlin-worley) eroded at the edges by finer worley cells
      float n1 = nz(np * 0.55 + vec3(0.0, 0.0, boil * 0.01), 0);
      float n3 = nz(np * 0.23 + vec3(0.31, 0.7, 0.0), 3);
      float n2 = detail ? nz(np * 1.9 + vec3(0.13, 0.0, boil * 0.03), 1) : 0.6;
      float x = -sd / (b * k);
      float v = x * 1.3 + (n1 - 0.4) * 0.55 + (n3 - 0.5) * 0.35;
      v -= (1.0 - n2) * 0.22 * (1.0 - clamp(v * 2.5, 0.0, 1.0));
      float dens = smoothstep(0.0, 0.22, v);
      d.x = dens * max(S.w, W.w);
      // hot core: hottest along the ring's core circle, cooler towards the edges, hot filaments
      // hot core, cooler mottled surface (dark NO2 patches over the glow)
      temp = W.z * (1.0 - 0.22 * clamp(rp, 0.0, 1.3)) * (0.78 + 0.22 * n1 + 0.16 * n2 * n3 * 2.0);
    }
  }
  // ---- stem
  if (S.z > 0.0 && p.z < S.y * 1.1) {
    vec2 c = drift(p.z);
    vec2 xy = p.xy - c;
    float rs = stemRadius(p.z);
    float rho = length(xy);
    if (rho < rs * 1.6) {
      float tw = p.z / max(S.x * 6.0, 1.0);
      vec2 r2 = mat2(cos(tw), -sin(tw), sin(tw), cos(tw)) * xy;
      vec3 np = vec3(r2, p.z - Mi.y) / (S.x * 2.2) + Mi.z * 1.7;
      float n1 = nz(np * 0.5, 0);
      float n2 = detail ? nz(np * 1.9, 2) : 0.5;
      float x = 1.0 - rho / rs;
      float dens = smoothstep(0.0, 0.45, x + (n1 - 0.5) * 0.9 + (n2 - 0.5) * 0.3);
      dens *= 1.0 - smoothstep(S.y * 0.92, S.y * 1.08, p.z);
      d.y = dens * S.z * (0.55 + 0.45 * smoothstep(0.0, 0.3 * S.y, S.y - p.z + 0.15 * S.y));
    }
  }
  // ---- dust raised along the ground by the blast wave (base surge)
  if (Rg.z > 0.0) {
    float rho = length(p.xy);
    float R = Rg.x, h = Rg.y;
    if (R > 1.0 && rho < R + 2.0 * h && p.z < 4.0 * h) {
      vec3 np = vec3(p.xy, p.z * 1.5 - age * 1.5) / (h * 2.5) + Mi.z * 2.3;
      float nl = nz(vec3(p.xy / (h * 9.0), 0.37) + Mi.z, 0);
      float n1 = nz(np * 0.5, 0);
      float n2 = detail ? nz(np * 1.7, 1) : 0.5;
      // a rolling wall of dust at the front, lower inside; ragged top and front
      float front = smoothstep(R + 0.8 * h, R - 1.6 * h, rho + (nl - 0.5) * 2.5 * h);
      float hz = h * (0.25 + 0.75 * smoothstep(R * 0.4, R * 0.97, rho)) * (0.45 + 1.1 * nl);
      float prof = front * exp(-max(p.z, 0.0) / hz) * (0.25 + 0.75 * smoothstep(R * 0.25, R * 0.9, rho));
      d.z = smoothstep(0.08, 0.6, prof + (n1 - 0.5) * 0.9 * prof + (n2 - 0.5) * 0.3 * prof) * Rg.z;
    }
  }
  // ---- Wilson condensation shell behind the blast front
  if (W.x > 0.0) {
    vec3 c = p - vec3(0.0, 0.0, W.y);
    float r = length(c);
    float th = 0.07 * Rg.w;
    float sh = exp(-pow((r - Rg.w * 0.97) / th, 2.0));
    if (sh > 0.02) {
      vec3 np = c / (Rg.w * 0.35) + Mi.z * 3.1;
      float n1 = nz(np * 0.6, 0);
      float elev = c.z / max(r, 1.0);
      d.w = W.x * sh * smoothstep(0.35, 0.65, n1 + 0.15 * elev) * smoothstep(-0.1, 0.25, elev + W.y / max(r, 1.0));
    }
  }
  // ---- ballistic ejecta curtain (airless bodies): an inverted cone, rays in azimuth
  if (E2.y > 0.0) {
    float rho = length(p.xy);
    float u = rho - E.x;
    if (u > E.z && u < E.w) {
      float zl = u - E.y;
      float th = 0.05 * u + 0.25 * E.x;
      float dd = (p.z - zl) * 0.7071;
      float sh = exp(-dd * dd / (th * th));
      if (sh > 0.02 && p.z > -th) {
        float az = atan(p.y, p.x);
        vec3 np = vec3(cos(az) * 3.0, sin(az) * 3.0, log(u + 1.0) * 0.35) + Mi.z;
        float rays = nz(np * 0.5, 0) * 0.65 + nz(np * 1.3, 1) * 0.35;
        float mass = 2.0 * pow(clamp(u / max(E2.x, 1.0), 1.0, 1e4), -1.3);
        float tip = 1.0 - smoothstep(E.w * 0.85, E.w, u);
        d.w = E2.y * sh * mass * tip * (0.35 + 0.65 * smoothstep(0.3, 0.7, rays));
      }
    }
  }
  return d;
}

// conservative distance to anything visible (sphere tracing through empty space) and step size
float boundSD(vec3 p, out float stepIn) {
  float sd = 1e12;
  stepIn = 1e12;
  if (S.w > 0.0 || W.w > 0.0) {
    vec3 q = p - vec3(drift(p.z), H.x);
    float s = headSD(q) - 0.45 * H.z;
    sd = min(sd, s);
    if (s < 0.0) stepIn = min(stepIn, 0.1 * H.z * H.w);
  }
  if (S.z > 0.0) {
    vec2 xy = p.xy - drift(p.z);
    float rs = stemRadius(max(p.z, 0.0)) * 1.6;
    float s = max(length(xy) - rs, max(-p.z - 10.0, p.z - S.y * 1.1));
    sd = min(sd, s);
    if (s < 0.0) stepIn = min(stepIn, 0.22 * S.x);
  }
  if (Rg.z > 0.0) {
    float s = max(length(p.xy) - Rg.x - 2.0 * Rg.y, max(-p.z - 10.0, p.z - 4.0 * Rg.y));
    sd = min(sd, s);
    if (s < 0.0) stepIn = min(stepIn, 0.3 * Rg.y);
  }
  if (W.x > 0.0) {
    float s = abs(length(p - vec3(0.0, 0.0, W.y)) - Rg.w * 0.97) - 0.2 * Rg.w;
    sd = min(sd, s);
    if (s < 0.0) stepIn = min(stepIn, 0.04 * Rg.w);
  }
  if (E2.y > 0.0) {
    float rho = length(p.xy);
    float u = clamp(rho - E.x, E.z, E.w);
    vec2 c = vec2(u + E.x, u - E.y);
    float th = 0.05 * u + 0.25 * E.x;
    float s = length(vec2(rho, p.z) - c) - 2.5 * th;
    // the segment of the curtain: also accept points along it
    float s2 = abs((p.z - (rho - E.x - E.y)) * 0.7071) - 2.5 * th;
    if (rho - E.x > E.z && rho - E.x < E.w) s = min(s, s2);
    sd = min(sd, s);
    if (s < 0.0) stepIn = min(stepIn, 0.6 * th);
  }
  return sd;
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

vec3 sunAt(int i, float z) {
  float x = clamp(z / max(gTop, 1.0), 0.0, 1.0) * 3.0;
  int j = int(min(floor(x), 2.0));
  return mix(uSunT[i * 4 + j], uSunT[i * 4 + j + 1], x - float(j));
}

// ray / vertical cylinder (radius r, z in [z0, z1])
vec2 rayCylinder(vec3 ro, vec3 rd, float r, float z0, float z1) {
  float a = dot(rd.xy, rd.xy);
  float b = dot(ro.xy, rd.xy);
  float c = dot(ro.xy, ro.xy) - r * r;
  float tn = -1e30, tf = 1e30;
  if (a > 1e-12) {
    float disc = b * b - a * c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    disc = sqrt(disc);
    tn = (-b - disc) / a; tf = (-b + disc) / a;
  } else if (c > 0.0) return vec2(1.0, -1.0);
  if (abs(rd.z) > 1e-9) {
    float ta = (z0 - ro.z) / rd.z, tb = (z1 - ro.z) / rd.z;
    tn = max(tn, min(ta, tb)); tf = min(tf, max(ta, tb));
  } else if (ro.z < z0 || ro.z > z1) return vec2(1.0, -1.0);
  return vec2(tn, tf);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec3 ray = uRayBasis * vec3(frag / uResolution * 2.0 - 1.0, 1.0);
  float rayLen = length(ray);
  vec3 rdW = ray / rayLen;
  float tScene = texture2D(uDepth, frag / uResolution).r * rayLen;
  float jitter = fract(hash12(frag) + uFrame * 0.618034);

  vec3 accum = vec3(0.0);
  float accA = 0.0;
  for (int i = 0; i < MAX_B; i++) {
    if (i >= uCount) break;
    H = uH[i]; S = uS[i]; Rg = uR[i]; W = uW[i]; E = uE[i]; E2 = uE2[i]; Wd = uWind[i]; Mi = uMisc[i];
    gTop = Wd.z;
    vec3 ro = uRo[i];
    vec3 rd = uM[i] * rdW;
    vec3 Ls = uSunL[i];
    vec3 col = vec3(0.0);
    float Tr = 1.0;
    float tFirst = -1.0;
    float tw = 0.0, twSum = 0.0;

    vec2 tc = rayCylinder(ro, rd, Wd.w, -50.0, Wd.z * 1.05 + 100.0);
    float t0 = max(tc.x, 0.0), t1 = min(tc.y, tScene);
    if (t1 > t0) {
      float cosSun = dot(rd, Ls);
      float phase = mix(hg(cosSun, 0.55), hg(cosSun, -0.2), 0.3);
      vec3 dust = uDust[i];
      // NO2 browns the young cloud; in humid air condensed water then whitens it
      vec3 no2 = vec3(0.62, 0.40, 0.26);
      vec3 capAlb = uHumid[i] > 0.5 ? mix(no2, vec3(0.88, 0.88, 0.9), E2.w) : mix(no2, dust * 1.25, 0.6);
      if (E2.y > 0.0 || S.w <= 0.0) capAlb = dust * 1.2;
      vec3 stemAlb = Mi.w > 0.5 ? vec3(0.9) : dust;
      vec3 coreB = planckRel(W.z) * uRadScale;
      float coreI = W.z > 600.0 ? 1.0 : 0.0;
      float t = t0 + jitter * min(10.0, (t1 - t0) * 0.01);
      bool entered = false;
      float refine = 1.0, prevDs = 0.0;
      for (int n = 0; n < 160; n++) {
        if (t >= t1 || Tr < 0.01) break;
        vec3 p = ro + rd * t;
        float stepIn;
        float sd = boundSD(p, stepIn);
        // empty space: sphere-trace (the wind drift bends the shapes, so stay a little conservative;
        // a floor that grows with distance keeps grazing rays from stalling along a bound)
        if (sd > 0.0 || stepIn > 1e11) { t += max(abs(sd) * 0.8, max(1.0, t * 0.002)); entered = false; continue; }
        float ds = stepIn * refine * (0.75 + 0.5 * fract(jitter + float(n) * 0.37));
        // entering a part: start at a random fraction of a step (no banding along its bound)
        if (!entered) { entered = true; t += ds * jitter; if (t >= t1) break; p = ro + rd * t; }
        float temp, cd;
        vec4 d = density(p, true, temp, cd);
        float sigH = 7.0 / max(H.z * H.w, 1.0);
        float sigS = 3.0 / max(S.x, 1.0);
        float sigR = 1.2 / max(Rg.y, 1.0);
        float sigW = E2.y > 0.0 ? 1.3 / max(0.05 * (length(p.xy) - E.x) + 0.25 * E.x, 1.0) : 1.6 / max(0.07 * Rg.w, 1.0);
        vec4 sg = d * vec4(sigH, sigS, sigR, sigW);
        float sigma = sg.x + sg.y + sg.z + sg.w;
        // stepped deep into a dense cloud in one go: back up and approach its edge in finer steps
        // (otherwise the lit outer layer is skipped and the pixel shows the cloud's dark inside)
        if (sigma * ds > 1.2 && Tr > 0.97 && prevDs > 0.0 && refine > 0.1) {
          t -= prevDs * 0.8; refine *= 0.3; prevDs = 0.0; continue;
        }
        if (sigma > 1e-7) {
          if (tFirst < 0.0) tFirst = t;
          vec3 alb = (sg.x * capAlb + sg.y * stemAlb + sg.z * stemAlb * 0.95 + sg.w * (E2.y > 0.0 ? dust * 1.3 : vec3(0.95))) / sigma;
          // light reaching this point: march towards the sun through the smooth shapes
          float sc = max(H.z * H.w, 50.0);
          float tauL = 0.0;
          float sl = 0.12 * sc;
          for (int j = 0; j < 4; j++) {
            vec3 q = p + Ls * sl * 1.5;
            tauL += headShape(q) * sigH * sl;
            if (S.z > 0.0) {
              float rs = stemRadius(max(q.z, 0.0));
              tauL += S.z * (1.0 - smoothstep(rs * 0.6, rs, length(q.xy - drift(q.z)))) * step(q.z, S.y) * sigS * sl;
            }
            sl *= 2.0;
          }
          float shadow = exp(-tauL) * 0.7 + exp(-tauL * 0.2) * 0.3;
          vec3 sun = sunAt(i, p.z) * shadow * phase * 4.0;
          // skylight: occluded from above by the cap
          float up = headShape(p + vec3(0.0, 0.0, 0.4 * sc)) * sigH * 0.4 * sc;
          vec3 sky = uSky[i] * exp(-up) * 0.8;
          // light of the hot core inside the cloud
          vec3 core = vec3(0.0);
          if (coreI > 0.0) {
            float dc = cd * H.z;
            float r0 = 0.45 * H.z;
            core = coreB * (r0 * r0) / (dc * dc + r0 * r0) * exp(-max(cd - 0.6, 0.0) * 2.5) * 0.35;
          }
          // light of the fireball itself on the stem, the dust and the outside of the cloud
          vec3 lv = vec3(drift(H.x), H.x) - p;
          float l2 = dot(lv, lv);
          float lr = max(H.z, 1.0);
          vec3 fire = uGlowI[i] / (l2 + lr * lr) * (0.25 + 0.75 * smoothstep(lr * 0.8, lr * 1.6, sqrt(l2))) * 0.3;
          vec3 scat = alb * (sun + sky + core + fire);
          vec3 emit = sg.x / sigma * planckRel(temp) * uRadScale * W.w;
          float a = 1.0 - exp(-sigma * ds);
          col += Tr * a * (scat + emit);
          tw += Tr * a * t; twSum += Tr * a;
          Tr *= 1.0 - a;
        }
        t += ds;
        prevDs = ds;
        refine = min(1.0, refine * 1.25);
      }
    }
    float alpha = 1.0 - Tr;
    float tMid = twSum > 0.0 ? tw / twSum : 0.0;
    // the fireball's light scattered by the air along the view ray (glows around the flash)
    vec3 I = uGlowI[i];
    if (I.r + I.g + I.b > 0.0) {
      vec3 lp = vec3(drift(H.x), H.x);
      float tcl = dot(lp - ro, rd);
      float h = max(length(ro + rd * tcl - lp), max(H.z * 0.7, 1.0));
      float tEnd = min(tScene, tFirst > 0.0 && alpha > 0.5 ? tMid : 1e9);
      tEnd = min(tEnd, tcl + 400.0 * h + 4e5);
      float ang = atan((tEnd - tcl) / h) - atan(-tcl / h);
      // rayleigh ~ isotropic; haze scatters forwards (halo around the fireball)
      float cs = dot(rd, normalize(lp - ro));
      vec3 beta = uBeta[i].rgb + uBeta[i].a * 12.566 * hg(cs, 0.7);
      float ext = exp(-dot(uBeta[i].rgb + uBeta[i].a, vec3(0.333)) * h);
      col += beta * I * ang / (12.566 * h) * ext;
    }
    // aerial perspective between the camera and the cloud
    if (uAtmo[i] > 0.5 && twSum > 0.0) {
      vec3 roA = uCamA * uAtmoScale;
      vec3 rdA = normalize(normalize(uRotInvA * rdW) * uAtmoScale);
      vec2 ts = raySphere(roA, rdA, uAtmoShape.y);
      float a0 = max(ts.x, 0.0), a1 = min(ts.y, tMid * 0.001);
      if (a1 > a0 && a1 - a0 > 0.05) {
        vec3 tr;
        vec3 ins = atmoScatter(roA, rdA, a0, a1, normalize(uSunDirA * uAtmoScale), tr);
        col = col * tr + alpha * ins * uSunIrrA;
      }
    }
    // composite far -> near (the CPU sorts the blasts)
    accum = col + (1.0 - alpha) * accum;
    accA = alpha + (1.0 - alpha) * accA;
  }
  gl_FragColor = vec4(min(accum, vec3(30000.0)), accA);
}
`;
