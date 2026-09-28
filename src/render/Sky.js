// Background sky in its own scene (rendered first, rotation-only camera):
// real stars (HYG/d3-celestial, V < 8) with B-V colours, Milky Way isophotes, constellations.
import * as THREE from 'three';
import { raDecToWorld } from '../core/ephemeris.js';
import { NOISE_GLSL } from './glsl/noise.js';
import { OBLIQUITY_J2000 } from '../core/constants.js';

function bvToRGB(bv) {
  // Ballesteros (2012) B-V -> temperature, then a blackbody fit (Tanner Helland), linearised
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const t = T / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
  else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
  const c = new THREE.Color().setRGB(Math.min(255, Math.max(0, r)) / 255, Math.min(255, Math.max(0, g)) / 255, Math.min(255, Math.max(0, b)) / 255, THREE.SRGBColorSpace);
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return [c.r / l, c.g / l, c.b / l];
}

const STAR_VERT = /* glsl */ `
attribute float aMag;
attribute vec3 aColor;
uniform float uBrightness;
uniform float uPixelRatio;
uniform float uInvExposure;
varying vec3 vColor;
varying float vPeak;
void main() {
  float I = uBrightness * pow(10.0, -0.4 * aMag);
  float s = clamp(1.6 + 2.2 * log(1.0 + I * 6.0), 1.6, 14.0) * uPixelRatio;
  gl_PointSize = s;
  vPeak = I * 7.0 / (s * s / (uPixelRatio * uPixelRatio)) + I * 0.35;
  vColor = aColor * uInvExposure;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vPeak;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r2 = dot(q, q) * 4.0;
  float g = exp(-r2 * 5.0) + 0.04 * exp(-r2 * 0.8);
  gl_FragColor = vec4(vColor * vPeak * g, 1.0);
}`;

const MW_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const MW_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform sampler2D uMap;
uniform float uIntensity;
uniform float uInvExposure;
uniform float uCosE, uSinE;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  // world (three) -> ecliptic -> equatorial J2000
  float ex = d.x, ey = -d.z, ez = d.y;
  vec3 q = vec3(ex, uCosE * ey - uSinE * ez, uSinE * ey + uCosE * ez);
  float ra = atan(q.y, q.x);
  if (ra < 0.0) ra += 6.28318530718;
  float dec = asin(clamp(q.z, -1.0, 1.0));
  vec2 uv = vec2(ra / 6.28318530718, dec / 3.14159265359 + 0.5);
  float m = texture2D(uMap, uv).r;
  // mottled star clouds and dust lanes
  float n = fbm3(q * 22.0 + 3.0, 6);
  float lanes = smoothstep(0.05, 0.45, fbm3(q * 11.0 + 11.0, 5));
  float v = m * m * (0.6 + 0.8 * n) * (1.0 - 0.55 * lanes * m);
  vec3 col = mix(vec3(0.55, 0.6, 0.75), vec3(1.0, 0.9, 0.75), m) * v;
  // faint zodiacal/background glow
  col += vec3(0.012, 0.012, 0.016) * (1.0 + 0.5 * n);
  gl_FragColor = vec4(col * uIntensity * uInvExposure, 1.0);
}`;

export class Sky {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.brightness = 1.0;
  }

  async load(base) {
    const [starBuf, lines, mwTex] = await Promise.all([
      fetch(base + 'data/stars.bin').then((r) => r.arrayBuffer()),
      fetch(base + 'data/constellations.json').then((r) => r.json()),
      new THREE.TextureLoader().loadAsync(base + 'textures/milkyway.png'),
    ]);
    // --- stars
    const dv = new DataView(starBuf);
    const n = dv.getUint32(0, true);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), mag = new Float32Array(n);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const o = 4 + i * 8;
      const ra = (dv.getUint16(o, true) / 65535) * 360;
      const dec = (dv.getUint16(o + 2, true) / 65535) * 180 - 90;
      mag[i] = dv.getInt16(o + 4, true) / 1000;
      const bv = dv.getInt16(o + 6, true) / 1000;
      raDecToWorld(ra, dec, v).multiplyScalar(100);
      pos.set([v.x, v.y, v.z], i * 3);
      col.set(bvToRGB(bv), i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uBrightness: { value: 1 }, uPixelRatio: { value: 1 }, uInvExposure: { value: 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 2;
    this.scene.add(this.stars);

    // --- Milky Way
    mwTex.colorSpace = THREE.NoColorSpace;
    mwTex.wrapS = THREE.RepeatWrapping;
    mwTex.minFilter = THREE.LinearFilter;
    this.mwMat = new THREE.ShaderMaterial({
      vertexShader: MW_VERT,
      fragmentShader: MW_FRAG,
      uniforms: {
        uMap: { value: mwTex }, uIntensity: { value: 0.05 }, uInvExposure: { value: 1 },
        uCosE: { value: Math.cos(OBLIQUITY_J2000) }, uSinE: { value: Math.sin(OBLIQUITY_J2000) },
      },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.milkyWay = new THREE.Mesh(new THREE.SphereGeometry(500, 64, 32), this.mwMat);
    this.milkyWay.renderOrder = 0;
    this.scene.add(this.milkyWay);

    // --- constellation lines
    const seg = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const line of lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        raDecToWorld(line[i][0], line[i][1], a).multiplyScalar(90);
        raDecToWorld(line[i + 1][0], line[i + 1][1], b).multiplyScalar(90);
        seg.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    this.constMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0.25, 0.4, 0.7), transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
    this.constellations = new THREE.LineSegments(lg, this.constMat);
    this.constellations.renderOrder = 1;
    this.constellations.visible = false;
    this.scene.add(this.constellations);
  }

  update(mainCamera, exposure, pixelRatio) {
    this.camera.quaternion.copy(mainCamera.quaternion);
    this.camera.fov = mainCamera.fov;
    this.camera.aspect = mainCamera.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    if (!this.starMat) return;
    this.starMat.uniforms.uBrightness.value = this.brightness;
    this.starMat.uniforms.uPixelRatio.value = pixelRatio;
    this.starMat.uniforms.uInvExposure.value = 1 / exposure;
    this.mwMat.uniforms.uInvExposure.value = 1 / exposure;
    this.constMat.color.setRGB(0.25 / exposure, 0.4 / exposure, 0.7 / exposure);
  }
}
