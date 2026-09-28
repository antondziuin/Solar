#!/usr/bin/env python3
"""Turn plate shape models of small, irregular moons into radius maps (the same DEM format as
scripts/build_body_maps.py), so the viewer can render their real shapes with infinite detail.

Models (CelestiaContent, github.com/CelestiaProject/CelestiaContent, clone to ../../celestia-content
or set CELESTIA=...):
  amalthea, proteus  - P. Stooke small-body shape models (NASA PDS) as distributed with Celestia
  hyperion           - Thomas, Joseph & Ansty, Saturn Small Moon Shape Models V1.0 (NASA PDS, CC0)
  deimos             - Ernst et al. 2023, Earth Planets Space (CC-BY-4.0)

Celestia models are body-fixed (y along the spin axis, the prime meridian - facing the planet for
these synchronous moons - at -x). Each is scaled so its long axis matches the IAU value.
Output: public/bodies/<id>_dem.png (height above a sphere of the median radius; "scale" metres per
unit when the relief exceeds +-32 km) + manifest part.
Run: python3 scripts/build_shape_models.py
"""
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "bodies")
CEL = os.environ.get("CELESTIA", os.path.join(os.path.dirname(ROOT), "celestia-content"))

# optional Celestia textures (mapped through the model's texture coordinates)
TEXTURES = {
    "amalthea": ("textures/lores/amalthea.jpg", "Celestia (ItzImcool, CC-BY-4.0), reprojected Galileo imagery"),
}

# id: (model file, IAU semi-major axis a (km), source)
MODELS = {
    "amalthea": ("models/amalthea.cmod", 125.0, "Stooke small-body shape model (NASA PDS), via Celestia"),
    "proteus": ("models/proteus.cmod", 218.0, "Stooke small-body shape model (NASA PDS), via Celestia"),
    "hyperion": ("models/hyperion.cmod", 180.1, "Thomas et al., Saturn Small Moon Shape Models V1.0 (NASA PDS), via Celestia"),
    "deimos": ("models/deimos.cmod", 7.8, "Ernst et al. 2023 (CC-BY-4.0), via Celestia"),
}


def read_cmod(path):
    """Minimal reader for Celestia binary models: triangle vertex positions (n, 3, 3) and
    texture coordinates (n, 3, 2) or None."""
    b = open(path, "rb").read()
    assert b[:16] == b"#celmodel_binary", "not a binary cmod"
    p = 16
    u16 = lambda: struct.unpack_from("<H", b, p)[0]
    tris, uvs = [], []
    fmt_size = {0: 1, 1: 2, 2: 3, 3: 4, 4: 1}  # Float1..Float4, UByte4 (4 bytes = 1 float slot)
    while p < len(b):
        tok = u16(); p += 2
        if tok == 1001:  # material: skip properties until EndMaterial
            while True:
                t = u16(); p += 2
                if t == 1002:
                    break
                if t == 1007:  # texture: semantic
                    p += 2
                typ = u16(); p += 2
                if typ == 7:
                    p += 12
                elif typ in (1, 2, 3, 4):
                    p += 4 * typ
                elif typ == 5:
                    n = u16(); p += 2 + n
                elif typ == 6:
                    p += 4
        elif tok == 1009:  # mesh
            assert u16() == 1011; p += 2
            attrs = []
            while True:
                s = u16(); p += 2
                if s == 1012:
                    break
                f = u16(); p += 2
                attrs.append((s, f))
            stride = sum(fmt_size[f] for _, f in attrs) * 4
            offs, o = {}, 0
            for s, f in attrs:
                offs[s] = o
                o += fmt_size[f] * 4
            pos_off = offs[0]
            assert u16() == 1013; p += 2
            nv = struct.unpack_from("<I", b, p)[0]; p += 4
            raw = np.frombuffer(b, np.uint8, nv * stride, p).reshape(nv, stride)
            verts = raw[:, pos_off:pos_off + 12].copy().view("<f4").reshape(nv, 3).astype(np.float64)
            tex = raw[:, offs[5]:offs[5] + 8].copy().view("<f4").reshape(nv, 2).astype(np.float64) if 5 in offs else None
            def add(ix):
                tris.append(verts[ix])
                uvs.append(tex[ix] if tex is not None else np.zeros(ix.shape + (2,)))
            p += nv * stride
            while True:
                t = u16(); p += 2
                if t == 1010:
                    break
                p += 4  # material index
                ni = struct.unpack_from("<I", b, p)[0]; p += 4
                idx = np.frombuffer(b, "<u4", ni, p); p += 4 * ni
                if t == 0:
                    add(idx.reshape(-1, 3))
                elif t == 1:  # strip
                    for k in range(ni - 2):
                        add((idx[k:k + 3] if k % 2 == 0 else idx[[k + 1, k, k + 2]])[None])
                elif t == 2:  # fan
                    for k in range(1, ni - 1):
                        add(idx[[0, k, k + 1]][None])
        else:
            raise ValueError(f"unexpected token {tok} at {p}")
    return np.concatenate(tris, 0), np.concatenate(uvs, 0)


def radius_map(tris, W, H, uvs=None):
    """Ray-cast from the centre for every (lat, lon) cell: radius of the outermost hit.
    Triangles are binned by the lat/lon cells they can cover, then only (ray, triangle)
    candidate pairs are tested (vectorised Moller-Trumbore)."""
    lat = np.radians(90 - 180 * (np.arange(H) + 0.5) / H)
    lon = np.radians(-180 + 360 * (np.arange(W) + 0.5) / W)
    LON, LAT = np.meshgrid(lon, lat)
    D = np.stack([np.cos(LAT) * np.cos(LON), np.cos(LAT) * np.sin(LON), np.sin(LAT)], -1).reshape(-1, 3)
    # angular footprint of every triangle, in cell units
    tl = np.degrees(np.arctan2(tris[..., 2], np.hypot(tris[..., 0], tris[..., 1])))
    tg = np.degrees(np.arctan2(tris[..., 1], tris[..., 0]))
    rows0 = np.floor((90 - tl.max(1)) * H / 180).astype(int) - 1
    rows1 = np.floor((90 - tl.min(1)) * H / 180).astype(int) + 1
    g0, g1 = tg.min(1), tg.max(1)
    wrap = g1 - g0 > 180
    tw = np.where(tg < 0, tg + 360, tg)
    g0 = np.where(wrap, tw.min(1), g0)
    g1 = np.where(wrap, tw.max(1), g1)
    pole = g1 - g0 > 180                    # the triangle surrounds a pole
    north = tl.mean(1) > 0
    rows0 = np.where(pole & north, 0, rows0)
    rows1 = np.where(pole & ~north, H - 1, rows1)
    c0 = np.floor((g0 + 180) * W / 360).astype(int) - 1
    c1 = np.floor((g1 + 180) * W / 360).astype(int) + 1
    c0 = np.where(pole, 0, c0)
    c1 = np.where(pole, W - 1, c1)
    rows0, rows1 = np.clip(rows0, 0, H - 1), np.clip(rows1, 0, H - 1)
    ti, ri = [], []
    for t in range(len(tris)):
        rr = np.arange(rows0[t], rows1[t] + 1)
        cc = np.arange(c0[t], c1[t] + 1) % W
        ri.append((rr[:, None] * W + cc[None, :]).ravel())
        ti.append(np.full(ri[-1].size, t))
    ti, ri = np.concatenate(ti), np.concatenate(ri)
    r = np.zeros(len(D))
    best = np.full(len(D), -1)            # candidate pair index of the outermost hit
    bu = np.zeros(len(D)); bv = np.zeros(len(D))
    for s in range(0, len(ti), 2_000_000):
        T, R = ti[s:s + 2_000_000], ri[s:s + 2_000_000]
        v0, e1, e2 = tris[T, 0], tris[T, 1] - tris[T, 0], tris[T, 2] - tris[T, 0]
        d = D[R]
        pv = np.cross(d, e2)
        det = (e1 * pv).sum(1)
        ok = np.abs(det) > 1e-18
        inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
        tv = -v0
        u = (tv * pv).sum(1) * inv
        qv = np.cross(tv, e1)
        v = (d * qv).sum(1) * inv
        dist = (e2 * qv).sum(1) * inv
        hit = ok & (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9) & (dist > 0)
        np.maximum.at(r, R[hit], dist[hit])
        if uvs is not None:
            k = np.where(hit & (dist >= r[R]))[0]  # the outermost hit so far
            best[R[k]] = T[k]; bu[R[k]] = u[k]; bv[R[k]] = v[k]
    r2 = r.reshape(H, W)
    for _ in range(4):  # numerical misses on edges: fill from neighbours
        m = r2 == 0
        if not m.any():
            break
        nb = np.maximum(np.roll(r2, 1, 1), np.roll(r2, -1, 1))
        r2[m] = nb[m]
    if uvs is None:
        return r2
    ok = best >= 0
    t = np.clip(best, 0, None)
    uv = (uvs[t, 0] * (1 - bu - bv)[:, None] + uvs[t, 1] * bu[:, None] + uvs[t, 2] * bv[:, None])
    return r2, uv.reshape(H, W, 2), ok.reshape(H, W)


def main():
    os.makedirs(OUT, exist_ok=True)
    only = set(sys.argv[1:])
    for bid, (rel, a_km, src) in MODELS.items():
        if only and bid not in only:
            continue
        tris, uvs = read_cmod(os.path.join(CEL, rel))
        # Celestia model frame is y-up: north pole +y, longitude 0 at -x, 90 deg E at +z
        # (Body::planetocentricToCartesian) -> body frame (-x, z, y) with z north, x at lon 0.
        # The model origin is the centre of mass of the shape model; keep it.
        tris = np.stack([-tris[..., 0], tris[..., 2], tris[..., 1]], -1)
        pts = tris.reshape(-1, 3)
        tris = tris * (2 * a_km * 1000 / np.ptp(pts, 0).max())  # longest axis = 2a (IAU)
        W, H = 360, 180
        r = radius_map(tris, W, H)
        R = float(np.median(r))
        h = r - R
        scale = max(1, int(np.ceil(np.abs(h).max() / 32000)))  # metres per DEM unit
        v = np.clip(np.round(h / scale) + 32768, 0, 65535).astype(np.uint32)
        rgb = np.stack([(v >> 8) & 255, v & 255, np.full_like(v, 255)], -1).astype(np.uint8)
        path = os.path.join(OUT, f"{bid}_dem.png")
        Image.fromarray(rgb, "RGB").save(path, optimize=True)
        p2 = tris.reshape(-1, 3) / 1000
        print(f"{bid}: {len(tris)} triangles, size {np.ptp(p2, 0).round(1)} km, R={R / 1000:.1f} km, "
              f"h {h.min():.0f}..{h.max():.0f} m, scale {scale}")
        part = {"file": f"bodies/{bid}_dem.png", "radius": R, "width": W, "height": H, "source": src, "shape": True}
        if scale != 1:
            part["scale"] = scale
        json.dump(part, open(os.path.join(OUT, f"{bid}_dem.part.json"), "w"), indent=1)
        if bid in TEXTURES:
            trel, tsrc = TEXTURES[bid]
            tex = np.asarray(Image.open(os.path.join(CEL, trel)).convert("RGB"), np.float32)
            TW, TH = 1024, 512
            _, uv, ok = radius_map(tris, TW, TH, uvs)
            th, tw = tex.shape[:2]
            x = np.clip(uv[..., 0] % 1.0 * tw - 0.5, 0, tw - 1.001)
            y = np.clip(uv[..., 1] * th - 0.5, 0, th - 1.001)   # cmod v runs from the top row
            x0, y0 = x.astype(int), y.astype(int)
            fx, fy = (x - x0)[..., None], (y - y0)[..., None]
            x1, y1 = np.minimum(x0 + 1, tw - 1), np.minimum(y0 + 1, th - 1)
            img = (tex[y0, x0] * (1 - fx) * (1 - fy) + tex[y0, x1] * fx * (1 - fy)
                   + tex[y1, x0] * (1 - fx) * fy + tex[y1, x1] * fx * fy)
            for _ in range(4):  # rays that slipped between triangles (poles): take a neighbour
                if ok.all():
                    break
                for sh in (1, -1):
                    src = np.roll(ok, sh, 0) & ~ok
                    img[src] = np.roll(img, sh, 0)[src]
                    ok = ok | src
            img = np.where(ok[..., None], np.maximum(img, 14), 0)
            Image.fromarray(img.astype(np.uint8), "RGB").save(os.path.join(OUT, f"{bid}_map.jpg"), quality=92)
            print(f"  map: {ok.mean() * 100:.1f}% covered")
            mpart = {"file": f"bodies/{bid}_map.jpg", "width": TW, "height": TH, "source": tsrc}
            json.dump(mpart, open(os.path.join(OUT, f"{bid}_map.part.json"), "w"), indent=1)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import build_body_maps
    build_body_maps.write_manifest()


if __name__ == "__main__":
    main()
