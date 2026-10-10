package com.alibaba.qwen.code.managedagent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.assertj.core.api.Assertions.assertThat;

// FG7 (issue #13802): the machinery both channel-gate classes share with
// the driver: phase launches and their results, and JDBC ground truth over
// the five channel tables plus the Session Store journal. The Spring and
// harness fixtures stay per-class, the FG6 self-containment convention.
class HostedChannelGateSupport {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final String node;
    private final Path repoRoot;

    HostedChannelGateSupport(JdbcTemplate jdbc, String node, Path repoRoot) {
        this.jdbc = jdbc;
        this.node = node;
        this.repoRoot = repoRoot;
    }

    // --- driver phases ---

    ProcessBuilder driverBuilder(Path caseDir, String phase,
            Map<String, Object> base, Map<String, Object> extra)
            throws IOException {
        Map<String, Object> config = new LinkedHashMap<>(base);
        config.put("phase", phase);
        config.putAll(extra);
        config.put("resultFile", caseDir.resolve("results-" + phase + ".json")
                .toString());
        Path configFile = caseDir.resolve("driver-" + phase + ".json");
        JSON.writeValue(configFile.toFile(), config);
        ProcessBuilder builder = new ProcessBuilder(node, "--import", "tsx",
                "integration-tests/helpers/hosted-channel-fault-driver.ts",
                configFile.toString()).directory(repoRoot.toFile())
                .redirectErrorStream(true)
                .redirectOutput(caseDir.resolve("driver-" + phase + ".log")
                        .toFile());
        // The Legacy-derived state store keys on the user-global qwen
        // directory: without an isolated HOME the case re-runs against a
        // previous run's cursor, and test state leaks into ~/.qwen.
        Path fakeHome = Files.createDirectories(caseDir.resolve("home"));
        builder.environment().put("HOME", fakeHome.toString());
        builder.environment().put("QWEN_HOME",
                fakeHome.resolve(".qwen").toString());
        return builder;
    }

    JsonNode drive(Path caseDir, String phase, Map<String, Object> base)
            throws Exception {
        return drive(caseDir, phase, base, Map.of());
    }

    JsonNode drive(Path caseDir, String phase, Map<String, Object> base,
            Map<String, Object> extra) throws Exception {
        Process driver = driverBuilder(caseDir, phase, base, extra).start();
        boolean finished = driver.waitFor(150, TimeUnit.SECONDS);
        if (!finished) {
            driver.destroyForcibly();
        }
        String log = safeRead(caseDir.resolve("driver-" + phase + ".log"));
        assertThat(finished).as(phase + " driver timed out:\n%s", log)
                .isTrue();
        assertThat(driver.exitValue()).as(phase + " driver output:\n%s", log)
                .isZero();
        assertThat(log).contains(
                "FG7_" + phase.replace("-", "_").toUpperCase(Locale.ROOT)
                        + "_OK");
        return resultsOf(caseDir, phase);
    }

    JsonNode resultsOf(Path caseDir, String phase) throws Exception {
        return JSON.readTree(safeRead(
                caseDir.resolve("results-" + phase + ".json")));
    }

    void awaitLog(Path caseDir, String name, String marker)
            throws Exception {
        Path log = caseDir.resolve(name);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120);
        while (System.nanoTime() < deadline) {
            if (Files.exists(log) && safeRead(log).contains(marker)) {
                return;
            }
            Thread.sleep(200);
        }
        throw new AssertionError(marker + " in " + name + " timed out:\n"
                + safeRead(log));
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
        base.put("sender", "alice@fg7.fixture");
        base.put("subject", "fg7-" + fault);
        base.put("bodyText", "please answer fg7-" + fault);
        return base;
    }

    // --- JDBC ground truth ---

    Map<String, Object> deliveryProjection(String tenant, String sessionId,
            String deliveryId) {
        var rows = jdbc.queryForList(
                "SELECT revision, delivery_state, record_resource_id FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " tenant_id = ? AND session_id = ? AND domain ="
                        + " 'channel_delivery' AND record_id = ?", tenant,
                sessionId, deliveryId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    Map<String, Object> ledger(String tenant, String channelId,
            String deliveryId) {
        var rows = jdbc.queryForList(
                "SELECT state, provider_receipt, segment_id, segment_ordinal"
                        + " FROM qwen_managed_channel_delivery WHERE tenant_id"
                        + " = ? AND channel_instance_id = ? AND delivery_id = ?",
                tenant, channelId, deliveryId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    int ledgerRows(String tenant, String channelId) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM qwen_managed_channel_delivery WHERE"
                        + " tenant_id = ? AND channel_instance_id = ?",
                Integer.class, tenant, channelId);
        return count == null ? 0 : count;
    }

    int claimRows(String tenant, String channelId) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM qwen_managed_channel_claim WHERE"
                        + " tenant_id = ? AND channel_id = ?",
                Integer.class, tenant, channelId);
        return count == null ? 0 : count;
    }

    Map<String, Object> routeRow(String tenant, String channelId) {
        var rows = jdbc.queryForList(
                "SELECT state, input_id, session_id FROM"
                        + " qwen_managed_channel_route WHERE tenant_id = ? AND"
                        + " channel_instance_id = ?", tenant, channelId);
        assertThat(rows).as("route rows for " + channelId).hasSize(1);
        return rows.getFirst();
    }

    String channelSession(String tenant, String channelId) {
        var rows = jdbc.queryForList(
                "SELECT session_id FROM qwen_managed_channel_binding WHERE"
                        + " tenant_id = ? AND channel_id = ?", tenant,
                channelId);
        assertThat(rows).as("the channel's binding rows").hasSize(1);
        return rows.getFirst().get("session_id").toString();
    }

    String sessionOfInput(String tenant, String channelId, String inputId) {
        var rows = jdbc.queryForList(
                "SELECT session_id FROM qwen_managed_channel_route WHERE"
                        + " tenant_id = ? AND channel_instance_id = ? AND"
                        + " input_id = ?", tenant, channelId, inputId);
        assertThat(rows).as("route row for " + inputId).hasSize(1);
        return rows.getFirst().get("session_id").toString();
    }

    Map<String, Object> routeProjection(String tenant, String sessionId) {
        var rows = jdbc.queryForList(
                "SELECT revision FROM qwen_managed_session_extension_record"
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
        var resources = jdbc.queryForList(
                "SELECT CONVERT(inline_bytes USING utf8mb4) AS body FROM"
                        + " qwen_managed_session_resource WHERE tenant_id = ?"
                        + " AND session_id = ? AND resource_id = ?", tenant,
                sessionId, projection.get("record_resource_id"));
        assertThat(resources).hasSize(1);
        return JSON.readTree(resources.getFirst().get("body").toString());
    }

    int inputAcceptedCount(String tenant, String sessionId)
            throws IOException {
        int count = 0;
        for (Map<String, Object> tx : jdbc.queryForList(
                "SELECT record_bytes FROM qwen_managed_session_journal_tx"
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
        jdbc.update("UPDATE qwen_managed_channel_claim SET claimed_at = 0"
                + " WHERE tenant_id = ? AND channel_id = ?", tenant,
                channelId);
    }

    String newTriggerName() {
        return "fg7b_" + UUID.randomUUID().toString().replace("-", "");
    }
}
