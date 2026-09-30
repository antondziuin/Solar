// Earth's cloud cover as a time-dependent map, computed on the GPU.
//
// The approach follows curl-noise flow (Bridson et al. 2007, "Curl-noise for procedural fluid
// flow"), as used for global cloud cover by J. Wedekind's sfsim: the wind is divergence-free,
// the curl of a stream function (noise eddies, plus the zonal jets and tracked cyclones), and the
// clouds are a noise pattern carried by it. Here the flow also evolves in time, and instead of
// warping a static pattern once, every texel traces its air parcel back along the time-dependent
// wind (semi-Lagrangian, TRACE seconds in STEPS midpoint steps) and reads the pattern where the
// air was: clouds really drift, stretch and wind up into swirls, and nothing piles up at the poles
// (the wind is a tangent vector field, not a rotation in longitude).
//
// Clouds form and dissolve: the pattern itself keeps changing (its small scales faster, so
// cumulus fields renew within hours, large systems over days), and where the air is humid - a
// slowly evolving humidity field, cyclonic vorticity, the seasonal climate - the pattern's peaks
// condense first as thin wisps and spread; where it dries they thin out from the edges.
//
// Keyframes are computed KEY_DT apart in simulated time (more when time runs fast) and blended.
import * as THREE from 'three';
import { NOISE_GLSL } from './glsl/noise.js';
import { CloudWeather, MAX_VORTEX } from '../core/clouds.js';

const W = 1024, H = 512;
const KEY_DT = 1800;            // s between keyframes at normal time rates
const TRACE = 20 * 3600;        // s of back-trajectory (long enough for the flow to draw filaments)
const TAU_FLOW = 1.5 * 86400;   // s: time scale on which the eddies change
const TAU_SRC = 12 * 3600;      // s: time scale of the cloud pattern's largest scales
const TAU_HUM = 86400;          // s: humidity field
const EARTH_ROT = 7.2921159e-5; // rad/s

const MAP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uFlowSeed;     // eddy noise offset at the keyframe; the eddies drift along z with time
uniform vec3 uHumSeed;      // humidity field, at mid-trace
uniform vec3 uSrcSeed;      // cloud pattern, at the start of the trace
uniform float uSrcDrift;    // (birth time / TAU_SRC) mod 289
uniform vec3 uSunDir;       // body frame, at the keyframe
uniform float uSinDecl;
uniform vec4 uVortexA[${MAX_VORTEX}];
uniform vec4 uVortexB[${MAX_VORTEX}];
uniform int uVortexCount;
uniform sampler2D uCoast;
${NOISE_GLSL}
const float PI = 3.14159265358979;
const float R = 6.371e6;
const float TRACE = ${TRACE.toFixed(1)};
const float TAU_FLOW = ${TAU_FLOW.toFixed(1)};
const int STEPS = 8;
float sq(float x) { return x * x; }

// mean zonal wind at cloud level (m/s, > 0 eastward): trade easterlies, the mid-latitude
// westerlies (jet ~25 m/s), polar easterlies
float zonal(float latDeg) {
  float a = abs(latDeg);
  return -8.0 * exp(-sq(a / 15.0)) + 25.0 * exp(-sq((a - 43.0) / 13.0)) - 5.0 * exp(-sq((a - 75.0) / 8.0));
}

// eddy stream function (value, gradient on the unit sphere); v = p x grad(psi): minima turn
// counter-clockwise seen from above
vec4 eddies(vec3 p, float s) {
  vec3 seed = uFlowSeed - vec3(0.0, 0.0, s / TAU_FLOW);
  vec4 r = vec4(0.0);
  float fr = 2.6, amp = 1.0;
  for (int k = 0; k < 3; k++) {
    vec4 n = gnoised(p * fr + seed + float(k) * 31.7);
    r += amp * vec4(n.x, n.yzw * fr);
    fr *= 2.1; amp *= 0.5;
  }
  return r;
}

// tangential wind (m/s) at unit vector p, s seconds before the keyframe
vec3 wind(vec3 p, float s) {
  float latDeg = degrees(asin(clamp(p.z, -1.0, 1.0)));
  vec3 east = cross(vec3(0.0, 0.0, 1.0), p);
  float el = length(east);
  east = el > 1e-5 ? east / el : vec3(1.0, 0.0, 0.0);
  vec3 v = zonal(latDeg) * east;
  // eddies: strongest in the baroclinic mid-latitudes
  vec4 e = eddies(p, s);
  vec3 g = e.yzw - p * dot(p, e.yzw);
  v += cross(p, g) * 3.0 * (0.45 + 0.55 * exp(-sq((abs(latDeg) - 45.0) / 18.0)));
  // tracked cyclones: Gaussian vortices (w > 0: counter-clockwise)
  for (int i = 0; i < ${MAX_VORTEX}; i++) {
    if (i >= uVortexCount) break;
    vec3 c = uVortexA[i].xyz;
    float r = uVortexB[i].x;
    float cd = dot(p, c);
    if (cd < cos(3.0 * r)) continue;
    float x = acos(clamp(cd, -1.0, 1.0)) / r;
    vec3 t = cross(c, p);
    float tl = length(t);
    if (tl > 1e-6) v += (t / tl) * uVortexA[i].w * 9.0 * x * exp(0.5 * (1.0 - x * x)); // w ~ peak wind / 9 m/s
  }
  return v;
}

// the cloud pattern: billowy fractal from ~1500 km down to the map's texel (~40 km); its smaller
// scales evolve faster (integer factors keep the drift periodic in 289)
float pattern(vec3 p) {
  float f = 0.0, amp = 0.36, fr = 4.0;
  for (int k = 0; k < 6; k++) {
    float drift = uSrcDrift * float(1 + k / 2 + k / 4);
    float n = gnoise(p * fr + uSrcSeed + vec3(float(k) * 13.1, 0.0, drift));
    f += amp * (k < 2 ? n : mix(n, 0.3 - 1.4 * abs(n), 0.3));
    fr *= 2.05; amp *= 0.66;
  }
  return f;
}

float deck(float lat, float lon, float lat0, float lon0, float dlat, float dlon) {
  return exp(-sq((lat - lat0) / dlat) - sq((lon - lon0) / dlon));
}

// seasonal tendency: gentle, the weather itself makes most of the pattern
float climate(vec3 p, float latDeg) {
  float declDeg = degrees(asin(uSinDecl));
  float a = abs(latDeg);
  float hs = latDeg >= 0.0 ? 1.0 : -1.0;
  float sub = a - 0.35 * hs * declDeg;
  float b = 0.10 * exp(-sq((latDeg - 5.0 - 0.4 * declDeg) / 7.0));      // ITCZ
  b -= 0.16 * exp(-sq((sub - 24.0) / 9.0));                            // subtropical highs
  b += 0.10 * exp(-sq((a - 52.0) / 14.0));                             // storm tracks
  vec2 uv = vec2(atan(p.y, p.x) / (2.0 * PI) + 0.5, asin(clamp(p.z, -1.0, 1.0)) / PI + 0.5);
  float land = smoothstep(0.40, 0.62, textureLod(uCoast, uv, 6.0).r);
  b -= 0.20 * land * exp(-sq((sub - 22.0) / 11.0));                    // deserts
  vec3 e = normalize(cross(vec3(0.0, 0.0, 1.0), p) + vec3(1e-6, 0.0, 0.0));
  float afternoon = smoothstep(0.1, 0.6, dot(uSunDir, p)) * smoothstep(0.5, -0.4, dot(uSunDir, e));
  b += 0.16 * land * afternoon * exp(-sq((latDeg - 0.8 * declDeg) / 25.0)); // afternoon cumulus
  float lon = degrees(atan(p.y, p.x));
  b += 0.12 * (deck(latDeg, lon, -18.0, -82.0, 10.0, 10.0) + deck(latDeg, lon, -17.0, 6.0, 9.0, 9.0)
             + deck(latDeg, lon, 28.0, -128.0, 8.0, 10.0) + deck(latDeg, lon, 23.0, -24.0, 7.0, 9.0)
             + deck(latDeg, lon, -28.0, 104.0, 7.0, 8.0)) * (1.0 - land); // marine stratocumulus
  return b;
}

void main() {
  float lat = (vUv.y - 0.5) * PI, lon = (vUv.x - 0.5) * 2.0 * PI;
  vec3 dir = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
  float latDeg = degrees(lat);
  // back-trajectory of the air now at dir
  vec3 p = dir, pHalf = dir;
  float ds = TRACE / float(STEPS);
  for (int i = 0; i < STEPS; i++) {
    float s = float(i) * ds;
    vec3 v = wind(p, s);
    vec3 pm = normalize(p - v * (0.5 * ds / R));
    p = normalize(p - wind(pm, s + 0.5 * ds) * (ds / R));
    if (i == STEPS / 2 - 1) pHalf = p;
  }
  // humidity: slowly evolving large-scale field, carried half-way
  float hum = 0.55 * gnoise(pHalf * 1.8 + uHumSeed) + 0.3 * gnoise(pHalf * 3.9 + uHumSeed + 9.1);
  // cyclonic vorticity (psi minimum in the north, maximum in the south) gathers the clouds
  float cyc = -(latDeg >= 0.0 ? 1.0 : -1.0) * eddies(dir, 0.0).x * smoothstep(8.0, 25.0, abs(latDeg));
  float boost = 0.0, eye = 0.0;
  for (int i = 0; i < ${MAX_VORTEX}; i++) {
    if (i >= uVortexCount) break;
    float d = acos(clamp(dot(dir, uVortexA[i].xyz), -1.0, 1.0));
    // cyclone cloud: broad shield, plus a dense central overcast for the tropical ones
    boost += uVortexB[i].y * exp(-sq(d / uVortexB[i].x)) * (1.0 + (uVortexB[i].z > 0.0 ? 1.5 * exp(-sq(d / (0.45 * uVortexB[i].x))) : 0.0));
    float re = uVortexB[i].z;
    if (re > 0.0) eye = max(eye, 1.0 - smoothstep(re * 0.6, re * 1.5, d));
  }
  float c = 0.9 * pattern(p) + 0.32 * hum + 0.22 * cyc + climate(dir, latDeg) + boost - 0.02;
  // r: organised cloud (systems, fronts, clusters); g: density of broken, scattered cumulus around
  // and between them (trade cumulus, open cells behind fronts) - drawn as small cells in the layer
  float cover = smoothstep(0.0, 0.24, c - 0.06) * (1.0 - eye);
  float scattered = smoothstep(-0.07, 0.03, c - 0.06) * (1.0 - eye);
  gl_FragColor = vec4(cover, scattered, 0.0, 1.0);
}
`;

export class CloudMap {
  constructor(coastTex) {
    const mk = () => {
      const t = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
      t.texture.wrapS = THREE.RepeatWrapping;
      t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
      t.texture.generateMipmaps = false;
      return t;
    };
    this.targets = [mk(), mk()];
    this.keys = [null, null]; // keyframe index held by each target
    this.weather = new CloudWeather();
    this.material = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: MAP_FRAG,
      uniforms: {
        uFlowSeed: { value: new THREE.Vector3() }, uHumSeed: { value: new THREE.Vector3() },
        uSrcSeed: { value: new THREE.Vector3(37.1, 91.7, 0) }, uSrcDrift: { value: 0 },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uSinDecl: { value: 0 },
        uVortexA: { value: this.weather.vortA }, uVortexB: { value: this.weather.vortB }, uVortexCount: { value: 0 },
        uCoast: { value: coastTex },
      },
      depthTest: false, depthWrite: false,
    });
    this.scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.dt = KEY_DT;
    this.blend = 0;
    this.a = this.targets[0].texture;
    this.b = this.targets[1].texture;
    this._pending = null;
    this.users = []; // uniform sets that sample the map
  }

  /** Remember the state for this frame (BodyView.update); the maps are rendered in render(). */
  prepare(ut, rate, sunDirBody) {
    this._pending = { ut, rate: Math.abs(rate), sun: sunDirBody.clone() };
  }

  _renderKey(renderer, k, target, now) {
    const t = k * this.dt; // s since J2000
    const U = this.material.uniforms;
    const m = (x) => ((x % 289) + 289) % 289;
    U.uFlowSeed.value.set(71.3, 23.9, m(t / TAU_FLOW));
    U.uHumSeed.value.set(11.7, 143.1, m((t - TRACE / 2) / TAU_HUM));
    U.uSrcDrift.value = m((t - TRACE) / TAU_SRC);
    // the Sun at the keyframe: the Earth turns under it
    const a = -(t - now.ut * 86400) * EARTH_ROT, c = Math.cos(a), s = Math.sin(a);
    U.uSunDir.value.set(c * now.sun.x - s * now.sun.y, s * now.sun.x + c * now.sun.y, now.sun.z);
    U.uSinDecl.value = now.sun.z;
    this.weather.update(t / 86400, now.sun.z);
    U.uVortexCount.value = this.weather.count;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
  }

  render(renderer) {
    const now = this._pending;
    if (!now) return;
    this._pending = null;
    // keyframe spacing: at most a few new keyframes per second of real time
    const dt = KEY_DT * 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(now.rate, 1) / 4 / KEY_DT)));
    if (dt !== this.dt) { this.dt = dt; this.keys = [null, null]; }
    const tk = (now.ut * 86400) / dt;
    const k0 = Math.floor(tk);
    for (const k of [k0, k0 + 1]) {
      if (this.keys.includes(k)) continue;
      const slot = this.keys[0] === k0 || this.keys[0] === k0 + 1 ? 1 : 0;
      this._renderKey(renderer, k, this.targets[slot], now);
      this.keys[slot] = k;
    }
    const i0 = this.keys.indexOf(k0);
    this.a = this.targets[i0].texture;
    this.b = this.targets[1 - i0].texture;
    this.blend = tk - k0;
    for (const U of this.users) {
      U.uCloudA.value = this.a;
      U.uCloudB.value = this.b;
      U.uCloudBlend.value = this.blend;
    }
  }
}
