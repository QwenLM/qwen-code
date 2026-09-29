package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
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

        check("PublicTaskEvent", "state_changed without state",
                event("state_changed"), false);
        check("PublicTaskEvent", "artifact without artifact_id",
                event("artifact"), false);
        check("PublicTaskEvent", "state_changed with text",
                event("state_changed").put("state", "running")
                        .put("text", "x"), false);
        check("PublicTaskEvent", "output without text", event("output"),
                false);
        check("PublicTaskEvent", "empty output", event("output")
                .put("text", ""), false);
        check("PublicTaskEvent", "output with state", event("output")
                .put("text", "x").put("state", "running"), false);
        check("PublicTaskEvent", "artifact with truncated", event("artifact")
                .put("artifact_id", "artifact-1").put("truncated", true),
                false);
        for (String field : List.of("cursor", "schema_version",
                "projection_version")) {
            ObjectNode partial = event("output").put("text", "x");
            partial.remove(field);
            check("PublicTaskEvent", "event without " + field, partial, false);
        }
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
        // The API contract test probes the 403 only on mapped routes.
        for (String operationId : List.of("listSessionTaskEvents",
                "queryWebShellTaskEvents", "cancelSessionTask",
                "cancelWebShellTask")) {
            assertThat(CONTRACT.responsePointer(
                    CONTRACT.operation(operationId), 403))
                    .as("%s declares 403", operationId).isNotNull();
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

    private void accept(String label, ObjectNode task) {
        check("PublicTask", label, task, true);
    }

    private void reject(String label, ObjectNode task) {
        check("PublicTask", label, task, false);
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
