"""Offline SerpApi and grounded source-to-map regressions."""

import copy
import json
import urllib.error
from dataclasses import replace
from unittest import mock

from backend import server
from backend.agent import MapAgentService
from backend.agent_tools import AgentTools
from backend.test_agent_studio import BackendCase, Client as ControlledClient, Hub as FakeHub, studio_context, tool_call


class SerpWebProviderTests(BackendCase):
    def test_search_engine_contracts_return_citations_not_place_geometry(self):
        item = {"title": "Official population data", "link": "https://example.org/population.csv", "snippet": "Village observations", "source": {"name": "Data office"}, "iso_date": "2025-01-01T00:00:00Z"}
        for engine, root in (("google", "organic_results"), ("google_news", "news_results"), ("google_scholar", "organic_results")):
            with self.subTest(engine=engine), mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value={root: [item]}) as fetch:
                result = server.search_serp_web("Darma Valley population", engine, "IN")
                self.assertEqual(result["results"][0]["url"], item["link"])
                self.assertEqual(result["results"][0]["publisher"], "Data office")
                self.assertNotIn("lat", result["results"][0])
                params = fetch.call_args.args[0]
                self.assertEqual(params["engine"], engine)
                self.assertEqual(params["hl"], "en")
                self.assertEqual(params.get("gl"), "in" if engine != "google_scholar" else None)
                self.assertIn("not verified numeric observations", result["caveat"])

    def test_news_clusters_are_flattened_and_invalid_or_credential_links_are_omitted(self):
        payload = {"news_results": [{"stories": [{"title": "Valid", "link": "https://example.org/a"}, {"title": "Invalid", "link": "http://127.0.0.1/admin"}, {"title": "Credential", "link": "https://example.org/data?api_key=hidden"}]}]}
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value=payload):
            result = server.search_serp_web("population", "google_news", "")
        self.assertEqual([item["title"] for item in result["results"]], ["Valid"])

    def test_search_is_bounded_and_provider_failures_are_not_empty_success(self):
        payload = {"organic_results": [{"title": str(index), "link": f"https://example.org/{index}", "snippet": "s" * 5000} for index in range(30)]}
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value=payload):
            result = server.search_serp_web("population", "google", "")
        self.assertEqual(len(result["results"]), 8)
        self.assertEqual(len(result["results"][0]["snippet"]), 1200)
        for payload in ({"error": "API key private value"}, {"organic_results": {}}, {"search_metadata": {"status": "Processing"}}):
            with self.subTest(payload=payload), mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value=payload), self.assertRaises(server.ServiceError):
                server.search_serp_web("population", "google", "")

    def test_cache_first_requests_do_not_bill_again_and_cached_results_work_without_key(self):
        params = {"engine": "google", "q": "Population data", "hl": "en"}
        config = replace(server.CONFIG, serp_api_key="fixture-key")
        payload = {"search_metadata": {"status": "Success"}, "organic_results": [{"title": "Data", "link": "https://example.org/data", "snippet": "fixture-key"}], "api_key": "fixture-key"}
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "CONFIG", config), mock.patch.object(server, "archive_serpapi_response"), mock.patch.object(server, "fetch_serp_json", return_value=payload) as fetch:
            first = server.fetch_serp_response(params)
            second = server.fetch_serp_response({**params, "q": "  POPULATION DATA "})
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(first, second)
            self.assertNotIn("fixture-key", json.dumps(first))
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "CONFIG", replace(config, serp_api_key="")), mock.patch.object(server, "fetch_serp_json") as fetch:
            cached = server.search_serp_web("Population data", "google", "")
            self.assertTrue(cached["stored"])
            self.assertIsNotNone(cached["retrievedAt"])
            fetch.assert_not_called()
            with self.assertRaises(server.ServiceError):
                server.fetch_serp_response({**params, "q": "uncached"})

    def test_semantic_error_payloads_are_not_cached_or_leaked(self):
        params = {"engine": "google", "q": "population"}
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "CONFIG", replace(server.CONFIG, serp_api_key="fixture-key")), mock.patch.object(server, "fetch_serp_json", return_value={"error": "fixture-key failed"}):
            with self.assertRaises(server.ServiceError) as raised:
                server.fetch_serp_response(params)
            self.assertNotIn("fixture-key", str(raised.exception))
            self.assertIsNone(self.cache.get_provider_response("serpapi", server.serp_request_key(params)))

    def test_transport_rejects_invalid_json_oversize_and_preserves_rate_limit(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = "https://serpapi.com/search.json"
        for raw in (b"not JSON", b"[]", b"x" * (4 * 1024 * 1024 + 1)):
            response.read.return_value = raw
            with self.subTest(size=len(raw)), mock.patch("urllib.request.urlopen", return_value=response), self.assertRaises(server.ServiceError):
                server.fetch_serp_json("https://serpapi.com/search.json?api_key=fixture-key")
        error = urllib.error.HTTPError("https://serpapi.com/search.json?api_key=fixture-key", 429, "Too many", {"Retry-After": "17"}, None)
        with mock.patch("urllib.request.urlopen", side_effect=error), self.assertRaises(server.ServiceError) as raised:
            server.fetch_serp_json("https://serpapi.com/search.json?api_key=fixture-key")
        self.assertEqual(raised.exception.retry_after, 17)
        self.assertNotIn("fixture-key", str(raised.exception))


class GroundedWebAgentTests(BackendCase):
    def setUp(self):
        super().setUp()
        self.web = mock.Mock(return_value={"results": [{"title": "Population observations 2011", "url": "https://example.org/population", "snippet": "Source evidence", "publisher": "Census office"}], "stored": True, "retrievedAt": "2026-01-01T00:00:00Z"})
        self.dataset = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [1, 1]}, "properties": {"population": 42, "year": 2011}}, {"type": "Feature", "geometry": {"type": "Point", "coordinates": [2, 2]}, "properties": {"population": 0, "year": 2011}}]}
        self.reader = mock.Mock(return_value={"url": "https://example.org/population", "title": "Population observations 2011", "format": "geojson", "text": "Sourced population counts", "tables": [], "links": [], "dataset": self.dataset})
        self.tools = AgentTools(replace(self.tools.dependencies, search_web=self.web, read_web_source=self.reader))

    def source_context(self):
        context = self.tools.new_context(studio_context())
        self.tools.execute(context, "search_web", {"query": "Darma Valley official population"})
        self.tools.execute(context, "read_web_source", {"sourceRef": "source:1"})
        return context

    def test_search_and_read_return_cited_data_not_map_changes_or_raw_model_datasets(self):
        context = self.source_context()
        self.assertFalse(context.requires_presentation)
        self.assertFalse(context.presented)
        result = self.tools.execute(context, "read_web_source", {"sourceRef": "source:1"})
        self.assertEqual(result["dataset"]["numericFields"], ["population", "year"])
        self.assertNotIn("features", result["dataset"])
        self.reader.assert_called_once()
        self.assertIn("untrusted evidence", result["caveat"])

    def test_real_geojson_values_are_copied_without_model_invention_and_scope_is_frozen(self):
        context = self.source_context()
        result = self.tools.execute(context, "load_web_dataset", {"sourceRef": "source:1", "field": "population", "units": "people per settlement", "visualization": "heatmap"})
        update = result["mapUpdate"]["dataset"]
        self.assertEqual(update["data"], self.dataset)
        self.assertIsNot(update["data"], self.dataset)
        self.assertEqual(update["scope"], {"type": "viewport", "bounds": [0, 0, 10, 10]})
        self.assertEqual(update["workspaceId"], "workspace-a")
        self.assertEqual(update["source"]["url"], "https://example.org/population")
        self.assertIn("not independently verified", update["source"]["caveat"])
        self.assertNotIn("mapUpdate", MapAgentService._model_tool_result(result))

    def test_dataset_import_rejects_invented_sources_fields_values_and_layer_scope(self):
        context = self.source_context()
        for arguments in ({"sourceRef": "source:999"}, {"sourceRef": "source:1", "field": "made_up"}, {"sourceRef": "source:1", "field": "population", "data": self.dataset}, {"sourceRef": "source:1", "visualization": "choropleth"}):
            with self.subTest(arguments=arguments), self.assertRaises(server.ServiceError):
                self.tools.execute(context, "load_web_dataset", arguments)
        context.map_context["scope"] = {"type": "layer", "layerId": "layer-a"}
        with self.assertRaises(server.ServiceError):
            self.tools.execute(context, "load_web_dataset", {"sourceRef": "source:1", "field": "population"})

    def test_research_is_attempted_before_declaring_missing_data(self):
        context = self.tools.new_context({})
        with self.assertRaisesRegex(server.ServiceError, "Use search_web"):
            self.tools.execute(context, "report_limitation", {"reason": "dataset_unavailable"})
        for _ in range(4):
            self.tools.execute(context, "search_web", {"query": "population sources"})
        with self.assertRaisesRegex(server.ServiceError, "four web-search"):
            self.tools.execute(context, "search_web", {"query": "another source"})
        result = self.tools.execute(context, "report_limitation", {"reason": "dataset_unavailable"})
        self.assertTrue(result["limitation"])

    def test_unsupported_download_returns_cited_limitation_without_fake_map(self):
        self.reader.side_effect = server.ServiceError("GeoTIFF is unsupported.", 422)
        hub = FakeHub()
        client = ControlledClient([tool_call("search_web", {"query": "population dataset"}), tool_call("read_web_source", {"sourceRef": "source:1"}), tool_call("report_limitation", {"reason": "dataset_unavailable"})])
        service = MapAgentService(client, self.tools, hub)
        run_id = service.start_run(hub.session, "Create the population heatmap", studio_context())
        event = hub.wait(run_id)
        self.assertEqual(event["type"], "agent.limitation")
        self.assertEqual(event["sources"][0]["url"], "https://example.org/population")
        self.assertFalse(any(item["type"] == "agent.map" for _, item in hub.events))

    def test_serp_research_to_dataset_agent_run_completes_and_does_not_mutate_sqlite_workspace(self):
        before = self.cache.capture_workspace()
        hub = FakeHub()
        client = ControlledClient([tool_call("search_web", {"query": "Darma Valley population source"}), tool_call("read_web_source", {"sourceRef": "source:1"}), tool_call("load_web_dataset", {"sourceRef": "source:1", "field": "population", "visualization": "heatmap", "units": "people per source cell"}), {"content": "Queued the actual sourced population layer for browser validation."}])
        service = MapAgentService(client, self.tools, hub)
        run_id = service.start_run(hub.session, "Create the population heatmap", studio_context())
        event = hub.wait(run_id)
        self.assertEqual(event["type"], "agent.completed")
        updates = [item["update"] for _, item in hub.events if item["type"] == "agent.map"]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["dataset"]["field"], "population")
        self.assertFalse(event["reversible"])
        self.assertEqual(self.cache.capture_workspace(), before)
        self.assertTrue(event["sources"][0]["readAt"])

    def test_html_table_join_takes_original_numeric_cells_at_verified_settlements(self):
        self.reader.return_value = {"url": "https://example.org/population", "title": "Settlement census 2011", "format": "html", "text": "Population, people, 2011", "tables": [{"headers": ["Village", "Population"], "rows": [["Chal", "1,200"], ["Sela", "0"], ["Total district", "99999"]]}], "links": []}
        context = self.source_context()
        chal = self.tools._register_entity(context, {**self.place, "id": "chal", "name": "Chal, Darma Valley", "shortName": "Chal"}, "place")
        sela = self.tools._register_entity(context, {**self.place, "id": "sela", "name": "Sela, Darma Valley", "shortName": "Sela"}, "place")
        result = self.tools.execute(context, "map_source_table", {"sourceRef": "source:1", "tableIndex": 0, "nameColumn": "Village", "valueColumn": "Population", "matches": [{"rowIndex": 0, "placeRef": chal["ref"]}, {"rowIndex": 1, "placeRef": sela["ref"]}], "units": "people in 2011", "visualization": "heatmap"})
        update = result["mapUpdate"]["dataset"]
        self.assertEqual([feature["properties"]["value"] for feature in update["data"]["features"]], [1200, 0])
        self.assertEqual(update["source"]["method"], "source-table-place-join")
        self.assertIn("not a continuous population grid", update["source"]["caveat"])
        for match in ({"rowIndex": 2, "placeRef": chal["ref"]}, {"rowIndex": 0, "placeRef": sela["ref"]}, {"rowIndex": 0, "placeRef": chal["ref"], "value": 42}):
            with self.subTest(match=match), self.assertRaises(server.ServiceError):
                self.tools.execute(context, "map_source_table", {"sourceRef": "source:1", "tableIndex": 0, "nameColumn": "Village", "valueColumn": "Population", "matches": [match]})
