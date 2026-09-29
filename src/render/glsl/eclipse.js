// Soft eclipse shadows: fraction of the solar disc hidden by nearby spheres (moons, planets).
// Lengths in km, body frame, relative to the shaded body's centre.
// Mirrored on the CPU by src/core/eclipse.js (eye adaptation during eclipses).
export const ECLIPSE_GLSL = /* glsl */ `
#ifndef MAX_OCC
#define MAX_OCC 4
#endif
uniform vec3 uSunPos;        // sun centre (km)
uniform float uSunRadius;    // km
uniform vec4 uOcc[MAX_OCC];  // occluder centre (km), radius (km)
// light left in the occluder's full shadow; x < 0: the Earth's refracting atmosphere (model below)
uniform vec3 uOccTint[MAX_OCC];
uniform int uOccCount;

// fraction of a uniform disc of angular radius a covered by a disc of radius b at separation d
float discOverlap(float a, float b, float d) {
  if (d >= a + b) return 0.0;
  if (d <= abs(a - b)) return min(1.0, (b * b) / (a * a));
  float a2 = a * a, b2 = b * b, d2 = d * d;
  float x = clamp((d2 + a2 - b2) / (2.0 * d * a), -1.0, 1.0);
  float y = clamp((d2 + b2 - a2) / (2.0 * d * b), -1.0, 1.0);
  float k = sqrt(max((-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b), 0.0));
  return clamp((a2 * acos(x) + b2 * acos(y) - 0.5 * k) / (PI * a2), 0.0, 1.0);
}

// Sunlight refracted into the Earth's umbra by its atmosphere (lunar eclipses): g = 0 on the shadow
// axis, 1 at the umbra's edge. Deep red and ~1e-4 of full sunlight at the centre, brighter and
// orange towards the edge, with the turquoise fringe of light filtered by stratospheric ozone.
vec3 earthUmbraLight(float g) {
  g = clamp(g, 0.0, 1.0);
  vec3 c = mix(vec3(1.6e-4, 2.6e-5, 4.0e-6), vec3(2.6e-3, 9.0e-4, 2.4e-4), g * g);
  c += vec3(0.0, 4.0e-4, 9.0e-4) * smoothstep(0.82, 1.0, g);
  return c;
}

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
    float occl = discOverlap(as, ao, sep);
    vec3 tint = uOccTint[i];
    if (tint.x < 0.0) tint = earthUmbraLight(sep / max(ao - as, 1e-6));
    vis *= mix(vec3(1.0), tint, occl);
  }
  return vis;
}

`;
