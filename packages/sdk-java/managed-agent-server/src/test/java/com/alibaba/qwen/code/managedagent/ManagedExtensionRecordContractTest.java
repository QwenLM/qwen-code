package com.alibaba.qwen.code.managedagent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion.VersionFlag;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/**
 * Replays the language-neutral managed-extension-record/1 fixtures (H0b)
 * that the TypeScript module replays too. The fixtures were generated and
 * labelled by an implementation independent of both languages.
 */
class ManagedExtensionRecordContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CONTRACT_DIR = findContractDirectory();
    private static final JsonSchemaFactory SCHEMAS =
            JsonSchemaFactory.getInstance(VersionFlag.V202012);

    @Test
    void validatesTheFixturesAgainstTheSchema() throws IOException {
        JsonNode schema = read("managed-extension-record-v1.schema.json");

        assertEquals(Set.of(), SCHEMAS.getSchema(schema).validate(fixtures()));
        // A case the validator accepts must satisfy the schema as well.
        List<String> wrong = new ArrayList<>();
        for (Map.Entry<String, String[]> list : Map.of(
                "grantCases", new String[] {"grant", "operationGrant"},
                "pinCases", new String[] {"pin", "definitionPin"},
                "runCases", new String[] {"run", "extensionRun"},
                "monitorRunCases", new String[] {"monitorRun", "monitorRun"})
                .entrySet()) {
            JsonSchema definition = definition(schema, list.getValue()[1]);
            for (JsonNode fixture : fixtures().required(list.getKey())) {
                if (fixture.required("valid").booleanValue()
                        && !definition.validate(fixture.required(
                                list.getValue()[0])).isEmpty()) {
                    wrong.add(list.getKey() + "/" + id(fixture));
                }
            }
        }
        assertEquals(List.of(), wrong);
    }

    @Test
    void pinsTheDomainsLimitsKindsStateLinesAndReasons() throws IOException {
        JsonNode fixtures = fixtures();
        ObjectNode limits = JSON.createObjectNode()
                .put("maxIdBytes", ManagedExtensionRecords.MAX_ID_BYTES)
                .put("minLeaseDurationMs", Math.toIntExact(
                        ManagedSessionStoreModels.MIN_LEASE_MILLIS))
                .put("maxLeaseDurationMs", Math.toIntExact(
                        ManagedSessionStoreModels.MAX_LEASE_MILLIS))
                .put("maxGrantPhases", ManagedExtensionRecords.MAX_GRANT_PHASES)
                .put("maxPhaseLength", ManagedExtensionRecords.MAX_PHASE_LENGTH)
                .put("maxMonitorEvents",
                        ManagedExtensionRecords.MAX_MONITOR_EVENTS)
                .put("maxMonitorIdleTimeoutMs",
                        ManagedExtensionRecords.MAX_MONITOR_IDLE_TIMEOUT_MS)
                .put("maxMonitorDebounceMs",
                        ManagedExtensionRecords.MAX_MONITOR_DEBOUNCE_MS);
        ObjectNode kinds = JSON.createObjectNode()
                .put("monitorRun", ManagedExtensionRecords.MONITOR_RUN_KIND)
                .put("monitorOutput",
                        ManagedExtensionRecords.MONITOR_OUTPUT_KIND);
        ObjectNode lines = JSON.createObjectNode();
        for (Map.Entry<String, List<String>> line : Map.of(
                "run", ManagedExtensionRecords.RUN_STATES,
                "execution", ManagedExtensionRecords.EXECUTION_STATES,
                "delivery", ManagedExtensionRecords.DELIVERY_STATES)
                .entrySet()) {
            lines.putObject(line.getKey())
                    .<ObjectNode>set("states", JSON.valueToTree(
                            line.getValue()))
                    .set("transitions", JSON.valueToTree(
                            ManagedExtensionRecords.TRANSITIONS.get(
                                    line.getKey())));
        }

        // Whole JSON nodes, so 1.0 or a reordered list cannot pass.
        assertEquals(JSON.readTree("1"), fixtures.required("contractVersion"));
        assertEquals(JSON.valueToTree(ManagedExtensionRecords.DOMAINS),
                fixtures.required("domains"));
        assertEquals(limits, fixtures.required("limits"));
        assertEquals(kinds, fixtures.required("kinds"));
        assertEquals(lines, fixtures.required("stateLines"));
        assertEquals(JSON.valueToTree(
                ManagedExtensionRecords.DELIVERY_TARGETS),
                fixtures.required("deliveryTargets"));
        assertEquals(JSON.createObjectNode()
                .<ObjectNode>set("recovery", JSON.valueToTree(
                        ManagedExtensionRecords.RECOVERY_REASONS))
                .set("quota", JSON.valueToTree(
                        ManagedExtensionRecords.QUOTA_REASONS)),
                fixtures.required("reasons"));
        assertEquals(JSON.valueToTree(
                ManagedExtensionRecords.MONITOR_STOP_REASONS),
                fixtures.required("monitorStopReasons"));
    }

    @Test
    void allowsExactlyTheListedStepBetweenEveryPairOfStates()
            throws IOException {
        List<String> wrong = new ArrayList<>();
        int pairs = 0;
        for (Map.Entry<String, JsonNode> line
                : fixtures().required("stateLines").properties()) {
            JsonNode transitions = line.getValue().required("transitions");
            for (JsonNode from : line.getValue().required("states")) {
                for (JsonNode to : line.getValue().required("states")) {
                    boolean listed = false;
                    for (JsonNode allowed : transitions.required(
                            from.textValue())) {
                        listed |= allowed.equals(to);
                    }
                    if (ManagedExtensionRecords.isTransitionAllowed(
                            line.getKey(), from.textValue(), to.textValue())
                            != listed) {
                        wrong.add(line.getKey() + ": " + from + " -> " + to);
                    }
                    pairs++;
                }
            }
        }
        assertEquals(List.of(), wrong);
        assertEquals(8 * 8 + 7 * 7 + 10 * 10, pairs);
        assertFalse(ManagedExtensionRecords.isTransitionAllowed(null,
                "reserved", "admitted"));
        assertFalse(ManagedExtensionRecords.isTransitionAllowed("run",
                null, "admitted"));
        assertFalse(ManagedExtensionRecords.isTransitionAllowed("run",
                "reserved", null));
        assertFalse(ManagedExtensionRecords.isTransitionAllowed("task",
                "reserved", "admitted"));
    }

    @Test
    void replaysEveryRecordCase() throws IOException {
        List<String> wrong = new ArrayList<>();
        wrong.addAll(replay("grantCases", "grant",
                ManagedExtensionRecords::requireOperationGrant));
        wrong.addAll(replay("pinCases", "pin",
                ManagedExtensionRecords::requireDefinitionPin));
        wrong.addAll(replay("runCases", "run",
                ManagedExtensionRecords::requireRun));
        wrong.addAll(replay("monitorRunCases", "monitorRun",
                ManagedExtensionRecords::requireMonitorRun));

        assertEquals(List.of(), wrong);
    }

    @Test
    void replaysEveryPairCase() throws IOException {
        List<String> wrong = new ArrayList<>();
        wrong.addAll(replayPairs("grantSuccessorCases", "previous", "next",
                ManagedExtensionRecords::isOperationGrantSuccessor));
        wrong.addAll(replayPairs("pinConsistencyCases", "first", "second",
                ManagedExtensionRecords::isDefinitionPinConsistent));
        wrong.addAll(replayPairs("pinConsistencyCases", "second", "first",
                ManagedExtensionRecords::isDefinitionPinConsistent));
        wrong.addAll(replayPairs("runSuccessorCases", "previous", "next",
                ManagedExtensionRecords::isRunSuccessor));
        wrong.addAll(replayPairs("monitorRunSuccessorCases", "previous",
                "next", ManagedExtensionRecords::isMonitorRunSuccessor));

        assertEquals(List.of(), wrong);
    }

    @Test
    void comparesNumbersByValueInRecordsBuiltInJava() throws IOException {
        JsonNode grant = fixtures().required("grant");
        ObjectNode renewal = grant.deepCopy();
        renewal.put("operationRevision", 1L)
                .put("leaseDurationMs", 60_000L)
                .put("expiresAt", grant.required("expiresAt").longValue() + 1);
        JsonNode monitor = fixtures().required("monitorRun");
        ObjectNode sameMonitor = monitor.deepCopy();
        sameMonitor.put("maxEvents", 1000L).put("observationSequence", 3L);

        assertTrue(ManagedExtensionRecords.isOperationGrantSuccessor(grant,
                renewal));
        assertTrue(ManagedExtensionRecords.isMonitorRunSuccessor(monitor,
                sameMonitor));
    }

    @Test
    void usesEachCaseIdOnceInEachList() throws IOException {
        int lists = 0;
        for (Map.Entry<String, JsonNode> field
                : fixtures().properties()) {
            if (!field.getKey().endsWith("Cases")) {
                continue;
            }
            Set<String> ids = new HashSet<>();
            for (JsonNode fixture : field.getValue()) {
                assertTrue(ids.add(id(fixture)), () -> "duplicate "
                        + field.getKey() + " id: " + id(fixture));
            }
            lists++;
        }
        assertEquals(8, lists);
    }

    private static List<String> replay(String list, String field,
            Consumer<JsonNode> check) throws IOException {
        List<String> wrong = new ArrayList<>();
        for (JsonNode fixture : fixtures().required(list)) {
            boolean accepted;
            try {
                check.accept(fixture.required(field));
                accepted = true;
            } catch (InvalidRecordException refused) {
                accepted = false;
            }
            if (accepted != fixture.required("valid").booleanValue()) {
                wrong.add(list + "/" + id(fixture));
            }
        }
        return wrong;
    }

    private static List<String> replayPairs(String list, String first,
            String second, BiPredicate<JsonNode, JsonNode> check)
            throws IOException {
        List<String> wrong = new ArrayList<>();
        for (JsonNode fixture : fixtures().required(list)) {
            if (check.test(fixture.required(first), fixture.required(second))
                    != fixture.required("valid").booleanValue()) {
                wrong.add(list + "/" + id(fixture));
            }
        }
        return wrong;
    }

    private static JsonSchema definition(JsonNode schema, String name) {
        ObjectNode wrapper = JSON.createObjectNode()
                .put("$schema", schema.required("$schema").textValue())
                .put("$ref", "#/$defs/" + name);
        wrapper.set("$defs", schema.required("$defs"));
        return SCHEMAS.getSchema(wrapper);
    }

    private static String id(JsonNode fixture) {
        return fixture.required("id").textValue();
    }

    private static JsonNode fixtures() throws IOException {
        return read("managed-extension-record-v1.fixtures.json");
    }

    private static JsonNode read(String name) throws IOException {
        Path path = CONTRACT_DIR.resolve(name);
        assertTrue(Files.isRegularFile(path),
                () -> "missing shared contract: " + path);
        return JSON.readTree(path.toFile());
    }

    private static Path findContractDirectory() {
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
