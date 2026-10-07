"""Offline regressions for map-first, grounded population/raster acquisition."""

import copy
import json
import threading
from dataclasses import replace
from unittest import mock

from backend.agent import MapAgentService
from backend.agent_tools import AgentTools
from backend.errors import ServiceError
from backend.test_agent_studio import BackendCase, Client, Hub, studio_context, tool_call


class PopulationAgentTests(BackendCase):
    def setUp(self):
        super().setUp()
        self.noida = {
            "id": "osm:relation:18814682", "name": "Noida, Uttar Pradesh, India", "shortName": "Noida",
            "countryCode": "IN", "country": "India", "provider": "openstreetmap", "placeType": "city",
            "lon": 77.3272147, "lat": 28.5706333, "bbox": [77.2928863, 28.4006672, 77.5065172, 28.6354703],
        }
        self.resolve.return_value = self.noida
        self.document = {
            "url": "https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/2020/IND/ind_ppp_2020_1km_Aggregated.tif",
            "title": "WorldPop India population 2020", "format": "geotiff", "field": "population",
            "units": "people per grid cell", "referenceYear": 2020, "resolution": "30 arc seconds (approximately 1 km)",
            "method": "raster-window", "license": "CC BY 4.0", "attribution": "WorldPop",
            "citation": "WorldPop population counts", "publishedDate": "2020-06-22",
            "metadataUrl": "https://www.worldpop.org/rest/data/pop/wpgp?iso3=IND",
            "directoryUrl": "https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/2020/IND/",
            "caveat": "Historical modeled population at original grid-cell centers. Bbox crop, not an administrative total.",
            "dataset": {"type": "FeatureCollection", "features": [
                {"type": "Feature", "geometry": {"type": "Point", "coordinates": [77.33, 28.56]}, "properties": {"population": 1042.25}},
                {"type": "Feature", "geometry": {"type": "Point", "coordinates": [77.34, 28.57]}, "properties": {"population": 0}},
            ]},
        }
        self.population = mock.Mock(side_effect=lambda *args: copy.deepcopy(self.document))
        self.raster = mock.Mock(side_effect=lambda *args: copy.deepcopy(self.document))
        self.web = mock.Mock(return_value={"results": [{"url": "https://example.org/observations.tif", "title": "Observed grid"}]})
        self.tools = AgentTools(replace(self.tools.dependencies, load_population=self.population, read_raster_source=self.raster))

    def context(self, **values):
        context = self.tools.new_context({"countryCode": "NP", "center": [85.3, 27.7], **values})
        context.research_intent = context.population_requested = True
        self.tools.execute(context, "find_city", {"query": "Noida"})
        return context

    def test_resolved_target_localizes_research_without_inheriting_geoip_country(self):
        self.tools = AgentTools(replace(self.tools.dependencies, search_web=self.web))
        context = self.context()
        self.tools.execute(context, "search_web", {"query": "Noida population data"})
        self.web.assert_called_with("Noida population data", "google", "IN")
        self.assertEqual(context.map_context["countryCode"], "NP")
        unlocated = self.tools.new_context({"countryCode": "NP"})
        self.tools.execute(unlocated, "search_web", {"query": "Noida population data"})
        self.web.assert_called_with("Noida population data", "google", "")
        self.tools.execute(context, "search_web", {"query": "population data", "nearRef": "city:1"})
        self.web.assert_called_with("population data", "google", "IN")
        with self.assertRaises(ServiceError):
            self.tools.execute(context, "search_web", {"query": "data", "nearRef": "city:missing"})

    def test_study_preview_is_verified_context_not_workspace_or_population_mutation(self):
        before = self.cache.capture_workspace()
        context = self.tools.new_context({})
        context.research_intent = True
        result = self.tools.execute(context, "find_city", {"query": "Noida"})
        update = result["mapUpdate"]
        self.assertEqual(update["researchArea"]["bounds"], self.noida["bbox"])
        self.assertIn("not an administrative boundary", update["researchArea"]["caveat"])
        self.assertEqual(update["view"]["bounds"], self.noida["bbox"])
        self.assertNotIn("dataset", update)
        self.assertNotIn("selectedCity", update)
        self.assertEqual(self.cache.capture_workspace(), before)
        self.assertTrue(context.requires_presentation)

    def test_population_values_and_provenance_reach_browser_without_entering_model_context(self):
        context = self.context()
        result = self.tools.execute(context, "load_population", {"cityRef": "city:1"})
        self.population.assert_called_once_with("IN", self.noida["bbox"], None)
        dataset = result["mapUpdate"]["dataset"]
        self.assertEqual(dataset["data"], self.document["dataset"])
        self.assertEqual(dataset["name"], "Noida population (2020)")
        self.assertEqual(dataset["field"], "population")
        self.assertEqual(dataset["units"], "people per grid cell")
        self.assertEqual(dataset["visualization"], "heatmap")
        self.assertEqual(dataset["source"]["referenceYear"], "2020")
        self.assertEqual(dataset["source"]["method"], "raster-window")
        self.assertEqual(dataset["source"]["license"], "CC BY 4.0")
        self.assertIn("approximately 1 km", dataset["source"]["resolution"])
        model_result = MapAgentService._model_tool_result(result)
        self.assertNotIn("mapUpdate", model_result)
        self.assertNotIn('"features":', json.dumps(model_result))
        self.assertNotIn('"coordinates":', json.dumps(model_result))
        citations = MapAgentService._source_citations(context)
        self.assertEqual(citations[0]["url"], self.document["url"])
        self.assertTrue(all(source["readAt"] for source in citations))

    def test_population_uses_frozen_scope_without_broadening_to_city_extent(self):
        bounds = [77.3, 28.45, 77.4, 28.6]
        context = self.context(scope={"type": "selection", "bounds": bounds})
        self.tools.execute(context, "load_population", {"cityRef": "city:1", "year": 2020})
        self.population.assert_called_once_with("IN", bounds, 2020)
        self.assertEqual(context.map_context["scope"]["bounds"], bounds)
        self.assertEqual(context.research_area["bounds"], bounds)

    def test_population_rejects_fabricated_refs_values_and_year_substitution(self):
        context = self.context()
        for arguments in ({"cityRef": "city:missing"}, {"cityRef": "city:1", "population": 123}, {"cityRef": "city:1", "year": True}):
            with self.subTest(arguments=arguments), self.assertRaises(ServiceError):
                self.tools.execute(context, "load_population", arguments)
        self.population.assert_not_called()
        context.requested_population_year = 2021
        with self.assertRaisesRegex(ServiceError, "explicitly requested by the user"):
            self.tools.execute(context, "load_population", {"cityRef": "city:1", "year": 2020})
        with self.assertRaisesRegex(ServiceError, "does not match.*requested year"):
            self.tools.execute(context, "load_population", {"cityRef": "city:1"})
        self.population.assert_called_once_with("IN", self.noida["bbox"], 2021)
        self.assertEqual(context.loaded_datasets, 0)

    def test_missing_population_cannot_be_reported_before_available_reader_is_attempted(self):
        with self.assertRaisesRegex(ServiceError, "call load_population"):
            self.tools.execute(self.context(), "report_limitation", {"reason": "dataset_unavailable"})
        context = self.context()
        self.tools.execute(context, "load_population", {"cityRef": "city:1"})
        with self.assertRaisesRegex(ServiceError, "already been queued"):
            self.tools.execute(context, "report_limitation", {"reason": "dataset_unavailable"})

    def test_generic_raster_cannot_bypass_explicit_population_year(self):
        self.tools = AgentTools(replace(self.tools.dependencies, search_web=self.web))
        context = self.context()
        context.requested_population_year = 2021
        self.tools.execute(context, "search_web", {"query": "Noida population 2021 GeoTIFF"})
        for year in (2020, None):
            self.document["referenceYear"] = year
            with self.subTest(year=year), self.assertRaisesRegex(ServiceError, "source observation year"):
                self.tools.execute(context, "load_raster_dataset", {"sourceRef": "source:1", "cityRef": "city:1"})
        self.assertEqual(context.loaded_datasets, 0)

    def test_coordinate_source_cannot_bypass_explicit_population_year(self):
        context = self.context()
        context.requested_population_year = 2021
        source = self.tools._register_source(context, {"url": "https://example.org/population.geojson", "title": "Population 2020"})
        data = copy.deepcopy(self.document["dataset"])
        for feature in data["features"]:
            feature["properties"]["year"] = 2020
        context.documents[source["sourceRef"]] = {"dataset": data}
        with self.assertRaisesRegex(ServiceError, "source observation year"):
            self.tools.execute(context, "load_web_dataset", {"sourceRef": source["sourceRef"], "field": "population"})
        self.assertEqual(context.loaded_datasets, 0)

    def test_raster_requires_discovered_source_and_verified_extent(self):
        self.tools = AgentTools(replace(self.tools.dependencies, search_web=self.web))
        context = self.context()
        with self.assertRaises(ServiceError):
            self.tools.execute(context, "load_raster_dataset", {"sourceRef": "https://example.org/grid.tif", "cityRef": "city:1"})
        self.tools.execute(context, "search_web", {"query": "official observations GeoTIFF"})
        result = self.tools.execute(context, "load_raster_dataset", {"sourceRef": "source:1", "cityRef": "city:1", "band": 2})
        self.raster.assert_called_once_with("https://example.org/observations.tif", self.noida["bbox"], 2)
        self.assertEqual(result["mapUpdate"]["dataset"]["data"], self.document["dataset"])
        context.map_context["scope"] = {"type": "layer", "layerId": "existing"}
        with self.assertRaisesRegex(ServiceError, "layer scope"):
            self.tools.execute(context, "load_population", {"cityRef": "city:1"})

    def test_explore_noida_shows_extent_before_loading_actual_population(self):
        hub = Hub()

        def acquire(*args):
            updates = [event["update"] for _, event in hub.events if event["type"] == "agent.map"]
            self.assertEqual(len(updates), 1)
            self.assertIn("researchArea", updates[0])
            return copy.deepcopy(self.document)

        self.population.side_effect = acquire
        client = Client([tool_call("find_city", {"query": "Noida"}), tool_call("load_population", {"cityRef": "city:1"}), {"content": "WorldPop's modeled 2020 population grid is queued for display."}])
        service = MapAgentService(client, self.tools, hub)
        run_id = service.start_run(hub.session, "Create a heatmap of population of Noida", {"countryCode": "NP"})
        terminal = hub.wait(run_id)
        self.assertEqual(terminal["type"], "agent.completed")
        updates = [event["update"] for _, event in hub.events if event["type"] == "agent.map"]
        self.assertEqual(len(updates), 2)
        self.assertEqual(updates[1]["dataset"]["data"]["features"][0]["properties"]["population"], 1042.25)
        self.assertEqual(terminal["sources"][0]["url"], self.document["url"])
        self.web.assert_not_called()

    def test_explicit_user_year_is_preserved_when_model_omits_year(self):
        self.document["referenceYear"] = 2015
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("load_population", {"cityRef": "city:1"}), {"content": "Queued modeled 2015 population."}])
        terminal = hub.wait(service.start_run(hub.session, "Plot population of Noida in 2015", {}))
        self.assertEqual(terminal["type"], "agent.completed")
        self.population.assert_called_once_with("IN", self.noida["bbox"], 2015)

    def test_source_failure_retains_only_context_and_reports_specific_issue(self):
        self.population.side_effect = ServiceError("WorldPop download timed out.", 504)
        before = self.cache.capture_workspace()
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("load_population", {"cityRef": "city:1"}), tool_call("report_limitation", {"reason": "dataset_unavailable"})])
        terminal = hub.wait(service.start_run(hub.session, "Create a population heatmap of Noida", {}))
        self.assertEqual(terminal["type"], "agent.limitation")
        self.assertTrue(terminal["contextOnly"])
        self.assertNotIn("rolledBack", terminal)
        self.assertIn("WorldPop download timed out", terminal["message"])
        self.assertIn("geographic context only", terminal["message"])
        self.assertEqual(self.cache.capture_workspace(), before)
        self.assertFalse(any("dataset" in event.get("update", {}) for _, event in hub.events))

    def test_explicit_city_presentation_during_research_is_still_only_a_preview(self):
        self.population.side_effect = ServiceError("Population source unavailable.", 503)
        before = self.cache.capture_workspace()
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("present_map", {"cityRef": "city:1"}), tool_call("load_population", {"cityRef": "city:1"}), tool_call("report_limitation", {"reason": "dataset_unavailable"})])
        terminal = hub.wait(service.start_run(hub.session, "Create a population heatmap of Noida", {}))
        self.assertEqual(terminal["type"], "agent.limitation")
        self.assertTrue(terminal["contextOnly"])
        self.assertNotIn("rolledBack", terminal)
        self.assertEqual(self.cache.capture_workspace(), before)

    def test_last_model_round_population_load_is_not_rolled_back_as_exhaustion(self):
        responses = [tool_call("find_city", {"query": "Noida"}) for _ in range(7)]
        responses.append(tool_call("load_population", {"cityRef": "city:1"}))
        service, hub, client = self.service(responses)
        terminal = hub.wait(service.start_run(hub.session, "Create a population heatmap of Noida", {}))
        self.assertEqual(terminal["type"], "agent.completed")
        self.assertEqual(len(client.messages), 8)
        self.assertNotIn("rolledBack", terminal)

    def test_loaded_population_layer_does_not_trigger_new_raster_acquisition(self):
        service, hub, _ = self.service([tool_call("studio_operation", {"action": "visualize", "layerId": "layer-a", "field": "value", "visualization": "heatmap"}), {"content": "Queued the existing layer."}])
        terminal = hub.wait(service.start_run(hub.session, "Show the loaded population as a heatmap", studio_context()))
        self.assertEqual(terminal["type"], "agent.completed")
        self.population.assert_not_called()

    def test_empty_geographic_presentation_does_not_complete_population_request(self):
        service, hub, client = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("present_map", {}), {"content": "The population heatmap is ready."}, tool_call("load_population", {"cityRef": "city:1"}), {"content": "The sourced 2020 layer is queued."}])
        terminal = hub.wait(service.start_run(hub.session, "Create a population heatmap of Noida", {}))
        self.assertEqual(terminal["type"], "agent.completed")
        self.population.assert_called_once()
        self.assertEqual(len(client.messages), 5)
        self.assertTrue(any("dataset" in event.get("update", {}) for _, event in hub.events))

    def test_geographic_preview_then_valid_studio_map_finishes_without_research_loop(self):
        service, hub, client = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("studio_operation", {"action": "visualize", "layerId": "layer-a", "field": "value", "visualization": "heatmap"}), {"content": "The loaded population heatmap is queued."}])
        terminal = hub.wait(service.start_run(hub.session, "Show loaded population as a heatmap around Noida", studio_context()))
        self.assertEqual(terminal["type"], "agent.completed")
        self.assertNotIn("rolledBack", terminal)
        self.assertEqual(len(client.messages), 3)
        self.population.assert_not_called()

    def test_cancellation_during_download_never_publishes_late_raster(self):
        entered, release = threading.Event(), threading.Event()

        def acquire(*args):
            entered.set()
            if not release.wait(3):
                raise AssertionError("Fixture download was not released")
            return copy.deepcopy(self.document)

        self.population.side_effect = acquire
        self.addCleanup(release.set)
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("load_population", {"cityRef": "city:1"})])
        run_id = service.start_run(hub.session, "Create a population heatmap of Noida", {})
        self.assertTrue(entered.wait(2))
        service.handle_socket_message(hub.session, {"type": "agent.cancel", "runId": run_id})
        release.set()
        terminal = hub.wait(run_id)
        self.assertEqual(terminal["type"], "agent.cancelled")
        self.assertTrue(terminal["rolledBack"])
        self.assertFalse(any("dataset" in event.get("update", {}) for _, event in hub.events))

    def test_download_does_not_lock_workspace_or_overwrite_intervening_edit(self):
        entered, release = threading.Event(), threading.Event()

        def acquire(*args):
            entered.set()
            if not release.wait(3):
                raise AssertionError("Fixture download was not released")
            return copy.deepcopy(self.document)

        self.population.side_effect = acquire
        self.addCleanup(release.set)
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("load_population", {"cityRef": "city:1"})])
        run_id = service.start_run(hub.session, "Create a population heatmap of Noida", {})
        self.assertTrue(entered.wait(2))
        pin = self.cache.add_pin("Concurrent user edit", 28.57, 77.33, None, "map-click")
        release.set()
        terminal = hub.wait(run_id)
        self.assertEqual(terminal["type"], "agent.failed")
        self.assertTrue(terminal["rollbackConflict"])
        self.assertEqual(self.cache.workspace_snapshot()["pins"][0]["id"], pin["id"])
        self.assertFalse(any("dataset" in event.get("update", {}) for _, event in hub.events))
