import asyncio
import socket
import struct
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from backend.agent import MapAgentService
from backend.agent_tools import AgentDependencies, AgentTools
from backend.openai_client import OpenAIChatClient
from backend.realtime import RealtimeHub
from backend import server
from websockets.asyncio.client import connect as websocket_connect


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

    def test_osm_category_lookup_precedes_nominatim_and_serp(self) -> None:
        place = {"id": "openstreetmap:node:1", "provider": "openstreetmap", "providerId": "node:1", "name": "Map Cafe", "address": "", "countryCode": "IN", "lat": 28.0, "lon": 77.0, "bbox": [77.0, 28.0, 77.0, 28.0]}
        stale_serp = {"id": "serpapi-google-maps:old", "provider": "serpapi-google-maps", "providerId": "old", "name": "Old Cafe", "address": "", "countryCode": "IN", "lat": 28.0, "lon": 77.0, "bbox": [77.0, 28.0, 77.0, 28.0]}
        with mock.patch.object(server.CACHE, "get_place_lookup", return_value=[stale_serp]), mock.patch.object(server.CACHE, "search_places", return_value=[]), mock.patch.object(server, "search_osm_category_places", return_value=[place]) as osm, mock.patch.object(server, "search_nominatim_places") as nominatim, mock.patch.object(server, "search_serp_places") as serp, mock.patch.object(server.CACHE, "put_place_lookup"):
            discovery = server.lookup_places("coffee shops", "IN", 28.0, 77.0)

        self.assertEqual(discovery["results"], [place])
        self.assertEqual(discovery["source"], "openstreetmap")
        self.assertEqual(discovery["lookupStage"], "osm-category-search")
        osm.assert_called_once_with("coffee shops", "IN", 28.0, 77.0)
        nominatim.assert_not_called()
        serp.assert_not_called()

    def test_osm_category_query_uses_only_the_reviewed_tag_taxonomy(self) -> None:
        payload = {"elements": [{"type": "node", "id": 7, "lat": 28.0, "lon": 77.0, "tags": {"name": "Map Cafe", "amenity": "cafe"}}]}
        with mock.patch.object(server, "fetch_overpass_payload", return_value=payload) as overpass, mock.patch.object(server.CACHE, "put_places"):
            places = server.search_osm_category_places('coffee; nwr["tourism"]', "IN", 28.0, 77.0)

        self.assertEqual(places[0]["id"], "openstreetmap:node:7")
        query = overpass.call_args.args[0]
        self.assertIn('["amenity"="cafe"]', query)
        self.assertNotIn('coffee; nwr', query)

    def test_agent_city_resolution_keeps_ambiguous_short_names_as_choices(self) -> None:
        cities = [
            {"shortName": "Portland", "countryCode": "US", "lat": 43.66, "lon": -70.25},
            {"shortName": "Portland", "countryCode": "US", "lat": 45.52, "lon": -122.67},
        ]
        with mock.patch.object(server, "suggest_locations", return_value=cities):
            self.assertIsNone(server.resolve_agent_city("Portland", "US"))
        with mock.patch.object(server, "suggest_locations", return_value=[cities[0]]):
            self.assertEqual(server.resolve_agent_city("Portland", "US"), cities[0])

    def test_serp_is_used_only_after_osm_discovery_is_empty(self) -> None:
        place = {"id": "serpapi-google-maps:example", "provider": "serpapi-google-maps", "providerId": "example", "name": "Example", "address": "", "countryCode": "", "lat": 28.0, "lon": 77.0, "bbox": [77.0, 28.0, 77.0, 28.0]}
        with mock.patch.object(server.CACHE, "get_place_lookup", return_value=None), mock.patch.object(server.CACHE, "search_places", return_value=[]), mock.patch.object(server, "search_osm_category_places", return_value=[]) as osm, mock.patch.object(server, "search_nominatim_places", return_value=[]) as nominatim, mock.patch.object(server, "search_serp_places", return_value=[place]) as serp, mock.patch.object(server.CACHE, "put_place_lookup"):
            discovery = server.lookup_places("unindexed place", "", None, None)

        self.assertEqual(discovery["source"], "serpapi")
        self.assertEqual(discovery["lookupStage"], "serp-fallback")
        self.assertEqual(discovery["fallbackReason"], "no-usable-osm-result")
        osm.assert_called_once_with("unindexed place", "", None, None)
        nominatim.assert_called_once_with("unindexed place", "", None, None)
        serp.assert_called_once_with("unindexed place", None, None, "")

    def test_local_place_suggestions_use_only_the_local_store(self) -> None:
        place = {"id": "openstreetmap:node:1", "provider": "openstreetmap", "providerId": "node:1", "name": "Example", "address": "", "countryCode": "", "lat": 28.0, "lon": 77.0, "bbox": [77.0, 28.0, 77.0, 28.0]}
        with mock.patch.object(server.CACHE, "search_places", return_value=[place]) as search:
            results = server.local_place_suggestions("exam")

        self.assertEqual(results, [place])
        search.assert_called_once_with("exam", limit=8)


class MapLocationSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database_path = Path(directory.name) / "search.db"
        self.cache = server.Cache(self.database_path)
        self.addCleanup(self.cache.close)
        patcher = mock.patch.object(server, "CACHE", self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.place = {
            "id": "serpapi-google-maps:darma", "provider": "serpapi-google-maps", "providerId": "darma",
            "name": "Darma valley", "address": "Darma, Uttarakhand 262545", "countryCode": "",
            "lat": 30.2474577, "lon": 80.54799, "bbox": [80.54799, 30.2474577, 80.54799, 30.2474577],
            "providerPayload": {"country": "India"},
        }

    def test_saved_landmark_resolves_without_city_or_internet_search(self) -> None:
        self.cache.put_places([self.place])
        with mock.patch.object(server, "nominatim_search") as city, mock.patch.object(server, "lookup_places") as discover:
            result = server.resolve_location("Darma Valley", "IN")

        self.assertEqual(result["shortName"], "Darma valley")
        self.assertEqual(result["lat"], self.place["lat"])
        self.assertEqual(result["country"], "India")
        self.assertEqual(result["countryCode"], "")
        self.assertTrue(result["cached"])
        self.assertNotIn("providerPayload", result)
        city.assert_not_called()
        discover.assert_not_called()

    def test_saved_places_override_previously_empty_city_suggestions(self) -> None:
        self.cache.put_suggestions("darma valley", "in", [])
        self.cache.put_places([self.place])
        with mock.patch.object(server, "nominatim_search") as city, mock.patch.object(server, "search_serp_places") as serp:
            results = server.suggest_map_locations("Darma Valley", "IN")

        self.assertEqual([item["shortName"] for item in results], ["Darma valley"])
        self.assertTrue(results[0]["cached"])
        city.assert_not_called()
        serp.assert_not_called()

    def test_saved_landmarks_do_not_change_strict_agent_city_search(self) -> None:
        self.cache.put_places([self.place])
        with mock.patch.object(server, "nominatim_search", return_value=[]) as city, mock.patch.object(server, "search_serp_places") as serp:
            result = server.resolve_agent_city("Darma Valley", "IN")

        self.assertIsNone(result)
        city.assert_called_once_with("Darma Valley", "in", 6)
        serp.assert_not_called()

    def test_qualified_saved_search_uses_address_and_provider_country(self) -> None:
        self.cache.put_places([self.place])
        with mock.patch.object(server, "nominatim_search") as city:
            result = server.resolve_location("Darma Valley, Uttarakhand, India", "GB")

        self.assertEqual(result["id"], self.place["id"])
        self.assertEqual(server.saved_place_matches("Darma Valley, Nepal", ""), [])
        city.assert_not_called()

    def test_saved_places_exclude_a_known_different_country(self) -> None:
        self.cache.put_places([{**self.place, "countryCode": "IN"}])
        self.assertEqual(server.saved_place_matches("Darma Valley", "GB"), [])
        self.assertEqual(len(server.saved_place_matches("Darma Valley", "IN")), 1)

    def test_exact_saved_match_is_not_lost_behind_newer_substring_matches(self) -> None:
        self.cache.put_places([self.place])
        self.cache.put_places([
            {**self.place, "id": f"serpapi-google-maps:other-{index}", "providerId": f"other-{index}",
             "name": f"Darma Valley Lodge {index}", "countryCode": "GB", "lat": 51.0, "lon": float(index)}
            for index in range(33)
        ])
        with mock.patch.object(server, "nominatim_search") as city:
            result = server.resolve_location("Darma Valley", "IN")
            suggestions = server.suggest_map_locations("Darma Valley", "IN")

        self.assertEqual(result["id"], self.place["id"])
        self.assertEqual(suggestions[0]["id"], self.place["id"])
        city.assert_not_called()

    def test_full_search_falls_back_to_google_and_reuses_persisted_places(self) -> None:
        payload = {
            "search_metadata": {"status": "Success"},
            "place_results": {
                "place_id": "darma", "title": "Darma valley", "address": self.place["address"], "country": "India",
                "gps_coordinates": {"longitude": self.place["lon"], "latitude": self.place["lat"]},
            },
        }
        with mock.patch.object(server, "nominatim_search", return_value=[]) as city, mock.patch.object(server, "search_osm_category_places", return_value=[]), mock.patch.object(server, "search_nominatim_places", return_value=[]) as osm, mock.patch.object(server, "fetch_serp_response", return_value=payload) as google:
            first = server.resolve_location("Darma Valley", "IN")
            reopened = server.Cache(self.database_path)
            self.addCleanup(reopened.close)
            with mock.patch.object(server, "CACHE", reopened):
                second = server.resolve_location("Darma Valley", "IN")
                suggestions = server.suggest_map_locations("Darma", "IN")

        self.assertEqual(first["provider"], "serpapi-google-maps")
        self.assertFalse(first["cached"])
        self.assertEqual(first["country"], "India")
        self.assertTrue(second["cached"])
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(suggestions[0]["id"], first["id"])
        city.assert_called_once_with("Darma Valley", "in", 1)
        osm.assert_called_once_with("Darma Valley", "IN", None, None)
        google.assert_called_once()

    def test_general_osm_result_is_persisted_without_google_lookup(self) -> None:
        osm_place = {**self.place, "id": "openstreetmap:node:1", "provider": "openstreetmap", "providerId": "node:1", "countryCode": "IN"}
        with mock.patch.object(server, "nominatim_search", return_value=[]), mock.patch.object(server, "search_osm_category_places", return_value=[]), mock.patch.object(server, "search_nominatim_places", return_value=[osm_place]), mock.patch.object(server, "search_serp_places") as google:
            result = server.resolve_location("Darma Valley", "IN")

        self.assertEqual(result["provider"], "openstreetmap")
        self.assertEqual(self.cache.search_places("darma valley")[0]["id"], result["id"])
        google.assert_not_called()

    def test_place_discovery_reuses_google_record_after_empty_osm_search(self) -> None:
        self.cache.put_places([self.place])
        with mock.patch.object(server, "search_osm_category_places", return_value=[]) as category, mock.patch.object(server, "search_nominatim_places", return_value=[]) as osm, mock.patch.object(server, "search_serp_places") as google:
            discovery = server.lookup_places("Darma Valley", "IN", 28.5, 77.5)

        self.assertEqual(discovery["lookupStage"], "local-serp-cache")
        self.assertTrue(discovery["stored"])
        self.assertEqual(discovery["results"][0]["id"], self.place["id"])
        category.assert_called_once()
        osm.assert_called_once()
        google.assert_not_called()

    def test_saved_google_results_are_ranked_by_context_before_limiting(self) -> None:
        self.cache.put_places([
            {**self.place, "id": f"serpapi-google-maps:other-{index}", "providerId": f"other-{index}",
             "name": "Darma valley", "lat": 10.0, "lon": float(index)}
            for index in range(9)
        ] + [self.place])
        with mock.patch.object(server, "search_osm_category_places", return_value=[]), mock.patch.object(server, "search_nominatim_places", return_value=[]), mock.patch.object(server, "search_serp_places") as google:
            result = server.lookup_places("Darma Valley", "IN", self.place["lat"], self.place["lon"])

        self.assertEqual(result["results"][0]["id"], self.place["id"])
        self.assertEqual(len(result["results"]), 8)
        google.assert_not_called()

    def test_normal_city_search_and_cached_autocomplete_still_work(self) -> None:
        city = {"id": "city-delhi", "name": "Delhi, India", "shortName": "Delhi", "countryCode": "IN", "lat": 28.6, "lon": 77.2}
        with mock.patch.object(server, "nominatim_search", return_value=[city]) as search:
            first = server.resolve_location("Delhi", "IN")
            second = server.resolve_location("Delhi", "IN")
            suggestions = server.suggest_map_locations("Del", "IN")
            cached_suggestions = server.suggest_map_locations("Del", "IN")

        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(suggestions, cached_suggestions)
        self.assertEqual(search.call_count, 2)


class MapAgentToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = {"pins": [], "areas": [], "state": {}}
        self.add_pin = mock.Mock(side_effect=lambda name, lat, lon, place_id, source: {
            "id": "pin-agent", "label": "A", "name": name, "lat": lat, "lon": lon, "placeId": place_id, "source": source,
        })

        def save_state(state):
            self.workspace["state"] = state
            return state

        city = {"id": "city-delhi", "name": "Delhi, India", "shortName": "Delhi", "country": "India", "countryCode": "IN", "lat": 28.6139, "lon": 77.2090, "bbox": [76.8, 28.4, 77.4, 28.9]}
        place = {"id": "osm-cafe", "provider": "openstreetmap", "name": "Map Cafe", "address": "Connaught Place", "countryCode": "IN", "lat": 28.632, "lon": 77.219, "bbox": [77.219, 28.632, 77.219, 28.632]}
        route = {"id": "route-agent", "provider": "openstreetmap-dijkstra", "profile": "driving", "waypoints": [[77.209, 28.6139], [77.219, 28.632]], "geometry": {"type": "LineString", "coordinates": [[77.209, 28.6139], [77.219, 28.632]]}, "summary": {"distanceMeters": 2400, "durationSeconds": 420}}
        self.tools = AgentTools(AgentDependencies(
            suggest_cities=mock.Mock(return_value=[city]),
            resolve_city=mock.Mock(return_value=city),
            search_places=mock.Mock(return_value={"results": [place], "source": "openstreetmap", "lookupStage": "osm-category-search"}),
            plan_route=mock.Mock(return_value=route),
            workspace_snapshot=lambda: self.workspace,
            clear_workspace=self.clear_workspace,
            add_pin=self.add_pin,
            save_workspace_state=save_state,
            capture_workspace=mock.Mock(),
            mutate_workspace=mock.Mock(),
            restore_workspace=mock.Mock(),
        ))

    def clear_workspace(self) -> None:
        self.workspace.update({"pins": [], "areas": [], "state": {}})

    def test_agent_tools_only_present_trusted_city_place_and_route_data(self) -> None:
        context = self.tools.new_context({})
        city_result = self.tools.execute(context, "find_city", {"query": "Delhi"})
        city_ref = city_result["locations"][0]["ref"]
        place_result = self.tools.execute(context, "search_places", {"query": "coffee shops", "nearRef": city_ref})
        place_ref = place_result["places"][0]["ref"]
        route_result = self.tools.execute(context, "plan_route", {"waypointRefs": [city_ref, place_ref]})

        result = self.tools.execute(context, "present_map", {
            "cityRef": city_ref,
            "placeRefs": [place_ref],
            "persistPlaceRefs": [place_ref],
            "routeRef": route_result["routeRef"],
        })

        update = result["mapUpdate"]
        self.assertEqual(update["selectedCity"]["name"], "Delhi, India")
        self.assertEqual(update["places"][0]["name"], "Map Cafe")
        self.assertEqual(update["route"]["id"], "route-agent")
        self.assertEqual(update["routeStops"][1]["id"], "osm-cafe")
        self.assertEqual(self.workspace["state"]["routeId"], "route-agent")
        self.add_pin.assert_called_once_with("Map Cafe", 28.632, 77.219, "osm-cafe", "place")

    def test_agent_tools_reject_unknown_references_and_clear_explicitly(self) -> None:
        context = self.tools.new_context({})
        with self.assertRaises(server.ServiceError):
            self.tools.execute(context, "present_map", {"placeRefs": ["place:not-trusted"]})

        cleared = self.tools.execute(context, "clear_map", {})
        self.assertTrue(cleared["mapUpdate"]["clear"])
        self.assertEqual(cleared["mapUpdate"]["workspace"]["pins"], [])

    def test_agent_map_presentation_recovers_from_invalid_legacy_workspace_state(self) -> None:
        self.workspace["state"] = "invalid legacy state"
        context = self.tools.new_context({})
        city_ref = self.tools.execute(context, "find_city", {"query": "Delhi"})["locations"][0]["ref"]

        result = self.tools.execute(context, "present_map", {"cityRef": city_ref})

        self.assertEqual(result["mapUpdate"]["selectedCity"]["name"], "Delhi, India")
        self.assertIsInstance(self.workspace["state"], dict)

    def test_socket_origin_policy_keeps_wildcard_configuration_loopback_only(self) -> None:
        hub = RealtimeHub(server.CONFIG)

        self.assertTrue(hub._origin_allowed("http://127.0.0.1:8080"))
        self.assertTrue(hub._origin_allowed("https://localhost:3000"))
        self.assertFalse(hub._origin_allowed("https://example.com"))
        self.assertFalse(hub._origin_allowed(""))


class OpenAICompatibleClientTests(unittest.TestCase):
    def test_posts_tools_to_chat_completions_without_exposing_the_key(self) -> None:
        config = replace(server.CONFIG, openai_base_url="https://model.example/v1", openai_api_key="secret", model_name="map-model", agent_max_tokens=0, agent_temperature=None)

        class Response:
            def read(self, _maximum):
                return b'{"choices":[{"message":{"content":"ready"}}]}'

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        with mock.patch("backend.openai_client.urllib.request.urlopen", return_value=Response()) as request:
            message = OpenAIChatClient(config).complete([{"role": "user", "content": "map it"}], [])

        self.assertEqual(message["content"], "ready")
        outbound = request.call_args.args[0]
        self.assertEqual(outbound.full_url, "https://model.example/v1/chat/completions")
        self.assertEqual(outbound.get_header("Authorization"), "Bearer secret")
        self.assertIn(b'"model":"map-model"', outbound.data)
        self.assertNotIn(b'"parallel_tool_calls"', outbound.data)
        self.assertNotIn(b'"temperature"', outbound.data)
        self.assertNotIn(b'"max_tokens"', outbound.data)
        self.assertNotIn(b'"max_completion_tokens"', outbound.data)


class MapAgentServiceTests(unittest.TestCase):
    class Hub:
        def __init__(self) -> None:
            self.events = []
            self.completed = threading.Event()
            self.handler = None

        def set_message_handler(self, handler) -> None:
            self.handler = handler

        def has_session(self, session_id: str) -> bool:
            return session_id == "session-12345678901234567890"

        def publish(self, session_id: str, event: dict) -> bool:
            self.events.append((session_id, event))
            if event["type"] in {"agent.completed", "agent.limitation", "agent.failed", "agent.cancelled"}:
                self.completed.set()
            return True

    class Client:
        available = True

        def __init__(self) -> None:
            self.calls = 0

        def complete(self, messages, tools):
            self.calls += 1
            if self.calls == 1:
                return {"content": "", "tool_calls": [{"id": "clear", "function": {"name": "clear_map", "arguments": "{}"}}]}
            return {"content": "The map is clear."}

    def test_agent_service_emits_validated_map_update_after_tool_loop(self) -> None:
        cache = server.Cache(Path(":memory:"))
        self.addCleanup(cache.close)
        tools = AgentTools(AgentDependencies(
            suggest_cities=lambda query, country: [],
            resolve_city=lambda query, country: None,
            search_places=lambda query, country, lat, lon: {"results": [], "source": "openstreetmap", "lookupStage": "local-osm-cache"},
            plan_route=lambda waypoints, profile: {},
            workspace_snapshot=cache.workspace_snapshot,
            clear_workspace=cache.clear_workspace,
            add_pin=lambda name, lat, lon, place_id, source: {},
            save_workspace_state=lambda state: state,
            capture_workspace=cache.capture_workspace,
            mutate_workspace=cache.mutate_workspace,
            restore_workspace=cache.restore_workspace,
        ))
        hub = self.Hub()
        service = MapAgentService(self.Client(), tools, hub)

        service.start_run("session-12345678901234567890", "clear the map", {})

        self.assertTrue(hub.completed.wait(2))
        self.assertTrue(any(event["type"] == "agent.map" and event["update"]["clear"] for _, event in hub.events))
        self.assertEqual(hub.events[-1][1]["type"], "agent.completed")

    def test_agent_cannot_complete_after_discovery_without_presenting_the_map(self) -> None:
        city = {"id": "city-delhi", "name": "Delhi", "shortName": "Delhi", "countryCode": "IN", "lat": 28.6139, "lon": 77.2090, "bbox": [77.0, 28.0, 77.4, 29.0]}

        class Client:
            available = True

            def __init__(self) -> None:
                self.calls = 0

            def complete(self, messages, tools):
                self.calls += 1
                if self.calls == 1:
                    return {"content": "", "tool_calls": [{"id": "city", "function": {"name": "find_city", "arguments": '{"query":"Delhi"}'}}]}
                return {"content": "Delhi is ready."}

        cache = server.Cache(Path(":memory:"))
        self.addCleanup(cache.close)
        tools = AgentTools(AgentDependencies(
            suggest_cities=lambda query, country: [city],
            resolve_city=lambda query, country: city,
            search_places=lambda query, country, lat, lon: {"results": [], "source": "openstreetmap", "lookupStage": "local-osm-cache"},
            plan_route=lambda waypoints, profile: {},
            workspace_snapshot=cache.workspace_snapshot,
            clear_workspace=cache.clear_workspace,
            add_pin=lambda name, lat, lon, place_id, source: {},
            save_workspace_state=lambda state: state,
            capture_workspace=cache.capture_workspace,
            mutate_workspace=cache.mutate_workspace,
            restore_workspace=cache.restore_workspace,
        ))
        hub = self.Hub()
        service = MapAgentService(Client(), tools, hub)

        service.start_run("session-12345678901234567890", "show Delhi", {})

        self.assertTrue(hub.completed.wait(2))
        self.assertEqual(hub.events[-1][1]["type"], "agent.failed")
        self.assertFalse(any(event["type"] == "agent.completed" for _, event in hub.events))


class RealtimeIntegrationTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def socket_port_pair() -> int:
        for _ in range(20):
            first = socket.socket()
            first.bind(("127.0.0.1", 0))
            port = first.getsockname()[1]
            second = socket.socket()
            try:
                second.bind(("127.0.0.1", port + 1))
                return port
            except OSError:
                continue
            finally:
                first.close()
                second.close()
        raise RuntimeError("Could not find a free local socket port pair.")

    async def test_session_registration_uses_the_dedicated_loopback_socket(self) -> None:
        port = self.socket_port_pair()
        hub = RealtimeHub(replace(server.CONFIG, port=port))
        hub.start()
        try:
            async with websocket_connect(f"ws://127.0.0.1:{port + 1}", origin="http://127.0.0.1:8080") as websocket:
                await websocket.send('{"v":1,"type":"session.open","sessionId":"session-12345678901234567890"}')
                reply = await asyncio.wait_for(websocket.recv(), 2)
                self.assertIn("session.ready", reply)
                self.assertTrue(hub.has_session("session-12345678901234567890"))
        finally:
            hub.stop()


if __name__ == "__main__":
    unittest.main()
