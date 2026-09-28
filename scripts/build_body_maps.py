#!/usr/bin/env python3
"""Bake real global elevation models (DEMs) and surface maps of moons and planets.

Sources
  * USGS Astrogeology Science Center map products (public S3 bucket `asc-pds-services`):
    LRO LOLA / Kaguya LALT (Moon), MGS MOLA (Mars), MESSENGER (Mercury), New Horizons
    (Pluto, Charon), Cassini ISS shape model (Enceladus), Mars Express HRSC (Phobos),
    Galileo/Voyager/Cassini mosaics (Io, Ganymede, Titan, Triton), Cassini (Jupiter).
  * NASA 3D Resources (github.com/nasa/NASA-3D-Resources, public domain) global maps of the
    other moons (clone it to ../nasa/nasa-3d-resources or set NASA3D=...).

Large rasters are read remotely with GDAL (/vsicurl/) and only every n-th scanline is fetched,
so a few hundred MB are transferred instead of many GB.

Output: public/bodies/<id>_dem.png   RGB8: height = R*256 + G - 32768 (metres, relative to the
                                     reference sphere), B = 255 where data exists
        public/bodies/<id>_map.jpg   surface colour / albedo (equirectangular)
        public/bodies/manifest.json
All maps: longitude -180..180 east-positive left to right, latitude +90..-90 top to bottom.
Run: python3 scripts/build_body_maps.py [ids...]   (needs rasterio, numpy, Pillow)
"""
import json
import os
import sys

import numpy as np
import rasterio
from PIL import Image
from rasterio.env import Env

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "bodies")
S3 = "/vsicurl/https://asc-pds-services.s3.amazonaws.com/"
NASA3D = os.environ.get("NASA3D", os.path.join(os.path.dirname(ROOT), "nasa", "nasa-3d-resources", "Images and Textures"))
Image.MAX_IMAGE_PIXELS = None

# (id, kind, source, target width) ; kind: dem | map ; source: s3 key or nasa3d folder name
JOBS = [
    ("moon", "dem", "mosaic/Moon_Kaguya_LALT_DEM_global_1895m.cub", 4096),
    ("mars", "dem", "mosaic/Mars_MGS_MOLA_DEM_mosaic_global_463m.tif", 4096),
    ("mercury", "dem", "mosaic/Mercury_Messenger_USGS_DEM_Global_665m_v2.tif", 4096),
    ("pluto", "dem", "mosaic/Pluto_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif", 2048),
    ("charon", "dem", "mosaic/Charon_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif", 2048),
    ("enceladus", "dem", "mosaic/Enceladus/enceladus_cassini_iss_shapemodel_bland_2019/enceladus_2019pm_radius.tif", 720),
    ("phobos", "dem", "mosaic/Phobos_ME_HRSC_DEM_Global_2ppd.tif", 720),
    ("moon", "map", "mosaic/Lunar_Clementine_UVVIS_750nm_Global_Mosaic_118m_v2.1.tif", 4096),
    ("mercury", "map", "mosaic/Mercury_MESSENGER_mosaic_global_250m_2013.tif", 4096),
    ("titan", "map", "mosaic/Titan_ISS_P19658_Mosaic_Global_4km.tif", 2048),
    ("triton", "map", "mosaic/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif", 2048),
    ("io", "map", "mosaic/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif", 2048),
    ("ganymede", "map", "mosaic/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif", 2048),
    ("jupiter", "map", "wms_basemaps/Jupiter/Jupiter/originals/jupiter_from_cassini.tif", 2048),
    ("europa", "map", "mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif", 4096),
    ("callisto", "map", "mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif", 2048),
    ("mars", "map", "nasa3d:Mars", 0),
    ("phobos", "map", "nasa3d:Mars - Phobos", 0),
    ("pluto", "map", "nasa3d:Pluto", 0),
    ("charon", "map", "nasa3d:Pluto - Charon", 0),
    ("mimas", "map", "nasa3d:Saturn - Mimas", 0),
    ("enceladus", "map", "nasa3d:Saturn - Enceladus", 0),
    ("tethys", "map", "nasa3d:Saturn - Tethys", 0),
    ("dione", "map", "nasa3d:Saturn - Dione", 0),
    ("rhea", "map", "nasa3d:Saturn - Rhea", 0),
    ("iapetus", "map", "nasa3d:Saturn - Iapetus", 0),
    ("saturn", "map", "nasa3d:Saturn", 0),
    ("miranda", "map", "nasa3d:Uranus - Miranda", 0),
    ("ariel", "map", "nasa3d:Uranus - Ariel", 0),
    ("umbriel", "map", "nasa3d:Uranus - Umbriel", 0),
    ("titania", "map", "nasa3d:Uranus - Titania", 0),
    ("oberon", "map", "nasa3d:Uranus - Oberon", 0),
]


# surface maps whose polar rows are unusable (treated as no data -> procedural colour)
MAP_LAT_LIMIT = {"moon": 77.0}

# DEMs whose heights are relative to an equipotential surface close to the body's ellipsoid
ELLIPSOID_DEMS = {"mars"}


def column_longitudes(ds):
    """East longitude (deg) of every column centre."""
    if ds.crs is None:  # un-georeferenced global map: assume -180..180 simple cylindrical
        return -180.0 + 360.0 * (np.arange(ds.width) + 0.5) / ds.width
    t = ds.transform
    x = t.c + t.a * (np.arange(ds.width) + 0.5)
    p = ds.crs.to_dict()
    if p.get("proj") == "longlat":
        return x
    R = p.get("R") or p.get("a")
    return p.get("lon_0", 0.0) + np.degrees(x / R)


def row_latitudes(ds):
    if ds.crs is None:
        return 90.0 - 180.0 * (np.arange(ds.height) + 0.5) / ds.height
    t = ds.transform
    y = t.f + t.e * (np.arange(ds.height) + 0.5)
    p = ds.crs.to_dict()
    if p.get("proj") == "longlat":
        return y
    R = p.get("R") or p.get("a")
    return np.degrees(y / R)


def resample_rows(rows, valid, lons, W):
    """Box-filter each row onto W columns spanning -180..180 (periodic)."""
    lons = ((lons + 180.0) % 360.0) - 180.0
    order = np.argsort(lons)
    lons, rows, valid = lons[order], rows[..., order], valid[..., order]
    edges = -180.0 + 360.0 * np.arange(W + 1) / W
    idx = np.searchsorted(lons, edges)
    csum = np.concatenate([np.zeros(rows.shape[:-1] + (1,)), np.cumsum(np.where(valid, rows, 0.0), -1)], -1)
    ccnt = np.concatenate([np.zeros(valid.shape[:-1] + (1,)), np.cumsum(valid, -1)], -1)
    s = csum[..., idx[1:]] - csum[..., idx[:-1]]
    n = ccnt[..., idx[1:]] - ccnt[..., idx[:-1]]
    # target columns narrower than a source column: fall back to nearest
    empty = idx[1:] == idx[:-1]
    if empty.any():
        centers = (edges[:-1] + edges[1:]) / 2
        near = np.clip(np.searchsorted(lons, centers[empty]), 0, len(lons) - 1)
        s[..., empty] = np.where(valid[..., near], rows[..., near], 0.0)
        n[..., empty] = valid[..., near]
    out = np.where(n > 0, s / np.maximum(n, 1), 0.0)
    return out, n > 0


def read_s3(key, W, bands=None):
    with Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.cub,.lbl",
             GDAL_HTTP_MAX_RETRY="5", GDAL_HTTP_RETRY_DELAY="2", VSI_CACHE="TRUE"):
        with rasterio.open(S3 + key) as ds:
            H = W // 2
            lats_src = row_latitudes(ds)
            lats_dst = 90.0 - 180.0 * (np.arange(H) + 0.5) / H
            # nearest source row for each output row (rows outside the coverage become no-data)
            step = abs(lats_src[1] - lats_src[0])
            ridx = np.round((lats_src[0] - lats_dst) / step).astype(int)
            inside = (ridx >= 0) & (ridx < ds.height)
            ridx = np.clip(ridx, 0, ds.height - 1)
            idx = list(range(1, ds.count + 1)) if bands is None else bands
            nb = len(idx)
            data = np.zeros((nb, H, ds.width), np.float32)
            uniq = np.unique(ridx)
            print(f"  {key.split('/')[-1]}: {ds.width}x{ds.height}, reading {len(uniq)} rows", flush=True)
            for k, r in enumerate(uniq):
                win = rasterio.windows.Window(0, int(r), ds.width, 1)
                row = ds.read(idx, window=win).astype(np.float32)[:, 0, :]
                data[:, ridx == r, :] = row[:, None, :]
                if k % 256 == 0:
                    print(f"    row {k}/{len(uniq)}", flush=True)
            nod = ds.nodata
            valid = np.ones(data.shape, bool) if nod is None else (data != nod) & np.isfinite(data)
            if nod is not None and abs(nod) > 1e30:
                valid &= np.abs(data) < 1e30
            valid[:, ~inside, :] = False
            scale, offset = ds.scales[0], ds.offsets[0]
            data = data * scale + offset
            lons = column_longitudes(ds)
            crsR = ds.crs.to_dict().get("R") if ds.crs else None
    out, ok = resample_rows(data, valid, lons, W)
    return out, ok, crsR


def save_dem(bid, h, ok, radius):
    v = np.clip(np.round(h) + 32768, 0, 65535).astype(np.uint32)
    rgb = np.stack([(v >> 8) & 255, v & 255, np.where(ok, 255, 0)], -1).astype(np.uint8)
    path = os.path.join(OUT, f"{bid}_dem.png")
    Image.fromarray(rgb, "RGB").save(path, optimize=True)
    print(f"  -> {path} {os.path.getsize(path) / 1e6:.1f} MB, h {h[ok].min():.0f}..{h[ok].max():.0f} m, coverage {ok.mean() * 100:.0f}%")
    return {"file": f"bodies/{bid}_dem.png", "radius": radius, "width": int(h.shape[1]), "height": int(h.shape[0])}


def save_map(bid, img, ok):
    img = np.asarray(img, np.float32)
    if img.ndim == 2:
        img = img[..., None].repeat(3, -1)
    ok2 = ok if ok.ndim == 2 else ok.all(0)
    if bid in MAP_LAT_LIMIT:
        lat = 90.0 - 180.0 * (np.arange(ok2.shape[0]) + 0.5) / ok2.shape[0]
        ok2 = ok2 & (np.abs(lat) < MAP_LAT_LIMIT[bid])[:, None]
    # fill pinholes (isolated bad pixels) from their neighbours; large gaps stay no-data
    img = img.copy()
    for _ in range(3):
        acc = np.zeros_like(img); cnt = np.zeros(ok2.shape)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            m = np.roll(ok2, (dy, dx), (0, 1))
            acc += np.where(m[..., None], np.roll(img, (dy, dx), (0, 1)), 0)
            cnt += m
        fill = ~ok2 & (cnt >= 3)
        img[fill] = acc[fill] / cnt[fill][:, None]
        ok2 = ok2 | fill
    # polar gaps (never imaged): the mean tone of the latitude row (or the nearest covered one)
    # instead of a patchwork of map and procedural surface
    H = ok2.shape[0]
    lat = 90.0 - 180.0 * (np.arange(H) + 0.5) / H
    cov = ok2.mean(1)
    if cov.mean() > 0.5 and bid not in MAP_LAT_LIMIT:
        for rows in (np.where(lat > 55)[0][::-1], np.where(lat < -55)[0]):  # equator -> pole
            last = None
            for r in rows:
                if cov[r] > 0.02:
                    last = img[r][ok2[r]].mean(0)
                if last is not None:
                    img[r][~ok2[r]] = last
                    ok2[r] = True
    # stretch to the valid range, keep no-data black (the viewer treats black as "no data")
    v = img[ok2]
    # scale only (no offset): keeps the albedo ratios of photometric mosaics
    lo, hi = 0.0, np.percentile(v, 99.8)
    img = np.clip((img - lo) / max(hi - lo, 1e-6), 0, 1)
    # valid pixels stay above the viewer's no-data threshold (sRGB 14/255 ~ linear 0.0044)
    img = np.where(ok2[..., None], np.maximum(img, 14 / 255), 0)
    path = os.path.join(OUT, f"{bid}_map.jpg")
    Image.fromarray((img * 255).astype(np.uint8), "RGB").save(path, quality=90)
    print(f"  -> {path} {os.path.getsize(path) / 1e6:.2f} MB {img.shape[1]}x{img.shape[0]}")
    return {"file": f"bodies/{bid}_map.jpg", "width": int(img.shape[1]), "height": int(img.shape[0])}


def write_manifest():
    """Assemble manifest.json from the per-product fragments (jobs may run in parallel)."""
    manifest = {}
    for f in sorted(os.listdir(OUT)):
        if f.endswith(".part.json"):
            bid, kind = f[: -len(".part.json")].rsplit("_", 1)
            manifest.setdefault(bid, {})[kind] = json.load(open(os.path.join(OUT, f)))
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)


def main():
    os.makedirs(OUT, exist_ok=True)
    only = set(sys.argv[1:])
    for bid, kind, src, W in JOBS:
        if only and bid not in only and f"{bid}:{kind}" not in only:
            continue
        print(bid, kind, src, flush=True)
        entry = {}
        if src.startswith("nasa3d:"):
            folder = src[7:]
            im = Image.open(os.path.join(NASA3D, folder, folder + ".jpg")).convert("RGB")
            a = np.asarray(im, np.float32) / 255
            ok = a.max(-1) > 0.012
            entry["map"] = save_map(bid, a, ok)
            entry["map"]["source"] = "NASA 3D Resources"
            json.dump(entry["map"], open(os.path.join(OUT, f"{bid}_map.part.json"), "w"), indent=1)
            continue
        if kind == "dem":
            h, ok, R = read_s3(src, W)
            h, ok = h[0], ok[0]
            # (the Enceladus "radius" product already stores height above the 251.5 km sphere)
            entry["dem"] = save_dem(bid, h, ok, R)
            entry["dem"]["source"] = "USGS Astrogeology: " + src.split("/")[-1]
        elif bid == "jupiter":
            # Cassini global map (PIA07782) with a title and axes: crop the plot frame
            with Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
                with rasterio.open(S3 + src) as ds:
                    j = ds.read().transpose(1, 2, 0)
            lum = j.mean(-1)
            xs = np.where((lum > 40).mean(0) > 0.6)[0]
            ys = np.where((lum > 40).mean(1) > 0.6)[0]
            crop = j[ys.min() + 3: ys.max() - 2, xs.min() + 3: xs.max() - 2]
            img = np.asarray(Image.fromarray(crop).resize((W, W // 2), Image.LANCZOS), np.float32) / 255
            entry["map"] = save_map(bid, img, np.ones(img.shape[:2], bool))
            entry["map"]["source"] = "NASA/JPL/Space Science Institute, Cassini (PIA07782) via USGS"
        else:
            m, ok, _ = read_s3(src, W)
            img = m.transpose(1, 2, 0) if m.shape[0] == 3 else m[0]
            entry["map"] = save_map(bid, img, ok if m.shape[0] == 3 else ok[0])
            entry["map"]["source"] = "USGS Astrogeology: " + src.split("/")[-1]
        part = entry.get("dem") or entry.get("map")
        if kind == "dem" and bid in ELLIPSOID_DEMS:
            part["ellipsoid"] = True  # heights above the areoid ~ reference ellipsoid
        json.dump(part, open(os.path.join(OUT, f"{bid}_{kind}.part.json"), "w"), indent=1)
    write_manifest()


if __name__ == "__main__":
    main()
