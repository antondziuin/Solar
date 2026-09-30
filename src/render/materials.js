import * as THREE from 'three';
import { TERRAIN_VERT, TERRAIN_FRAG, MAX_OCTAVES, MAX_FEATURES, MAX_OCCLUDERS } from './glsl/terrain.js';
import { gnoise } from '../core/noise.js';

export const linColor = (hex) => new THREE.Color(hex); // ColorManagement converts sRGB hex -> linear

/** Latitude colour profile for gas giants (512 texels, south pole -> north pole), linear half-float. */
export function makeBandTexture(bands, seed = 0, fine = 0.06) {
  const N = 1024;
  const data = new Uint16Array(N * 4);
  const stops = bands.map(([lat, hex]) => [lat, linColor(hex)]);
  for (let i = 0; i < N; i++) {
    const lat = -90 + (180 * (i + 0.5)) / N;
    let j = 0;
    while (j < stops.length - 2 && lat > stops[j + 1][0]) j++;
    const [l0, c0] = stops[j], [l1, c1] = stops[j + 1];
    let t = Math.max(0, Math.min(1, (lat - l0) / (l1 - l0)));
    t = t * t * (3 - 2 * t);
    const c = c0.clone().lerp(c1, t);
    const f = 1 + fine * (gnoise(lat * 0.6, seed, 0.5) + 0.5 * gnoise(lat * 1.9, seed + 3, 0.5));
    data[i * 4] = THREE.DataUtils.toHalfFloat(c.r * f);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(c.g * f);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(c.b * f);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(data, 1, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Radial ring profile: rgb = linear colour, a = normal optical depth. */
export function makeRingTexture(rings, seed = 0) {
  const inner = Math.min(...rings.bands.map((b) => b[0]));
  const outer = Math.max(...rings.bands.map((b) => b[1]));
  const N = 8192;
  const data = new Uint16Array(N * 4);
  const base = linColor(rings.color);
  for (let i = 0; i < N; i++) {
    const r = inner + ((outer - inner) * (i + 0.5)) / N;
    let tau = 0;
    let col = base;
    for (const [a, b, t, hex] of rings.bands) {
      if (r >= a && r <= b) {
        // soft edges and ringlet structure within each band
        const u = (r - a) / (b - a);
        const edge = Math.min(1, Math.min(u, 1 - u) * (b - a) / 30 + 0.2);
        const ringlets = 1 + 0.45 * gnoise(r / 180, seed, 0.3) + 0.25 * gnoise(r / 47, seed + 2, 0.7) + 0.15 * gnoise(r / 13, seed + 4, 0.1);
        tau = Math.max(tau, t * Math.max(0.05, ringlets) * edge);
        if (hex) col = linColor(hex);
      }
    }
    data[i * 4] = THREE.DataUtils.toHalfFloat(col.r);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(col.g);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(col.b);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(tau);
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, inner, outer };
}

const dummyTex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
dummyTex.needsUpdate = true;
const dummyFloatTex = new THREE.DataTexture(new Float32Array([0, 0]), 1, 1, THREE.RGFormat, THREE.FloatType);
dummyFloatTex.needsUpdate = true;

export function atmosphereUniforms(body, groundRadiusKm, U = {}) {
  const a = body.atmosphere;
  const mc = a.mieColor || [1, 1, 1];
  U.uAtmoRayleigh = { value: new THREE.Vector3(...(a.rayleigh || [0, 0, 0])) };
  U.uAtmoMie = { value: new THREE.Vector3(a.mie * mc[0], a.mie * mc[1], a.mie * mc[2]) };
  U.uAtmoMieExt = { value: new THREE.Vector3(a.mieExt, a.mieExt, a.mieExt) };
  U.uAtmoAbsorb = { value: new THREE.Vector3(...(a.absorb || [0, 0, 0])) };
  U.uAtmoShape = { value: new THREE.Vector4(groundRadiusKm, groundRadiusKm + a.height, a.rayleighH, a.mieH) };
  U.uAtmoShape2 = { value: new THREE.Vector4(a.g ?? 0.76, a.absorbCenter ?? -1, a.absorbWidth ?? 1, a.absorbH ?? 10) };
  U.uAtmoMS = { value: a.ms ?? 0.05 };
  const eq = body.radius || 1, pol = body.polarRadius || eq;
  U.uAtmoScale = { value: new THREE.Vector3(1, 1, eq / pol) };
  return U;
}

/**
 * @param mode 'rock' | 'gas' | 'sun' | 'clouds'
 */
export function createSurfaceMaterial(body, model, mode, textures, extra = {}) {
  const s = body.surface;
  const camOff = Array.from({ length: MAX_OCTAVES }, () => new THREE.Vector3());
  const feat = (key) => Array.from({ length: MAX_FEATURES }, (_, i) => (model.features[i] ? model.features[i][key].clone() : new THREE.Vector4()));
  const U = {
    uRadii: { value: new THREE.Vector3(...(extra.radii || model.radii)) },
    uLambda0: { value: model.lambda0 },
    uCamOff: { value: camOff },
    uNoiseStretch: { value: new THREE.Vector3(...model.noiseStretch) },
    uVertexCut: { value: 0.09 },
    uPixelCut: { value: 0.002 },
    uCamPF: { value: new THREE.Vector3() },
    uGroundH: { value: 0 },
    uSpecial: { value: model.special },
    uTime: { value: 0 },
    uAmp: { value: model.amp },
    uHurst: { value: model.hurst },
    uLamTop: { value: model.lamTop },
    uRidge: { value: model.ridge },
    uLumpy: { value: model.lumpy },
    uMicro: { value: model.micro || 0 },
    uCraterStrength: { value: model.craterStrength },
    uCraterDensity: { value: model.craterDensity },
    uCraterRc: { value: model.craterRc },
    uCraterK0: { value: model.craterK0 },
    uBoulders: { value: model.boulders },
    uBoulderK0: { value: model.boulderK0 },
    uFeatA: { value: feat('A') },
    uFeatB: { value: feat('B') },
    uFeatC: { value: feat('C') },
    uFeatCount: { value: model.features.length },
    uTexA: { value: dummyTex }, uTexB: { value: dummyTex }, uTexC: { value: dummyTex }, uTexD: { value: dummyTex }, uTexE: { value: dummyTex },
    uSeedVec: { value: new THREE.Vector3(...model.seedVec).multiplyScalar(0.05) },
    uRot: { value: new THREE.Matrix3() },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uSunPos: { value: new THREE.Vector3() },
    uSunRadius: { value: 695700 },
    uSunIrr: { value: new THREE.Vector3(1, 1, 1) },
    uColor0: { value: linColor(s.c0 || '#808080') },
    uColor1: { value: linColor(s.c1 || '#c0c0c0') },
    uColor2: { value: linColor(s.c2 || '#ffffff') },
    uAlbedoNoise: { value: s.albedoNoise ?? 0.3 },
    uPolarCap: { value: s.polarCap ? new THREE.Vector4(...linColor(s.polarCap.color).toArray(), s.polarCap.lat) : new THREE.Vector4(0, 0, 0, -1) },
    uPolarSoft: { value: s.polarCap?.soft ?? 3 },
    uOcc: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4()) },
    uOccTint: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector3()) },
    uOccCount: { value: 0 },
    uShine: { value: new THREE.Vector3() },
    uShineColor: { value: new THREE.Vector3() },
    uAmbient: { value: 0 },
    uExposure: { value: 1 },
    uBandTex: { value: dummyTex },
    uStorms: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
    uStormCol: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
    uStormCount: { value: 0 },
    uContrast: { value: s.contrast ?? 1 },
    uTurbulence: { value: s.turbulence ?? 1 },
    uRingTex: { value: dummyTex },
    uRingRange: { value: new THREE.Vector2(0, 0) },
    uSunRadiance: { value: 1 },
    uOpacity: { value: 1 },
    uBodyDem: { value: dummyFloatTex },
    uHasDem: { value: 0 },
    uDemTexelM: { value: 1 },
    uBodyMap: { value: dummyTex },
    uHasMap: { value: 0 },
    uMapGain: { value: 1 },
    uMapGray: { value: new THREE.Vector2(0, 0.5) },
    // relief shadows (see TerrainShadows)
    uShadowTex: { value: dummyFloatTex },
    uShadowVP: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] },
    uShadowInfo: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uShadowOn: { value: 0 },
    uShadowSize: { value: 1 },
    uSunAngR: { value: 0.00465 },
    uLightVP: { value: new THREE.Matrix4() },
  };
  const defines = {};
  if (mode === 'rock') defines.MODE_ROCK = '';
  if (mode === 'gas') defines.MODE_GAS = '';
  if (mode === 'sun') defines.MODE_SUN = '';
  if (mode === 'clouds') defines.MODE_CLOUDS = '';
  if (s.special === 'earth' && mode === 'rock') defines.EARTH = '';
  if (body.atmosphere && mode !== 'sun') {
    defines.ATMO = '';
    atmosphereUniforms(body, (body.radius + (body.renderRadiusOffset || 0)), U);
  } else {
    atmosphereUniforms({ atmosphere: { height: 1, rayleighH: 1, mieH: 1, mie: 0, mieExt: 0 } }, 1, U);
  }
  if (body.rings && mode === 'gas') defines.RINGSHADOW = '';

  if (s.special === 'earth' && mode === 'rock') {
    U.uDemBase = { value: textures.dem.baseTex };
    U.uDemLevels = { value: textures.dem.levelTex };
    U.uDemWin = { value: textures.dem.winUniform };
    U.uLakeLevels = { value: textures.earth_lakes };
  }
  if (s.special === 'earth') {
    U.uTexA.value = textures.earth_coast;
    U.uTexC.value = textures.earth_day;
    U.uTexD.value = textures.earth_lights;
    U.uTexE.value = textures.earth_clouds;
  } else if (s.special === 'moon') {
    U.uTexA.value = textures.moon_albedo;
  }
  if (mode === 'clouds') U.uTexE.value = textures.earth_clouds;
  if (mode === 'gas') {
    U.uBandTex.value = makeBandTexture(s.bands, s.seed || 0, body.id === 'jupiter' ? 0.08 : 0.04);
    (s.storms || []).slice(0, 6).forEach((st, i) => {
      U.uStorms.value[i].set((st.lat * Math.PI) / 180, (st.lon * Math.PI) / 180, (st.rx * Math.PI) / 180, (st.ry * Math.PI) / 180);
      const c = linColor(st.color);
      U.uStormCol.value[i].set(c.r, c.g, c.b, st.strength);
    });
    U.uStormCount.value = Math.min(6, (s.storms || []).length);
  }

  const mat = new THREE.ShaderMaterial({
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    uniforms: U,
    defines,
    side: THREE.DoubleSide,
    transparent: mode === 'clouds',
    depthWrite: mode !== 'clouds',
  });
  return mat;
}
