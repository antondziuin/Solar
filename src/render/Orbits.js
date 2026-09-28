import * as THREE from 'three';
import { orbitalPeriodDays } from '../core/ephemeris.js';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uFadeNear;
varying float vFade;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  float d = length(w.xyz);
  vFade = smoothstep(uFadeNear, uFadeNear * 4.0, d);
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;
const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uColor * uOpacity * vFade, 1.0);
}`;

const COLORS = { planet: 0x4f7bd8, dwarf: 0x9a7bd8, moon: 0x5aa0a8 };

export class Orbits {
  constructor(scene, ephem) {
    this.ephem = ephem;
    this.items = [];
    this.visible = true;
    for (const b of ephem.bodies) {
      if (!b.parent) continue;
      const parent = ephem.byId[b.parent];
      const n = b.type === 'moon' ? 360 : 720;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uColor: { value: new THREE.Color(COLORS[b.type] || 0x888888) }, uOpacity: { value: 0.5 }, uFadeNear: { value: 1 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const line = new THREE.LineLoop(geom, mat);
      line.frustumCulled = false;
      line.matrixAutoUpdate = false;
      line.renderOrder = 6;
      scene.add(line);
      this.items.push({ body: b, parent, line, n, period: orbitalPeriodDays(b, parent), sampledAt: null, a: 0 });
    }
  }

  _resample(it, ut) {
    const pts = this.ephem.sampleOrbit(it.body, ut, it.n);
    const arr = it.line.geometry.attributes.position.array;
    let a = 0;
    // store relative to the first point's parent-centred frame (float-safe: magnitudes <= orbit size)
    pts.forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; a = Math.max(a, p.length()); });
    it.line.geometry.attributes.position.needsUpdate = true;
    it.sampledAt = ut;
    it.a = a;
  }

  update(ut, camPos, pixelAngle, focusId, lowFade = 1) {
    for (const it of this.items) {
      const { line, parent, body } = it;
      if (!this.visible) { line.visible = false; continue; }
      const rel = parent.state.pos.clone().sub(camPos);
      const dist = rel.length();
      if (it.sampledAt === null || Math.abs(ut - it.sampledAt) > it.period * (body.type === 'moon' ? 0.05 : 0.02)) this._resample(it, ut);
      const px = it.a / Math.max(dist, 1) / pixelAngle;
      let op = Math.min(1, Math.max(0, (px - 12) / 40)) * lowFade;
      if (body.type === 'moon' && px > 20000) op *= 0.6;
      const isFocus = body.id === focusId;
      const sameSystem = focusId && (body.parent === focusId || body.id === focusId);
      line.material.uniforms.uOpacity.value = op * (isFocus ? 0.8 : sameSystem ? 0.3 : body.type === 'moon' ? 0.15 : 0.22);
      line.material.uniforms.uFadeNear.value = Math.max(it.a * 0.004, body.radius * 1000 * 8);
      line.visible = op > 0.001;
      line.matrix.makeTranslation(rel.x, rel.y, rel.z);
      line.matrixWorld.copy(line.matrix);
    }
  }
}
