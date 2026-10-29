package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.io.CleanupMode;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedSessionHistoryScaleGate {
    private static final long HEAP_GROWTH_BYTES = 32L * 1024 * 1024;
    private static final Map<Integer, ObjectNode> RESULTS = new HashMap<>();

    @ParameterizedTest
    @ValueSource(ints = {10000, 100000})
    void completedHistoryKeepsLiveAndRecoveredMemoryBounded(int eventCount, @TempDir(cleanup = CleanupMode.ON_SUCCESS) Path directory) throws Exception {
        String engine = System.getProperty("qwen.managed.history.engine");
        assertThat(engine).as("qwen.managed.history.engine is required").isIn("h2", "mysql");
        assertThat(RESULTS).as("JVM samples run from the smaller history to the larger history")
                .hasSize(eventCount == 10000 ? 0 : 1);
        if (eventCount == 100000) {
            assertThat(RESULTS).containsKey(10000);
        }
        ObjectNode evidence;
        if (engine.equals("mysql")) {
            try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
                evidence = ManagedSessionHistoryHttpFixture.run(directory, database.url(), System.getProperty("mysql.user"),
                        System.getProperty("mysql.password", ""), "com.mysql.cj.jdbc.Driver", eventCount, engine);
            }
        } else {
            Files.createDirectories(directory.resolve("database"));
            String url = "jdbc:h2:file:" + directory.resolve("database/managed").toAbsolutePath()
                    + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_ON_EXIT=FALSE;WRITE_DELAY=0;CACHE_SIZE=8192";
            evidence = ManagedSessionHistoryHttpFixture.run(directory, url, "sa", "", "org.h2.Driver", eventCount, engine);
        }
        assertThat(evidence.path("engine").isTextual()).isTrue();
        assertThat(evidence.path("engine").textValue()).isEqualTo(engine);
        assertThat(evidence.path("revision").isTextual()).isTrue();
        assertThat(evidence.path("revision").textValue()).matches("[a-f0-9]{40}|[a-f0-9]{64}|working-tree-uncommitted");
        for (String field : new String[]{"coreAuthoritySha256", "workerSha256"}) {
            assertThat(evidence.path(field).isTextual()).isTrue();
            assertThat(evidence.path(field).textValue()).matches("[a-f0-9]{64}");
        }
        assertThat(number(evidence, "eventCount")).isEqualTo(eventCount);
        assertThat(number(evidence, "activeItems")).isZero();
        assertThat(number(evidence, "contextMessages")).isZero();
        assertThat(number(evidence, "peakHeapUsedBytes")).isPositive();
        assertThat(number(evidence, "peakRssBytes")).isPositive();
        assertThat(number(evidence, "peakExternalBytes")).isPositive();
        assertThat(number(evidence, "peakArrayBuffersBytes")).isNotNegative();
        for (String phase : new String[]{"live", "cold", "closed"}) {
            JsonNode sample = evidence.path("phases").path(phase);
            assertThat(sample.isObject()).as("Node phase %s is present", phase).isTrue();
            assertThat(number(sample, "heapUsedBytes")).isPositive().isLessThan(256L * 1024 * 1024);
            assertThat(number(sample, "rssBytes")).isPositive();
            assertThat(number(sample, "externalBytes")).isNotNegative();
            assertThat(number(sample, "arrayBuffersBytes")).isNotNegative();
            assertThat(number(sample, "maximumRssKiB")).isPositive();
            if (!phase.equals("closed")) {
                JsonNode state = sample.path("state");
                assertThat(number(state, "pendingInputs")).isZero();
                assertThat(number(state, "modelContextRecords")).isZero();
                assertThat(number(state, "contextRecords")).isZero();
                for (String flag : new String[]{"activationActive", "maintenanceActive"}) {
                    assertThat(state.path(flag).isBoolean()).isTrue();
                    assertThat(state.path(flag).booleanValue()).isFalse();
                }
                JsonNode residency = sample.path("residency");
                assertThat(number(sample, "committedSequence")).isEqualTo(eventCount);
                assertThat(number(residency, "events")).isEqualTo(1024);
                assertThat(number(residency, "eventBytes")).isPositive().isLessThanOrEqualTo(8L * 1024 * 1024);
                assertThat(number(residency, "cacheEntries")).isBetween(0L, 2048L);
                assertThat(number(residency, "cacheBytes")).isBetween(0L, 4L * 1024 * 1024);
            }
        }
        JsonNode scan = evidence.path("scan");
        assertThat(number(scan, "calls")).isGreaterThanOrEqualTo(2);
        assertThat(number(scan, "batches")).isGreaterThan(1);
        assertThat(number(scan, "activeConsumers")).isZero();
        assertThat(number(scan, "peakConsumers")).isEqualTo(1);
        assertThat(number(scan, "peakSourceBytes")).isPositive().isLessThanOrEqualTo(8L * 1024 * 1024);
        assertThat(number(scan, "peakEvents")).isBetween(1L, 256L);
        assertThat(number(scan, "peakTransactions")).isEqualTo(1);
        assertThat(number(scan, "legacyReadCalls")).isZero();
        assertThat(evidence.path("close").path("first").isBoolean()).isTrue();
        assertThat(evidence.path("close").path("second").isBoolean()).isTrue();
        assertThat(evidence.path("close").path("first").booleanValue()).isTrue();
        assertThat(evidence.path("close").path("second").booleanValue()).isTrue();
        JsonNode jvm = evidence.path("jvm");
        assertThat(number(jvm, "heapUsedBytes")).isPositive();
        assertThat(number(jvm, "heapMaxBytes")).isPositive().isLessThanOrEqualTo(512L * 1024 * 1024);
        assertThat(number(jvm, "nioMaxCachedBufferSize")).isEqualTo(1024 * 1024);
        assertThat(number(jvm.path("bufferPools").path("direct"), "memoryUsedBytes")).isNotNegative();
        assertThat(number(jvm, "collectionsAfter")).isGreaterThan(number(jvm, "collectionsBefore"));
        assertThat(jvm.path("pools").isObject()).isTrue();
        assertThat(jvm.path("pools").isEmpty()).isFalse();
        jvm.path("pools").elements().forEachRemaining(pool -> {
            assertThat(number(pool, "usedBytes")).isNotNegative();
            assertThat(number(pool, "peakUsedBytes")).isNotNegative();
        });
        RESULTS.put(eventCount, evidence);
    }

    private static long number(JsonNode object, String field) {
        JsonNode value = object.path(field);
        assertThat(value.isIntegralNumber() && value.canConvertToLong()).as("Metric %s is present and integral", field).isTrue();
        return value.longValue();
    }

    @AfterAll
    static void compareBothCompletedScales() throws Exception {
        ObjectMapper json = new ObjectMapper();
        ObjectNode comparison = json.createObjectNode().put("engine", System.getProperty("qwen.managed.history.engine", "missing"))
                .put("retainedGrowthBudgetBytes", HEAP_GROWTH_BYTES)
                .put("jvmIsolation", "Shared sequential JVM; peak pool deltas are reported, retained GC heap and direct buffers are asserted.")
                .put("status", "collecting")
                .put("rssQualification", "RSS and pool peaks are recorded; scan callback boundaries and retained heap/buffers are asserted, not all network buffers.");
        Path report = Path.of("target/managed-history-scale/comparison.json");
        Files.createDirectories(report.getParent());
        comparison.set("completedEventCounts", json.valueToTree(RESULTS.keySet()));
        json.writerWithDefaultPrettyPrinter().writeValue(report.toFile(), comparison);
        assertThat(RESULTS.keySet()).as("Both isolated Node scales must complete").containsExactlyInAnyOrder(10000, 100000);
        JsonNode small = RESULTS.get(10000);
        JsonNode large = RESULTS.get(100000);
        comparison.put("engine", large.path("engine").textValue());
        comparison.put("status", "compared");
        for (String field : new String[]{"revision", "coreAuthoritySha256", "workerSha256"}) {
            assertThat(small.path(field).textValue()).as("Both scales use the same %s", field).isEqualTo(large.path(field).textValue());
            comparison.put(field, large.path(field).textValue());
        }
        ObjectNode phases = comparison.putObject("nodeRetainedHeapDeltas");
        for (String phase : new String[]{"live", "cold", "closed"}) {
            long delta = number(large.path("phases").path(phase), "heapUsedBytes")
                    - number(small.path("phases").path(phase), "heapUsedBytes");
            phases.put(phase, delta);
        }
        ObjectNode external = comparison.putObject("nodeRetainedBufferDeltas");
        for (String phase : new String[]{"live", "cold", "closed"}) {
            ObjectNode delta = external.putObject(phase);
            for (String field : new String[]{"externalBytes", "arrayBuffersBytes"}) {
                delta.put(field, number(large.path("phases").path(phase), field)
                        - number(small.path("phases").path(phase), field));
            }
        }
        long jvmDelta = number(large.path("jvm"), "heapUsedBytes") - number(small.path("jvm"), "heapUsedBytes");
        comparison.put("jvmRetainedHeapDeltaBytes", jvmDelta);
        long directDelta = number(large.path("jvm").path("bufferPools").path("direct"), "memoryUsedBytes")
                - number(small.path("jvm").path("bufferPools").path("direct"), "memoryUsedBytes");
        comparison.put("jvmRetainedDirectBufferDeltaBytes", directDelta);
        ObjectNode pools = comparison.putObject("jvmPoolPeakDeltas");
        large.path("jvm").path("pools").fields().forEachRemaining(entry -> pools.put(entry.getKey(),
                number(entry.getValue(), "peakUsedBytes")
                        - number(small.path("jvm").path("pools").path(entry.getKey()), "peakUsedBytes")));
        json.writerWithDefaultPrettyPrinter().writeValue(report.toFile(), comparison);
        System.out.println("PR5_MANAGED_HISTORY_COMPARISON " + json.writeValueAsString(comparison));
        for (String phase : new String[]{"live", "cold", "closed"}) {
            assertThat(phases.path(phase).asLong()).as("Node retained heap growth: %s", phase).isLessThanOrEqualTo(HEAP_GROWTH_BYTES);
        }
        for (String phase : new String[]{"live", "cold", "closed"}) {
            for (String field : new String[]{"externalBytes", "arrayBuffersBytes"}) {
                assertThat(number(external.path(phase), field)).as("Node retained %s growth: %s", field, phase)
                        .isLessThanOrEqualTo(HEAP_GROWTH_BYTES);
            }
        }
        assertThat(jvmDelta).as("Service GC heap growth with its context still open").isLessThanOrEqualTo(HEAP_GROWTH_BYTES);
        assertThat(directDelta).as("Service retained direct buffer growth").isLessThanOrEqualTo(HEAP_GROWTH_BYTES);
        comparison.put("status", "pass");
        json.writerWithDefaultPrettyPrinter().writeValue(report.toFile(), comparison);
    }
}
