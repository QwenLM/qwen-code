package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

// FG7 (issue #13802): the machinery both channel-gate classes share with
// the driver: phase launches and their results, and JDBC ground truth over
// the five channel tables plus the Session Store journal. The Spring and
// harness fixtures stay per-class, the FG6 self-containment convention.
class HostedChannelGateSupport {
    private static final ObjectMapper JSON = new ObjectMapper();
    static final String SENDER = "alice@fg7.fixture";
    private final JdbcTemplate jdbc;
    private final String node;
    private final Path repoRoot;

    HostedChannelGateSupport(JdbcTemplate jdbc, String node, Path repoRoot) {
        this.jdbc = jdbc;
        this.node = node;
        this.repoRoot = repoRoot;
    }

    // --- driver phases ---

    // One phase can launch several times in a case (resume-cold behind a
    // fault phase, a retry after a kill): every launch keeps its own
    // config/log/results trio so a case asking after its first launch
    // never reads the second launch's evidence.
    record DriverLaunch(Process process, String tag) {
    }

    DriverLaunch startDriver(Path caseDir, String phase,
            Map<String, Object> base, Map<String, Object> extra)
            throws IOException {
        String tag = tagForLaunch(caseDir, phase);
        Map<String, Object> config = new LinkedHashMap<>(base);
        config.put("phase", phase);
        config.putAll(extra);
        config.put("resultFile", caseDir.resolve("results-" + tag + ".json")
                .toString());
        Path configFile = caseDir.resolve("driver-" + tag + ".json");
        JSON.writeValue(configFile.toFile(), config);
        ProcessBuilder builder = new ProcessBuilder(node, "--import", "tsx",
                "integration-tests/helpers/hosted-channel-fault-driver.ts",
                configFile.toString()).directory(repoRoot.toFile())
                .redirectErrorStream(true)
                .redirectOutput(caseDir.resolve("driver-" + tag + ".log")
                        .toFile());
        // The Legacy-derived state store keys on the user-global qwen
        // directory: without an isolated HOME the case re-runs against a
        // previous run's cursor, and test state leaks into ~/.qwen.
        Path fakeHome = Files.createDirectories(caseDir.resolve("home"));
        builder.environment().put("HOME", fakeHome.toString());
        builder.environment().put("QWEN_HOME",
                fakeHome.resolve(".qwen").toString());
        return new DriverLaunch(builder.start(), tag);
    }

    private static String tagForLaunch(Path caseDir, String phase) {
        int next = 1;
        while (Files.exists(
                caseDir.resolve("driver-" + phase + "-" + next + ".log"))) {
            next++;
        }
        return phase + "-" + next;
    }

    JsonNode drive(Path caseDir, String phase, Map<String, Object> base)
            throws Exception {
        return drive(caseDir, phase, base, Map.of());
    }

    JsonNode drive(Path caseDir, String phase, Map<String, Object> base,
            Map<String, Object> extra) throws Exception {
        DriverLaunch launch = startDriver(caseDir, phase, base, extra);
        Process driver = launch.process();
        try {
            boolean finished = driver.waitFor(150, TimeUnit.SECONDS);
            if (!finished) {
                driver.destroyForcibly();
            }
            String log = safeRead(
                    caseDir.resolve("driver-" + launch.tag() + ".log"));
            assertThat(finished).as(phase + " driver timed out:\n%s", log)
                    .isTrue();
            assertThat(driver.exitValue()).as(phase + " driver output:\n%s",
                    log).isZero();
            assertThat(log).contains(
                    "FG7_" + phase.replace("-", "_").toUpperCase(Locale.ROOT)
                            + "_OK");
            return JSON.readTree(safeRead(
                    caseDir.resolve("results-" + launch.tag() + ".json")));
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw failure;
        } finally {
            // Every exit path — normal, timeout, interrupt, assertion —
            // reaps the driver: JUnit's @Timeout interrupts the wait.
            driver.destroyForcibly();
        }
    }

    JsonNode resultsOf(Path caseDir, String tag) throws Exception {
        return JSON.readTree(safeRead(
                caseDir.resolve("results-" + tag + ".json")));
    }

    void awaitLog(Path caseDir, String name, String marker, Process writer)
            throws Exception {
        Path log = caseDir.resolve(name);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120);
        while (System.nanoTime() < deadline) {
            if (Files.exists(log) && safeRead(log).contains(marker)) {
                return;
            }
            if (!writer.isAlive()) {
                throw new AssertionError(marker + " in " + name
                        + ": the driver exited " + writer.exitValue() + ":\n"
                        + safeRead(log));
            }
            Thread.sleep(200);
        }
        throw new AssertionError(marker + " in " + name + " timed out:\n"
                + safeRead(log));
    }

    /** A MissingNode is empty too — a vacant sends check must be present. */
    static void assertSendsEmpty(JsonNode results, String label) {
        assertThat(results.has("sends")).as(label).isTrue();
        assertThat(results.path("sends").isEmpty()).as(label).isTrue();
    }

    /** Every physical send of a gate went to the scripted recipient. */
    static void assertSendsTo(JsonNode results) {
        for (JsonNode send : results.path("sends")) {
            assertThat(send.path("to").asText())
                    .as("the reply went to the scripted recipient")
                    .contains(SENDER);
        }
    }

    static String safeRead(Path file) {
        try {
            return Files.readString(file);
        } catch (IOException failure) {
            return String.valueOf(failure);
        }
    }

    static int relayCount(JsonNode results, String verb, boolean dropped) {
        int count = 0;
        for (JsonNode relay : results.path("relays")) {
            if (verb.equals(relay.path("verb").asText())
                    && relay.path("dropped").asBoolean() == dropped) {
                count++;
            }
        }
        return count;
    }

    /**
     * A positive control counts only healthy answers: the proxy records
     * the status of every relay, and a 4xx/5xx is not adapter liveness.
     */
    static int relayCountOk(JsonNode results, String verb) {
        int count = 0;
        for (JsonNode relay : results.path("relays")) {
            if (verb.equals(relay.path("verb").asText())
                    && !relay.path("dropped").asBoolean()
                    && relay.path("status").asInt() < 400) {
                count++;
            }
        }
        return count;
    }

    // --- channel driver config ---

    Map<String, Object> caseBase(String tenant, String fault, Path stateDir,
            int internalPort) {
        Map<String, Object> base = new LinkedHashMap<>();
        base.put("faultCase", fault);
        base.put("tenantId", tenant);
        base.put("channelId", "fg7-" + fault);
        base.put("actorId", "actor");
        base.put("workspaceId", "workspace-0");
        base.put("cwdRelative", ".");
        base.put("internalUrl", "http://127.0.0.1:" + internalPort);
        base.put("stateDir", stateDir.toString());
        base.put("mailboxAddress", "agent@fg7.fixture");
        base.put("sender", SENDER);
        base.put("subject", "fg7-" + fault);
        base.put("bodyText", "please answer fg7-" + fault);
        return base;
    }

    // --- JDBC ground truth ---

    Map<String, Object> deliveryProjection(String tenant, String sessionId,
            String deliveryId) {
        var rows = jdbc.queryForList(
                "SELECT revision, delivery_state, record_resource_id FROM"
                        + " ma_session_record WHERE"
                        + " tenant_id = ? AND session_id = ? AND domain ="
                        + " 'channel_delivery' AND record_id = ?", tenant,
                sessionId, deliveryId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    Map<String, Object> ledger(String tenant, String channelId,
            String deliveryId) {
        var rows = jdbc.queryForList(
                "SELECT transport_state AS state, JSON_UNQUOTE(provider_receipt_json) AS provider_receipt, segment_id, segment_ordinal"
                        + " FROM ma_delivery WHERE delivery_kind = 'CHANNEL' AND tenant_id"
                        + " = ? AND channel_id = ? AND delivery_id = ?",
                tenant, channelId, deliveryId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    int ledgerRows(String tenant, String channelId) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_delivery WHERE delivery_kind = 'CHANNEL' AND"
                        + " tenant_id = ? AND channel_id = ?",
                Integer.class, tenant, channelId);
        return count == null ? 0 : count;
    }

    int claimRows(String tenant, String channelId) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_delivery WHERE delivery_kind = 'CHANNEL' AND claimed_at IS NOT NULL AND"
                        + " tenant_id = ? AND channel_id = ?",
                Integer.class, tenant, channelId);
        return count == null ? 0 : count;
    }

    Map<String, Object> routeRow(String tenant, String channelId) {
        var rows = jdbc.queryForList(
                "SELECT state, JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.inputId')) AS input_id, session_id FROM"
                        + " ma_operation WHERE operation_kind = 'CHANNEL_INGRESS' AND tenant_id = ? AND"
                        + " JSON_UNQUOTE(JSON_EXTRACT(request_json, '$.channelId')) = ?", tenant, channelId);
        assertThat(rows).as("route rows for " + channelId).hasSize(1);
        return rows.getFirst();
    }

    String channelSession(String tenant, String channelId) {
        var rows = jdbc.queryForList(
                "SELECT session_id FROM ma_channel_binding WHERE"
                        + " tenant_id = ? AND channel_id = ?", tenant,
                channelId);
        assertThat(rows).as("the channel's binding rows").hasSize(1);
        return rows.getFirst().get("session_id").toString();
    }

    String sessionOfInput(String tenant, String channelId, String inputId) {
        var rows = jdbc.queryForList(
                "SELECT session_id FROM ma_operation WHERE operation_kind = 'CHANNEL_INGRESS' AND"
                        + " tenant_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(request_json, '$.channelId')) = ? AND"
                        + " JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.inputId')) = ?", tenant, channelId, inputId);
        assertThat(rows).as("route row for " + inputId).hasSize(1);
        return rows.getFirst().get("session_id").toString();
    }

    Map<String, Object> routeProjection(String tenant, String sessionId) {
        var rows = jdbc.queryForList(
                "SELECT revision FROM ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ? AND domain"
                        + " = 'channel_route'", tenant, sessionId);
        // The route-admit probe awaits this row: empty is legal, ambiguous
        // (a reopened chain) is the regression these gates exist to catch.
        assertThat(rows).as("channel_route projection rows")
                .hasSizeLessThanOrEqualTo(1);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    JsonNode deliveryRecord(String tenant, String sessionId,
            String deliveryId) throws IOException {
        Map<String, Object> projection = deliveryProjection(tenant, sessionId,
                deliveryId);
        assertThat(projection).as("delivery record " + deliveryId).isNotNull();
        // Led by the indexed session scope key, as in HostedGateTestSupport: the
        // raw tenant+session form scans the lane's accumulated ma_resource rows.
        var resources = jdbc.queryForList(
                "SELECT CONVERT(inline_bytes USING utf8mb4) AS body FROM"
                        + " ma_resource WHERE session_scope_key = ?"
                        + " AND resource_id = ? AND tenant_id = ?"
                        + " AND session_id = ?",
                ManagedSessionStore.sessionScopeKey(tenant, sessionId),
                projection.get("record_resource_id"), tenant, sessionId);
        assertThat(resources).hasSize(1);
        return JSON.readTree(resources.getFirst().get("body").toString());
    }

    int inputAcceptedCount(String tenant, String sessionId)
            throws IOException {
        int count = 0;
        for (Map<String, Object> tx : jdbc.queryForList(
                "SELECT record_bytes FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?", tenant,
                sessionId)) {
            String bytes = new String((byte[]) tx.get("record_bytes"),
                    StandardCharsets.UTF_8);
            for (String line : bytes.lines().toList()) {
                JsonNode record = JSON.readTree(line);
                if ("managed_session_event_v1".equals(record.path("subtype")
                        .asText()) && "input.accepted".equals(record
                        .path("managedSession").path("kind").asText())) {
                    count++;
                }
            }
        }
        return count;
    }

    void expireClaims(String tenant, String channelId) {
        jdbc.update("UPDATE ma_delivery SET claimed_at = 0"
                + " WHERE delivery_kind = 'CHANNEL' AND claimed_at IS NOT NULL AND tenant_id = ? AND channel_id = ?", tenant,
                channelId);
    }

    String newTriggerName() {
        return "fg7b_" + UUID.randomUUID().toString().replace("-", "");
    }
}
