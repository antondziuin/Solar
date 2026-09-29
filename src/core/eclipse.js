// CPU mirror of the eclipse shading (src/render/glsl/eclipse.js): how much sunlight reaches a
// point, used to adapt the exposure while the camera or the focused body is in a shadow.
import { KM } from './constants.js';

function discOverlap(a, b, d) {
  if (d >= a + b) return 0;
  if (d <= Math.abs(a - b)) return Math.min(1, (b * b) / (a * a));
  const a2 = a * a, b2 = b * b, d2 = d * d;
  const x = Math.max(-1, Math.min(1, (d2 + a2 - b2) / (2 * d * a)));
  const y = Math.max(-1, Math.min(1, (d2 + b2 - a2) / (2 * d * b)));
  const k = Math.sqrt(Math.max((-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b), 0));
  return Math.max(0, Math.min(1, (a2 * Math.acos(x) + b2 * Math.acos(y) - 0.5 * k) / (Math.PI * a2)));
}

function earthUmbraLum(g) {
  g = Math.max(0, Math.min(1, g));
  const t = g * g;
  const r = 1.6e-4 + (2.6e-3 - 1.6e-4) * t, gg = 2.6e-5 + (9e-4 - 2.6e-5) * t, b = 4e-6 + (2.4e-4 - 4e-6) * t;
  return 0.2126 * r + 0.7152 * gg + 0.0722 * b;
}

/**
 * Luminance fraction of full sunlight at world position p (m), with every other body as occluder.
 * skyGlow: p is in an atmosphere, which keeps a little light in a moon's umbra.
 */
export function sunlightFraction(p, bodies, sun, exclude = null, skyGlow = false) {
  const S = sun.state.pos.clone().sub(p);
  const ds = S.length();
  const as = (sun.radius * KM) / ds;
  let vis = 1;
  for (const o of bodies) {
    if (o === sun || o === exclude || o.type === 'star') continue;
    const O = o.state.pos.clone().sub(p);
    const dO = O.length();
    if (dO > ds || dO < o.radius * KM) continue;
    const ao = (o.radius * KM) / dO;
    const sep = Math.acos(Math.max(-1, Math.min(1, S.dot(O) / (ds * dO))));
    if (sep > as + ao) continue;
    const occl = discOverlap(as, ao, sep);
    const tint = o.id === 'earth' ? earthUmbraLum(sep / Math.max(ao - as, 1e-9)) : o.atmosphere ? 0.006 : skyGlow ? 1.8e-4 : 0;
    vis *= 1 + (tint - 1) * occl;
  }
  return vis;
}
