import struct
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from backend import server


def polygon_wkb() -> bytes:
    coordinates = [(77.0, 28.0), (77.1, 28.0), (77.1, 28.1), (77.0, 28.0)]
    return b"".join(
        [
            b"\x01",
            struct.pack("<I", 3),
            struct.pack("<I", 1),
            struct.pack("<I", len(coordinates)),
            b"".join(struct.pack("<2d", *coordinate) for coordinate in coordinates),
        ]
    )


def geopackage_polygon() -> str:
    # GeoPackage header: little-endian, XY envelope, WGS84 SRS, then WKB.
    header = b"GP" + bytes([0, 3]) + struct.pack("<i", 4326)
    envelope = struct.pack("<4d", 77.0, 77.1, 28.0, 28.1)
    return (header + envelope + polygon_wkb()).hex()


class OpenBuildingMapGeometryTests(unittest.TestCase):
    def test_decodes_geopackage_wkb_polygon(self) -> None:
        feature = server.openbuildingmap_feature({"geom": geopackage_polygon(), "fid": "building-1"}, "buildings.gpkg")

        self.assertIsNotNone(feature)
        assert feature is not None
        self.assertEqual(feature["geometry"]["type"], "Polygon")
        self.assertEqual(feature["geometry"]["coordinates"][0][0], [77.0, 28.0])
        self.assertEqual(feature["properties"]["sourceId"], "buildings.gpkg:building-1")

    def test_decodes_raw_wkb_polygon(self) -> None:
        geometry = server.binary_geometry(polygon_wkb().hex())

        self.assertIsNotNone(geometry)
        assert geometry is not None
        self.assertEqual(geometry["type"], "Polygon")
        self.assertEqual(len(geometry["coordinates"][0]), 4)

    def test_rejects_malformed_binary_geometry(self) -> None:
        self.assertIsNone(server.binary_geometry("47500003"))
        self.assertIsNone(server.binary_geometry("not-a-geometry"))

    def test_exposes_complete_tile_metadata_headers(self) -> None:
        headers = server.tile_response_headers({
            "cached": True,
            "source": "openbuildingmap",
            "stale": False,
            "stats": {"featureCount": 12, "buildingCount": 10, "poiCount": 2, "inferredCount": 4, "modelSampleSize": 6},
        })

        self.assertEqual(headers["X-Data-Source"], "openbuildingmap")
        self.assertEqual(headers["X-Inferred-Building-Count"], "4")
        self.assertEqual(headers["X-Height-Model-Sample-Size"], "6")

    def test_marks_floor_derived_height_as_inferred(self) -> None:
        geometry = {"type": "Polygon", "coordinates": [[[77.0, 28.0], [77.1, 28.0], [77.1, 28.1], [77.0, 28.0]]]}
        features = [{
            "type": "Feature", "geometry": geometry,
            "properties": {"kind": "building", "sourceId": "levels-only", "buildingType": "apartments", "levels": 4, "minHeight": 0},
        }]

        enriched, _ = server.apply_heights(features, [77.05, 28.05])
        properties = enriched[0]["properties"]

        self.assertEqual(properties["heightSource"], "levels")
        self.assertEqual(properties["heightKind"], "source-derived")
        self.assertEqual(properties["heightConfidence"], "medium")
        self.assertTrue(properties["inferred"])

    def test_raises_explicit_height_above_its_base(self) -> None:
        geometry = {"type": "Polygon", "coordinates": [[[77.0, 28.0], [77.1, 28.0], [77.1, 28.1], [77.0, 28.0]]]}
        features = [{
            "type": "Feature", "geometry": geometry,
            "properties": {"kind": "building", "sourceId": "bad-base", "buildingType": "office", "realHeight": 5, "minHeight": 6},
        }]

        enriched, _ = server.apply_heights(features, [77.05, 28.05])
        properties = enriched[0]["properties"]

        self.assertEqual(properties["height"], 6.5)
        self.assertTrue(properties["heightAdjustedToBase"])

    def test_removing_a_pin_invalidates_referencing_areas(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = server.Cache(Path(directory) / "workspace.db")
            try:
                first = cache.add_pin("First", 28.0, 77.0, None, "map-click")
                second = cache.add_pin("Second", 28.1, 77.1, None, "map-click")
                third = cache.add_pin("Third", 28.2, 77.0, None, "map-click")
                area = cache.add_area(
                    "Triangle",
                    {"type": "Polygon", "coordinates": [[[77.0, 28.0], [77.1, 28.1], [77.0, 28.2], [77.0, 28.0]]]},
                    {"pinIds": [first["id"], second["id"], third["id"]]},
                )

                self.assertTrue(cache.delete_pin(second["id"]))
                stored = next(item for item in cache.list_areas() if item["id"] == area["id"])

                self.assertTrue(stored["summary"]["invalid"])
                self.assertEqual(stored["summary"]["invalidReason"], "A referenced pin was removed.")
            finally:
                cache.close()

    def test_rejects_self_intersecting_area_and_derives_its_summary(self) -> None:
        bow_tie = {"type": "Polygon", "coordinates": [[[77.0, 28.0], [77.1, 28.1], [77.1, 28.0], [77.0, 28.1], [77.0, 28.0]]]}
        triangle = {"type": "Polygon", "coordinates": [[[77.0, 28.0], [77.1, 28.0], [77.0, 28.1], [77.0, 28.0]]]}

        self.assertIsNone(server.valid_polygon(bow_tie))
        geometry = server.valid_polygon(triangle)
        self.assertIsNotNone(geometry)
        assert geometry is not None
        summary = server.area_summary(geometry, {"areaSquareMeters": 1, "pinIds": ["pin-a", "pin-b"]})

        self.assertGreater(summary["areaSquareMeters"], 1_000)
        self.assertEqual(summary["pinIds"], ["pin-a", "pin-b"])

    def test_accepts_only_loopback_hosts(self) -> None:
        self.assertTrue(server.is_loopback_host("127.0.0.1"))
        self.assertTrue(server.is_loopback_host("localhost"))
        self.assertTrue(server.is_loopback_host("::1"))
        self.assertFalse(server.is_loopback_host("0.0.0.0"))
        self.assertFalse(server.is_loopback_host("api.example.com"))

    def test_request_gate_returns_retryable_busy_response(self) -> None:
        class Handler:
            def __init__(self) -> None:
                self.response = None

            def send_json(self, status, body, headers) -> None:
                self.response = (status, body, headers)

        @server.limited_request
        def endpoint(handler) -> None:
            handler.response = (200, {}, {})

        held_slots = []
        while server.REQUEST_GATE.acquire(blocking=False):
            held_slots.append(True)
        try:
            handler = Handler()
            endpoint(handler)
            self.assertIsNotNone(handler.response)
            assert handler.response is not None
            self.assertEqual(handler.response[0], 503)
            self.assertEqual(handler.response[2]["Retry-After"], "1")
        finally:
            for _ in held_slots:
                server.REQUEST_GATE.release()

    def test_browser_country_context_is_not_cached(self) -> None:
        payload = {"address": {"country": "India", "country_code": "in"}}
        with mock.patch.object(server.CACHE, "get_geocode") as get_cached, mock.patch.object(server.CACHE, "put_geocode") as put_cached, mock.patch.object(server, "fetch_json", return_value=payload):
            result = server.detect_country(28.6139, 77.2090)

        self.assertEqual(result["countryCode"], "IN")
        get_cached.assert_not_called()
        put_cached.assert_not_called()

    def test_uses_overture_when_osm_tile_has_no_buildings(self) -> None:
        osm_poi = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [77.0, 28.0]}, "properties": {"kind": "poi"}}
        overture_building = {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": []}, "properties": {"kind": "building"}}
        osm = {"features": [osm_poi], "source": "openstreetmap", "cached": True, "stale": False}
        overture = {"features": [overture_building], "source": "overture", "cached": False, "stale": False}
        config = replace(server.CONFIG, openbuildingmap_api_url="", disable_overture=False)

        with mock.patch.object(server, "CONFIG", config), mock.patch.object(server, "get_source_tile", side_effect=[osm, overture]):
            result = server.source_tile_with_fallback(1, 2, 14)

        self.assertEqual(result["source"], "overture")
        self.assertEqual([feature["properties"]["kind"] for feature in result["features"]], ["building", "poi"])

    def test_uses_stale_openbuildingmap_catalog_after_refresh_failure(self) -> None:
        original_catalog = dict(server.OPENBUILDINGMAP_CATALOG)
        config = replace(server.CONFIG, openbuildingmap_api_url="https://mirror.example")
        server.OPENBUILDINGMAP_CATALOG.update({"expires": 0.0, "files": [{"filename": "building.12.gpkg", "quadkey": "12"}]})
        try:
            with mock.patch.object(server, "CONFIG", config), mock.patch.object(server, "fetch_json", side_effect=server.ServiceError("mirror unavailable")):
                files = server.openbuildingmap_files()
        finally:
            server.OPENBUILDINGMAP_CATALOG.clear()
            server.OPENBUILDINGMAP_CATALOG.update(original_catalog)

        self.assertEqual(files, [{"filename": "building.12.gpkg", "quadkey": "12"}])

    def test_dijkstra_route_records_each_examined_osm_road_segment(self) -> None:
        ways = [
            {"tags": {"highway": "residential"}, "geometry": [{"lon": 77.0, "lat": 28.0}, {"lon": 77.001, "lat": 28.0}]},
            {"tags": {"highway": "residential"}, "geometry": [{"lon": 77.001, "lat": 28.0}, {"lon": 77.002, "lat": 28.0}]},
            {"tags": {"highway": "residential"}, "geometry": [{"lon": 77.001, "lat": 28.0}, {"lon": 77.001, "lat": 28.001}]},
        ]
        with mock.patch.object(server, "fetch_osm_driving_ways", return_value=ways):
            result = server.dijkstra_osm_route([[77.0, 28.0], [77.002, 28.0]])

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["summary"]["algorithm"], "dijkstra")
        self.assertEqual(result["geometry"]["coordinates"][0], [77.0, 28.0])
        self.assertEqual(result["geometry"]["coordinates"][-1], [77.002, 28.0])
        self.assertGreaterEqual(len(result["summary"]["search"]["exploredEdges"]), 3)

    def test_accepts_multi_stop_route_plans_up_to_the_supported_limit(self) -> None:
        plan = [[77.0 + index / 10_000, 28.0] for index in range(server.MAX_ROUTE_WAYPOINTS)]

        self.assertEqual(server.route_waypoints(plan), plan)
        with self.assertRaises(server.ServiceError):
            server.route_waypoints(plan + [[77.1, 28.0]])

    def test_dijkstra_connects_each_leg_of_an_ordered_route_plan(self) -> None:
        ways = [
            {"tags": {"highway": "residential"}, "geometry": [{"lon": 77.0, "lat": 28.0}, {"lon": 77.001, "lat": 28.0}]},
            {"tags": {"highway": "residential"}, "geometry": [{"lon": 77.001, "lat": 28.0}, {"lon": 77.002, "lat": 28.0}]},
            {"tags": {"highway": "residential"}, "geometry": [{"lon": 77.002, "lat": 28.0}, {"lon": 77.003, "lat": 28.0}]},
        ]
        with mock.patch.object(server, "fetch_osm_driving_ways", return_value=ways):
            result = server.dijkstra_osm_route([[77.0, 28.0], [77.001, 28.0], [77.003, 28.0]])

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["geometry"]["coordinates"], [[77.0, 28.0], [77.001, 28.0], [77.002, 28.0], [77.003, 28.0]])

    def test_serp_place_search_keeps_every_coordinate_result(self) -> None:
        payload = {
            "search_metadata": {"status": "Success"},
            "place_results": {"place_id": "primary", "title": "Primary", "gps_coordinates": {"longitude": 77.0, "latitude": 28.0}},
            "local_results": [
                {"place_id": "one", "title": "First", "gps_coordinates": {"longitude": 77.1, "latitude": 28.1}},
                {"place_id": "two", "title": "Second", "gps_coordinates": {"longitude": 77.2, "latitude": 28.2}},
            ],
        }
        with mock.patch.object(server, "fetch_serp_response", return_value=payload), mock.patch.object(server.CACHE, "put_places", side_effect=lambda places: places):
            results = server.search_serp_places("example", None, None, "")

        self.assertEqual([place["name"] for place in results], ["Primary", "First", "Second"])

    def test_forced_serp_lookup_skips_local_and_osm_lookup_paths(self) -> None:
        place = {"id": "serpapi-google-maps:example", "provider": "serpapi-google-maps", "providerId": "example", "name": "Example", "address": "", "countryCode": "", "lat": 28.0, "lon": 77.0, "bbox": [77.0, 28.0, 77.0, 28.0]}
        with mock.patch.object(server, "search_serp_places", return_value=[place]) as serp, mock.patch.object(server.CACHE, "get_place_lookup") as lookup, mock.patch.object(server.CACHE, "search_places") as local:
            results, stored = server.lookup_places("Example", "", None, None, "serp")

        self.assertEqual(results, [place])
        self.assertFalse(stored)
        serp.assert_called_once_with("Example", None, None, "")
        lookup.assert_not_called()
        local.assert_not_called()

    def test_local_place_suggestions_use_only_the_local_store(self) -> None:
        place = {"id": "openstreetmap:node:1", "provider": "openstreetmap", "providerId": "node:1", "name": "Example", "address": "", "countryCode": "", "lat": 28.0, "lon": 77.0, "bbox": [77.0, 28.0, 77.0, 28.0]}
        with mock.patch.object(server.CACHE, "search_places", return_value=[place]) as search:
            results = server.local_place_suggestions("exam")

        self.assertEqual(results, [place])
        search.assert_called_once_with("exam", limit=8)


if __name__ == "__main__":
    unittest.main()
