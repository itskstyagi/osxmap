"""Offline geometry regressions; run with backend.test_isolated for HTTP wiring."""

import copy
import json
import subprocess
import sys
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit

from backend import map_geometry as geometry
from backend import web_sources as web
from backend.errors import ServiceError


CITY = {"id": "relation:18814682", "shortName": "Noida", "name": "Noida, India", "countryCode": "IN",
        "lat": 28.57, "lon": 77.35, "bbox": [77.0, 28.0, 78.0, 29.0]}
BOX = [77.30, 28.50, 77.40, 28.60]
OUTER = [[77.31, 28.51], [77.39, 28.51], [77.38, 28.58], [77.33, 28.59], [77.31, 28.51]]
HOLE = [[77.34, 28.53], [77.35, 28.53], [77.35, 28.54], [77.34, 28.53]]


def city_payload(kind="Polygon", coordinates=None, **properties):
    metadata = {"osm_type": "relation", "osm_id": 18814682, "category": "boundary", "type": "administrative",
                "addresstype": "city", "name": "Noida", "address": {"city": "Noida", "country_code": "in"},
                "extratags": {"population": "637272", "website": "http://127.0.0.1/", "admin_level": "8"}}
    metadata.update(properties)
    return {"type": "FeatureCollection", "licence": "untrusted provider text", "features": [
        {"type": "Feature", "properties": metadata,
         "geometry": {"type": kind, "coordinates": [OUTER, HOLE] if coordinates is None else coordinates}}]}


def way(number=1, coordinates=None, highway="residential", name="Main Road"):
    positions = [[77.31, 28.55], [77.32, 28.56], [77.38, 28.55]] if coordinates is None else coordinates
    return {"type": "way", "id": number, "tags": {"highway": highway, "name": name},
            "geometry": [{"lon": point[0], "lat": point[1]} if isinstance(point, list) else point for point in positions]}


class OfflineCase(unittest.TestCase):
    def setUp(self):
        for name in ("getaddrinfo", "socket"):
            patch = mock.patch.object(web.socket, name, side_effect=AssertionError("Live network forbidden in geometry tests"))
            patch.start()
            self.addCleanup(patch.stop)

    def fetch(self, payload, *, raw=None, media="application/json", final_url=None):
        def read(url, **limits):
            return {"raw": json.dumps(payload, allow_nan=False).encode("utf-8") if raw is None else raw,
                    "content_type": media, "final_url": url if final_url is None else final_url}

        return mock.Mock(side_effect=read)

    def error(self, status, callback, *args, **kwargs):
        with self.assertRaises(ServiceError) as caught:
            callback(*args, **kwargs)
        self.assertEqual(caught.exception.status, status)
        return str(caught.exception)

    def city(self, payload=None, city=None, **options):
        return geometry.load_city_geometry(CITY if city is None else city,
            fetch_bytes=self.fetch(city_payload() if payload is None else payload, **options))

    def roads(self, ways=None, query="roads", bounds=BOX, classes=None, **options):
        payload = {"elements": [way()] if ways is None else ways}
        return geometry.load_road_geometry(query, bounds, classes, fetch_bytes=self.fetch(payload, **options))


class CityGeometryTests(OfflineCase):
    def test_keeps_real_polygon_and_holes_not_city_bbox(self):
        document = self.city()
        feature = document["dataset"]["features"][0]
        self.assertEqual(feature["geometry"], {"type": "Polygon", "coordinates": [OUTER, HOLE]})
        self.assertEqual(document["bounds"], [77.31, 28.51, 77.39, 28.59])
        self.assertNotEqual(document["bounds"], CITY["bbox"])
        self.assertEqual(feature["id"], "osm:relation:18814682")
        self.assertEqual(feature["properties"], {"name": "Noida", "kind": "city-boundary", "osmType": "relation", "osmId": 18814682})
        self.assertEqual(document["source"]["license"], "ODbL 1.0")
        self.assertIn("legal or census definitions may differ", document["source"]["caveat"])
        self.assertNotIn("637272", json.dumps(document))
        self.assertNotIn("127.0.0.1", json.dumps(document))

    def test_multipolygon_keeps_islands_and_ring_structure(self):
        island = [[77.36, 28.55], [77.37, 28.55], [77.36, 28.56], [77.36, 28.55]]
        coordinates = [[OUTER, HOLE], [island]]
        document = self.city(city_payload("MultiPolygon", coordinates))
        self.assertEqual(document["dataset"]["features"][0]["geometry"]["coordinates"], coordinates)

    def test_current_and_explicit_osm_identity_forms_use_fixed_lookup(self):
        for identifier in ("relation:18814682", "osm:relation:18814682", "openstreetmap:relation:18814682"):
            fetch = self.fetch(city_payload())
            with self.subTest(identifier=identifier):
                geometry.load_city_geometry({**CITY, "id": identifier, "url": "http://127.0.0.1/"}, fetch_bytes=fetch)
                url = fetch.call_args.args[0]
                self.assertEqual(urlsplit(url).hostname, "nominatim.openstreetmap.org")
                self.assertEqual(urlsplit(url).path, "/lookup")
                self.assertEqual(parse_qs(urlsplit(url).query)["osm_ids"], ["R18814682"])
                self.assertEqual(fetch.call_args.kwargs["max_bytes"], 4 * 1024 * 1024)
                self.assertEqual(fetch.call_args.kwargs["timeout"], 20)

    def test_verified_supplied_polygon_is_reused_and_metadata_cannot_override_source(self):
        payload = city_payload()["features"][0]
        metadata = {**payload["properties"], "geojson": payload["geometry"]}
        city = {**CITY, "providerPayload": metadata,
                "source": {"url": "http://127.0.0.1/", "attribution": "fiction", "license": "invented"}}
        fetch = self.fetch({})
        document = geometry.load_city_geometry(city, fetch_bytes=fetch)
        fetch.assert_not_called()
        self.assertEqual(document["dataset"]["features"][0]["geometry"], payload["geometry"])
        document["dataset"]["features"][0]["geometry"]["coordinates"][0][0][0] = 0
        document["source"]["license"] = "changed"
        repeated = geometry.load_city_geometry(city, fetch_bytes=fetch)
        self.assertEqual(repeated["dataset"]["features"][0]["geometry"]["coordinates"][0][0], OUTER[0])
        self.assertEqual(repeated["source"]["license"], "ODbL 1.0")
        self.assertEqual(repeated["source"]["attribution"], "OpenStreetMap contributors")

    def test_rejects_wrong_identity_country_city_name_and_county_class(self):
        variants = [dict(osm_id=123), dict(osm_type="way"), dict(name="Greater Noida"),
                    dict(address={"city": "Noida", "country_code": "np"}), dict(addresstype="county"),
                    dict(category="landuse", type="residential", addresstype="city"),
                    dict(category="place", type="county", addresstype="county")]
        for properties in variants:
            with self.subTest(properties=properties):
                self.error(422, self.city, city_payload(**properties))

    def test_identity_mismatch_never_falls_back_to_a_search(self):
        fetch = self.fetch(city_payload(osm_id=123))
        self.error(422, geometry.load_city_geometry, CITY, fetch_bytes=fetch)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(urlsplit(fetch.call_args.args[0]).path, "/lookup")
        self.error(422, geometry.load_city_geometry, {**CITY, "providerId": "way:123"}, fetch_bytes=fetch)

    def test_points_empty_and_multiple_results_fail_without_polygon_substitute(self):
        message = self.error(422, self.city, city_payload("Point", [77.35, 28.57]))
        self.assertIn("bounding box is not a city boundary", message)
        self.error(404, self.city, {"type": "FeatureCollection", "features": []})
        payload = city_payload()
        payload["features"].append(copy.deepcopy(payload["features"][0]))
        self.error(422, self.city, payload)

    def test_settlement_polygon_is_honestly_labeled_not_legal_boundary(self):
        document = self.city(city_payload(category="place", type="city", addresstype="city"))
        self.assertIn("settlement extent", document["source"]["caveat"])
        self.assertIn("not a verified legal", document["source"]["caveat"])

    def test_polygon_validation_rejects_open_degenerate_and_non_geographic_rings(self):
        coordinates = [[OUTER[:-1]], [[[77.31, 28.51], [77.32, 28.52], [77.33, 28.53], [77.31, 28.51]]],
                       [[[181, 28.51], [77.39, 28.51], [77.38, 28.58], [181, 28.51]]],
                       [[[True, 28.51], [77.39, 28.51], [77.38, 28.58], [True, 28.51]]]]
        for rings in coordinates:
            with self.subTest(rings=rings):
                self.error(422, self.city, city_payload(coordinates=rings))
        payload = city_payload()
        payload["crs"] = {"type": "name", "properties": {"name": "EPSG:3857"}}
        self.error(422, self.city, payload)

    def test_city_limits_feature_positions_raw_and_total_document_bytes(self):
        with mock.patch.object(geometry, "MAX_POSITIONS", 8):
            self.error(413, self.city)
        payload = city_payload()
        payload["features"] *= 1001
        self.error(413, self.city, payload)
        self.error(413, self.city, raw=b" " * (geometry.MAX_RAW_BYTES + 1))
        payload = city_payload()["features"][0]
        city = {**CITY, "providerPayload": {**payload["properties"], "geojson": payload["geometry"]}}
        document = geometry.load_city_geometry(city)
        dataset_bytes = len(json.dumps(document["dataset"], ensure_ascii=False, separators=(",", ":")).encode())
        with mock.patch.object(geometry, "MAX_RAW_BYTES", dataset_bytes + 1):
            self.assertIn("document", self.error(413, geometry.load_city_geometry, city))

    def test_missing_identity_search_is_exact_country_and_location_verified(self):
        candidate = {**city_payload()["features"][0]["properties"], "lat": "28.57", "lon": "77.35",
                     "boundingbox": ["28.5", "28.6", "77.3", "77.4"]}
        decoys = [{**candidate, "name": "Noida District", "addresstype": "county"},
                  {**candidate, "osm_id": 123, "address": {"country_code": "np", "city": "Noida"}},
                  {**candidate, "osm_id": 456, "boundingbox": ["20", "21", "70", "71"]}]
        responses = [[*decoys, candidate], city_payload()]
        fetch = mock.Mock(side_effect=lambda url, **_: {"raw": json.dumps(responses.pop(0)).encode(),
                         "content_type": "application/json", "final_url": url})
        document = geometry.load_city_geometry({**CITY, "id": "city:known-point"}, fetch_bytes=fetch)
        self.assertEqual(document["name"], "Noida")
        self.assertEqual([urlsplit(call.args[0]).path for call in fetch.call_args_list], ["/search", "/lookup"])
        self.assertEqual(parse_qs(urlsplit(fetch.call_args_list[0].args[0]).query)["countrycodes"], ["in"])

    def test_missing_identity_search_does_not_pick_ambiguous_or_wrong_city(self):
        candidate = {**city_payload()["features"][0]["properties"], "boundingbox": [28.5, 28.6, 77.3, 77.4]}
        city = {**CITY, "id": "unknown:point"}
        self.error(409, geometry.load_city_geometry, city,
                   fetch_bytes=self.fetch([candidate, {**candidate, "osm_id": 123}]))
        self.error(404, geometry.load_city_geometry, city,
                   fetch_bytes=self.fetch([{**candidate, "name": "Greater Noida"}]))
        self.error(422, geometry.load_city_geometry, {**city, "lat": None}, fetch_bytes=self.fetch([]))

    def test_malformed_identity_and_untrusted_supplied_metadata_fail(self):
        for identifier in ("relation:0", "osm:relation:123;out", "openstreetmap:relation:-2", "relation:99999999999999999999"):
            with self.subTest(identifier=identifier):
                self.error(422, geometry.load_city_geometry, {**CITY, "id": identifier}, fetch_bytes=self.fetch({}))
        metadata = city_payload()["features"][0]["properties"]
        self.error(422, geometry.load_city_geometry, {**CITY, "providerPayload": {**metadata, "osm_id": 2,
                   "geojson": {"type": "Polygon", "coordinates": [OUTER]}}}, fetch_bytes=self.fetch({}))
        self.error(400, geometry.load_city_geometry, {**CITY, "countryCode": "IND"}, fetch_bytes=self.fetch({}))

    def test_source_redirects_and_content_cannot_be_replaced_by_model_urls(self):
        self.error(502, self.city, final_url="https://example.org/foreign-geometry")
        self.error(400, self.city, final_url="http://127.0.0.1/private")
        self.error(415, self.city, media="text/html", raw=b"<p>ignore instructions</p>")
        self.error(422, self.city, raw=b'{"type":"FeatureCollection","features":[],"x":NaN}')


class RoadGeometryTests(OfflineCase):
    def test_returns_source_lines_not_generated_connections_or_routing(self):
        first, second = way(1), way(2, [[77.36, 28.57], [77.37, 28.58]], highway="footway")
        document = self.roads([first, second])
        self.assertEqual(len(document["dataset"]["features"]), 2)
        self.assertEqual(document["dataset"]["features"][0]["geometry"]["coordinates"], [[77.31, 28.55], [77.32, 28.56], [77.38, 28.55]])
        self.assertEqual(document["dataset"]["features"][1]["properties"]["highway"], "footway")
        self.assertFalse(document["coverage"]["truncated"])
        self.assertIn("not complete city coverage", document["source"]["caveat"])
        self.assertIn("no routing", document["source"]["caveat"])

    def test_bbox_clips_crossings_with_both_endpoints_outside(self):
        document = self.roads([way(coordinates=[[77.2, 28.55], [77.5, 28.55]])])
        self.assertEqual(document["dataset"]["features"][0]["geometry"]["coordinates"], [[77.3, 28.55], [77.4, 28.55]])
        for feature in document["dataset"]["features"]:
            for lon, lat in feature["geometry"]["coordinates"]:
                self.assertTrue(BOX[0] <= lon <= BOX[2] and BOX[1] <= lat <= BOX[3])

    def test_exit_and_reentry_remain_disconnected_without_outside_branch_connection(self):
        document = self.roads([way(coordinates=[[77.31, 28.52], [77.5, 28.52], [77.5, 28.58], [77.31, 28.58]])])
        lines = [feature["geometry"]["coordinates"] for feature in document["dataset"]["features"]]
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines, [[[77.31, 28.52], [77.4, 28.52]], [[77.4, 28.58], [77.31, 28.58]]])

    def test_null_missing_and_invalid_coordinates_split_instead_of_joining(self):
        positions = [[77.31, 28.52], [77.32, 28.52], None, [77.37, 28.58], [77.38, 28.58],
                     {"lon": 77.39}, [77.31, 28.59], [77.32, 28.59], [999, 20], [77.35, 28.54]]
        document = self.roads([way(coordinates=positions)])
        self.assertEqual(len(document["dataset"]["features"]), 3)
        self.assertEqual(document["coverage"]["excludedInvalidPositions"], 3)
        self.assertIn("without connecting gaps", document["source"]["caveat"])

    def test_duplicate_original_vertices_do_not_break_continuity(self):
        positions = [[77.31000000000002, 28.52], [77.32, 28.52], [77.32, 28.52], [77.38, 28.58]]
        document = self.roads([way(coordinates=positions)])
        self.assertEqual(document["dataset"]["features"][0]["geometry"]["coordinates"], [positions[0], positions[1], positions[3]])
        self.assertEqual(len(document["dataset"]["features"]), 1)

    def test_does_not_connect_a_dateline_edge_across_the_world(self):
        document = self.roads([way(coordinates=[[179.9, 0], [-179.9, 0]])], bounds=[-.05, -.05, .05, .05])
        self.assertEqual(document["dataset"]["features"], [])

    def test_named_query_is_literal_case_insensitive_phrase_not_substring(self):
        ways = [way(1, name="Old MAIN Road East"), way(2, name="main roadway"), way(3, name="Mainland Road"),
                way(4, name="Main road", highway="construction"), way(5, name="Other Road")]
        document = self.roads(ways, query="Main Road")
        self.assertEqual([feature["properties"]["osmId"] for feature in document["dataset"]["features"]], [1])
        self.assertEqual(document["coverage"]["nameFilter"], "Main Road")

    def test_safe_overpass_escaping_includes_all_ql_and_regex_punctuation_as_literal_data(self):
        queries = ['M.G. Road', 'Road (A+B) [North] .*', 'x"];node(0,0,1,1);out;["name"~".*', 'Road\\Branch', "Road 'West'"]
        for query in queries:
            with self.subTest(query=query):
                fetch = self.fetch({"elements": [way(name=query), way(2, name="arbitrary name")]})
                document = geometry.load_road_geometry(query, BOX, fetch_bytes=fetch)
                ql = parse_qs(urlsplit(fetch.call_args.args[0]).query)["data"][0]
                prefix, encoded = ql.split('["name"~', 1)
                pattern, end = json.JSONDecoder().raw_decode(encoded)
                self.assertTrue(end > 1)
                self.assertTrue(encoded[end:].startswith(',i]('))
                self.assertEqual(prefix.count("way["), 1)
                self.assertEqual([feature["properties"]["name"] for feature in document["dataset"]["features"]], [query])
                self.assertIn("[timeout:25]", ql)
                self.assertIn("[maxsize:4194304]", ql)
                self.assertTrue(ql.endswith("out tags geom 1001;"))
                if ".*" in query:
                    self.assertIn(r"\.\*", pattern)
                self.assertEqual(urlsplit(fetch.call_args.args[0]).hostname, "overpass-api.de")
                self.assertEqual(fetch.call_args.kwargs["timeout"], 30)

    def test_general_roads_is_bounded_class_allowlist_not_full_map_fetch(self):
        fetch = self.fetch({"elements": [way(highway="footway"), way(2, highway="residential"), way(3, highway="construction")]})
        document = geometry.load_road_geometry("all roads", BOX, ["footway", "residential"], fetch_bytes=fetch)
        ql = parse_qs(urlsplit(fetch.call_args.args[0]).query)["data"][0]
        self.assertNotIn('["name"', ql)
        self.assertIn('"^(residential|footway)$"', ql)
        self.assertIn("(28.5,77.3,28.6,77.4)", ql)
        self.assertNotIn("relation", ql)
        self.assertNotIn("node", ql)
        self.assertEqual(len(document["dataset"]["features"]), 2)
        self.assertIsNone(document["coverage"]["nameFilter"])

    def test_zero_empty_and_nonmatching_geometry_return_truthful_empty_collection(self):
        for ways in ([], [way(name="Other Road")], [way(coordinates=[[0, 0], [.01, .01]])]):
            with self.subTest(ways=ways):
                document = self.roads(ways, query="Missing Road")
                self.assertEqual(document["dataset"], {"type": "FeatureCollection", "features": []})
                self.assertFalse(document["coverage"]["truncated"])
                self.assertIn("No matching road geometry", document["source"]["caveat"])

    def test_bounds_classes_and_query_validation_happens_before_fetch(self):
        fetch = self.fetch({"elements": []})
        for bounds in (None, [], BOX + [0], [77.3, 28.5, "77.4", 28.6], [True, 0, .1, .1],
                       [0, 0, float("nan"), 1], [0, 0, float("inf"), 1], [0, 0, 10**1000, 1],
                       [1, 0, 1, 1], [170, 0, -170, 1], [0, 91, 1, 92]):
            with self.subTest(bounds=bounds):
                self.error(400, geometry.load_road_geometry, "roads", bounds, fetch_bytes=fetch)
        for bounds in ([-180, -90, 180, 90], [0, 0, 1, 1], [0, 89.9, 10, 90]):
            self.error(413, geometry.load_road_geometry, "roads", bounds, fetch_bytes=fetch)
        for classes in ([], "primary", ["primary", 'x"];out;'], [None], ["motorway_link"]):
            self.error(400, geometry.load_road_geometry, "roads", BOX, classes, fetch_bytes=fetch)
        for query in ("", "x" * 161, "http://127.0.0.1/", "https://example.org/roads", "roads\nnode;", None):
            self.error(400, geometry.load_road_geometry, query, BOX, fetch_bytes=fetch)
        fetch.assert_not_called()

    def test_elements_positions_bytes_and_output_limits_fail_or_report_truncation(self):
        with mock.patch.object(geometry, "MAX_FEATURES", 2):
            document = self.roads([way(1), way(2), way(3)])
            self.assertEqual(len(document["dataset"]["features"]), 2)
            self.assertTrue(document["coverage"]["truncated"])
            self.assertIn("provider element limit reached", document["coverage"]["truncationReasons"])
            self.error(413, self.roads, [way(1), way(2), way(3), way(4)])
        with mock.patch.object(geometry, "MAX_POSITIONS", 2):
            self.error(413, self.roads)
        self.error(413, self.roads, raw=b" " * (geometry.MAX_RAW_BYTES + 1))

    def test_clipping_position_limit_returns_whole_segments_with_explicit_partial_coverage(self):
        crossing = way(coordinates=[[77.2, 28.52], [77.5, 28.52], [77.2, 28.58], [77.5, 28.58]])
        with mock.patch.object(geometry, "MAX_POSITIONS", 4):
            document = self.roads([crossing])
        self.assertEqual(len(document["dataset"]["features"]), 2)
        self.assertEqual(document["coverage"]["positionCount"], 4)
        self.assertTrue(document["coverage"]["truncated"])
        self.assertIn("output geometry limit reached", document["coverage"]["truncationReasons"])

    def test_provider_partial_data_is_honest_and_empty_timeout_is_error(self):
        fetch = self.fetch({"elements": [way()], "remark": "runtime error: Query timed out"})
        document = geometry.load_road_geometry("roads", BOX, fetch_bytes=fetch)
        self.assertTrue(document["coverage"]["truncated"])
        self.assertIn("Coverage is truncated", document["source"]["caveat"])
        self.assertNotIn("runtime error", document["source"]["caveat"])
        self.error(503, geometry.load_road_geometry, "roads", BOX,
                   fetch_bytes=self.fetch({"elements": [], "remark": "timeout"}))

    def test_fixed_or_configuration_endpoint_only_with_no_credentials_private_url_or_redirect(self):
        for endpoint in ("http://127.0.0.1/api/interpreter", "https://127.0.0.1/api/interpreter", "https://example.org/other",
                         "https://example.org/api/interpreter?data=untrusted", "https://user:pass@example.org/api/interpreter"):
            with self.subTest(endpoint=endpoint):
                self.error(400, geometry.load_road_geometry, "roads", BOX, fetch_bytes=self.fetch({"elements": []}),
                           overpass_endpoint=endpoint)
        self.error(502, self.roads, final_url="https://example.org/api/interpreter")
        self.error(400, self.roads, final_url="http://127.0.0.1/private")


class ImportTests(unittest.TestCase):
    def test_provider_import_has_no_server_config_or_network_side_effects(self):
        script = ("import sys, socket\nfrom unittest import mock\n"
                  "with mock.patch.object(socket, 'getaddrinfo', side_effect=AssertionError('Live DNS forbidden')), "
                  "mock.patch.object(socket, 'socket', side_effect=AssertionError('Live socket forbidden')):\n"
                  " import backend.map_geometry\n assert 'backend.server' not in sys.modules\n assert 'backend.config' not in sys.modules\n")
        result = subprocess.run([sys.executable, "-B", "-c", script], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)


class TransportSafetyTests(OfflineCase):
    def test_providers_use_shared_public_dns_check_not_an_unpinned_network_reader(self):
        address = [(web.socket.AF_INET, web.socket.SOCK_STREAM, web.socket.IPPROTO_TCP, "", ("127.0.0.1", 443))]
        with mock.patch.object(web.socket, "getaddrinfo", return_value=address) as dns:
            self.error(400, geometry.load_city_geometry, {**CITY, "url": "https://example.org/geometry"})
            self.error(400, geometry.load_road_geometry, "roads", BOX)
        self.assertEqual([call.args[0] for call in dns.call_args_list], ["nominatim.openstreetmap.org", "overpass-api.de"])


@unittest.skipUnless("backend.server" in sys.modules, "HTTP tests run under backend.test_isolated")
class GeometryHttpTests(OfflineCase):
    def setUp(self):
        super().setUp()
        self.server = sys.modules["backend.server"]
        document = {"dataset": {"type": "FeatureCollection", "features": []}, "source": {"name": "verified"},
                    "bounds": BOX, "name": "Test", "cached": False}
        self.document = document

    def request(self, path):
        handler = self.server.ApiHandler.__new__(self.server.ApiHandler)
        handler.path = path
        handler.response = None
        handler.send_json = lambda status, body, headers=None: setattr(handler, "response", (status, body, headers))
        self.server.ApiHandler.do_GET(handler)
        return handler.response

    def test_city_endpoint_uses_unambiguous_resolver_and_readonly_geometry(self):
        with mock.patch.object(self.server, "resolve_agent_city", return_value=CITY) as resolve, \
             mock.patch.object(self.server, "load_city_geometry", return_value=self.document) as load, \
             mock.patch.object(self.server.CACHE, "mutate_workspace") as mutate:
            response = self.request("/api/map/city-boundary?query=Noida&countryCode=IN")
        self.assertEqual(response[0], 200)
        self.assertIs(response[1], self.document)
        self.assertEqual(response[2], {"Cache-Control": "no-store", "X-Cache": "MISS"})
        resolve.assert_called_once_with("Noida", "IN")
        load.assert_called_once_with(CITY)
        mutate.assert_not_called()

    def test_roads_endpoint_validates_bounds_and_does_not_accept_provider_or_url(self):
        with mock.patch.object(self.server, "load_road_geometry", return_value=self.document) as load:
            response = self.request("/api/map/roads?" + urlencode({"query": "Main Road", "west": 77.3, "south": 28.5,
                                      "east": 77.4, "north": 28.6, "classes": "primary,residential"}))
        self.assertEqual(response[0], 200)
        load.assert_called_once_with("Main Road", BOX, ["primary", "residential"])
        for path in ("/api/map/roads?query=roads", "/api/map/roads?query=roads&url=http://127.0.0.1/",
                     "/api/map/city-boundary?query=Noida&provider=local", "/api/map/city-boundary?query=Noida&query=Delhi",
                     "/api/map/city-boundary?query=https%3A%2F%2Fexample.org", "/api/map/city-boundary?query=Noida&countryCode=IND",
                     "/api/map/city-boundary?query=Noida&url=", "/api/map/city-boundary?query=Noida&" + "&".join("x=1" for _ in range(17))):
            with self.subTest(path=path), mock.patch.object(self.server, "load_road_geometry") as roads, \
                 mock.patch.object(self.server, "resolve_agent_city") as city:
                self.assertEqual(self.request(path)[0], 400)
                roads.assert_not_called()
                city.assert_not_called()

    def test_http_errors_are_typed_and_retry_after_is_preserved(self):
        with mock.patch.object(self.server, "resolve_agent_city", return_value=None):
            self.assertEqual(self.request("/api/map/city-boundary?query=Noida")[0], 404)
        with mock.patch.object(self.server, "resolve_agent_city", return_value=CITY), \
             mock.patch.object(self.server, "load_city_geometry", side_effect=ServiceError("No polygon", 422)):
            response = self.request("/api/map/city-boundary?query=Noida")
        self.assertEqual(response[:2], (422, {"error": "No polygon"}))
        with mock.patch.object(self.server, "load_road_geometry", side_effect=ServiceError("rate limited", 503, 9)):
            response = self.request("/api/map/roads?query=roads&west=77.3&south=28.5&east=77.4&north=28.6")
        self.assertEqual(response, (503, {"error": "rate limited"}, {"Retry-After": "9"}))

    def test_provider_wiring_caches_under_namespace_and_preserves_queue_policies(self):
        server = self.server
        self.assertIs(server.AGENT_TOOLS.dependencies.load_city_geometry, server.load_city_geometry)
        self.assertIs(server.AGENT_TOOLS.dependencies.load_road_geometry, server.load_road_geometry)
        fetch = self.fetch(city_payload())
        with mock.patch.object(server.CACHE, "get_geocode", return_value=None), \
             mock.patch.object(server.CACHE, "put_geocode") as save, \
             mock.patch.object(server.NOMINATIM_QUEUE, "run", side_effect=lambda task: task()) as queue, \
             mock.patch.object(server, "fetch_public_bytes", side_effect=fetch):
            document = server.load_city_geometry(CITY)
        self.assertFalse(document["cached"])
        self.assertTrue(save.call_args.args[0].startswith("map-geometry-city-v1:"))
        queue.assert_called_once()
        with mock.patch.object(server.CACHE, "get_geocode", return_value=document), \
             mock.patch.object(server, "fetch_city_geometry") as provider:
            cached = server.load_city_geometry(CITY)
        self.assertTrue(cached["cached"])
        provider.assert_not_called()

    def test_road_transport_uses_safe_reader_shared_queue_cooldown_and_rate_limit_backoff(self):
        server = self.server
        with mock.patch.object(server, "overpass_cooldown_seconds", return_value=0), \
             mock.patch.object(server.OVERPASS_QUEUE, "run", side_effect=lambda task: task()) as queue, \
             mock.patch.object(server, "fetch_public_bytes", return_value={"raw": b"{}"}) as fetch:
            server._fetch_map_road_bytes("https://overpass-api.de/api/interpreter?data=fixed", max_bytes=400)
        queue.assert_called_once()
        fetch.assert_called_once_with("https://overpass-api.de/api/interpreter?data=fixed", max_bytes=400)
        with mock.patch.object(server, "overpass_cooldown_seconds", return_value=7), \
             mock.patch.object(server, "fetch_public_bytes") as fetch:
            self.error(503, server._fetch_map_road_bytes, "unused")
        fetch.assert_not_called()
        with mock.patch.object(server, "overpass_cooldown_seconds", return_value=0), \
             mock.patch.object(server.OVERPASS_QUEUE, "run", side_effect=lambda task: task()), \
             mock.patch.object(server, "fetch_public_bytes", side_effect=ServiceError("Web source request failed (HTTP 429).", 502)), \
             mock.patch.object(server, "pause_overpass", return_value=12):
            with self.assertRaises(ServiceError) as caught:
                server._fetch_map_road_bytes("https://overpass-api.de/api/interpreter")
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(caught.exception.retry_after, 12)

    def test_road_cache_uses_verified_document_and_never_persists_partial_coverage(self):
        server = self.server
        for partial in (False, True):
            document = {**self.document, "coverage": {"truncated": partial}}
            with self.subTest(partial=partial), mock.patch.object(server.CACHE, "get_geocode", return_value=None), \
                 mock.patch.object(server.CACHE, "put_geocode") as save, \
                 mock.patch.object(server, "fetch_road_geometry", return_value=document) as fetch:
                result = server.load_road_geometry("roads", BOX, ["residential"])
            self.assertFalse(result["cached"])
            self.assertEqual(fetch.call_args.args, ("roads", BOX, ["residential"]))
            self.assertIs(fetch.call_args.kwargs["fetch_bytes"], server._fetch_map_road_bytes)
            self.assertEqual(fetch.call_args.kwargs["overpass_endpoint"], server.CONFIG.overpass_endpoint)
            self.assertEqual(save.call_count, 0 if partial else 1)
        with mock.patch.object(server.CACHE, "get_geocode", return_value=document), \
             mock.patch.object(server, "fetch_road_geometry") as fetch:
            self.assertTrue(server.load_road_geometry("roads", BOX)["cached"])
        fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
