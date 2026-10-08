"""Offline explicit map-action and no-camera-only-highlight regressions."""

import copy
import json
import threading
from dataclasses import replace
from unittest import mock

from backend.agent import MapAgentService
from backend.agent_tools import AgentTools
from backend.errors import ServiceError
from backend.map_actions import color, style
from backend.test_agent_studio import BackendCase, studio_context, tool_call


class MapActionAgentTests(BackendCase):
    def setUp(self):
        super().setUp()
        self.city.update({"id": "relation:18814682", "name": "Noida", "shortName": "Noida", "countryCode": "IN"})
        self.source = {"name": "OpenStreetMap / Nominatim", "url": "https://www.openstreetmap.org/relation/18814682", "attribution": "OpenStreetMap contributors", "license": "ODbL-1.0", "caveat": "OSM-mapped administrative boundary, not certified legal limits."}
        self.boundary = {"dataset": {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[4, 4], [5.5, 4], [6, 5], [5, 6], [4, 4]]]}, "properties": {"name": "Noida", "sourceId": "relation:18814682"}}]}, "name": "Noida boundary", "bounds": [4, 4, 6, 6], "source": self.source}
        self.roads = {"dataset": {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[4.5, 4.5], [5, 5], [5.5, 5.5]]}, "properties": {"name": "Test road", "roadClass": "primary"}}]}, "name": "Source roads", "source": {**self.source, "url": "https://overpass-api.de/api/interpreter", "caveat": "Roads clipped to search bounds, not a complete city network."}, "coverage": {"truncated": False}}
        self.load_boundary = mock.Mock(side_effect=lambda *args: copy.deepcopy(self.boundary))
        self.load_roads = mock.Mock(side_effect=lambda *args: copy.deepcopy(self.roads))
        self.tools = AgentTools(replace(self.tools.dependencies, load_city_geometry=self.load_boundary, load_road_geometry=self.load_roads))

    def located(self, raw=None):
        context = self.tools.new_context(raw or {})
        self.tools.execute(context, "find_city", {"query": "Noida"})
        return context

    def test_city_color_materializes_actual_source_polygon_not_bbox_or_focus_point(self):
        context = self.located()
        result = self.tools.execute(context, "highlight_city", {"cityRef": "city:1", "style": {"color": "red"}})
        layer = result["mapUpdate"]["actions"][0]["layer"]
        self.assertEqual(layer["data"], self.boundary["dataset"])
        self.assertEqual(layer["style"]["color"], "#ff0000")
        self.assertEqual(layer["style"]["fillColor"], "#ff0000")
        self.assertEqual(layer["source"], self.source)
        self.assertEqual(result["mapUpdate"]["actions"][1], {"action": "fit_layer", "layerId": result["layerId"]})
        self.assertNotIn("selectedCity", result["mapUpdate"])
        self.assertEqual(context.loaded_datasets, 0)
        self.assertEqual(context.highlight_actions, 1)
        self.assertNotIn('"coordinates":', json.dumps(MapAgentService._model_tool_result(result)))

    def test_requested_red_is_enforced_even_if_model_omits_color(self):
        context = self.located()
        context.requested_color = "#ff0000"
        result = self.tools.execute(context, "highlight_city", {"cityRef": "city:1"})
        self.assertEqual(result["style"]["color"], "#ff0000")
        with self.assertRaisesRegex(ServiceError, "explicitly requested"):
            self.tools.execute(context, "highlight_city", {"cityRef": "city:1", "style": {"color": "blue"}})
        self.assertEqual(self.load_boundary.call_count, 1)

    def test_city_rejects_unknown_ref_point_only_and_boundary_outside_scope(self):
        context = self.located({"scope": {"type": "selection", "bounds": [4.5, 4.5, 5.5, 5.5]}})
        with self.assertRaises(ServiceError):
            self.tools.execute(context, "highlight_city", {"cityRef": "city:missing"})
        self.load_boundary.assert_not_called()
        with self.assertRaisesRegex(ServiceError, "leaves the frozen"):
            self.tools.execute(context, "highlight_city", {"cityRef": "city:1"})
        self.assertFalse(context.overlays)
        self.boundary["dataset"]["features"][0]["geometry"] = {"type": "Point", "coordinates": [5, 5]}
        with self.assertRaisesRegex(ServiceError, "actual city polygon"):
            self.tools.execute(self.located(), "highlight_city", {"cityRef": "city:1"})

    def test_roads_use_target_extent_exact_source_lines_and_width(self):
        context = self.located({"countryCode": "NP", "bounds": [85, 27, 86, 28]})
        result = self.tools.execute(context, "highlight_roads", {"query": "Test road", "nearRef": "city:1", "classes": ["primary"], "style": {"color": "yellow", "lineWidth": 6}})
        self.load_roads.assert_called_once_with("Test road", [4, 4, 6, 6], ["primary"])
        self.assertEqual(result["mapUpdate"]["actions"][0]["layer"]["data"], self.roads["dataset"])
        self.assertEqual(result["style"]["lineWidth"], 6)
        self.assertEqual(result["style"]["color"], "#ffff00")
        self.assertEqual(result["kind"], "roads")

    def test_geographic_overlay_does_not_satisfy_population_or_wrong_highlight_target(self):
        context = self.located()
        context.highlight_target = "city"
        result = self.tools.execute(context, "highlight_roads", {"query": "roads", "nearRef": "city:1"})
        self.assertEqual(context.highlight_actions, 0)
        self.assertEqual(context.loaded_datasets, 0)
        self.assertTrue(result["queued"])

    def test_exact_layer_restyle_hide_filter_reorder_remove(self):
        context = self.located()
        first = self.tools.execute(context, "highlight_city", {"cityRef": "city:1"})["layerId"]
        second = self.tools.execute(context, "highlight_roads", {"query": "roads", "nearRef": "city:1"})["layerId"]
        result = self.tools.execute(context, "map_action", {"action": "style_layer", "layerId": first, "style": {"color": "blue", "fillOpacity": .3}})
        self.assertEqual(result["mapUpdate"]["actions"][0]["style"]["color"], "#0000ff")
        self.tools.execute(context, "map_action", {"action": "set_visibility", "layerId": first, "visible": False})
        self.assertFalse(context.overlays[first]["visible"])
        self.tools.execute(context, "map_action", {"action": "filter_layer", "layerId": second, "field": "roadClass", "operator": "eq", "value": "primary"})
        self.assertEqual(context.overlays[second]["filter"]["value"], "primary")
        self.tools.execute(context, "map_action", {"action": "filter_layer", "layerId": second, "field": None})
        self.tools.execute(context, "map_action", {"action": "move_layer", "layerId": second, "beforeLayerId": first})
        self.assertEqual(list(context.overlays), [second, first])
        self.tools.execute(context, "map_action", {"action": "remove_layer", "layerId": first})
        self.assertNotIn(first, context.overlays)

    def test_overlay_registry_and_fields_survive_new_run_without_raw_data(self):
        raw = {"mapActions": {"version": 1, "layers": [{"id": "noida-boundary", "name": "Noida", "style": {"color": "red"}, "bounds": [4, 4, 6, 6], "geometryTypes": ["Polygon"], "featureCount": 1, "visible": True, "data": self.boundary["dataset"], "private": "no-secret-leak", "source": self.source}]}}
        context = self.tools.new_context(raw)
        self.assertNotIn("data", json.dumps(context.map_context))
        self.assertNotIn("no-secret-leak", json.dumps(context.map_context))
        self.assertEqual(context.overlays["noida-boundary"]["style"]["color"], "#ff0000")
        self.tools.execute(context, "map_action", {"action": "style_layer", "layerId": "noida-boundary", "style": {"color": "blue"}})

    def test_action_allowlist_strict_types_known_fields_noop_and_scope(self):
        context = self.located()
        layer_id = self.tools.execute(context, "highlight_city", {"cityRef": "city:1", "style": {"color": "red"}})["layerId"]
        invalid = [
            {"action": "style_layer", "layerId": "road-primary", "style": {"color": "red"}},
            {"action": "style_layer", "layerId": layer_id, "style": {"color": "red"}},
            {"action": "style_layer", "layerId": layer_id, "style": {"color": "url(javascript:alert(1))"}},
            {"action": "set_visibility", "layerId": layer_id, "visible": "false"},
            {"action": "filter_layer", "layerId": layer_id, "field": "invented", "operator": "eq", "value": 1},
            {"action": "filter_layer", "layerId": layer_id, "field": "name", "operator": "gt", "value": 1},
            {"action": "move_layer", "layerId": layer_id, "beforeLayerId": "missing"},
            {"action": "set_basemap", "mode": "streets", "style": {"color": "red"}},
            {"action": "set_terrain", "enabled": True, "exaggeration": float("nan")},
            {"action": "set_view", "center": [5, 5], "bounds": [4, 4, 6, 6]},
        ]
        for arguments in invalid:
            with self.subTest(arguments=arguments), self.assertRaises(ServiceError):
                self.tools.execute(context, "map_action", arguments)
        context.map_context["scope"] = {"type": "selection", "bounds": [4.5, 4.5, 5.5, 5.5]}
        with self.assertRaisesRegex(ServiceError, "escape the frozen"):
            self.tools.execute(context, "map_action", {"action": "style_layer", "layerId": layer_id, "style": {"color": "blue"}})

    def test_points_named_refs_and_explicit_coordinates_have_distinct_provenance(self):
        context = self.located()
        self.tools.execute(context, "search_places", {"query": "Test place", "nearRef": "city:1"})
        result = self.tools.execute(context, "plot_points", {"placeRefs": ["city:1", "place:2"], "style": {"color": "orange", "pointRadius": 10}})
        features = result["mapUpdate"]["actions"][0]["layer"]["data"]["features"]
        self.assertEqual([feature["geometry"]["coordinates"] for feature in features], [[5, 5], [6, 6]])
        with self.assertRaisesRegex(ServiceError, "do not invent"):
            self.tools.execute(context, "plot_points", {"points": [{"coordinates": [77, 28]}]})
        context.explicit_geometry_requested = True
        context.explicit_coordinates_requested = True
        context.user_coordinates = [[77, 28]]
        result = self.tools.execute(context, "plot_points", {"points": [{"coordinates": [77, 28], "label": "<script>literal text</script>"}]})
        self.assertIn("Explicit", result["source"]["name"])
        self.assertEqual(result["mapUpdate"]["actions"][0]["layer"]["data"]["features"][0]["properties"]["label"], "<script>literal text</script>")

    def test_annotation_shapes_use_known_or_explicit_coordinates_without_source_claims(self):
        context = self.located()
        with self.assertRaisesRegex(ServiceError, "drawing requires"):
            self.tools.execute(context, "draw_geometry", {"kind": "circle", "centerRef": "city:1", "radiusMeters": 500})
        context.explicit_geometry_requested = True
        context.explicit_coordinates_requested = True
        context.user_coordinates = [[4, 4], [6, 4], [5, 6], [6, 6]]
        context.user_bounds = [[4, 4, 6, 6]]
        for arguments in (
            {"kind": "circle", "centerRef": "city:1", "radiusMeters": 500},
            {"kind": "rectangle", "bounds": [4, 4, 6, 6]},
            {"kind": "polygon", "coordinates": [[4, 4], [6, 4], [5, 6]]},
            {"kind": "line", "coordinates": [[4, 4], [6, 6]]},
            {"kind": "label", "centerRef": "city:1", "label": "Noida"},
        ):
            result = self.tools.execute(context, "draw_geometry", arguments)
            self.assertEqual(result["kind"], "annotation")
            self.assertIn("User-requested annotation", result["source"]["caveat"])
        self.assertEqual(context.loaded_datasets, 0)

    def test_camera_and_appearance_are_explicit_but_not_highlights(self):
        context = self.located()
        for arguments in (
            {"action": "set_view", "center": [5, 5], "zoom": 14, "pitch": 45, "bearing": 30},
            {"action": "set_basemap", "mode": "satellite"},
            {"action": "set_terrain", "enabled": True, "exaggeration": 1.5},
            {"action": "set_display", "preference": "roads", "enabled": True},
        ):
            self.assertTrue(self.tools.execute(context, "map_action", arguments)["queued"])
        self.assertEqual(context.highlight_actions, 0)

    def test_studio_style_visibility_order_and_remove_are_typed_client_actions(self):
        context = self.tools.new_context(studio_context())
        for arguments in (
            {"action": "style", "layerId": "layer-a", "color": "red", "opacity": .5, "lineWidth": 4, "pointRadius": 9},
            {"action": "visibility", "layerId": "layer-a", "visible": False},
            {"action": "move", "layerId": "layer-a", "beforeLayerId": "layer-b"},
            {"action": "remove", "layerId": "layer-a"},
        ):
            result = self.tools.execute(context, "studio_operation", arguments)["mapUpdate"]["studio"]
            self.assertEqual(result["workspaceId"], "workspace-a")
            self.assertEqual(result["action"], arguments["action"])
        context = self.tools.new_context(studio_context())
        invalid = {"action": "style", "layerId": "layer-a", "color": "red", "visible": False}
        with self.assertRaises(ServiceError):
            self.tools.execute(context, "studio_operation", invalid)

    def test_highlight_instruction_recovers_from_camera_only_result(self):
        service, hub, client = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("present_map", {"cityRef": "city:1"}), {"content": "Noida is highlighted red."}, tool_call("highlight_city", {"cityRef": "city:1"}), {"content": "The actual Noida boundary is highlighted red."}])
        terminal = hub.wait(service.start_run(hub.session, "Highlight the map of Noida in Red", {}))
        self.assertEqual(terminal["type"], "agent.completed")
        self.assertEqual(len(client.messages), 5)
        layer = next(event["update"]["actions"][0]["layer"] for _, event in hub.events if event["type"] == "agent.map" and "actions" in event["update"])
        self.assertEqual(layer["style"]["color"], "#ff0000")
        self.assertEqual(layer["data"]["features"][0]["geometry"]["type"], "Polygon")

    def test_highlight_camera_only_and_final_round_places_never_complete(self):
        for responses in (
            [tool_call("find_city", {"query": "Noida"}), tool_call("present_map", {"cityRef": "city:1"}), {"content": "Highlighted."}, {"content": "Ready."}],
            [tool_call("find_city", {"query": "Noida"}) for _ in range(7)] + [tool_call("present_map", {"cityRef": "city:1"})],
        ):
            service, hub, _ = self.service(responses)
            terminal = hub.wait(service.start_run(hub.session, "Highlight Noida in red", {}))
            self.assertEqual(terminal["type"], "agent.failed")
            self.assertTrue(terminal["rolledBack"])
            self.assertFalse(any(event["type"] == "agent.completed" for _, event in hub.events))

    def test_source_failures_are_limitation_not_successful_red_camera(self):
        self.load_boundary.side_effect = ServiceError("Noida boundary source timed out.", 504)
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("highlight_city", {"cityRef": "city:1"}), tool_call("report_limitation", {"reason": "dataset_unavailable"})])
        terminal = hub.wait(service.start_run(hub.session, "Highlight Noida in red", {}))
        self.assertEqual(terminal["type"], "agent.limitation")
        self.assertIn("Noida boundary source timed out", terminal["message"])

    def test_download_cancellation_and_concurrent_edit_preserve_guarded_workspace(self):
        entered, release = threading.Event(), threading.Event()

        def source(*args):
            entered.set()
            if not release.wait(3):
                raise AssertionError("Fixture not released")
            return copy.deepcopy(self.boundary)

        self.addCleanup(release.set)
        self.load_boundary.side_effect = source
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("highlight_city", {"cityRef": "city:1"})])
        run_id = service.start_run(hub.session, "Highlight Noida in red", {})
        self.assertTrue(entered.wait(2))
        pin = self.cache.add_pin("User edit", 5, 5, None, "map-click")
        release.set()
        terminal = hub.wait(run_id)
        self.assertEqual(terminal["type"], "agent.failed")
        self.assertTrue(terminal["rollbackConflict"])
        self.assertEqual(self.cache.workspace_snapshot()["pins"][0]["id"], pin["id"])
        self.assertFalse(any("actions" in event.get("update", {}) for _, event in hub.events))

    def test_color_and_style_validation_is_shared_strict_and_bounded(self):
        self.assertEqual(color("Red"), "#ff0000")
        self.assertEqual(color("#f0a"), "#ff00aa")
        for value in (True, None, "url(secret)", "var(--red)", "rgba(255,0,0,1)", "#ff000000"):
            with self.subTest(value=value), self.assertRaises(ServiceError):
                color(value)
        for value in ({"opacity": True}, {"lineWidth": float("inf")}, {"pointRadius": 0}, {"dashArray": [0, 0]}, {"labels": 1}, {"onClick": "eval"}):
            with self.subTest(value=value), self.assertRaises(ServiceError):
                style(value)

    def test_transparent_hidden_removed_or_empty_filtered_geometry_is_not_highlighted(self):
        context = self.located()
        context.requested_color = "#ff0000"
        context.highlight_target = "city"
        result = self.tools.execute(context, "highlight_city", {"cityRef": "city:1", "style": {"opacity": 0, "fillOpacity": 0, "labels": False}})
        self.assertFalse(self.tools.highlight_fulfilled(context))
        layer_id = result["layerId"]
        self.tools.execute(context, "map_action", {"action": "style_layer", "layerId": layer_id, "style": {"opacity": .8, "fillOpacity": .18}})
        self.assertTrue(self.tools.highlight_fulfilled(context))
        self.tools.execute(context, "map_action", {"action": "set_visibility", "layerId": layer_id, "visible": False})
        self.assertFalse(self.tools.highlight_fulfilled(context))
        self.tools.execute(context, "map_action", {"action": "set_visibility", "layerId": layer_id, "visible": True})
        self.tools.execute(context, "map_action", {"action": "filter_layer", "layerId": layer_id, "field": "name", "operator": "eq", "value": "Missing city"})
        self.assertFalse(self.tools.highlight_fulfilled(context))
        self.tools.execute(context, "map_action", {"action": "filter_layer", "layerId": layer_id, "field": None})
        self.assertTrue(self.tools.highlight_fulfilled(context))
        self.tools.execute(context, "map_action", {"action": "remove_layer", "layerId": layer_id})
        self.assertFalse(self.tools.highlight_fulfilled(context))

    def test_fill_only_request_cannot_leave_line_color_at_default(self):
        context = self.located()
        context.requested_color = "#ff0000"
        context.highlight_target = "roads"
        result = self.tools.execute(context, "highlight_roads", {"query": "roads", "nearRef": "city:1", "style": {"fillColor": "red"}})
        self.assertEqual(result["style"]["color"], "#ff0000")
        self.assertTrue(self.tools.highlight_fulfilled(context))

    def test_draw_markers_for_named_places_does_not_authorize_invented_coordinates(self):
        service, hub, _ = self.service([tool_call("plot_points", {"points": [{"coordinates": [0, 0], "label": "Noida Hospital"}], "style": {"color": "red"}}), {"content": "Markers ready."}, {"content": "Complete."}])
        terminal = hub.wait(service.start_run(hub.session, "Draw red markers for Noida hospitals", {}))
        self.assertEqual(terminal["type"], "agent.failed")
        self.assertFalse(any("actions" in event.get("update", {}) for _, event in hub.events))

    def test_unrelated_studio_point_style_does_not_fulfill_city_boundary_highlight(self):
        service, hub, _ = self.service([tool_call("studio_operation", {"action": "style", "layerId": "layer-a", "color": "red"}), {"content": "Noida highlighted."}, {"content": "Complete."}])
        terminal = hub.wait(service.start_run(hub.session, "Highlight Noida in red", studio_context()))
        self.assertEqual(terminal["type"], "agent.failed")

    def test_removed_highlight_is_not_completed_as_success(self):
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("highlight_city", {"cityRef": "city:1"}), tool_call("map_action", {"action": "remove_layer", "layerId": "overlay-1"}), {"content": "Noida highlighted."}, {"content": "Complete."}])
        terminal = hub.wait(service.start_run(hub.session, "Highlight Noida in red", {}))
        self.assertEqual(terminal["type"], "agent.failed")

    def test_city_and_roads_keep_distinct_requested_colors_and_both_targets(self):
        service, hub, client = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("highlight_city", {"cityRef": "city:1", "style": {"color": "red"}}), {"content": "Both highlighted."}, tool_call("highlight_roads", {"query": "roads", "nearRef": "city:1", "style": {"color": "blue"}}), {"content": "Noida red and roads blue."}])
        terminal = hub.wait(service.start_run(hub.session, "Highlight Noida in red, and its roads in blue", {}))
        self.assertEqual(terminal["type"], "agent.completed")
        self.assertEqual(len(client.messages), 5)
        layers = [event["update"]["actions"][0]["layer"] for _, event in hub.events if event["type"] == "agent.map" and "actions" in event["update"]]
        self.assertEqual([layer["style"]["color"] for layer in layers], ["#ff0000", "#0000ff"])

    def test_same_geometry_can_have_red_fill_and_blue_outline(self):
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("highlight_city", {"cityRef": "city:1", "style": {"color": "blue", "fillColor": "red"}}), {"content": "Red fill with blue outline."}])
        terminal = hub.wait(service.start_run(hub.session, "Highlight Noida with red fill and blue outline", {}))
        self.assertEqual(terminal["type"], "agent.completed")
        layer = next(event["update"]["actions"][0]["layer"] for _, event in hub.events if event["type"] == "agent.map" and "actions" in event["update"])
        self.assertEqual(layer["style"], {"color": "#0000ff", "fillColor": "#ff0000"})

    def test_wrapped_scope_rejects_world_spanning_camera_extent_and_restyle(self):
        raw = {"scope": {"type": "selection", "bounds": [170, -10, -170, 10]}, "mapActions": {"version": 1, "layers": [{"id": "world-span", "bounds": [-175, -5, 175, 5], "geometryTypes": ["Polygon"], "featureCount": 1, "style": {"color": "red"}}]}}
        context = self.tools.new_context(raw)
        for arguments in ({"action": "set_view", "bounds": [-175, -5, 175, 5]}, {"action": "style_layer", "layerId": "world-span", "style": {"color": "blue"}}):
            with self.subTest(arguments=arguments), self.assertRaises(ServiceError):
                self.tools.execute(context, "map_action", arguments)
        self.assertTrue(self.tools.execute(context, "map_action", {"action": "set_view", "bounds": [175, -5, -175, 5]})["queued"])

    def test_null_properties_source_geometry_is_valid_normalized_geojson(self):
        context = self.located()
        source = self.tools._register_source(context, {"url": "https://example.org/shape.geojson", "title": "Source shape"})
        data = copy.deepcopy(self.boundary["dataset"])
        data["features"][0]["properties"] = None
        context.documents[source["sourceRef"]] = {"dataset": data}
        result = self.tools.execute(context, "draw_geometry", {"kind": "source", "sourceRef": source["sourceRef"]})
        self.assertEqual(result["mapUpdate"]["actions"][0]["layer"]["data"]["features"][0]["properties"], {})

    def test_restyling_existing_empty_filtered_overlay_is_not_a_visible_highlight(self):
        raw = {"mapActions": {"version": 1, "layers": [{"id": "empty-points", "featureCount": 3, "matchingFeatureCount": 0, "geometryTypes": ["Point"], "visible": True, "style": {"color": "blue"}}]}}
        context = self.tools.new_context(raw)
        context.highlight_target = "points"
        context.requested_color = "#ff0000"
        self.tools.execute(context, "map_action", {"action": "style_layer", "layerId": "empty-points", "style": {"color": "red"}})
        self.assertFalse(self.tools.highlight_fulfilled(context))

    def test_exact_user_coordinate_pair_is_bound_to_the_plotted_point(self):
        for prompt in ("Plot a red point at [77.36,28.55]", "Draw red markers for 1,000 Noida hospitals"):
            service, hub, _ = self.service([tool_call("plot_points", {"points": [{"coordinates": [0, 0]}]}), {"content": "Point ready."}, {"content": "Complete."}])
            terminal = hub.wait(service.start_run(hub.session, prompt, {}))
            self.assertEqual(terminal["type"], "agent.failed")
            self.assertFalse(any("actions" in event.get("update", {}) for _, event in hub.events))
        service, hub, _ = self.service([tool_call("plot_points", {"points": [{"coordinates": [77.36, 28.55]}]}), {"content": "Requested point plotted."}])
        terminal = hub.wait(service.start_run(hub.session, "Plot a red point at [77.36,28.55]", {}))
        self.assertEqual(terminal["type"], "agent.completed")

    def test_followup_real_boundary_nominatim_source_is_recognized_for_recoloring(self):
        raw = {"mapActions": {"version": 1, "layers": [{"id": "noida", "featureCount": 1, "matchingFeatureCount": 1, "geometryTypes": ["Polygon"], "style": {"color": "red"}, "source": {**self.source, "url": "https://nominatim.openstreetmap.org/lookup?osm_ids=R18814682&format=geojson"}}]}}
        service, hub, _ = self.service([tool_call("map_action", {"action": "style_layer", "layerId": "noida", "style": {"color": "blue"}}), {"content": "Noida recolored blue."}])
        terminal = hub.wait(service.start_run(hub.session, "Recolor Noida in blue", raw))
        self.assertEqual(terminal["type"], "agent.completed")

    def test_studio_lifecycle_does_not_fulfill_creation_of_population_heatmap(self):
        for arguments in ({"action": "visibility", "layerId": "layer-a", "visible": False}, {"action": "remove", "layerId": "layer-a"}, {"action": "style", "layerId": "layer-a", "opacity": 0}):
            service, hub, _ = self.service([tool_call("studio_operation", arguments), {"content": "Population heatmap ready."}, {"content": "Done."}])
            terminal = hub.wait(service.start_run(hub.session, "Create a population heatmap of Noida", studio_context()))
            self.assertNotEqual(terminal["type"], "agent.completed")

    def test_recoloring_an_existing_visible_population_heatmap_does_not_reload_data(self):
        raw = studio_context()
        raw["studio"]["layers"][0].update({"visualization": "heatmap", "field": "value", "visible": True, "opacity": .85})
        service, hub, client = self.service([tool_call("studio_operation", {"action": "style", "layerId": "layer-a", "color": "red"}), {"content": "Existing population heatmap recolored red."}])
        terminal = hub.wait(service.start_run(hub.session, "Recolor the loaded population heatmap in red", raw))
        self.assertEqual(terminal["type"], "agent.completed")
        self.assertEqual(len(client.messages), 2)

    def test_creating_then_styling_visible_population_heatmap_uses_current_layer_state(self):
        service, hub, client = self.service([tool_call("studio_operation", {"action": "visualize", "layerId": "layer-a", "visualization": "heatmap", "field": "value"}), tool_call("studio_operation", {"action": "style", "layerId": "layer-a", "color": "red"}), {"content": "Red population heatmap queued."}])
        terminal = hub.wait(service.start_run(hub.session, "Create a red population heatmap", studio_context()))
        self.assertEqual(terminal["type"], "agent.completed")
        self.assertEqual(len(client.messages), 3)

    def test_wrong_fill_outline_colors_and_omitted_second_city_cannot_complete(self):
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("highlight_city", {"cityRef": "city:1", "style": {"color": "yellow", "fillColor": "green"}}), {"content": "Red fill and blue outline ready."}, {"content": "Complete."}])
        terminal = hub.wait(service.start_run(hub.session, "Highlight Noida with red fill and blue outline", {}))
        self.assertEqual(terminal["type"], "agent.failed")
        self.assertFalse(any("actions" in event.get("update", {}) for _, event in hub.events))
        service, hub, _ = self.service([tool_call("find_city", {"query": "Noida"}), tool_call("highlight_city", {"cityRef": "city:1", "style": {"color": "red"}}), {"content": "Noida red and Delhi blue ready."}, {"content": "Complete."}])
        terminal = hub.wait(service.start_run(hub.session, "Highlight Noida in red and Delhi in blue", {}))
        self.assertEqual(terminal["type"], "agent.failed")
