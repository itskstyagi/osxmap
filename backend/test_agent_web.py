"""Offline SerpApi and grounded source-to-map regressions."""

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from dataclasses import replace
from unittest import mock
from pathlib import Path

from backend import server
from backend.agent import MapAgentService
from backend.agent_tools import AgentTools
from backend.test_agent_studio import BackendCase, Client as ControlledClient, Hub as FakeHub, studio_context, tool_call


class StartupInvocationTests(unittest.TestCase):
    def test_direct_script_and_package_startup_use_the_same_import_contract(self):
        root = Path(__file__).resolve().parent.parent
        code = r'''
import pathlib, runpy, sys
from unittest import mock

exists = pathlib.Path.exists
read = pathlib.Path.read_text
def safe_read(path, *args, **kwargs):
    if path.name == ".env":
        raise AssertionError("Startup tests must not read local credentials")
    return read(path, *args, **kwargs)

with mock.patch.object(pathlib.Path, "exists", lambda path: False if path.name == ".env" else exists(path)), mock.patch.object(pathlib.Path, "read_text", safe_read), mock.patch("urllib.request.urlopen", side_effect=AssertionError("Startup tests cannot use providers")), mock.patch("http.server.ThreadingHTTPServer") as http, mock.patch("signal.signal"):
    if sys.argv[1] == "script":
        import realtime
    else:
        from backend import realtime
    with mock.patch.object(realtime.RealtimeHub, "start") as start, mock.patch.object(realtime.RealtimeHub, "stop") as stop:
        if sys.argv[1] == "script":
            runpy.run_path("server.py", run_name="__main__")
        else:
            runpy.run_module("backend.server", run_name="__main__")
        start.assert_called_once()
        stop.assert_called_once()
        assert http.call_args.args[0] == ("127.0.0.1", 8787)
        http.return_value.serve_forever.assert_called_once()
        http.return_value.server_close.assert_called_once()
'''
        for mode in ("script", "module"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="meridian-startup-test-") as directory:
                environment = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP") if key in os.environ}
                environment.update({"PYTHONDONTWRITEBYTECODE": "1", "DATABASE_PATH": str(Path(directory) / "startup.db"), "HOST": "127.0.0.1", "PORT": "8787", "SERP_API_KEY": "", "OPENAI_API_KEY": "", "OPENAI_BASE_URL": "", "MODEL_NAME": ""})
                result = subprocess.run([sys.executable, "-B", "-c", code, mode], cwd=root / "backend" if mode == "script" else root, env=environment, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("API listening", result.stdout)


class SerpWebProviderTests(BackendCase):
    def test_nominatim_administrative_polygons_retain_actual_settlement_classification(self):
        place = server.public_place({"provider": "openstreetmap", "providerPayload": {"type": "administrative", "addresstype": "village"}})
        self.assertEqual(place["placeType"], "village")
        self.assertNotIn("providerPayload", place)

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
                self.assertEqual(params.get("num"), "8" if engine == "google_scholar" else None)
                self.assertIn("not verified numeric observations", result["caveat"])

    def test_relevance_precedes_cap_without_excluding_global_or_hdx_sources(self):
        unrelated = [
            {"title": "Comoros poverty estimates" if index % 2 else "Cote d'Ivoire conservation areas", "link": f"https://data.humdata.org/dataset/unrelated-{index}.csv", "snippet": "Official CSV GeoJSON dataset download. " + "Population statistics. " * 20}
            for index in range(10)
        ]
        relevant = [
            {"title": "WorldPop India population 2020", "link": "https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/2020/IND/", "snippet": "Gridded population GeoTIFF downloads for India."},
            {"title": "Noida Census 2011", "link": "https://censusindia.gov.in/noida", "snippet": "Official ward population census for Noida, India."},
            {"title": "Noida population observations", "link": "https://data.humdata.org/dataset/noida-population.csv", "snippet": "Ward population counts for Noida, India."},
            {"title": "WorldPop global gridded estimates", "link": "https://hub.worldpop.org/geodata/listing?id=29", "snippet": "Global population counts, downloadable GeoTIFF grids."},
        ]
        for engine, root in (("google", "organic_results"), ("google_news", "news_results"), ("google_scholar", "organic_results")):
            with self.subTest(engine=engine), mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value={root: unrelated + relevant}):
                result = server.search_serp_web("Noida India population GeoJSON CSV official census ward dataset", engine, "IN")
            urls = [item["url"] for item in result["results"]]
            self.assertEqual(len(urls), 8)
            self.assertEqual(set(urls[:4]), {item["link"] for item in relevant})
            self.assertEqual(result["results"][0]["title"], "Noida Census 2011")

    def test_population_authority_is_host_bounded_and_not_a_general_search_bias(self):
        unrelated = [{"title": "Global gridded estimates", "link": f"https://worldpop.org.example.org/grids/{index}"} for index in range(10)]
        official = [
            {"title": "Global gridded estimates", "link": "https://hub.worldpop.org/geodata/summary?id=29"},
            {"title": "India gridded estimates", "link": "https://data.worldpop.org/grids/IND/"},
        ]
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value={"organic_results": unrelated + official}):
            population = server.search_serp_web("Noida population", "google", "IN")
            general = server.search_serp_web("bridge maintenance", "google", "")
        self.assertEqual([item["url"] for item in population["results"][:2]], [item["link"] for item in official])
        self.assertEqual([item["url"] for item in general["results"]], [item["link"] for item in unrelated[:8]])

    def test_challenge_garbage_is_removed_but_usable_citations_survive(self):
        challenge = "JavaScript is disabled. In order to continue, we need to verify that you're not a robot. This requires JavaScript. Enable JavaScript and then reload the page."
        payload = {"organic_results": [
            {"title": "Untitled", "link": "https://data.humdata.org/dataset/comoros-poverty", "snippet": challenge},
            {"title": "Just a moment...", "link": "https://example.org/challenge", "snippet": "Checking your browser. Please wait."},
            {"title": "CAPTCHA", "link": "https://example.org/captcha"},
            {"title": "Untitled", "link": "https://example.org/empty"},
            {"title": "Noida census archive", "link": "https://data.humdata.org/dataset/noida-census", "snippet": challenge},
            {"title": "Untitled", "link": "https://data.humdata.org/dataset/noida-counts", "snippet": "Noida population counts from the census. " + challenge},
            {"title": "CAPTCHA usability research", "link": "https://example.org/research", "snippet": "A study of accessible browser challenges and human verification design."},
        ]}
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value=payload):
            result = server.search_serp_web("Noida population", "google", "IN")
        by_url = {item["url"]: item for item in result["results"]}
        self.assertEqual(set(by_url), {item["link"] for item in payload["organic_results"][-3:]})
        self.assertEqual(by_url["https://data.humdata.org/dataset/noida-census"]["snippet"], "")
        self.assertEqual(by_url["https://data.humdata.org/dataset/noida-counts"]["snippet"], "Noida population counts from the census.")

    def test_canonical_duplicates_keep_best_usable_citation_and_stable_ties(self):
        blocked = {"title": "Untitled", "link": "https://EXAMPLE.ORG/wards#blocked", "snippet": "Please verify you are human."}
        weak = {"title": "Archive", "link": "https://example.org/wards#preview"}
        useful = {"title": "Noida population census", "link": "https://example.org/wards#table", "snippet": "Ward counts from the census.", "source": "First publisher"}
        other = [{"title": "Research archive", "link": f"https://example.org/{index}"} for index in range(10)]
        payload = {"organic_results": [blocked] + [weak] * 10 + other + [useful, {**useful, "source": "Later publisher"}]}
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value=payload):
            result = server.search_serp_web("Noida population census", "google", "IN")
        self.assertEqual(len(result["results"]), 8)
        self.assertEqual(result["results"][0]["url"], "https://example.org/wards")
        self.assertEqual(result["results"][0]["title"], useful["title"])
        self.assertEqual(result["results"][0]["publisher"], "First publisher")
        self.assertEqual([item["url"] for item in result["results"][1:]], [item["link"] for item in other[:7]])

    def test_general_research_and_equal_matches_keep_provider_order(self):
        items = [{"title": "Bridge maintenance research", "link": f"https://example.org/{name}", "snippet": "Civil engineering findings."} for name in ("z", "a.csv", "b", "c", "d", "e", "f", "g", "h")]
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value={"organic_results": items}):
            result = server.search_serp_web("bridge maintenance", "google", "")
        self.assertEqual([item["url"] for item in result["results"]], [item["link"] for item in items[:8]])

    def test_query_terms_normalize_accents_url_escapes_and_word_boundaries(self):
        items = [
            {"title": "Cambridge maintenance", "link": "https://example.org/cambridge.csv"},
            {"title": "Archive", "link": "https://example.org/S%C3%A3o_Paulo/bridge-maintenance"},
            {"title": "S\u00e3o Paulo bridge maintenance", "link": "https://example.org/study"},
        ]
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value={"organic_results": items}):
            result = server.search_serp_web("SAO PAULO bridge maintenance", "google", "")
        self.assertEqual([item["url"] for item in result["results"]], [items[index]["link"] for index in (1, 2, 0)])

    def test_google_supplemental_sources_are_ranked_before_final_cap(self):
        payload = {
            "organic_results": [{"title": "Poverty data", "link": f"https://example.org/unrelated-{index}.csv"} for index in range(10)],
            "knowledge_graph": {"title": "Noida population", "description": "India census counts.", "source": {"link": "https://example.org/census", "name": "Census office"}},
            "answer_box": {"title": "Noida population census", "link": "https://example.org/answer", "snippet": "Official India counts."},
        }
        with mock.patch.object(server, "CACHE", self.cache), mock.patch.object(server, "fetch_serp_response", return_value=payload):
            result = server.search_serp_web("Noida India population census", "google", "IN")
        self.assertEqual(len(result["results"]), 8)
        self.assertEqual({item["kind"] for item in result["results"][:2]}, {"knowledge-source", "answer-source"})
        self.assertEqual({item["url"] for item in result["results"][:2]}, {"https://example.org/census", "https://example.org/answer"})

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
        self.assertEqual(update["scope"], {"type": "workspace"})
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

    def test_population_counts_that_look_like_years_do_not_invent_temporal_fields(self):
        self.reader.return_value["dataset"] = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [1, 1]}, "properties": {"census_population": population, "update_count": population}} for population in (1901, 2011)]}
        context = self.source_context()
        read = self.tools.execute(context, "read_web_source", {"sourceRef": "source:1"})
        self.assertEqual(read["dataset"]["temporalFields"], [])
        result = self.tools.execute(context, "load_web_dataset", {"sourceRef": "source:1", "field": "census_population"})
        self.assertEqual(len(result["mapUpdate"]["dataset"]["data"]["features"]), 2)
        self.assertEqual(result["mapUpdate"]["dataset"]["source"]["referenceYear"], "")

    def test_source_load_requires_point_observations_and_one_actual_census_year(self):
        self.reader.return_value["dataset"] = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [1, 1]}, "properties": {"population": 100, "year": 2011}}, {"type": "Feature", "geometry": {"type": "Point", "coordinates": [1, 1]}, "properties": {"population": 200, "year": 2021}}]}
        context = self.source_context()
        read = self.tools.execute(context, "read_web_source", {"sourceRef": "source:1"})
        self.assertEqual(read["dataset"]["timeValues"]["year"], ["2011", "2021"])
        with self.assertRaisesRegex(server.ServiceError, "multiple observation"):
            self.tools.execute(context, "load_web_dataset", {"sourceRef": "source:1", "field": "population"})
        result = self.tools.execute(context, "load_web_dataset", {"sourceRef": "source:1", "field": "population", "timeField": "year", "timeValue": "2021"})
        update = result["mapUpdate"]["dataset"]
        self.assertEqual([feature["properties"]["population"] for feature in update["data"]["features"]], [200])
        self.assertEqual(update["source"]["referenceYear"], "2021")
        for geometry in ({"type": "MultiPoint", "coordinates": [[1, 1], [20, 20]]}, {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 0]]]}):
            context.documents["source:1"]["dataset"] = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": geometry, "properties": {"population": 120000}}]}
            with self.assertRaisesRegex(server.ServiceError, "original Point"):
                self.tools.execute(context, "load_web_dataset", {"sourceRef": "source:1", "field": "population", "visualization": "heatmap"})

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
        context.map_context["scope"] = {"type": "selection", "bounds": [0, 0, 10, 10]}
        chal = self.tools._register_entity(context, {**self.place, "id": "chal", "name": "Chal, Darma Valley", "shortName": "Chal", "placeType": "village"}, "place")
        sela = self.tools._register_entity(context, {**self.place, "id": "sela", "name": "Sela, Darma Valley", "shortName": "Sela", "placeType": "village"}, "place")
        result = self.tools.execute(context, "map_source_table", {"sourceRef": "source:1", "tableIndex": 0, "nameColumn": "Village", "valueColumn": "Population", "matches": [{"rowIndex": 0, "placeRef": chal["ref"]}, {"rowIndex": 1, "placeRef": sela["ref"]}], "units": "people in 2011", "visualization": "heatmap"})
        update = result["mapUpdate"]["dataset"]
        self.assertEqual([feature["properties"]["value"] for feature in update["data"]["features"]], [1200, 0])
        self.assertEqual(update["source"]["method"], "source-table-place-join")
        self.assertIn("not a continuous population grid", update["source"]["caveat"])
        for match in ({"rowIndex": 2, "placeRef": chal["ref"]}, {"rowIndex": 0, "placeRef": sela["ref"]}, {"rowIndex": 0, "placeRef": chal["ref"], "value": 42}):
            with self.subTest(match=match), self.assertRaises(server.ServiceError):
                self.tools.execute(context, "map_source_table", {"sourceRef": "source:1", "tableIndex": 0, "nameColumn": "Village", "valueColumn": "Population", "matches": [match]})

    def test_table_join_rejects_substring_names_pois_and_unscoped_ambiguous_regions(self):
        self.reader.return_value = {"url": "https://example.org/population", "title": "Census", "format": "html", "text": "", "tables": [{"headers": ["Village", "Population", "District"], "rows": [["York", "10", "Pithoragarh"]]}], "links": []}
        context = self.source_context()
        arguments = {"sourceRef": "source:1", "tableIndex": 0, "nameColumn": "Village", "valueColumn": "Population", "matches": [{"rowIndex": 0, "placeRef": "place:1"}]}
        self.tools._register_entity(context, {**self.place, "name": "New York", "shortName": "New York", "placeType": "city"}, "place")
        with self.assertRaisesRegex(server.ServiceError, "administrative-region column"):
            self.tools.execute(context, "map_source_table", arguments)
        context.map_context["scope"] = {"type": "selection", "bounds": [0, 0, 10, 10]}
        with self.assertRaisesRegex(server.ServiceError, "does not match"):
            self.tools.execute(context, "map_source_table", arguments)
        context.entities["place:1"]["shortName"] = "York"
        context.entities["place:1"]["placeType"] = "school"
        with self.assertRaisesRegex(server.ServiceError, "not identified.*settlement"):
            self.tools.execute(context, "map_source_table", arguments)
        context.entities["place:1"]["placeType"] = "village"
        context.map_context["scope"] = {"type": "workspace"}
        with self.assertRaisesRegex(server.ServiceError, "administrative region does not match"):
            self.tools.execute(context, "map_source_table", {**arguments, "regionColumn": "District"})
        context.entities["place:1"]["address"] = "York, Pithoragarh, Uttarakhand, India"
        result = self.tools.execute(context, "map_source_table", {**arguments, "regionColumn": "District"})
        self.assertEqual(result["mapUpdate"]["dataset"]["data"]["features"][0]["properties"]["value"], 10)
