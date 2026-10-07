"""Offline raster and binary-fetch regressions using tiny generated in-memory TIFFs."""

import json
import math
import unittest
import warnings
from unittest import mock

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import Affine, from_origin

from backend import raster_sources as raster
from backend import test_web_sources as fixtures
from backend import web_sources as web


def tiff(values, *, transform=None, crs="EPSG:4326", nodata=None, dtype="float32", units=None, scale=1, **options):
    values = np.asarray(values, dtype=dtype)
    if values.ndim == 2:
        values = values[np.newaxis, :, :]
    with warnings.catch_warnings(), MemoryFile() as memory:
        warnings.simplefilter("ignore", rasterio.errors.NotGeoreferencedWarning)
        with memory.open(driver="GTiff", width=values.shape[2], height=values.shape[1], count=values.shape[0],
                         dtype=values.dtype, crs=crs, nodata=nodata,
                         transform=from_origin(0, values.shape[1], 1, 1) if transform is None else transform, **options) as dataset:
            dataset.write(values)
            dataset.scales = (scale,) * values.shape[0]
            if units is not None:
                dataset.set_band_unit(1, units)
        return memory.read()


class RasterDecodeTests(fixtures.OfflineCase):
    def test_crop_preserves_cell_centers_zero_nodata_and_values(self):
        raw = tiff([[1, 2, 3, 4], [5, 0, -9999, 8], [9, 10.25, 11, 12]], nodata=-9999)
        document = raster.decode_geotiff(raw, [1, 0, 3, 2], field="population", nonnegative=True)
        features = document["dataset"]["features"]
        self.assertEqual([feature["geometry"]["coordinates"] for feature in features], [[1.5, 1.5], [1.5, .5], [2.5, .5]])
        self.assertEqual([feature["properties"] for feature in features], [{"population": 0}, {"population": 10.25}, {"population": 11}])
        self.assertEqual(document["fields"], ["population"])
        self.assertEqual(document["extraction"], {"bounds": [1, 0, 3, 2], "boundsCRS": "EPSG:4326", "sourceCRS": "EPSG:4326",
                         "sourceResolution": [1, 1], "band": 1, "aggregation": "none", "cellSelection": "centers within bounds",
                         "featureCount": 3, "excludedInvalidCells": 1})
        self.assertIn("not an administrative polygon", document["caveat"])
        self.dns.assert_not_called()
        self.socket.assert_not_called()

    def test_intersecting_window_is_filtered_by_actual_cell_center(self):
        document = raster.decode_geotiff(tiff([[1, 2, 3], [4, 5, 6]]), [.6, .6, 2.6, 1.6])
        self.assertEqual([feature["properties"]["value"] for feature in document["dataset"]["features"]], [2, 3])
        self.assertEqual([feature["geometry"]["coordinates"] for feature in document["dataset"]["features"]], [[1.5, 1.5], [2.5, 1.5]])

    def test_generic_signed_values_and_population_invalid_cells(self):
        raw = tiff([[-3, 0, 1.25, float("nan"), float("inf"), -9999]], nodata=-9999)
        generic = raster.decode_geotiff(raw, [0, 0, 6, 1])
        self.assertEqual([feature["properties"]["value"] for feature in generic["dataset"]["features"]], [-3, 0, 1.25])
        population = raster.decode_geotiff(raw, [0, 0, 6, 1], field="population", nonnegative=True)
        self.assertEqual([feature["properties"]["population"] for feature in population["dataset"]["features"]], [0, 1.25])
        self.assertEqual(population["extraction"]["excludedInvalidCells"], 4)

    def test_nodata_nan_and_all_zero_do_not_become_missing(self):
        document = raster.decode_geotiff(tiff([[0, float("nan")]], nodata=float("nan")), [0, 0, 2, 1])
        self.assertEqual(document["dataset"]["features"][0]["properties"], {"value": 0})
        self.assertEqual(len(document["dataset"]["features"]), 1)
        document = raster.decode_geotiff(tiff([[0, 0]]), [0, 0, 2, 1])
        self.assertEqual(len(document["dataset"]["features"]), 2)

    def test_fractional_values_and_nonzero_origin_are_not_rounded(self):
        raw = tiff([[.1]], transform=from_origin(77.25, 28.75, .008333333333, .008333333333))
        document = raster.decode_geotiff(raw, [77, 28, 78, 29])
        feature = document["dataset"]["features"][0]
        self.assertEqual(feature["properties"]["value"], float(np.float32(.1)))
        self.assertAlmostEqual(feature["geometry"]["coordinates"][0], 77.25 + .008333333333 / 2)
        self.assertAlmostEqual(feature["geometry"]["coordinates"][1], 28.75 - .008333333333 / 2)

    def test_projected_web_mercator_is_transformed_not_treated_as_degrees(self):
        size = math.pi * 6378137 / 180
        raw = tiff([[1, 2], [3, 4]], crs="EPSG:3857", transform=from_origin(0, 2 * size, size, size))
        document = raster.decode_geotiff(raw, [0, 0, 2, 2])
        coordinates = [feature["geometry"]["coordinates"] for feature in document["dataset"]["features"]]
        self.assertEqual(len(coordinates), 4)
        self.assertAlmostEqual(coordinates[0][0], .5)
        self.assertAlmostEqual(coordinates[0][1], math.degrees(math.atan(math.sinh(1.5 * size / 6378137))))
        self.assertEqual(document["extraction"]["sourceCRS"], "EPSG:3857")

    def test_wgs84_utm_uses_the_declared_zone(self):
        raw = tiff([[7]], crs="EPSG:32643", transform=from_origin(499500, 500, 1000, 1000))
        document = raster.decode_geotiff(raw, [74.9, -.1, 75.1, .1])
        coordinates = document["dataset"]["features"][0]["geometry"]["coordinates"]
        self.assertAlmostEqual(coordinates[0], 75)
        self.assertAlmostEqual(coordinates[1], 0)

    def test_bounds_are_finite_geographic_and_not_wrapped_or_empty(self):
        for bounds in [None, {}, [0, 0, 1], [0, 0, 1, 1, 1], [True, 0, 1, 1], [0, 0, "1", 1],
                       [float("nan"), 0, 1, 1], [0, 0, float("inf"), 1], [0, 0, 10**1000, 1],
                       [-181, 0, 1, 1], [0, -91, 1, 1], [0, 0, 181, 1], [0, 0, 1, 91], [1, 0, 1, 1], [170, 0, -170, 1]]:
            with self.subTest(bounds=bounds):
                self.error(400, raster.decode_geotiff, b"invalid", bounds)

    def test_missing_wrong_unsupported_and_invalid_georeferences_fail(self):
        self.assertIn("CRS is missing", self.error(422, raster.decode_geotiff, tiff([[1]], crs=None), [0, 0, 1, 1]))
        self.error(422, raster.decode_geotiff, tiff([[1]], transform=from_origin(1000, 1000, 1, 1)), [0, 0, 1, 1])
        self.error(415, raster.decode_geotiff, tiff([[1]], crs="EPSG:27700"), [0, 0, 1, 1])
        for affine in [Affine.identity(), Affine(0, 0, 0, 0, -1, 1), Affine(1, .1, 0, 0, -1, 1), Affine(1, 0, 0, .1, -1, 1)]:
            with self.subTest(affine=affine), warnings.catch_warnings():
                warnings.simplefilter("ignore", rasterio.errors.NotGeoreferencedWarning)
                self.error(422, raster.decode_geotiff, tiff([[1]], transform=affine), [0, 0, 1, 1])

    def test_no_overlap_no_centers_and_all_invalid_fail_without_fallback(self):
        raw = tiff([[1, 2]])
        self.assertIn("no overlap", self.error(422, raster.decode_geotiff, raw, [20, 20, 21, 21]))
        self.assertIn("no valid cell centers", self.error(422, raster.decode_geotiff, raw, [0, 0, .1, .1]))
        self.error(422, raster.decode_geotiff, tiff([[-9999]], nodata=-9999), [0, 0, 1, 1])
        self.error(422, raster.decode_geotiff, tiff([[float("nan")]]), [0, 0, 1, 1])

    def test_bytes_dimensions_storage_blocks_and_output_are_bounded(self):
        raw = tiff([[1, 2], [3, 4]])
        for name, limit in [("MAX_RASTER_BYTES", len(raw) - 1), ("MAX_RASTER_PIXELS", 3), ("MAX_BLOCK_BYTES", 1),
                            ("MAX_FEATURES", 3), ("MAX_OUTPUT_BYTES", 100)]:
            with self.subTest(name=name), mock.patch.object(raster, name, limit):
                self.error(413, raster.decode_geotiff, raw, [0, 0, 2, 2])
        with mock.patch.object(raster, "MAX_RASTER_BYTES", len(raw)):
            self.assertEqual(len(raster.decode_geotiff(raw, [0, 0, 2, 2])["dataset"]["features"]), 4)

    def test_full_feature_budget_does_not_subsample(self):
        raw = tiff(np.ones((100, 100)), transform=from_origin(0, 1, .01, .01), compress="deflate")
        document = raster.decode_geotiff(raw, [0, 0, 1, 1])
        self.assertEqual(len(document["dataset"]["features"]), 10000)
        self.assertEqual(sum(feature["properties"]["value"] for feature in document["dataset"]["features"]), 10000)
        self.assertLess(len(json.dumps(document).encode()), raster.MAX_OUTPUT_BYTES)
        raw = tiff(np.ones((101, 100)), transform=from_origin(0, 1.01, .01, .01), compress="deflate")
        self.assertIn("No cells were subsampled", self.error(413, raster.decode_geotiff, raw, [0, 0, 1, 1.01]))

    def test_band_units_selection_and_unsupported_measurements(self):
        raw = tiff([[[1]], [[2]]], units="metres")
        self.assertEqual(raster.decode_geotiff(raw, [0, 0, 1, 1])["units"], "metres")
        document = raster.decode_geotiff(raw, [0, 0, 1, 1], band=2)
        self.assertEqual(document["dataset"]["features"][0]["properties"]["value"], 2)
        for band in [0, -1, True, "1", 3]:
            self.error(400, lambda: raster.decode_geotiff(raw, [0, 0, 1, 1], band=band))
        for field in ["__proto__", "CONSTRUCTOR", "prototype", "a.b", "", "x" * 65, 1]:
            self.error(400, lambda: raster.decode_geotiff(raw, [0, 0, 1, 1], field=field))
        self.error(415, raster.decode_geotiff, tiff([[1]], scale=2), [0, 0, 1, 1])
        self.error(415, raster.decode_geotiff, tiff([[1 + 2j]], dtype="complex64"), [0, 0, 1, 1])
        self.error(415, raster.decode_geotiff, tiff([[[1]], [[2]], [[3]]], dtype="uint8", photometric="RGB"), [0, 0, 1, 1])
        self.error(422, raster.decode_geotiff, tiff([[2**53 + 1]], dtype="uint64"), [0, 0, 1, 1])

    def test_unsupported_documents_never_reach_gdal_and_external_resources_are_disabled(self):
        documents = [b"<VRTDataset><SourceFilename>/vsicurl/http://127.0.0.1/secret</SourceFilename></VRTDataset>",
                     b"<html>not data</html>", b"%PDF-1.7", b"\x89PNG", b"PK\x03\x04", b'{"type":"FeatureCollection"}']
        with mock.patch("rasterio.io.MemoryFile", side_effect=AssertionError("Unsupported input reached GDAL")):
            for raw in documents:
                self.error(415, raster.decode_geotiff, raw, [0, 0, 1, 1])
        self.error(422, raster.decode_geotiff, b"", [0, 0, 1, 1])
        self.error(422, raster.decode_geotiff, b"II*\x00broken", [0, 0, 1, 1])
        raw = tiff([[1]])
        with mock.patch.object(rasterio, "Env", wraps=rasterio.Env) as env, mock.patch.object(
                rasterio, "open", side_effect=AssertionError("A path/URL was passed to GDAL")):
            raster.decode_geotiff(raw, [0, 0, 1, 1])
        options = env.call_args.kwargs
        self.assertEqual(options["GDAL_DISABLE_READDIR_ON_OPEN"], "EMPTY_DIR")
        self.assertEqual(options["GDAL_PAM_ENABLED"], "NO")
        self.assertEqual(options["PROJ_NETWORK"], "OFF")
        self.dns.assert_not_called()
        self.socket.assert_not_called()


class PopulationSourceTests(fixtures.OfflineCase):
    bounds = [77, 28.975, 77.025, 29]

    def entry(self, iso3="IND", year=2020, **changes):
        return {"iso3": iso3, "country": "India", "popyear": str(year), "date": "2018-11-01",
                "title": f"The spatial distribution of population in {year}", "source": "WorldPop, University of Southampton, UK",
                "citation": "WorldPop and CIESIN (2018), doi:10.5258/SOTON/WP00645",
                "license": "https://hub.worldpop.org/data/licence.txt",
                "files": [f"https://data.worldpop.org/GIS/Population/Global_2000_2020/{year}/{iso3}/{iso3.lower()}_ppp_{year}.tif"], **changes}

    def source(self, entries=None, iso3="IND", year=2020, links=None, raw=None, metadata_final=None, raster_final=None):
        metadata_url = f"https://www.worldpop.org/rest/data/pop/wpgp?iso3={iso3}"
        directory_url = f"https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/{year}/{iso3}/"
        tiff_url = f"{directory_url}{iso3.lower()}_ppp_{year}_1km_Aggregated.tif"
        raw = tiff([[0, 2, -9999], [4, 5, 6], [7, 8, 9]], transform=from_origin(77, 29, 1 / 120, 1 / 120), nodata=-9999) if raw is None else raw
        metadata = {"data": [self.entry(iso3, year)] if entries is None else entries}
        self.fetch = self.patch(raster, "fetch_public_bytes", side_effect=[
            {"raw": json.dumps(metadata).encode(), "content_type": "application/json", "final_url": metadata_final or metadata_url},
            {"raw": raw, "content_type": "image/tiff", "final_url": raster_final or tiff_url},
        ])
        self.directory = self.patch(raster, "fetch_web_document", return_value={"url": directory_url, "format": "html",
                                    "links": [{"url": tiff_url, "title": "Raster"}] if links is None else [{"url": url} for url in links]})
        return metadata_url, directory_url, tiff_url

    def test_actual_metadata_year_citation_and_grid_values_stay_distinct(self):
        metadata_url, directory_url, tiff_url = self.source(entries=[self.entry(year=2019), self.entry()])
        document = raster.load_population_grid("in", self.bounds)
        self.assertEqual(document["url"], tiff_url)
        self.assertEqual(document["metadataUrl"], metadata_url)
        self.assertEqual(document["directoryUrl"], directory_url)
        self.assertEqual(document["referenceYear"], 2020)
        self.assertEqual(document["publishedDate"], "2018-11-01")
        self.assertIn("(2018)", document["citation"])
        self.assertIn("licence.txt", document["license"])
        self.assertIn("historical modeled", document["title"])
        self.assertIn("not current population or ward census", document["caveat"])
        self.assertIn("1 km", document["resolution"])
        self.assertEqual(document["units"], "people per grid cell")
        self.assertEqual(document["field"], "population")
        self.assertEqual([feature["properties"]["population"] for feature in document["dataset"]["features"]], [0, 2, 4, 5, 6, 7, 8, 9])
        self.assertEqual(self.fetch.call_args_list[1].args, (tiff_url,))
        self.assertEqual(self.fetch.call_args_list[1].kwargs["timeout"], 60)
        self.assertEqual(self.fetch.call_args_list[1].kwargs["max_bytes"], raster.MAX_RASTER_BYTES)
        self.dns.assert_not_called()

    def test_iso_country_mapping_is_not_india_specific(self):
        for iso2, iso3 in [("US", "USA"), ("NP", "NPL"), ("GB", "GBR"), ("CI", "CIV")]:
            with self.subTest(iso2=iso2):
                self.source(iso3=iso3)
                document = raster.load_population_grid(iso2, self.bounds)
                self.assertIn(f"/2020/{iso3}/", document["url"])
                self.assertEqual(self.fetch.call_args_list[0].args, (f"https://www.worldpop.org/rest/data/pop/wpgp?iso3={iso3}",))

    def test_invalid_country_bounds_and_requested_year_fail_before_fetch(self):
        fetch = self.patch(raster, "fetch_public_bytes", side_effect=AssertionError("Invalid inputs reached transport"))
        for country in [None, "", "IND", "I", "ZZ", "XX", " IN", "in?", "../", "1N"]:
            self.error(400, raster.load_population_grid, country, self.bounds)
        for year in [True, "2020", 2020.0, 1999, 2021, 2026]:
            self.error(400, raster.load_population_grid, "IN", self.bounds, year)
        self.error(400, raster.load_population_grid, "IN", [77, 29, 77, 29])
        fetch.assert_not_called()

    def test_explicit_year_uses_only_that_metadata_and_never_falls_back(self):
        self.source(entries=[self.entry(year=2019), self.entry()], year=2019)
        self.assertEqual(raster.load_population_grid("IN", self.bounds, 2019)["referenceYear"], 2019)
        self.source()
        self.error(422, raster.load_population_grid, "IN", self.bounds, 2019)
        self.directory.assert_not_called()
        self.assertEqual(self.fetch.call_count, 1)

    def test_verified_official_hub_metadata_redirect_is_retained(self):
        final_url = "https://hub.worldpop.org/rest/data/pop/wpgp?iso3=IND"
        self.source(metadata_final=final_url)
        self.assertEqual(raster.load_population_grid("IN", self.bounds)["metadataUrl"], final_url)
        self.source(metadata_final="https://hub.worldpop.org/rest/data/pop/wpgp?iso3=USA")
        self.error(422, raster.load_population_grid, "IN", self.bounds)

    def test_wrong_missing_year_or_country_metadata_cannot_supply_a_grid(self):
        entries = [self.entry(popyear=None), self.entry(popyear=""), self.entry(popyear="2026"), self.entry(popyear=True),
                   self.entry(popyear=2020.5), self.entry(iso3="USA"), self.entry(popyear="2019")]
        for entry in entries:
            with self.subTest(entry=entry):
                self.source(entries=[entry])
                self.error(422, raster.load_population_grid, "IN", self.bounds)
                self.directory.assert_not_called()

    def test_metadata_and_directory_links_are_country_year_product_and_host_filtered(self):
        invalid_files = ["https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/USA/usa_ppp_2020.tif",
                         "https://example.org/ind_ppp_2020.tif", "http://127.0.0.1/ind_ppp_2020.tif",
                         "https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/IND/ind_ppp_2020.tif?token=secret"]
        for link in invalid_files:
            self.source(entries=[self.entry(files=[link])])
            self.error(422, raster.load_population_grid, "IN", self.bounds)
            self.directory.assert_not_called()
        prefix = "https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/2020/IND/"
        invalid_links = [prefix + "ind_ppp_2020_1km_ASCII_XYZ.zip", prefix + "ind_ppp_2019_1km_Aggregated.tif",
                         prefix + "usa_ppp_2020_1km_Aggregated.tif", prefix + "ind_ppp_2020_1km_Aggregated.tif?download=1",
                         "https://example.org/ind_ppp_2020_1km_Aggregated.tif", "http://127.0.0.1/source.tif"]
        self.source(links=invalid_links)
        self.assertIn("no verified 1 km", self.error(422, raster.load_population_grid, "IN", self.bounds))
        self.assertEqual(self.fetch.call_count, 1)
        valid = prefix + "ind_ppp_2020_1km_Aggregated.tif"
        self.source(links=invalid_links + [valid])
        self.assertEqual(raster.load_population_grid("IN", self.bounds)["url"], valid)

    def test_changed_source_redirects_missing_license_and_invalid_rasters_fail(self):
        for key in ["metadata_final", "raster_final"]:
            self.source(**{key: "https://example.org/data.tif"})
            self.assertIn("redirected outside", self.error(422, raster.load_population_grid, "IN", self.bounds))
        for changes in [{"citation": ""}, {"license": None}]:
            self.source(entries=[self.entry(**changes)])
            self.error(422, raster.load_population_grid, "IN", self.bounds)
            self.directory.assert_not_called()
        self.source(raw=b"<html>download blocked</html>")
        self.error(415, raster.load_population_grid, "IN", self.bounds)
        self.source(raw=tiff([[1]], transform=from_origin(77, 29, .01, .01)))
        self.assertIn("does not match", self.error(422, raster.load_population_grid, "IN", self.bounds))
        self.source()
        self.directory.return_value["format"] = "text"
        self.error(422, raster.load_population_grid, "IN", self.bounds)

    def test_generic_loader_uses_safe_bytes_final_url_and_embedded_units_only(self):
        raw = tiff([[-12.5, 0]], units="metres")
        fetch = self.patch(raster, "fetch_public_bytes", return_value={"raw": raw, "content_type": "image/tiff",
                                                                     "final_url": "https://example.org/elevation_2018.tif"})
        document = raster.load_raster_grid("https://example.org/data", [0, 0, 2, 1])
        self.assertEqual(document["url"], "https://example.org/elevation_2018.tif")
        self.assertEqual(document["title"], "elevation_2018.tif")
        self.assertEqual(document["units"], "metres")
        self.assertEqual([feature["properties"]["value"] for feature in document["dataset"]["features"]], [-12.5, 0])
        self.assertNotIn("referenceYear", document)
        self.assertNotIn("license", document)
        self.assertEqual(fetch.call_args.kwargs["max_bytes"], raster.MAX_RASTER_BYTES)


class BinaryFetchTests(fixtures.OfflineCase):
    transport = fixtures.FetchTests.transport

    def fetch(self, url="https://example.org/data.tif", **kwargs):
        return web.fetch_public_bytes(url, allowed_media_types={"image/tiff", "application/octet-stream"}, **kwargs)

    def test_real_protocol_pins_dns_and_returns_bytes_without_credentials_or_range(self):
        body = b"II*\x00actual bytes"
        sock = fixtures.FakeSocket(b"HTTP/1.1 200 OK\r\nContent-Type: image/tiff\r\nContent-Length: " + str(len(body)).encode()
                                   + b"\r\nConnection: close\r\n\r\n" + body)
        self.socket.side_effect = None
        self.socket.return_value = sock
        self.dns.side_effect = None
        self.dns.return_value = [fixtures.address(port=80)]
        with mock.patch.object(web.socket, "create_connection", side_effect=AssertionError("Second DNS lookup forbidden")):
            result = self.fetch("http://example.org/data.tif", timeout=60)
        self.assertEqual(result, {"raw": body, "content_type": "image/tiff", "final_url": "http://example.org/data.tif"})
        self.assertEqual(sock.connected, ("8.8.8.8", 80))
        self.assertEqual(self.dns.call_count, 1)
        headers = b"".join(sock.sent)
        for forbidden in [b"Cookie:", b"Authorization:", b"Proxy-Authorization:", b"Range:"]:
            self.assertNotIn(forbidden, headers)
        self.assertIn(b"Accept-Encoding: identity", headers)
        self.assertTrue(sock.closed)

    def test_redirects_are_revalidated_without_forwarding_state(self):
        first = fixtures.FakeResponse(status=302, headers={"Location": "https://example.net/file.tif", "Set-Cookie": "secret"})
        last = fixtures.FakeResponse(b"II*\x00data", headers={"Content-Type": "image/tiff; profile=geotiff"})
        connections = self.transport([first, last])
        result = self.fetch(timeout=60)
        self.assertEqual(result["final_url"], "https://example.net/file.tif")
        self.assertEqual(self.dns.call_count, 2)
        self.assertEqual(first.reads, 0)
        self.assertTrue(first.closed)
        self.assertNotIn("Cookie", connections[1].request.call_args.kwargs["headers"])
        for location in ["http://127.0.0.1/secret", "https://user:secret@example.org/x", "https://example.org/?token=secret"]:
            self.transport([fixtures.FakeResponse(status=302, headers={"Location": location})])
            self.assertNotIn("secret", self.error(400, self.fetch))
        connections = self.transport([fixtures.FakeResponse(status=302, headers={"Location": "/again"})])
        self.dns.side_effect = [[fixtures.address()], [fixtures.address("127.0.0.1")]]
        self.error(400, self.fetch)
        self.assertEqual(len(connections), 1)

    def test_binary_budget_does_not_raise_the_text_limit(self):
        body = b"x" * (web.MAX_RAW_BYTES + 1)
        self.transport([fixtures.FakeResponse(body, headers={"Content-Type": "image/tiff"})])
        self.assertEqual(self.fetch(max_bytes=len(body))["raw"], body)
        self.transport([fixtures.FakeResponse(body)])
        self.error(413, web.fetch_web_document, fixtures.URL)
        response = fixtures.FakeResponse(body, headers={"Content-Type": "image/tiff", "Content-Length": str(len(body))})
        self.transport([response])
        self.error(413, self.fetch)
        self.assertEqual(response.reads, 0)
        response = fixtures.FakeResponse(b"12345", headers={"Content-Type": "image/tiff"})
        self.transport([response])
        self.error(413, lambda: self.fetch(max_bytes=4))
        self.assertEqual(response.offset, 5)

    def test_media_compression_partial_and_incomplete_responses_fail(self):
        for headers, status in [({"Content-Type": "text/html"}, 415), ({"Content-Encoding": "gzip", "Content-Type": "image/tiff"}, 415),
                                ({"Content-Type": "image/tiff", "Content-Length": "100"}, 502)]:
            self.transport([fixtures.FakeResponse(b"x", headers=headers)])
            self.error(status, self.fetch)
        self.transport([fixtures.FakeResponse(status=206, headers={"Content-Type": "image/tiff"})])
        self.error(502, self.fetch)

    def test_official_legacy_none_encoding_is_bytes_not_decompression(self):
        body = b'{"data": []}'
        self.transport([fixtures.FakeResponse(body, headers={"Content-Type": "application/json", "Content-Encoding": "none"})])
        result = web.fetch_public_bytes(fixtures.URL, allowed_media_types={"application/json"})
        self.assertEqual(result["raw"], body)
        self.transport([fixtures.FakeResponse(body, headers={"Content-Type": "application/json", "Content-Encoding": "none"})])
        self.error(415, web.fetch_web_document, fixtures.URL)

    def test_total_binary_deadline_allows_long_download_but_not_unbounded_trickle(self):
        response = fixtures.FakeResponse(b"data", headers={"Content-Type": "image/tiff"})
        connections = self.transport([response])
        clock = [0.0]
        original_read = response.read1

        def slow_read(size):
            clock[0] += 11
            return original_read(size)

        response.read1 = slow_read
        with mock.patch.object(web.time, "monotonic", side_effect=lambda: clock[0]), mock.patch.object(web.threading, "Timer") as timer:
            self.assertEqual(self.fetch(timeout=60)["raw"], b"data")
        self.assertEqual(timer.call_args.args[0], 60)
        self.assertEqual(self.https.call_args.args[-1], 60)
        self.assertTrue(all(0 < value <= 10 for value in connections[0]._transport_socket.timeouts))
        timer.return_value.cancel.assert_called_once_with()
        self.transport([response])
        clock[0], response.offset = 0, 0
        with mock.patch.object(web.time, "monotonic", side_effect=lambda: clock[0]), mock.patch.object(web.threading, "Timer"):
            self.error(504, lambda: self.fetch(timeout=20))

    def test_invalid_limits_and_allowlists_fail_before_transport(self):
        for changes in [{"max_bytes": 0}, {"max_bytes": True}, {"max_bytes": 64 * 1024 * 1024 + 1}, {"timeout": 0},
                        {"timeout": True}, {"timeout": float("nan")}, {"timeout": 10**1000}, {"timeout": 121}]:
            self.error(400, lambda: self.fetch(**changes))
        for media in ["image/tiff", set(), {"image/tiff\r\nCookie:x"}, {1}, {"image/*"}]:
            self.error(400, lambda: web.fetch_public_bytes(fixtures.URL, allowed_media_types=media))
        self.dns.assert_not_called()
        self.socket.assert_not_called()


if __name__ == "__main__":
    unittest.main()
