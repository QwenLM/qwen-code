package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** The package-aware body of the existing config_install domain. */
public final class ManagedConfigInstall {
    public static final String KIND = "hosted-extension-config";
    private static final long MAX = 9_007_199_254_740_991L;
    private static final Set<String> PHASES = Set.of("preparing", "prepared", "committed", "active", "recovery_required", "failed");
    private static final Map<String, Set<String>> TRANSITIONS = Map.of(
            "preparing", Set.of("prepared", "failed"), "prepared", Set.of("committed", "failed"),
            "committed", Set.of("active", "recovery_required"), "recovery_required", Set.of("active", "recovery_required"),
            "active", Set.of(), "failed", Set.of());

    private ManagedConfigInstall() { }

    public static boolean isPackageConfig(JsonNode body) {
        return body != null && KIND.equals(body.path("kind").textValue());
    }

    public static void require(JsonNode body) {
        ManagedExtensionRecords.closed(body, Set.of("kind", "formatVersion", "command", "mode", "phaseOperationId", "configRevision",
                "previousConfigRevision", "phase", "previousBundleRef", "restoresBundleRef", "bundleRef", "rootSnapshotRef",
                "stageAckRefs", "enableAckRefs", "error", "operationId", "revision", "previousRecordRef"), "Configuration install");
        check(KIND.equals(body.path("kind").textValue()) && body.path("formatVersion").isIntegralNumber()
                && body.path("formatVersion").asLong() == 1, "Invalid configuration install kind");
        long revision = count(body.get("revision"), 1);
        JsonNode predecessor = body.get("previousRecordRef");
        ref(predecessor, true);
        check((revision == 1) == predecessor.isNull(), "Invalid configuration predecessor");
        check(predecessor.isNull() || "managed-config_install".equals(predecessor.path("kind").textValue()), "Invalid configuration predecessor kind");
        String phase = body.path("phase").asText();
        check(PHASES.contains(phase), "Invalid configuration phase");
        boolean compensation = "recoverPrevious".equals(body.path("mode").textValue());
        check(compensation || "apply".equals(body.path("mode").textValue()), "Invalid configuration mode");
        long before = count(body.get("previousConfigRevision"), 0);
        check(count(body.get("configRevision"), 1) == before + 1, "Invalid effective configuration revision");
        JsonNode command = body.get("command");
        ManagedExtensionRecords.closed(command, command.has("mcpChange")
                ? Set.of("operationId", "actorKey", "expectedRevision", "extensions", "mcpChange")
                : Set.of("operationId", "actorKey", "expectedRevision", "extensions"), "Extension apply command");
        if (command.has("mcpChange")) {
            mcpChange(command.get("mcpChange"));
        }
        check(uuid(command.path("operationId").asText()) && command.get("operationId").equals(body.get("operationId"))
                && command.path("actorKey").asText().matches("[a-f0-9]{64}"), "Invalid extension apply identity");
        check(count(command.get("expectedRevision"), 0) + (compensation ? 1 : 0) == before, "Extension apply revision conflicts");
        check(body.path("phaseOperationId").asText().equals(compensation ? derivedOperationId("managed-extension-recoverPrevious:", command.path("operationId").asText().toLowerCase(java.util.Locale.ROOT))
                : command.path("operationId").asText()), "Configuration phase operation conflicts");
        pins(command.get("extensions"));
        ref(body.get("previousBundleRef"), true);
        ref(body.get("restoresBundleRef"), true);
        check(!body.get("restoresBundleRef").isNull() == compensation, "Invalid compensation content");
        boolean mayBeUnprepared = Set.of("preparing", "failed").contains(phase);
        ref(body.get("bundleRef"), mayBeUnprepared);
        ref(body.get("rootSnapshotRef"), false);
        refs(body.get("stageAckRefs"));
        refs(body.get("enableAckRefs"));
        check(!Set.of("prepared", "committed", "active").contains(phase) || body.get("stageAckRefs").size() >= 2,
                "Both stage acknowledgements are required");
        check(!"active".equals(phase) || body.get("enableAckRefs").size() >= 2, "Both enable acknowledgements are required");
        check(!Set.of("preparing", "prepared", "failed").contains(phase) || body.get("enableAckRefs").isEmpty(), "Unexpected enable acknowledgement");
        JsonNode error = body.get("error");
        check((Set.of("failed", "recovery_required").contains(phase)) == !error.isNull(), "Invalid configuration error");
        if (!error.isNull()) {
            ManagedExtensionRecords.closed(error, Set.of("code"), "Configuration error");
            check(error.path("code").asText().matches("[a-z][a-z0-9_]{0,127}"), "Invalid configuration error code");
        }
    }

    public static void pins(JsonNode pins) {
        check(pins != null && pins.isArray() && pins.size() <= 32, "Invalid package selection");
        Set<String> ids = new HashSet<>();
        for (JsonNode pin : pins) {
            ManagedExtensionRecords.closed(pin, pin.has("settingsRevision")
                    ? Set.of("extensionId", "packageRevision", "packageDigest", "settingsRevision")
                    : Set.of("extensionId", "packageRevision", "packageDigest"), "Extension pin");
            check(pin.path("extensionId").asText().matches("[A-Za-z0-9._:-]{1,128}")
                    && ids.add(pin.get("extensionId").asText()) && pin.path("packageDigest").asText().matches("[a-f0-9]{64}"), "Invalid extension pin");
            count(pin.get("packageRevision"), 1);
            if (pin.has("settingsRevision")) {
                count(pin.get("settingsRevision"), 1);
            }
        }
    }

    private static void mcpChange(JsonNode change) {
        ManagedExtensionRecords.closed(change, Set.of("action", "serverId", "expectedRevision", "servers"), "Independent MCP change");
        check(Set.of("add", "edit", "remove", "enable", "disable", "reload", "restart").contains(change.path("action").asText())
                && change.path("serverId").asText().matches("[A-Za-z0-9._:-]{1,128}"), "Invalid independent MCP command");
        count(change.get("expectedRevision"), 0);
        JsonNode servers = change.get("servers");
        check(servers.isArray() && servers.size() <= 32, "Invalid independent MCP selection");
        Set<String> ids = new HashSet<>();
        int enabled = 0;
        for (JsonNode pin : servers) {
            ManagedExtensionRecords.closed(pin, Set.of("serverId", "serverRevision", "definitionDigest", "state"), "Independent MCP pin");
            check(pin.path("serverId").asText().matches("[A-Za-z0-9._:-]{1,128}") && ids.add(pin.get("serverId").asText())
                    && pin.path("definitionDigest").asText().matches("[a-f0-9]{64}")
                    && Set.of("enabled", "disabled", "removed").contains(pin.path("state").asText()), "Invalid independent MCP pin");
            count(pin.get("serverRevision"), 1);
            if ("enabled".equals(pin.path("state").asText())) {
                enabled++;
            }
        }
        check(enabled <= 16 && ids.contains(change.path("serverId").asText()), "Independent MCP selection conflicts");
    }

    public static void successor(JsonNode previous, JsonNode next) {
        require(next);
        if (!isPackageConfig(previous)) {
            check("preparing".equals(next.path("phase").asText()) && "apply".equals(next.path("mode").asText())
                    && next.path("previousConfigRevision").asLong() == 0, "Invalid initial package configuration");
            return;
        }
        require(previous);
        String phase = previous.path("phase").asText();
        if (!previous.get("operationId").equals(next.get("operationId"))) {
            check(Set.of("active", "failed").contains(phase)
                    && !("failed".equals(phase) && "recoverPrevious".equals(previous.path("mode").asText()))
                    && "preparing".equals(next.path("phase").asText()) && "apply".equals(next.path("mode").asText())
                    && next.path("previousConfigRevision").asLong() == previous.path("failed".equals(phase)
                            ? "previousConfigRevision" : "configRevision").asLong(), "Configuration operation conflicts");
            return;
        }
        boolean compensation = "recovery_required".equals(phase) && "apply".equals(previous.path("mode").asText())
                && "recoverPrevious".equals(next.path("mode").asText()) && "preparing".equals(next.path("phase").asText());
        check(previous.get("command").equals(next.get("command")), "Configuration command changed");
        if (compensation) {
            check(next.path("configRevision").asLong() == previous.path("configRevision").asLong() + 1
                    && !previous.path("previousBundleRef").isNull()
                    && next.get("previousBundleRef").equals(previous.get("bundleRef"))
                    && next.get("restoresBundleRef").equals(previous.get("previousBundleRef")), "Invalid compensation revision");
            return;
        }
        check(TRANSITIONS.get(phase).contains(next.path("phase").asText()), "Configuration phase conflicts");
        for (String field : List.of("mode", "phaseOperationId", "configRevision", "previousConfigRevision", "previousBundleRef", "restoresBundleRef", "rootSnapshotRef")) {
            check(previous.get(field).equals(next.get(field)), "Configuration content changed");
        }
        if (!"preparing".equals(phase) || !previous.path("bundleRef").isNull()) {
            check(previous.get("bundleRef").equals(next.get("bundleRef")),
                    "Prepared configuration changed");
        }
    }

    public static boolean barrier(JsonNode body) {
        if (!isPackageConfig(body)) {
            return false;
        }
        String phase = body.path("phase").asText();
        return Set.of("committed", "recovery_required").contains(phase)
                || "recoverPrevious".equals(body.path("mode").asText()) && !"active".equals(phase);
    }

    public static void requireOpen(JdbcTemplate jdbc, String tenantId, String sessionId) {
        if (blocked(jdbc, tenantId, sessionId)) {
            throw new ManagedAgentException(HttpStatus.CONFLICT,
                    "session_config_recovery_required", "The Session configuration operation must be reconciled first.");
        }
    }

    public static boolean blocked(JdbcTemplate jdbc, String tenantId, String sessionId) {
        return !jdbc.queryForList("SELECT record_key FROM ma_session_record WHERE session_scope_key=? AND tenant_id=?"
                + " AND session_id=? AND record_kind='DOMAIN' AND domain='config_install' AND record_id=?"
                + " AND settled_at IS NULL LIMIT 1 FOR UPDATE", ManagedSessionStore.sessionScopeKey(tenantId, sessionId),
                tenantId, sessionId, ManagedMcpSettings.RECORD_ID).isEmpty();
    }

    public static String derivedOperationId(String prefix, String identity) {
        byte[] bytes = org.apache.commons.codec.digest.DigestUtils.sha256(prefix + identity);
        bytes[6] = (byte) ((bytes[6] & 15) | 80);
        bytes[8] = (byte) ((bytes[8] & 63) | 128);
        String hex = java.util.HexFormat.of().formatHex(bytes, 0, 16);
        return hex.substring(0, 8) + "-" + hex.substring(8, 12) + "-" + hex.substring(12, 16) + "-" + hex.substring(16, 20) + "-" + hex.substring(20);
    }

    public static boolean uuid(String id) {
        return id != null && id.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    }

    private static long count(JsonNode value, long min) {
        return ManagedExtensionRecords.count(value, min, MAX, "Configuration revision");
    }

    private static void ref(JsonNode value, boolean nullable) {
        check(value != null, "Missing configuration reference");
        if (!nullable || !value.isNull()) {
            ManagedExtensionRecords.durableRef(value, "Configuration reference");
        }
    }

    private static void refs(JsonNode value) {
        check(value != null && value.isArray() && value.size() <= 8, "Invalid configuration acknowledgement list");
        Set<String> ids = new HashSet<>();
        for (JsonNode entry : value) {
            ref(entry, false);
            check(ids.add(entry.path("resourceId").asText()), "Duplicate configuration acknowledgement");
        }
    }

    private static void check(boolean valid, String message) {
        if (!valid) {
            throw new ManagedExtensionRecords.InvalidRecordException(message);
        }
    }
}
