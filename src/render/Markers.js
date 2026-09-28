// Bodies smaller than a couple of pixels are drawn as point sources whose brightness follows
// the reflected sunlight (so e.g. the Galilean moons look like stars next to Jupiter).
import * as THREE from 'three';
import { AU, KM } from '../core/constants.js';
import { SUN_COLOR } from './BodyView.js';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor;
attribute float aSize;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_PointSize = aSize;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 q = gl_PointCoord - 0.5;
  float r2 = dot(q, q) * 4.0;
  gl_FragColor = vec4(vColor * exp(-r2 * 4.0), 1.0);
}`;

export class Markers {
  constructor(scene, count) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geom = g;
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    scene.add(this.points);
  }

  update(views, ctx) {
    let n = 0;
    for (const v of views) {
      if (v.visible && v.pixelRadius > 1.2) continue;
      const b = v.body;
      if (v.distance < 1) continue;
      const rel = v.relCam;
      // push the point slightly towards the camera so it is not hidden by its own (tiny) surface
      const k = Math.max(0, 1 - (b.radius * KM * 1.05) / v.distance);
      this.pos[n * 3] = rel.x * k; this.pos[n * 3 + 1] = rel.y * k; this.pos[n * 3 + 2] = rel.z * k;
      // radiance of the disc * solid angle / pixel solid angle
      const omega = Math.PI * ((b.radius * KM) / v.distance) ** 2;
      const pix = ctx.pixelAngle * ctx.pixelAngle;
      let I;
      let c = v.meanColor;
      if (b.type === 'star') {
        I = 14700 * omega / pix;
      } else {
        const toSun = ctx.sun.state.pos.clone().sub(b.state.pos);
        const ds = toSun.length();
        const toCam = rel.clone().negate();
        const phaseCos = toSun.dot(toCam) / (ds * v.distance);
        const phase = (1 + phaseCos) / 2;
        I = (b.albedo || 0.3) / Math.PI * (AU / ds) ** 2 * phase * omega / pix * 1.4;
      }
      const lum = (c.r + c.g + c.b) / 3 || 1;
      let disp = I * ctx.exposure;
      // keep every body at least faintly visible
      disp = Math.max(disp, ctx.markerFloor);
      const size = Math.min(10, 2.5 + Math.log2(1 + disp) * 1.2) * ctx.pixelRatio;
      const peak = (disp * 3.0) / Math.max(1, (size / ctx.pixelRatio) ** 2 / 6);
      this.col[n * 3] = (c.r / lum) * SUN_COLOR.x * peak;
      this.col[n * 3 + 1] = (c.g / lum) * SUN_COLOR.y * peak;
      this.col[n * 3 + 2] = (c.b / lum) * SUN_COLOR.z * peak;
      this.size[n] = size;
      n++;
      if (n >= this.count) break;
    }
    this.geom.setDrawRange(0, n);
    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.aColor.needsUpdate = true;
    this.geom.attributes.aSize.needsUpdate = true;
  }
}
