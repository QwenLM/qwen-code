package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/** The explicit MCP selection, separate from the Session's immutable definition. */
public final class ManagedMcpSettings {
    public static final String DOMAIN = "config_install";
    public static final String RECORD_ID = "hosted-mcp-settings";
    private static final long MAX_REVISION = 9_007_199_254_740_991L;

    private ManagedMcpSettings() { }

    public static void require(JsonNode body) {
        if (ManagedConfigInstall.isPackageConfig(body)) {
            ManagedConfigInstall.require(body);
            return;
        }
        ManagedExtensionRecords.closed(body, Set.of("kind", "schemaVersion", "servers", "command",
                "operationId", "revision", "previousRecordRef"), "MCP settings");
        check("hosted-mcp-settings".equals(body.path("kind").textValue())
                && body.path("schemaVersion").isIntegralNumber() && body.path("schemaVersion").canConvertToLong()
                && body.path("schemaVersion").asLong() == 1,
                "Invalid MCP settings kind");
        long revision = ManagedExtensionRecords.count(body.get("revision"), 1, MAX_REVISION, "MCP revision");
        JsonNode previous = body.get("previousRecordRef");
        if (!previous.isNull()) {
            ManagedExtensionRecords.durableRef(previous, "MCP settings predecessor");
            check("managed-config_install".equals(previous.path("kind").textValue()), "Invalid MCP predecessor");
        }
        check((revision == 1) == previous.isNull(), "MCP settings predecessor is missing");
        JsonNode command = body.get("command");
        boolean pinRequired = Set.of("add", "edit").contains(command.path("action").asText());
        ManagedExtensionRecords.closed(command, pinRequired
                ? Set.of("operationId", "actorKey", "action", "serverId", "expectedRevision", "server")
                : Set.of("operationId", "actorKey", "action", "serverId", "expectedRevision"), "MCP command");
        check(command.path("operationId").asText().matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
                && command.path("actorKey").isTextual() && command.path("actorKey").asText().matches("[a-f0-9]{64}")
                && Set.of("add", "edit", "remove", "enable", "disable", "reload", "restart")
                        .contains(command.path("action").asText())
                && command.path("serverId").isTextual() && command.path("serverId").asText().matches("[A-Za-z0-9._:-]{1,128}")
                && command.get("operationId").equals(body.get("operationId")), "Invalid MCP command identity");
        check(ManagedExtensionRecords.count(command.get("expectedRevision"), 0, MAX_REVISION - 1,
                "Expected MCP revision") + 1 == revision, "MCP settings revision conflicts");
        if (pinRequired) {
            pin(command.get("server"), false);
            check(command.get("serverId").equals(command.path("server").get("serverId")), "MCP server identity conflicts");
        }
        JsonNode servers = body.get("servers");
        check(servers.isArray() && servers.size() <= 32, "Invalid MCP settings servers");
        Set<String> ids = new HashSet<>();
        int enabled = 0;
        for (JsonNode server : servers) {
            pin(server, true);
            check(ids.add(server.get("serverId").textValue()), "Duplicate MCP server");
            if ("enabled".equals(server.get("state").textValue())) {
                enabled++;
            }
        }
        check(enabled <= 16, "MCP connection quota exceeded");
    }

    private static void pin(JsonNode pin, boolean state) {
        ManagedExtensionRecords.closed(pin, state
                ? Set.of("serverId", "serverRevision", "definitionDigest", "state")
                : Set.of("serverId", "serverRevision", "definitionDigest"), "MCP server pin");
        check(pin.path("serverId").isTextual() && pin.path("serverId").asText().matches("[A-Za-z0-9._:-]{1,128}")
                && pin.path("definitionDigest").isTextual() && pin.path("definitionDigest").asText().matches("[a-f0-9]{64}"),
                "Invalid MCP server pin");
        ManagedExtensionRecords.count(pin.get("serverRevision"), 1, MAX_REVISION, "MCP server revision");
        check(!state || Set.of("enabled", "disabled", "removed").contains(pin.path("state").asText()), "Invalid MCP server state");
    }

    public static JsonNode find(JdbcTemplate jdbc, String tenantId, String sessionId) {
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        return jdbc.query("SELECT u.inline_bytes, u.byte_length, u.sha256, u.kind, u.schema_version, r.revision,"
                        + " u.state, u.storage_kind, u.object_key, u.object_version_id, u.encryption_key_id"
                        + " FROM ma_session_record r LEFT JOIN ma_resource u ON u.session_scope_key=r.session_scope_key"
                        + " AND u.resource_id=r.record_resource_id AND u.tenant_id=r.tenant_id AND u.session_id=r.session_id"
                        + " AND u.workspace_id=r.workspace_id WHERE r.session_scope_key=? AND r.tenant_id=? AND r.session_id=?"
                        + " AND r.record_kind='DOMAIN' AND r.domain=? AND r.record_id=?",
                (row, index) -> {
                    byte[] bytes = row.getBytes("inline_bytes");
                    check(bytes != null && bytes.length == row.getLong("byte_length")
                            && bytes.length <= ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES
                            && DigestUtils.sha256Hex(bytes).equals(row.getString("sha256"))
                            && "managed-config_install".equals(row.getString("kind")) && row.getInt("schema_version") == 1
                            && "REFERENCED".equals(row.getString("state")) && "MYSQL_INLINE".equals(row.getString("storage_kind"))
                            && row.getString("object_key") == null && row.getString("object_version_id") == null
                            && row.getString("encryption_key_id") == null,
                            "The committed MCP settings are corrupt");
                    JsonNode body = ManagedExtensionRecordStore.parse(new String(bytes, StandardCharsets.UTF_8));
                    require(body);
                    check(body.get("revision").longValue() == row.getLong("revision"), "MCP settings projection conflicts");
                    return body;
                }, scope, tenantId, sessionId, DOMAIN, RECORD_ID).stream().findFirst().orElse(null);
    }

    private static void check(boolean valid, String message) {
        if (!valid) {
            throw new ManagedExtensionRecords.InvalidRecordException(message);
        }
    }
}
