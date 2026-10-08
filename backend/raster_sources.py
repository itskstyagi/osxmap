"""Bounded, memory-only numerical GeoTIFF extraction and official WorldPop discovery."""

from __future__ import annotations

import json
import math
import re
from urllib.parse import urlsplit

try:
    from .errors import ServiceError
    from .web_sources import MAX_RAW_BYTES, _load_json, fetch_public_bytes, fetch_web_document, validate_web_url
except ImportError:  # Supports direct execution through `python backend/server.py`.
    from errors import ServiceError
    from web_sources import MAX_RAW_BYTES, _load_json, fetch_public_bytes, fetch_web_document, validate_web_url

MAX_RASTER_BYTES = 64 * 1024 * 1024
MAX_RASTER_PIXELS = 100_000_000
MAX_BLOCK_BYTES = 16 * 1024 * 1024
MAX_FEATURES = 10000
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
_TIFF_TYPES = {"image/tiff", "image/geotiff", "application/geotiff", "application/octet-stream"}
_DATA_ROOT = "https://data.worldpop.org/GIS/Population/"


def _bounds(bounds):
    if (not isinstance(bounds, (list, tuple)) or len(bounds) != 4
            or any(type(value) not in {int, float} or not -180 <= value <= 180 for value in bounds)):
        raise ServiceError("Raster bounds must be four finite WGS84 numbers [west, south, east, north].", 400)
    west, south, east, north = bounds
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ServiceError("Raster bounds must be a nonempty WGS84 box without antimeridian crossing.", 400)
    return [float(value) for value in bounds]


def _bounded_document(document):
    if len(json.dumps(document, allow_nan=False, separators=(",", ":")).encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise ServiceError("Raster result exceeds the 4 MiB output limit; request smaller bounds.", 413)
    return document


def decode_geotiff(raw: bytes, bounds, *, field="value", band=1, nonnegative=False) -> dict:
    """Extract original pixel values at cell centers inside a WGS84 bounding box.

    Returns a document with format, dataset (Point FeatureCollection), field, fields,
    resolution, method, caveat and extraction metadata. No resampling, interpolation,
    subsampling or administrative-area totals are performed. NoData/non-finite cells
    are excluded; zero is retained. nonnegative=True additionally excludes negatives.
    Only north-up, unscaled numeric GTiffs in WGS84, Web Mercator or WGS84 UTM are
    supported. Other georeferencing fails explicitly instead of guessing coordinates.
    """
    bounds = _bounds(bounds)
    if (not isinstance(field, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", field)
            or field.casefold() in {"__proto__", "prototype", "constructor"} or type(band) is not int or band < 1
            or type(nonnegative) is not bool):
        raise ServiceError("Raster field, band, or value constraint is invalid.", 400)
    if not isinstance(raw, bytes) or not raw:
        raise ServiceError("Raster document is empty or invalid.", 422)
    if len(raw) > MAX_RASTER_BYTES:
        raise ServiceError("Raster document exceeds the 64 MiB byte limit.", 413)
    if not raw.startswith((b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")):
        raise ServiceError("Raster format is unsupported; only in-memory GeoTIFF is accepted.", 415)
    try:
        import numpy as np
        import rasterio
        from rasterio.io import MemoryFile
        from rasterio.warp import transform as transform_coordinates, transform_bounds
        from rasterio.windows import Window, from_bounds
    except ImportError:
        raise ServiceError("Raster support requires the rasterio dependency in the backend Python environment.", 503) from None

    try:
        # Only GTiff sees these bytes. No URL, VRT, sidecar, external mask, PAM or
        # downloaded PROJ resource participates in decoding or coordinate transforms.
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_PAM_ENABLED="NO",
                          PROJ_NETWORK="OFF", GDAL_NUM_THREADS="1", GDAL_CACHEMAX=MAX_BLOCK_BYTES), MemoryFile(raw) as memory:
            with memory.open(driver="GTiff", GEOREF_SOURCES="INTERNAL", NUM_THREADS="1") as source:
                if source.driver != "GTiff":
                    raise ServiceError("Raster format is unsupported; only GeoTIFF is accepted.", 415)
                if (source.width <= 0 or source.height <= 0 or not 1 <= source.count <= 8
                        or source.width * source.height * source.count > MAX_RASTER_PIXELS):
                    raise ServiceError("Raster dimensions exceed the bounded pixel limit.", 413)
                if band > source.count:
                    raise ServiceError("Requested raster band does not exist.", 400)
                if source.crs is None:
                    raise ServiceError("Raster CRS is missing; coordinates cannot be inferred.", 422)
                epsg = source.crs.to_epsg()
                if (epsg not in {4326, 3857} and not (epsg and (32601 <= epsg <= 32660 or 32701 <= epsg <= 32760))
                        or (epsg and source.crs != rasterio.crs.CRS.from_epsg(epsg))):
                    raise ServiceError("Raster CRS is unsupported; use WGS84, Web Mercator or WGS84 UTM.", 415)
                affine = source.transform
                if (not all(math.isfinite(value) for value in affine) or affine.a <= 0 or affine.e >= 0
                        or affine.b != 0 or affine.d != 0):
                    raise ServiceError("Raster georeference is invalid or unsupported; a north-up affine grid is required.", 422)
                extent = source.bounds
                if (not all(math.isfinite(value) for value in extent) or (epsg == 4326 and not (
                        -180.000001 <= extent.left < extent.right <= 180.000001
                        and -90.000001 <= extent.bottom < extent.top <= 90.000001))):
                    raise ServiceError("Raster georeference is inconsistent with its CRS.", 422)
                dtype = np.dtype(source.dtypes[band - 1])
                units = source.units[band - 1] or ""
                if (dtype.kind not in "iuf" or source.colorinterp[band - 1] not in {
                        rasterio.enums.ColorInterp.undefined, rasterio.enums.ColorInterp.gray}
                        or source.scales[band - 1] != 1 or source.offsets[band - 1] != 0 or len(units) > 60):
                    raise ServiceError("Raster band is unsupported; unscaled numerical measurements are required.", 415)
                block_height, block_width = source.block_shapes[band - 1]
                if block_height * block_width * sum(np.dtype(value).itemsize for value in source.dtypes) > MAX_BLOCK_BYTES:
                    raise ServiceError("Raster storage block exceeds the bounded decode byte limit.", 413)

                crop = bounds if epsg == 4326 else transform_bounds("EPSG:4326", f"EPSG:{epsg}", *bounds, densify_pts=21)
                if not all(math.isfinite(value) for value in crop):
                    raise ServiceError("Raster bounds cannot be transformed into the source CRS.", 422)
                left, bottom = max(crop[0], extent.left), max(crop[1], extent.bottom)
                right, top = min(crop[2], extent.right), min(crop[3], extent.top)
                if left >= right or bottom >= top:
                    raise ServiceError("Raster has no overlap with the requested bounds.", 422)
                window = from_bounds(left, bottom, right, top, affine)
                col0, row0 = max(0, math.floor(window.col_off)), max(0, math.floor(window.row_off))
                col1 = min(source.width, math.ceil(window.col_off + window.width))
                row1 = min(source.height, math.ceil(window.row_off + window.height))
                if (col1 - col0) * (row1 - row0) > MAX_FEATURES:
                    raise ServiceError("Raster crop exceeds the 10000 grid-cell limit; request smaller bounds. No cells were subsampled.", 413)
                values = source.read(band, window=Window(col0, row0, col1 - col0, row1 - row0), masked=True)
                valid = ~np.ma.getmaskarray(values) & np.isfinite(values.data)
                if nonnegative:
                    valid &= values.data >= 0
                rows, cols = np.nonzero(valid)
                xs = affine.c + (cols + col0 + 0.5) * affine.a
                ys = affine.f + (rows + row0 + 0.5) * affine.e
                if epsg != 4326 and len(xs):
                    xs, ys = transform_coordinates(f"EPSG:{epsg}", "EPSG:4326", xs.tolist(), ys.tolist())
                features = []
                for row, col, x, y in zip(rows, cols, xs, ys):
                    if not math.isfinite(x) or not math.isfinite(y) or not -180 <= x <= 180 or not -90 <= y <= 90:
                        raise ServiceError("Raster cell coordinates cannot be transformed safely to WGS84.", 422)
                    if not bounds[0] <= x <= bounds[2] or not bounds[1] <= y <= bounds[3]:
                        continue
                    value = values.data[row, col].item()
                    if isinstance(value, int) and abs(value) > 2**53 - 1:
                        raise ServiceError("Raster integer value exceeds the exact GeoJSON numeric range.", 422)
                    features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(x), float(y)]},
                                     "properties": {field: value}})
                if not features:
                    raise ServiceError("Raster crop contains no valid cell centers in the requested bounds.", 422)
                unit = "degrees" if epsg == 4326 else "metres"
                return _bounded_document({
                    "format": "geotiff", "dataset": {"type": "FeatureCollection", "features": features},
                    "field": field, "fields": [field], "units": units,
                    "resolution": f"{affine.a:.9g} x {-affine.e:.9g} {unit} (EPSG:{epsg})",
                    "method": "Original raster cell values at georeferenced cell centers; bounding-box extraction without resampling or aggregation.",
                    "caveat": "Cell centers within the extraction bounding box only, not an administrative polygon or complete administrative total. NoData and non-finite cells are excluded; zero is retained."
                              + (" Negative population cells are excluded." if nonnegative else ""),
                    "extraction": {"bounds": bounds, "boundsCRS": "EPSG:4326", "sourceCRS": f"EPSG:{epsg}",
                                   "sourceResolution": [affine.a, -affine.e], "band": band, "aggregation": "none",
                                   "cellSelection": "centers within bounds", "featureCount": len(features),
                                   "excludedInvalidCells": int(values.size - np.count_nonzero(valid))},
                })
    except (rasterio.errors.RasterioError, ValueError, OverflowError):
        raise ServiceError("Raster GeoTIFF is invalid or its georeference cannot be decoded safely.", 422) from None


def load_raster_grid(url, bounds, band=1) -> dict:
    """Fetch a discovered numerical GTiff and return its signed, finite cell values.

    Units come only from the selected band's embedded metadata. Reference year,
    measurement meaning, citation and license are not inferred from a filename.
    """
    bounds = _bounds(bounds)
    if type(band) is not int or band < 1:
        raise ServiceError("Raster band must be a positive integer.", 400)
    fetched = fetch_public_bytes(url, max_bytes=MAX_RASTER_BYTES, timeout=60, allowed_media_types=_TIFF_TYPES)
    document = decode_geotiff(fetched["raw"], bounds, band=band)
    document.update(url=fetched["final_url"], title=urlsplit(fetched["final_url"]).path.rsplit("/", 1)[-1][:160],
                    caveat="Measurement meaning, license and reference year must be checked against the original source. " + document["caveat"])
    return _bounded_document(document)


def _official_url(url, expected):
    """Match a discovered resource to its official country/year path, not just its suffix."""
    try:
        url = validate_web_url(url)
        actual, wanted = urlsplit(url), urlsplit(expected)
        if (actual.scheme == wanted.scheme == "https" and actual.hostname == wanted.hostname
                and actual.port in {None, 443} and actual.path == wanted.path and actual.query == wanted.query):
            return url
    except ServiceError:
        pass
    return None


def load_population_grid(country_code, bounds, year=None) -> dict:
    """Load verified WorldPop 2000-2020 population counts, never model-supplied values.

    country_code is an ISO 3166-1 alpha-2 code; bounds is [west,south,east,north].
    None selects the latest verified popyear in this historical collection, not the
    current year. A requested year must exist. Returns the decode_geotiff document
    plus url, title, units, referenceYear (int), attribution, citation, license,
    metadataUrl, directoryUrl and publishedDate. Publication/citation years describe
    the parent dataset, not the population observation or extraction date.
    """
    bounds = _bounds(bounds)
    if not isinstance(country_code, str) or not re.fullmatch(r"[A-Za-z]{2}", country_code):
        raise ServiceError("Population country must be an ISO 3166-1 alpha-2 code.", 400)
    if year is not None and (type(year) is not int or not 2000 <= year <= 2020):
        raise ServiceError("The WorldPop 2000-2020 collection cannot supply the requested reference year.", 400)
    try:
        import pycountry
    except ImportError:
        raise ServiceError("Population country lookup requires the pycountry dependency.", 503) from None
    country = pycountry.countries.get(alpha_2=country_code.upper())
    if country is None:
        raise ServiceError("Population country is not a recognized ISO 3166-1 alpha-2 code.", 400)
    iso3 = country.alpha_3
    metadata_url = f"https://www.worldpop.org/rest/data/pop/wpgp?iso3={iso3}"
    fetched = fetch_public_bytes(metadata_url, max_bytes=MAX_RAW_BYTES, timeout=20,
                                 allowed_media_types={"application/json", "text/plain"})
    if not any(_official_url(fetched["final_url"], expected) for expected in (
            metadata_url, f"https://hub.worldpop.org/rest/data/pop/wpgp?iso3={iso3}")):
        raise ServiceError("WorldPop metadata redirected outside the verified country resource.", 422)
    metadata_url = fetched["final_url"]
    try:
        metadata = _load_json(fetched["raw"].decode("utf-8-sig"))
    except UnicodeError:
        raise ServiceError("WorldPop metadata is not valid UTF-8 JSON.", 422) from None
    entries = metadata.get("data") if isinstance(metadata, dict) else None
    if not isinstance(entries, list) or len(entries) > 1000:
        raise ServiceError("WorldPop population metadata is unsupported.", 422)
    candidates = {}
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("iso3") != iso3:
            continue
        reference = entry.get("popyear")
        if type(reference) not in {str, int} or not re.fullmatch(r"20[0-2][0-9]", str(reference)):
            continue
        reference = int(reference)
        if reference > 2020 or (year is not None and reference != year):
            continue
        parent_url = f"{_DATA_ROOT}Global_2000_2020/{reference}/{iso3}/{iso3.lower()}_ppp_{reference}.tif"
        files = entry.get("files")
        if not isinstance(files, list) or not any(_official_url(url, parent_url) for url in files):
            continue
        candidates.setdefault(reference, entry)
    if not candidates:
        raise ServiceError("WorldPop has no verified country metadata for the requested population reference year.", 422)
    reference_year = max(candidates)
    entry = candidates[reference_year]
    citation, license_value = entry.get("citation"), entry.get("license")
    if (not isinstance(citation, str) or not 0 < len(citation) <= 4000
            or not isinstance(license_value, str) or not 0 < len(license_value) <= 2048):
        raise ServiceError("WorldPop citation or license metadata is missing or unsupported.", 422)

    directory_url = f"{_DATA_ROOT}Global_2000_2020_1km/{reference_year}/{iso3}/"
    directory = fetch_web_document(directory_url)
    if directory.get("format") != "html" or not _official_url(directory.get("url"), directory_url):
        raise ServiceError("WorldPop 1 km directory is unsupported or redirected outside the verified source.", 422)
    expected_tiff = f"{directory_url}{iso3.lower()}_ppp_{reference_year}_1km_Aggregated.tif"
    # The constructed path is a filter only: a TIFF is fetched only if the official
    # directory actually links to that exact country, year and population product.
    discovered = next((url for link in directory.get("links", []) if isinstance(link, dict)
                       if (url := _official_url(link.get("url"), expected_tiff))), None)
    if discovered is None:
        raise ServiceError("WorldPop has no verified 1 km GeoTIFF link for this country and reference year.", 422)
    fetched = fetch_public_bytes(discovered, max_bytes=MAX_RASTER_BYTES, timeout=60, allowed_media_types=_TIFF_TYPES)
    if not _official_url(fetched["final_url"], expected_tiff):
        raise ServiceError("WorldPop raster redirected outside the verified country/year resource.", 422)
    document = decode_geotiff(fetched["raw"], bounds, field="population", nonnegative=True)
    pixel_size = document["extraction"]["sourceResolution"]
    if document["extraction"]["sourceCRS"] != "EPSG:4326" or any(not math.isclose(value, 1 / 120, rel_tol=1e-5) for value in pixel_size):
        raise ServiceError("WorldPop raster georeference does not match the verified 1 km population product.", 422)
    document.update(
        url=fetched["final_url"], title=f"WorldPop {country.name} population {reference_year} (historical modeled 1 km grid)",
        units="people per grid cell", referenceYear=reference_year,
        attribution=entry.get("source", "WorldPop") if isinstance(entry.get("source", "WorldPop"), str) else "WorldPop",
        citation=citation, license=license_value, metadataUrl=metadata_url,
        directoryUrl=directory["url"], publishedDate=entry.get("date", "") if isinstance(entry.get("date", ""), str) else "",
        resolution="1 km nominal (30 arc-seconds); " + document["resolution"],
        method="WorldPop historical modeled population counts; official 1 km aggregated grid. " + document["method"],
        caveat=f"Historical modeled population for {reference_year}, not current population or ward census. The citation and publication date describe the underlying WorldPop 100 m collection; values come from its official 1 km aggregated product. " + document["caveat"],
    )
    return _bounded_document(document)
