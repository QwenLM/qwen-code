package com.alibaba.qwen.code.managedagent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.TaskProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;

/**
 * Replays the language-neutral managed-extension-projection/1 fixtures (H0c)
 * that the TypeScript module replays too, labelled by an implementation
 * independent of both languages. ManagedExtensionRecordStoreTest commits
 * their monitor chains through the Session store.
 */
class ManagedExtensionProjectionContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void pinsTheBodiesStatesAndOutbox() throws IOException {
        JsonNode fixtures = fixtures();
        assertEquals(1, fixtures.required("contractVersion").intValue());
        Map<String, String> bodies = new TreeMap<>();
        ManagedExtensionProjection.RECORD_BODIES.forEach(
                (domain, body) -> bodies.put(domain, body.taskKind()));
        assertEquals(JSON.convertValue(fixtures.required("recordBodies"),
                TreeMap.class), bodies);
        assertEquals(JSON.convertValue(fixtures.required("taskStates"),
                List.class), ManagedExtensionProjection.TASK_STATES);
        List<String> runtimeStates = new ArrayList<>(
                ManagedExtensionProjection.RUNTIME_STATES);
        runtimeStates.sort(null);
        assertEquals(JSON.convertValue(fixtures.required("runtimeStates"),
                List.class), runtimeStates);
        List<String> taskKinds = new ArrayList<>(
                ManagedExtensionProjection.TASK_KINDS);
        taskKinds.sort(null);
        assertEquals(JSON.convertValue(fixtures.required("taskKinds"),
                List.class), taskKinds);
        Set<String> pending = new TreeSet<>();
        ManagedExtensionRecords.DELIVERY_TARGETS.forEach((target, states) -> {
            for (String state : states) {
                JsonNode run = JSON.createObjectNode().put("state", "settled")
                        .putNull("reason").putNull("definition")
                        .putNull("executionCallId").putNull("effectId")
                        .putNull("dispatchId")
                        .put("deliveryId", "channel".equals(target)
                                ? "delivery-1" : null)
                        .putNull("execution").putNull("runtime")
                        .set("delivery", JSON.createObjectNode()
                                .put("target", target).put("state", state));
                ManagedExtensionRecords.requireRun(run);
                if (ManagedExtensionProjection.isDeliveryPending(run)) {
                    pending.add(state);
                }
            }
        });
        assertEquals(JSON.convertValue(fixtures.required(
                "pendingDeliveryStates"), List.class), List.copyOf(pending));
    }

    @Test
    void derivesTaskIds() throws IOException {
        for (JsonNode fixture : fixtures().required("taskIdCases")) {
            String key = ManagedExtensionProjection.recordKey(
                    text(fixture, "sessionId"), text(fixture, "domain"),
                    text(fixture, "recordId"));
            assertEquals(text(fixture, "recordKey"), key, id(fixture));
            assertEquals(text(fixture, "taskId"),
                    ManagedExtensionProjection.taskId(key), id(fixture));
        }
    }

    @Test
    void judgesStarts() throws IOException {
        List<String> wrong = new ArrayList<>();
        for (JsonNode fixture : fixtures().required("runStartCases")) {
            if (ManagedExtensionRecords.isRunStart(fixture.required("run"))
                    != fixture.required("valid").booleanValue()) {
                wrong.add("runStartCases/" + id(fixture));
            }
        }
        for (JsonNode fixture : fixtures().required("monitorRunStartCases")) {
            JsonNode monitor = fixture.required("monitorRun");
            boolean valid = fixture.required("valid").booleanValue();
            if (ManagedExtensionRecords.isMonitorRunStart(monitor) != valid
                    || ManagedExtensionProjection.RECORD_BODIES
                            .get("monitor_run").isStart().test(monitor)
                            != valid) {
                wrong.add("monitorRunStartCases/" + id(fixture));
            }
        }
        assertEquals(List.of(), wrong);
    }

    @Test
    void projectsSingleRevisions() throws IOException {
        for (JsonNode fixture : fixtures().required("viewCases")) {
            JsonNode run = fixture.required("run");
            ManagedExtensionRecords.requireRun(run);
            assertEquals(view(fixture.required("view")),
                    ManagedExtensionProjection.project(null, run,
                            fixture.required("occurredAt").longValue()),
                    id(fixture));
            assertEquals(fixture.required("deliveryPending").booleanValue(),
                    ManagedExtensionProjection.isDeliveryPending(run),
                    id(fixture));
        }
    }

    @Test
    void settlesEveryRunStateWhoseLineEnds() throws IOException {
        // The projection's terminal set is the run line's own: a state with
        // no successors must stamp settledAt and no runtime state. The
        // execution proven to have ended carries the state, so only the
        // terminality of the line itself can force the runtime out —
        // without it the assertion short-circuits on execution == null.
        ManagedExtensionRecords.TRANSITIONS.get("run").forEach((state,
                successors) -> {
            if (!successors.isEmpty()) {
                return;
            }
            JsonNode run = JSON.createObjectNode().put("state", state)
                    .putNull("reason").putNull("definition")
                    .put("executionCallId", "call-1").putNull("effectId")
                    .putNull("dispatchId").putNull("deliveryId")
                    .put("execution", "settled").putNull("runtime")
                    .putNull("delivery");
            ManagedExtensionRecords.requireRun(run);
            TaskProjection view = ManagedExtensionProjection.project(null,
                    run, 1_000);
            assertTrue(view.settledAt() != null, state);
            assertTrue(view.runtimeState() == null, state);
        });
    }

    @Test
    void projectsHistories() throws IOException {
        for (JsonNode fixture : fixtures().required("historyCases")) {
            TaskProjection previous = null;
            JsonNode previousRun = null;
            for (JsonNode revision : fixture.required("revisions")) {
                JsonNode run = revision.required("run");
                assertTrue(previousRun == null
                        ? ManagedExtensionRecords.isRunStart(run)
                        : ManagedExtensionRecords.isRunSuccessor(previousRun,
                                run), id(fixture));
                previous = ManagedExtensionProjection.project(previous, run,
                        revision.required("occurredAt").longValue());
                assertEquals(view(revision.required("view")), previous,
                        id(fixture));
                assertEquals(revision.required("deliveryPending")
                        .booleanValue(),
                        ManagedExtensionProjection.isDeliveryPending(run),
                        id(fixture));
                previousRun = run;
            }
        }
    }

    @Test
    void readsBrokerExecutions() throws IOException {
        for (JsonNode fixture : fixtures().required("brokerExecutionCases")) {
            JsonNode status = fixture.required("executionStatus");
            assertEquals(text(fixture, "execution"),
                    ManagedExtensionProjection.executionOf(
                            ToolExecutionRecord.State.valueOf(
                                    text(fixture, "state")),
                            status.isNull() ? null : status.textValue()),
                    id(fixture));
        }
        Set<String> covered = new HashSet<>();
        fixtures().required("brokerExecutionCases").forEach(
                fixture -> covered.add(text(fixture, "state")));
        for (ToolExecutionRecord.State state
                : ToolExecutionRecord.State.values()) {
            assertTrue(covered.contains(state.name()), state.name());
        }
    }

    @Test
    void usesEachCaseIdOnceInEachList() throws IOException {
        // The name set pins the lists the fixture must carry: no replayed
        // list may vanish, go empty or arrive unannounced.
        List<String> names = new ArrayList<>();
        for (Map.Entry<String, JsonNode> field : fixtures().properties()) {
            if (!field.getKey().endsWith("Cases")) {
                continue;
            }
            names.add(field.getKey());
            assertTrue(field.getValue().size() > 0,
                    () -> field.getKey() + " replays an empty list");
            Set<String> ids = new HashSet<>();
            for (JsonNode fixture : field.getValue()) {
                assertTrue(ids.add(id(fixture)), () -> "duplicate "
                        + field.getKey() + " id: " + id(fixture));
            }
        }
        names.sort(null);
        assertEquals(List.of("brokerExecutionCases", "historyCases",
                "monitorChainCases", "monitorChainRejectCases",
                "monitorRunStartCases", "runStartCases", "taskIdCases",
                "viewCases"), names);
    }

    /** The six components the projection record carries, sorted. */
    static final List<String> PROJECTION_FIELDS = List.of("createdAt",
            "definitionRevision", "runtimeState", "settledAt", "startedAt",
            "state");

    static TaskProjection view(JsonNode view) {
        List<String> keys = new ArrayList<>();
        view.fieldNames().forEachRemaining(keys::add);
        keys.sort(null);
        // The same six components the record carries, so a seventh fixture
        // field cannot pass unread.
        assertEquals(PROJECTION_FIELDS, keys);
        return new TaskProjection(text(view, "state"),
                text(view, "runtimeState"),
                view.required("definitionRevision").isNull() ? null
                        : view.required("definitionRevision").longValue(),
                view.required("createdAt").longValue(),
                view.required("startedAt").isNull() ? null
                        : view.required("startedAt").longValue(),
                view.required("settledAt").isNull() ? null
                        : view.required("settledAt").longValue());
    }

    static JsonNode fixtures() throws IOException {
        return contract("managed-extension-projection-v1.fixtures.json");
    }

    /** A file of the shared managed-runtime contracts. */
    static JsonNode contract(String name) throws IOException {
        Path path = contractDirectory().resolve(name);
        assertTrue(Files.isRegularFile(path),
                () -> "missing shared contract: " + path);
        return JSON.readTree(path.toFile());
    }

    private static String text(JsonNode node, String field) {
        return node.required(field).textValue();
    }

    private static String id(JsonNode fixture) {
        return text(fixture, "id");
    }

    private static Path contractDirectory() {
        Path current = Path.of(System.getProperty("user.dir"))
                .toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++) {
            Path candidate = current.resolve(Path.of("packages", "core",
                    "src", "managed-runtime", "contracts"));
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            current = current.getParent();
        }
        throw new AssertionError(
                "cannot locate the shared managed-runtime contracts");
    }
}
