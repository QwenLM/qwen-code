package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Checks the Stage H task schemas with valid and invalid instances. The API
 * contract test validates only what the mapped task list and detail return,
 * so the invalid instances, the planned task events and the cancel operation
 * have no other gate. Every instance is written in the public shape and also
 * checked, renamed to camelCase, against the WebShell mirror, whose
 * conditionals are copied.
 */
class PlannedTaskContractTest {
    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION =
            "6f1c7d7e-3a4b-4c2d-9e8f-0123456789ab";
    private static final Map<String, String> MIRRORS = Map.of(
            "PublicTask", "WebShellTask",
            "PublicTaskList", "WebShellTaskPage",
            "PublicTaskEvent", "WebShellTaskEvent",
            "PublicTaskEventList", "WebShellTaskEventPage",
            "PublicCommandOperation", "WebShellCommandOperation",
            "PublicOperation", "WebShellOperation");

    private final List<String> failures = new ArrayList<>();

    @Test
    void taskViewKeepsItsStateInvariants() {
        accept("running", task("running", 2L, null, "cancel", "read_output"));
        accept("pending", task("pending", null, null, "cancel"));
        accept("waiting", task("waiting", 2L, null, "cancel"));
        accept("degraded", task("degraded", 2L, null, "read_output"));
        accept("completed", task("completed", 2L, 3L, "read_output"));
        accept("failed after start", task("failed", 2L, 3L));
        accept("cancelled before start", task("cancelled", null, 3L));
        accept("recovery_blocked may cancel",
                task("recovery_blocked", 2L, null, "cancel"));

        reject("terminal without settled_at", task("failed", 2L, null));
        reject("terminal still cancellable",
                task("completed", 2L, 3L, "cancel"));
        reject("terminal still takes input",
                task("cancelled", 2L, 3L, "send_input"));
        reject("running with settled_at", task("running", 2L, 3L));
        reject("recovery_blocked with settled_at",
                task("recovery_blocked", 2L, 3L));
        reject("recovery_blocked takes input",
                task("recovery_blocked", 2L, null, "send_input"));
        reject("running without started_at", task("running", null, null));
        reject("waiting without started_at", task("waiting", null, null));
        reject("degraded without started_at", task("degraded", null, null));
        reject("completed without started_at", task("completed", null, 3L));
        reject("pending with started_at", task("pending", 2L, null));
        reject("duplicate capability",
                task("running", 2L, null, "cancel", "cancel"));
        ObjectNode atBound = task("running", 2L, null);
        ArrayNode boundRefs = atBound.putArray("artifact_refs");
        for (int i = 0; i < 100; i++) {
            boundRefs.add("artifact-" + i);
        }
        accept("artifact_refs at the bound", atBound);
        ObjectNode overBound = task("running", 2L, null);
        ArrayNode refs = overBound.putArray("artifact_refs");
        for (int i = 0; i < 101; i++) {
            refs.add("artifact-" + i);
        }
        reject("artifact_refs over the bound", overBound);
        ObjectNode duplicated = task("running", 2L, null);
        ArrayNode dupes = duplicated.putArray("artifact_refs");
        dupes.add("artifact-1");
        dupes.add("artifact-1");
        reject("duplicate artifact_ref", duplicated);
        for (String field : List.of("runtime_binding_id", "generation", "pid",
                "path")) {
            ObjectNode leaked = task("running", 2L, null);
            leaked.put(field, "x");
            reject("leaks " + field, leaked);
        }
        ObjectNode untyped = task("running", 2L, null);
        untyped.remove("object");
        checkPublic("PublicTask", "missing object", untyped, false);
        assertThat(failures).isEmpty();
    }

    @Test
    void taskEventsKeepOneShapePerType() {
        check("PublicTaskEvent", "state_changed",
                event("state_changed").put("state", "running"), true);
        check("PublicTaskEvent", "output",
                event("output").put("text", "hello\n").put("truncated", false),
                true);
        check("PublicTaskEvent", "artifact",
                event("artifact").put("artifact_id", "artifact-1"), true);
        check("PublicTaskEvent", "a later event type",
                event("input_received"), true);
        check("PublicTaskEvent", "unknown field on a later type",
                event("input_received").put("future_field", "x"), false);
        check("PublicTaskEvent", "unknown field on a known type",
                event("output").put("text", "x")
                        .put("future_field", "x"), false);

        check("PublicTaskEvent", "state_changed without state",
                event("state_changed"), false);
        check("PublicTaskEvent", "artifact without artifact_id",
                event("artifact"), false);
        check("PublicTaskEvent", "output without text", event("output"),
                false);
        check("PublicTaskEvent", "empty output", event("output")
                .put("text", ""), false);
        for (String field : List.of("cursor", "schema_version",
                "projection_version")) {
            ObjectNode partial = event("output").put("text", "x");
            partial.remove(field);
            check("PublicTaskEvent", "event without " + field, partial, false);
        }
        pinEventFieldTotality();
        assertThat(failures).isEmpty();
    }

    @Test
    void listsAndPagesKeepTheirCursors() {
        ObjectNode tasks = JSON.createObjectNode().put("object", "list")
                .put("has_more", true);
        tasks.putArray("data").add(task("running", 2L, null));
        tasks.putNull("next_cursor");
        check("PublicTaskList", "more tasks without a cursor", tasks, false);
        tasks.put("next_cursor", "");
        check("PublicTaskList", "more tasks with an empty cursor", tasks,
                false);
        tasks.put("next_cursor", "cursor-1");
        check("PublicTaskList", "more tasks with a cursor", tasks, true);

        ObjectNode events = JSON.createObjectNode().put("object", "list")
                .put("has_more", false);
        events.putArray("data").add(event("output").put("text", "x"));
        events.putNull("next_cursor");
        check("PublicTaskEventList", "null event cursor", events, false);
        events.put("next_cursor", "cursor-1");
        check("PublicTaskEventList", "last page keeps its position", events,
                true);
        events.putArray("data");
        check("PublicTaskEventList", "empty page keeps its position", events,
                true);
        events.putNull("next_cursor");
        check("PublicTaskEventList", "empty page with null cursor", events,
                false);
        events.remove("next_cursor");
        check("PublicTaskEventList", "empty page without cursor", events,
                false);
        assertThat(failures).isEmpty();
    }

    @Test
    void taskCancelOutcomesDescribeTheCommand() {
        for (String schema : List.of("PublicCommandOperation",
                "PublicOperation")) {
            for (String status : List.of("pending", "running")) {
                check(schema, "task_cancel " + status,
                        operation("task_cancel").put("task_id", "task-1")
                                .put("status", status), true);
            }
            check(schema, "recovery_blocked task_cancel stops delivery",
                    settledCancel("recovery_blocked"), true);
            check(schema, "recovery_blocked task_cancel still pending",
                    settledCancel("recovery_blocked")
                            .put("delivery_state", "pending"), false);

            ObjectNode completed = operation("task_cancel")
                    .put("task_id", "task-1").put("status", "completed")
                    .put("admission_stage", "harness_confirmed")
                    .put("delivery_state", "confirmed")
                    .put("receipt_id", "receipt-1");
            check(schema, "recorded task_cancel", completed, true);
            completed.remove("receipt_id");
            check(schema, "completed task_cancel without receipt",
                    completed, false);
            check(schema, "completed task_cancel still java_durable",
                    operation("task_cancel").put("task_id", "task-1")
                            .put("status", "completed")
                            .put("delivery_state", "confirmed")
                            .put("receipt_id", "receipt-1"), false);
            check(schema, "completed task_cancel still unconfirmed",
                    operation("task_cancel").put("task_id", "task-1")
                            .put("status", "completed")
                            .put("admission_stage", "harness_confirmed")
                            .put("receipt_id", "receipt-1"), false);

            ObjectNode failed = settledCancel("failed")
                    .put("failure_code", "task_action_unavailable");
            check(schema, "definitively failed task_cancel", failed, true);
            check(schema, "failed task_cancel still pending",
                    failed.deepCopy().put("delivery_state", "pending"),
                    false);
            failed.remove("failure_code");
            check(schema, "failed task_cancel without reason", failed, false);
            check(schema, "task_cancel cannot itself be cancelled",
                    operation("task_cancel").put("task_id", "task-1")
                            .put("status", "cancelled"), false);
            check(schema, "another command keeps its status shape",
                    operation("submit_input").put("status", "cancelled"),
                    true);
            check(schema, "another command may fail without a code",
                    operation("submit_input").put("status", "failed"), true);
        }
        assertThat(failures).isEmpty();
    }

    @Test
    void taskCancelOperationCarriesItsTask() {
        check("PublicOperation", "task_cancel", operation("task_cancel")
                .put("task_id", "task-1"), true);
        check("PublicCommandOperation", "task_cancel without task_id",
                operation("task_cancel"), false);
        check("PublicCommandOperation", "close with task_id",
                operation("close").put("task_id", "task-1"), false);
        check("PublicCommandOperation", "close without task_id",
                operation("close"), true);

        ObjectNode resolved = operation("task_cancel").put("task_id", "task-1")
                .put("status", "completed").put("receipt_id", "receipt-1");
        resolved.putObject("action_resolution").put("action_id", "action-1")
                .put("outcome", "vote_recorded")
                .put("receipt_id", "receipt-2");
        check("PublicCommandOperation", "task_cancel with a resolution",
                resolved, false);
        resolved.put("type", "action_response").remove("task_id");
        check("PublicCommandOperation", "the same resolution on its own type",
                resolved, true);
        assertThat(failures).isEmpty();
    }

    @Test
    void plannedTaskRoutesDeclareTheTenantFilterForbidden() {
        // The API contract test checks this declaration in a Spring context;
        // this gate also checks it without starting one.
        for (String operationId : List.of("listSessionTaskEvents",
                "queryWebShellTaskEvents", "cancelSessionTask",
                "cancelWebShellTask")) {
            assertThat(CONTRACT.responsePointer(
                    CONTRACT.operation(operationId), 403))
                    .as("%s declares the tenant filter refusal", operationId)
                    .isEqualTo("/components/responses/Forbidden");
        }
    }

    @Test
    void webShellTaskRequestsRequireTheirKeys() {
        ObjectNode cancel = JSON.createObjectNode().put("sessionId", SESSION)
                .put("taskId", "task-1").put("idempotencyKey", "key-1");
        checkPublic("WebShellTaskCancelRequest", "cancel", cancel, true);
        cancel.remove("idempotencyKey");
        checkPublic("WebShellTaskCancelRequest", "cancel without a key",
                cancel, false);
        ObjectNode events = JSON.createObjectNode().put("sessionId", SESSION)
                .put("taskId", "task-1").put("after", "cursor-1")
                .put("limit", 100);
        checkPublic("WebShellTaskEventQueryRequest", "events", events, true);
        events.put("limit", 101);
        checkPublic("WebShellTaskEventQueryRequest", "events over the limit",
                events, false);
        assertThat(failures).isEmpty();
    }

    private static ObjectNode task(String state, Long startedAt,
            Long settledAt, String... capabilities) {
        ObjectNode task = JSON.createObjectNode().put("id", "task-1")
                .put("object", "agent.task").put("session_id", SESSION)
                .put("kind", "background_shell").put("state", state)
                .put("created_at", 1L);
        if (startedAt != null) {
            task.put("started_at", startedAt);
        }
        if (settledAt != null) {
            task.put("settled_at", settledAt);
        }
        task.putArray("artifact_refs");
        ArrayNode actions = task.putArray("action_capabilities");
        List.of(capabilities).forEach(actions::add);
        return task;
    }

    private static ObjectNode event(String type) {
        return JSON.createObjectNode().put("schema_version", 1)
                .put("projection_version", 1).put("task_id", "task-1")
                .put("session_id", SESSION).put("type", type)
                .put("cursor", "cursor-1").put("created_at", 1L);
    }

    private static ObjectNode operation(String type) {
        return JSON.createObjectNode().put("id", "operation-1")
                .put("session_id", SESSION).put("type", type)
                .put("status", "pending").put("admission_stage", "java_durable")
                .put("delivery_state", "pending").put("replayed", false);
    }

    /** A task_cancel that will not be delivered again: delivery is blocked. */
    private static ObjectNode settledCancel(String status) {
        return operation("task_cancel").put("task_id", "task-1")
                .put("status", status).put("delivery_state", "blocked");
    }

    private void accept(String label, ObjectNode task) {
        check("PublicTask", label, task, true);
    }

    private void reject(String label, ObjectNode task) {
        check("PublicTask", label, task, false);
    }

    /**
     * Every optional event property must be required or forbidden by each
     * known type's conditional, apart from the type's own optional
     * companions (design 4.3). The pins are validator probes on the minimal
     * valid event of each type, so they hold however a prohibition is
     * spelled, and a property added without conditional updates fails here
     * instead of silently widening every known type. The WebShell mirror must
     * carry the same property set and no other conditional's type, so the
     * guarantee holds on both surfaces.
     */
    private void pinEventFieldTotality() {
        Map<String, Set<String>> companions = Map.of("state_changed",
                Set.of("runtime_state"), "output", Set.of("truncated"),
                "artifact", Set.of());
        Map<String, ObjectNode> minimal = Map.of("state_changed",
                event("state_changed").put("state", "running"), "output",
                event("output").put("text", "x"), "artifact",
                event("artifact").put("artifact_id", "artifact-1"));
        Map<String, Object> values = Map.of("state", "running",
                "runtime_state", "ready", "text", "x", "truncated", false,
                "artifact_id", "artifact-1");
        JsonNode node = CONTRACT.node("/components/schemas/PublicTaskEvent");
        Set<String> required = new HashSet<>();
        node.path("required")
                .forEach(field -> required.add(field.asText()));
        List<String> optional = new ArrayList<>();
        for (Map.Entry<String, JsonNode> field
                : node.path("properties").properties()) {
            if (!required.contains(field.getKey())) {
                optional.add(field.getKey());
            }
        }
        for (JsonNode conditional : node.path("allOf")) {
            String type = conditional.path("if").path("properties")
                    .path("type").path("const").asText();
            if (!companions.containsKey(type)) {
                failures.add("PublicTaskEvent has an unlisted conditional for "
                        + type);
                continue;
            }
            ObjectNode base = minimal.get(type);
            for (String field : optional) {
                if (base.has(field)) {
                    continue;
                }
                if (!values.containsKey(field)) {
                    failures.add("PublicTaskEvent has no known valid value "
                            + "for " + field);
                    continue;
                }
                ObjectNode probe = base.deepCopy();
                probe.set(field, JSON.valueToTree(values.get(field)));
                check("PublicTaskEvent", type + " with " + field, probe,
                        companions.get(type).contains(field));
            }
        }
        JsonNode mirror =
                CONTRACT.node("/components/schemas/WebShellTaskEvent");
        Set<String> mirrored = new HashSet<>();
        mirror.path("properties").properties()
                .forEach(entry -> mirrored.add(entry.getKey()));
        Set<String> expected = new HashSet<>();
        node.path("properties").properties()
                .forEach(entry -> expected.add(camelCase(entry.getKey())));
        if (!mirrored.equals(expected)) {
            failures.add("WebShellTaskEvent properties " + mirrored
                    + " do not mirror PublicTaskEvent " + expected);
        }
        for (JsonNode conditional : mirror.path("allOf")) {
            String type = conditional.path("if").path("properties")
                    .path("type").path("const").asText();
            if (!companions.containsKey(type)) {
                failures.add("WebShellTaskEvent has an unlisted conditional "
                        + "for " + type);
            }
        }
    }

    /** Checks the public instance and its camelCase WebShell mirror. */
    private void check(String schema, String label, ObjectNode instance,
            boolean valid) {
        checkPublic(schema, label, instance, valid);
        String id = schema.contains("Operation") ? "operationId" : "taskId";
        checkPublic(MIRRORS.get(schema), label, webShell(instance, id), valid);
    }

    private void checkPublic(String schema, String label, JsonNode instance,
            boolean valid) {
        boolean actual = CONTRACT.validate("/components/schemas/" + schema,
                instance).isEmpty();
        if (actual != valid) {
            failures.add(schema + " " + label + ": expected "
                    + (valid ? "valid" : "invalid") + " " + instance);
        }
    }

    /**
     * Renames a public instance to the WebShell shape: camelCase names, the
     * resource ID under its WebShell name, and no {@code object}.
     */
    private static JsonNode webShell(JsonNode node, String id) {
        if (node.isArray()) {
            ArrayNode items = JSON.createArrayNode();
            node.forEach(item -> items.add(webShell(item, id)));
            return items;
        }
        if (!node.isObject()) {
            return node;
        }
        ObjectNode renamed = JSON.createObjectNode();
        node.properties().forEach(field -> {
            String name = field.getKey();
            if (!name.equals("object")) {
                renamed.set(name.equals("id") ? id : camelCase(name),
                        webShell(field.getValue(), id));
            }
        });
        return renamed;
    }

    private static String camelCase(String name) {
        StringBuilder out = new StringBuilder();
        boolean upper = false;
        for (char c : name.toCharArray()) {
            if (c == '_') {
                upper = true;
            } else {
                out.append(upper ? Character.toUpperCase(c) : c);
                upper = false;
            }
        }
        return out.toString();
    }
}
