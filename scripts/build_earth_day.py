#!/usr/bin/env python3
"""Bake the Earth's day map (8192 x 4096, ~5 km) from NASA's Blue Marble Next Generation.

Source: the Blue Marble tile pyramid published by Modest Maps on Amazon S3
(com.modestmaps.bluemarble, Web Mercator, 256 px tiles; NASA imagery, public domain).
Zoom 6 (16384 px around the equator) is resampled to equirectangular with 3 x 3 supersampling
per output texel. Beyond the Mercator limit (|lat| > 85.05 deg) and where a tile has no data, the previous map
(three-globe's Blue Marble, scripts/build_assets.py) is kept.
The ocean of these tiles carries shaded bathymetry; the renderer only uses the land colour.

Output: public/textures/earth_day.jpg   (rows from +90 at the top, columns from -180)
Run:    python3 scripts/build_earth_day.py   (needs numpy, scipy, Pillow; downloads ~45 MB)
"""
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "bluemarble")
URL = "https://s3.amazonaws.com/com.modestmaps.bluemarble/{z}-r{y}-c{x}.jpg"
Z = 6
W, H = 8192, 4096
SS = 3


def fetch(y, x):
    """Tile as an array, or None where the pyramid has no tile (a few, open ocean)."""
    path = os.path.join(CACHE, str(Z), f"{y}_{x}.jpg")
    if os.path.exists(path + ".missing"):
        return None
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        for attempt in range(4):
            try:
                data = urllib.request.urlopen(URL.format(z=Z, y=y, x=x), timeout=60).read()
                break
            except urllib.error.HTTPError as e:
                if e.code in (403, 404):
                    open(path + ".missing", "w").close()
                    return None
                if attempt == 3:
                    raise
            except Exception:
                if attempt == 3:
                    raise
        with open(path, "wb") as f:
            f.write(data)
    return np.asarray(Image.open(path).convert("RGB"))


def main():
    n = 2 ** Z
    mos = np.zeros((n * 256, n * 256, 3), np.uint8)
    have = np.zeros((n * 256, n * 256), np.uint8)
    jobs = [(y, x) for y in range(n) for x in range(n)]
    missing = 0
    with ThreadPoolExecutor(16) as ex:
        for (y, x), tile in zip(jobs, ex.map(lambda j: fetch(*j), jobs)):
            if tile is None:
                missing += 1
                continue
            mos[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = tile
            # pure black: no data (parts of Antarctica); the deep ocean is dark blue, never black
            have[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = np.where(tile.max(axis=2) > 3, 255, 0)
    print("mosaic", mos.shape, "missing tiles", missing)
    N = mos.shape[0]
    old = np.asarray(Image.open(os.path.join(ROOT, "public", "textures", "earth_day.jpg")).convert("RGB").resize((W, H), Image.BICUBIC), np.float32)
    out = np.zeros((H, W, 3), np.float32)
    # work in bands of rows (memory)
    band = 256
    for r0 in range(0, H, band):
        rows = np.arange(r0, min(r0 + band, H))
        sub = (np.arange(SS) + 0.5) / SS
        lat = 90 - (rows[:, None] + sub[None, :]).reshape(-1) / H * 180          # (rows*SS)
        lon = -180 + (np.arange(W)[:, None] + sub[None, :]).reshape(-1) / W * 360  # (W*SS)
        latc = np.clip(lat, -85.05, 85.05)
        yy = (1 - np.log(np.tan(np.radians(latc)) + 1 / np.cos(np.radians(latc))) / np.pi) / 2 * N - 0.5
        xx = (lon + 180) / 360 * N - 0.5
        Y, X = np.meshgrid(yy, xx, indexing="ij")
        acc = np.zeros((len(rows), W, 3), np.float32)
        cov = ndimage.map_coordinates(have, [Y, X % N], order=1, mode="nearest").astype(np.float32)
        cov = cov.reshape(len(rows), SS, W, SS).mean(axis=(1, 3))[..., None] / 255
        for c in range(3):
            v = ndimage.map_coordinates(mos[..., c], [Y, X % N], order=1, mode="nearest").astype(np.float32)
            acc[..., c] = v.reshape(len(rows), SS, W, SS).mean(axis=(1, 3))
        # beyond the Mercator limit: previous map, blended over half a degree
        la = 90 - (rows + 0.5) / H * 180
        k = np.clip((np.abs(la) - 84.5) / 0.5, 0, 1)[:, None, None]
        k = 1 - (1 - k) * cov
        acc = acc / np.maximum(cov, 1e-3)
        # Antarctica: parts of the ice shelves and coast are filled with ocean in these tiles
        ice = (old[rows].mean(-1) > 150) & (acc.mean(-1) < 90) & (la[:, None] < -60)
        k = np.maximum(k, ice[..., None].astype(np.float32))
        out[rows] = acc * (1 - k) + old[rows] * k
        print(f"rows {r0}..{rows[-1]}", flush=True)
    dst = os.path.join(ROOT, "public", "textures", "earth_day.jpg")
    Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8)).save(dst, quality=88, optimize=True)
    print("wrote", dst, os.path.getsize(dst) // 1024, "KB")


if __name__ == "__main__":
    main()
