#!/usr/bin/env python3
"""Bake the Earth's coastlines and lakes into a signed-distance texture.

Source: Natural Earth 1:10m vectors (public domain; ocean and lake polygons), via GitHub
(nvkelso/natural-earth-vector). Lake surface levels come from the Terrarium elevation tiles
cached by build_earth_dem.py (zoom 5, ~5 km).

Output:
  public/textures/earth_coast.png   8192 x 4096 RGB8, rows from +90 (top) to -90, columns from -180
    R: signed distance to the sea shore,  G: signed distance to a lake shore
       value = 128 + 16 * distance in texels (positive on land), clamped to [1, 255]:
       bilinear filtering of a distance field gives smooth, sub-texel coastlines
    B: index (1..255) of the lake the texel belongs to (dilated a few texels); 0: none
  public/textures/earth_lakes.json  surface level (m) of each indexed lake

Run:  python3 scripts/build_earth_coast.py   (needs numpy, scipy, rasterio, Pillow)
"""
import json
import os
import urllib.request

import numpy as np
import rasterio.features
from PIL import Image
from rasterio.transform import from_origin
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache")
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/{}.geojson"
W, H = 8192, 4096
SS = 2  # supersampling of the distance transform
SCALE = 16  # code units per texel
MAX_LAKES = 255

# Levels of lakes whose floor the elevation tiles contain (bathymetry), metres above sea level
KNOWN_LEVELS = {
    "Lake Superior": 183, "Lake Michigan": 176, "Lake Huron": 176, "Lake Erie": 174,
    "Lake Ontario": 75, "Georgian Bay": 176, "Lake St. Clair": 175, "Caspian Sea": -28, "Lake Baikal": 456,
    "Lake Tanganyika": 773, "Lake Malawi": 474, "Lake Victoria": 1134, "Lake Titicaca": 3812,
    "Lake Ladoga": 5, "Lake Onega": 33, "Great Bear Lake": 156, "Great Slave Lake": 156,
    "Lake Winnipeg": 217, "Dead Sea": -430, "Issyk-Kul": 1607, "Lake Geneva": 372,
    "Lake Constance": 395, "Lake Tahoe": 1897, "Crater Lake": 1883, "Lake Van": 1640,
    "Lake Khanka": 69, "Lake Balkhash": 342, "Lake Turkana": 360, "Lake Albert": 619,
    "Lake Edward": 912, "Lake Kivu": 1460, "Lake Nicaragua": 32, "Lake Maracaibo": 0,
    "Lake Vänern": 44, "Lake Vättern": 88, "Lake Peipus": 30, "Great Salt Lake": 1280,
    "Lake Chad": 280, "Lake Nasser": 180, "Qinghai Lake": 3196, "Lake Hovsgol": 1645,
}


def geojson(name):
    path = os.path.join(CACHE, "naturalearth", name + ".geojson")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        urllib.request.urlretrieve(NE.format(name), path)
    with open(path) as f:
        return json.load(f)["features"]


def rasterize(features, w, h, values=None):
    shapes = [(f["geometry"], v) for f, v in zip(features, values or [1] * len(features)) if f["geometry"]]
    return rasterio.features.rasterize(shapes, out_shape=(h, w), transform=from_origin(-180, 90, 360 / w, 180 / h),
                                       fill=0, dtype="int32" if values else "uint8")


def sdf(mask):
    """Signed distance (final texels, positive outside the mask) from a supersampled mask."""
    inside = ndimage.distance_transform_edt(mask).astype(np.float32)
    outside = ndimage.distance_transform_edt(~mask).astype(np.float32)
    d = np.where(mask, 0.5 - inside, outside - 0.5) / SS
    d = d.reshape(H, SS, W, SS).mean(axis=(1, 3))
    return np.clip(np.round(128 + SCALE * d), 1, 255).astype(np.uint8)


def terrarium_mosaic():
    z = 5
    n = 2 ** z
    mos = np.zeros((n * 256, n * 256), np.float32)
    for x in range(n):
        for y in range(n):
            a = np.asarray(Image.open(os.path.join(CACHE, "terrarium", str(z), str(x), f"{y}.png")).convert("RGB"), np.float32)
            mos[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    return mos


def sample_mercator(mos, lat, lon):
    n = mos.shape[0]
    lat = np.clip(lat, -85.05, 85.05)
    x = (lon + 180) / 360 * n - 0.5
    y = (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / np.pi) / 2 * n - 0.5
    return ndimage.map_coordinates(mos, [y, x % n], order=1, mode="nearest")


def main():
    ocean = geojson("ne_10m_ocean")
    lakes = geojson("ne_10m_lakes")
    # the Caspian Sea is part of Natural Earth's ocean; it is a lake 28 m below sea level
    parts = []
    for f in ocean:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        keep = []
        for poly in polys:
            xs = [c[0] for c in poly[0]]; ys = [c[1] for c in poly[0]]
            if 45 < min(xs) and max(xs) < 56 and 35 < min(ys) and max(ys) < 48:
                parts.append(poly)
            else:
                keep.append(poly)
        f["geometry"] = {"type": "MultiPolygon", "coordinates": keep}
    for poly in parts:
        lakes.insert(0, {"geometry": {"type": "Polygon", "coordinates": poly}, "properties": {"name": "Caspian Sea"}})
    print("ocean sdf...")
    r = sdf(rasterize(ocean, W * SS, H * SS).astype(bool))
    print("lake sdf...")
    g = sdf(rasterize(lakes, W * SS, H * SS).astype(bool))

    print("lake levels...")
    ids = rasterize(lakes, W, H, values=list(range(1, len(lakes) + 1)))
    lat = 90 - (np.arange(H) + 0.5) / H * 180
    area = ndimage.sum_labels(np.cos(np.radians(lat))[:, None] * np.ones((1, W), np.float32), ids, np.arange(len(lakes) + 1))
    order = [int(i) for i in np.argsort(-area) if i > 0 and area[i] > 0][:MAX_LAKES]
    mos = terrarium_mosaic()
    b = np.zeros((H, W), np.uint8)
    levels = []
    for k, fid in enumerate(order, start=1):
        m = ids == fid
        ys, xs = np.nonzero(m)
        y0, y1, x0, x1 = max(ys.min() - 3, 0), min(ys.max() + 4, H), max(xs.min() - 3, 0), min(xs.max() + 4, W)
        sub = m[y0:y1, x0:x1]
        ring = ndimage.binary_dilation(sub, iterations=2) & ~sub
        yy, xx = np.mgrid[y0:y1, x0:x1]
        la, lo = 90 - (yy + 0.5) / H * 180, -180 + (xx + 0.5) / W * 360
        inner = sample_mercator(mos, la[sub], lo[sub])
        shore = sample_mercator(mos, la[ring], lo[ring])
        name = lakes[fid - 1]["properties"].get("name") or ""
        med, p25 = float(np.median(inner)), float(np.percentile(shore, 25)) if shore.size else float(np.median(inner))
        # flat water surface in the data (SRTM) -> its height; lake floor (bathymetry) -> the shore
        level = med if med > p25 - 30 else p25
        if name in KNOWN_LEVELS:
            level = KNOWN_LEVELS[name]
        levels.append(round(level, 1))
        # index: the lake plus a few texels around it (nearest lookups near the shore)
        grow = ndimage.binary_dilation(sub, iterations=3)
        bs = b[y0:y1, x0:x1]
        bs[grow & (bs == 0)] = k
        if k <= 40:
            print(f"  {k:3d} {name:28s} level {level:7.1f}  (inside {med:7.1f}, shore p25 {p25:7.1f})")

    out = os.path.join(ROOT, "public", "textures")
    Image.fromarray(np.dstack([r, g, b])).save(os.path.join(out, "earth_coast.png"), optimize=True)
    with open(os.path.join(out, "earth_lakes.json"), "w") as f:
        json.dump(levels, f)
    print("wrote earth_coast.png", os.path.getsize(os.path.join(out, "earth_coast.png")) // 1024, "KB")


if __name__ == "__main__":
    main()
