// Soft eclipse shadows: fraction of the solar disc hidden by nearby spheres (moons, planets).
// Lengths in km, body frame, relative to the shaded body's centre.
export const ECLIPSE_GLSL = /* glsl */ `
#ifndef MAX_OCC
#define MAX_OCC 4
#endif
uniform vec3 uSunPos;        // sun centre (km)
uniform float uSunRadius;    // km
uniform vec4 uOcc[MAX_OCC];  // occluder centre (km), radius (km)
uniform vec3 uOccTint[MAX_OCC]; // light left in full shadow (red for Earth's refracting atmosphere)
uniform int uOccCount;

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
    float cover = min(1.0, (ao * ao) / (as * as));
    float f = clamp((as + ao - sep) / (2.0 * min(as, ao)), 0.0, 1.0);
    f = f * f * (3.0 - 2.0 * f);
    float occl = f * cover;
    vis *= mix(vec3(1.0), uOccTint[i], occl);
  }
  return vis;
}

`;
