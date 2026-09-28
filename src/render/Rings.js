// Planetary rings: a flat annulus in the equatorial plane, ray-cast per pixel so that the
// radial structure (and, very close up, individual particles) stays sharp at any zoom.
import * as THREE from 'three';
import { NOISE_GLSL } from './glsl/noise.js';
import { MAX_OCTAVES } from './glsl/terrain.js';
import { makeRingTexture } from './materials.js';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
out vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#define MAX_OCT ${MAX_OCTAVES}
${NOISE_GLSL}
uniform mat3 uRotInv;
uniform vec3 uCamPF;       // m, body frame
uniform float uCamR;       // |camPF.xy| (m)
uniform float uCamOffR[MAX_OCT];
uniform vec2 uCamOffXY[MAX_OCT];
uniform sampler2D uRingTex;
uniform vec2 uRange;       // m
uniform vec3 uSunDir;      // body frame
uniform vec3 uSunIrr;
uniform float uAlbedo;
uniform vec3 uPlanetRadii; // m
uniform float uPixelCut;
uniform float uLambda0;
uniform mat3 uRayBasis; // camera right*tan, up*tan, forward: exact per-pixel view rays
uniform vec2 uResolution;
in vec3 vWorld;

void main() {
  #include <logdepthbuf_fragment>
  vec3 ray = uRayBasis * vec3(gl_FragCoord.xy / uResolution * 2.0 - 1.0, 1.0);
  vec3 d = uRotInv * normalize(ray);
  if (abs(d.z) < 1e-7) discard;
  float t = -uCamPF.z / d.z;
  if (t <= 0.0) discard;
  vec2 c = uCamPF.xy;
  vec2 off = d.xy * t;
  float r = length(c + off);
  float dr = (2.0 * dot(c, off) + dot(off, off)) / (r + uCamR);
  float u = (r - uRange.x) / (uRange.y - uRange.x);
  if (u < 0.0 || u > 1.0) discard;
  vec4 prof = texture(uRingTex, vec2(u, 0.5));
  float tau = prof.a;
  float mu = max(abs(d.z), 1e-3);
  float foot = t * uPixelCut / mu;

  // radial fine structure (ringlets, waves) at every scale above the pixel footprint
  float m = 0.0, amp = 0.5;
  float lam = uLambda0;
  for (int k = 0; k < MAX_OCT; k++) {
    float w = clamp(log2(lam / foot), 0.0, 1.0);
    if (w <= 0.0 || lam < 30.0) break;
    float x = dr / lam + uCamOffR[k];
    m += w * amp * gnoise(vec3(x, 0.37, 0.71));
    amp *= 0.82;
    lam *= 0.5;
  }
  tau *= exp(1.3 * m);

  // self-gravity wakes and individual particles when very close
  float coverage = 1.0 - exp(-tau / mu);
  float pw = clamp(log2(8.0 / max(foot, 1e-6)), 0.0, 1.0);
  vec3 pn = vec3(0.0, 0.0, 1.0);
  float pHit = 0.0;
  if (pw > 0.0 && tau > 0.0) {
    float fill = clamp(1.0 - exp(-tau), 0.0, 0.9);
    float lamP = uLambda0;
    int k0 = int(ceil(log2(uLambda0 / 16.0)));
    lamP = uLambda0 * exp2(-float(k0));
    for (int j = 0; j < 5; j++) {
      int k = k0 + j;
      if (k >= MAX_OCT) break;
      vec2 x = off / lamP + uCamOffXY[k];
      vec2 cell = floor(x);
      vec3 h = hash3(vec3(cell, float(j) * 17.0));
      if (h.x < fill) {
        vec2 q = x - (cell + 0.3 + 0.4 * h.yz);
        float rr = 0.12 + 0.18 * h.y;
        float dd = length(q) / rr;
        if (dd < 1.0 && pHit == 0.0) {
          pHit = 1.0;
          pn = normalize(vec3(q / rr, sqrt(1.0 - dd * dd)));
          if (d.z > 0.0) pn.z = -pn.z;
        }
      }
      lamP *= 0.5;
    }
    coverage = mix(coverage, pHit, pw);
  }
  if (coverage < 1e-4) discard;

  // lighting: single-scattering slab, lit or unlit face
  vec3 L = uSunDir;
  float mu0 = max(abs(L.z), 1e-3);
  bool lit = (L.z > 0.0) == (uCamPF.z > 0.0);
  float cosScat = dot(-d, L);
  float phase = 0.8 + 0.6 * pow(max(-cosScat, 0.0), 3.0) + 0.9 * pow(max(cosScat, 0.0), 12.0); // back + forward scattering
  float refl;
  if (lit) refl = mu0 / (mu0 + mu) * (1.0 - exp(-tau * (1.0 / mu + 1.0 / mu0)));
  else refl = abs(mu - mu0) < 1e-3 ? tau / mu * exp(-tau / mu) : mu0 / (mu0 - mu) * (exp(-tau / mu0) - exp(-tau / mu));
  refl = max(refl, 0.0);
  float particleShade = max(dot(pn, vec3(L.xy, abs(L.z) * (lit ? 1.0 : -1.0))), 0.0);
  refl = mix(refl, particleShade * 0.6, pw * pHit);
  // shadow of the planet on the rings
  vec3 p = vec3(c + off, 0.0) / uPlanetRadii;
  vec3 Ls = normalize(L / uPlanetRadii);
  float b = dot(p, Ls);
  float disc = b * b - dot(p, p) + 1.0;
  float shadow = (b < 0.0 && disc > 0.0) ? 1.0 - smoothstep(0.0, 0.004, disc) : 0.0;
  vec3 col = prof.rgb * uAlbedo * phase * refl * uSunIrr * (1.0 - shadow);
  float a = coverage;
  // premultiplied: the reflectance already accounts for coverage
  gl_FragColor = vec4(col / 3.14159265 * 2.0 * mix(1.0, a, pw * pHit), a);
}`;

export class RingView {
  constructor(body) {
    this.body = body;
    const { tex, inner, outer } = makeRingTexture(body.rings, body.surface.seed || 0);
    this.inner = inner * 1000;
    this.outer = outer * 1000;
    const geom = new THREE.RingGeometry(this.inner * 0.995, this.outer * 1.005, 512, 1);
    this.camOffR = new Array(MAX_OCTAVES).fill(0);
    this.camOffXY = Array.from({ length: MAX_OCTAVES }, () => new THREE.Vector2());
    this.lambda0 = 2.0e6;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uRotInv: { value: new THREE.Matrix3() },
        uCamPF: { value: new THREE.Vector3() },
        uCamR: { value: 0 },
        uCamOffR: { value: this.camOffR },
        uCamOffXY: { value: this.camOffXY },
        uRingTex: { value: tex },
        uRange: { value: new THREE.Vector2(this.inner, this.outer) },
        uSunDir: { value: new THREE.Vector3() },
        uSunIrr: { value: new THREE.Vector3() },
        uAlbedo: { value: body.rings.albedo ?? 0.5 },
        uPlanetRadii: { value: new THREE.Vector3(body.radius * 1000, body.radius * 1000, (body.polarRadius || body.radius) * 1000) },
        uPixelCut: { value: 0.002 },
        uLambda0: { value: this.lambda0 },
        uRayBasis: { value: new THREE.Matrix3() },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 4;
  }

  update(relCam, rot, rotInv, camPF, sunDirPF, sunIrr, pixelCut, invViewProj, resolution) {
    this.material.uniforms.uRayBasis.value.copy(invViewProj);
    this.material.uniforms.uResolution.value.copy(resolution);
    const e = rot.elements;
    this.mesh.matrix.set(
      e[0], e[3], e[6], relCam.x,
      e[1], e[4], e[7], relCam.y,
      e[2], e[5], e[8], relCam.z,
      0, 0, 0, 1,
    );
    this.mesh.matrixWorld.copy(this.mesh.matrix);
    const U = this.material.uniforms;
    U.uRotInv.value.copy(rotInv);
    U.uCamPF.value.copy(camPF);
    const camR = Math.hypot(camPF.x, camPF.y);
    U.uCamR.value = camR;
    let f = 1 / this.lambda0;
    const m = (v) => ((v % 289) + 289) % 289;
    for (let k = 0; k < MAX_OCTAVES; k++) {
      this.camOffR[k] = m(camR * f);
      this.camOffXY[k].set(m(camPF.x * f), m(camPF.y * f));
      f *= 2;
    }
    U.uSunDir.value.copy(sunDirPF);
    U.uSunIrr.value.copy(sunIrr);
    U.uPixelCut.value = pixelCut;
  }
}
