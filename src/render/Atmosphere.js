// Sky / limb glow: an ellipsoidal shell drawn with back faces so that it only covers pixels
// where no surface was drawn (sky from the ground, limb from space).
import * as THREE from 'three';
import { ATMOSPHERE_GLSL } from './glsl/atmosphere.js';
import { atmosphereUniforms } from './materials.js';

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
${ATMOSPHERE_GLSL}
uniform mat3 uRotInv;
uniform vec3 uCamPF;   // km, body frame
uniform vec3 uSunDir;  // body frame
uniform vec3 uSunIrr;
uniform float uExposureComp;
in vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(uRotInv * normalize(vWorld));
  vec3 ro = uCamPF * uAtmoScale;
  rd = normalize(rd * uAtmoScale);
  vec3 L = normalize(uSunDir * uAtmoScale);
  vec2 ta = raySphere(ro, rd, uAtmoShape.y);
  if (ta.y <= 0.0) discard;
  float t0 = max(ta.x, 0.0);
  float t1 = ta.y;
  vec2 tg = raySphere(ro, rd, uAtmoShape.x);
  if (tg.x > 0.0) t1 = min(t1, tg.x);
  vec3 tr;
  vec3 ins = atmoScatter(ro, rd, t0, t1, L, tr);
  float a = 1.0 - dot(tr, vec3(0.3333));
  gl_FragColor = vec4(ins * uSunIrr, clamp(a, 0.0, 1.0));
}`;

export class AtmosphereShell {
  constructor(body) {
    this.body = body;
    const a = body.atmosphere;
    const groundKm = body.radius + (body.renderRadiusOffset || 0);
    const eq = body.radius, pol = body.polarRadius || eq;
    this.topKm = groundKm + a.height;
    this.flat = pol / eq;
    const U = atmosphereUniforms(body, groundKm);
    Object.assign(U, {
      uRotInv: { value: new THREE.Matrix3() },
      uCamPF: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3() },
      uSunIrr: { value: new THREE.Vector3() },
      uExposureComp: { value: 1 },
    });
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: U,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    const geom = new THREE.SphereGeometry(1, 160, 80);
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 5;
    this._m4 = new THREE.Matrix4();
  }

  /** relCam: body centre relative to camera (world); rot: body->world Matrix3 */
  update(relCam, rot, rotInv, camPF, sunDirPF, sunIrr) {
    const R = this.topKm * 1000 * 1.003; // faceting margin
    const e = rot.elements;
    // columns scaled by radii (sphere geometry is Y-up; map geometry z -> body z)
    this.mesh.matrix.set(
      e[0] * R, e[3] * R, e[6] * R * this.flat, relCam.x,
      e[1] * R, e[4] * R, e[7] * R * this.flat, relCam.y,
      e[2] * R, e[5] * R, e[8] * R * this.flat, relCam.z,
      0, 0, 0, 1,
    );
    this.mesh.matrixWorld.copy(this.mesh.matrix);
    const U = this.material.uniforms;
    U.uRotInv.value.copy(rotInv);
    U.uCamPF.value.copy(camPF).multiplyScalar(0.001);
    U.uSunDir.value.copy(sunDirPF);
    U.uSunIrr.value.copy(sunIrr);
  }
}
