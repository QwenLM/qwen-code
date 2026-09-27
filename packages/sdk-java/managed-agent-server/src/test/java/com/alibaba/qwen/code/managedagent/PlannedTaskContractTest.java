package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Checks the planned Stage H task schemas with valid and invalid instances.
 * The API contract test validates only operations that are not planned, so
 * these invariants have no other gate until H0c maps the task routes.
 */
class PlannedTaskContractTest {
    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION =
            "6f1c7d7e-3a4b-4c2d-9e8f-0123456789ab";

    private final List<String> failures = new ArrayList<>();

    @Test
    void taskViewKeepsItsStateInvariants() {
        accept("running", task("running", 2L, null, "cancel", "read_output"));
        accept("pending", task("pending", null, null, "cancel"));
        accept("completed", task("completed", 2L, 3L, "read_output"));
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
        reject("missing object", untyped);

        ObjectNode webShell = JSON.createObjectNode().put("taskId", "task-1")
                .put("sessionId", SESSION).put("kind", "monitor")
                .put("state", "completed").put("createdAt", 1L)
                .put("startedAt", 2L).put("settledAt", 3L);
        webShell.putArray("artifactRefs");
        ArrayNode actions = webShell.putArray("actionCapabilities");
        actions.add("read_output");
        check("WebShellTask", "WebShell completed", webShell, true);
        actions.add("cancel");
        check("WebShellTask", "WebShell terminal still cancellable",
                webShell, false);
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
        ObjectNode uncursored = event("output").put("text", "x");
        uncursored.remove("cursor");
        check("PublicTaskEvent", "event without cursor", uncursored, false);
        assertThat(failures).isEmpty();
    }

    @Test
    void listsAndPagesKeepTheirCursors() {
        ObjectNode tasks = JSON.createObjectNode().put("object", "list")
                .put("has_more", true);
        tasks.putArray("data");
        tasks.putNull("next_cursor");
        check("PublicTaskList", "more tasks without a cursor", tasks, false);
        tasks.put("next_cursor", "cursor-1");
        check("PublicTaskList", "more tasks with a cursor", tasks, true);

        ObjectNode page = JSON.createObjectNode().put("hasMore", true);
        page.putArray("data");
        check("WebShellTaskPage", "WebShell page without a cursor", page,
                false);

        ObjectNode events = JSON.createObjectNode().put("object", "list")
                .put("has_more", false);
        events.putArray("data");
        events.putNull("next_cursor");
        check("PublicTaskEventList", "null event cursor", events, false);
        events.put("next_cursor", "cursor-0");
        check("PublicTaskEventList", "empty page keeps its position", events,
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

        ObjectNode webShell = JSON.createObjectNode()
                .put("operationId", "operation-1").put("sessionId", SESSION)
                .put("type", "task_cancel").put("status", "pending")
                .put("admissionStage", "java_durable")
                .put("deliveryState", "pending").put("replayed", false);
        check("WebShellCommandOperation", "WebShell task_cancel without taskId",
                webShell, false);
        webShell.put("taskId", "task-1");
        check("WebShellOperation", "WebShell task_cancel", webShell, true);
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
        return JSON.createObjectNode().put("task_id", "task-1")
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

    private void check(String schema, String label, ObjectNode instance,
            boolean valid) {
        boolean actual = CONTRACT.validate("/components/schemas/" + schema,
                instance).isEmpty();
        if (actual != valid) {
            failures.add(schema + " " + label + ": expected "
                    + (valid ? "valid" : "invalid") + " " + instance);
        }
    }
}
