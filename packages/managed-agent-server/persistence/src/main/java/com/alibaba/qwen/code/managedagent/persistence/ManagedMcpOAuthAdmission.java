package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Objects;
import java.util.Set;

/** SQL projection and admission share the Session lock with configuration commit. */
public final class ManagedMcpOAuthAdmission {
    private ManagedMcpOAuthAdmission() {}

    public static void requireActorForUpdate(JdbcTemplate jdbc, String tenant, String session, String actor) {
        jdbc.queryForObject(
                "SELECT session_id FROM ma_session WHERE tenant_id = ? AND session_id ="
                        + " ? AND session_kind = 'PUBLIC' FOR UPDATE",
                String.class, tenant, session);
        requireActor(jdbc, tenant, session, actor);
    }

    public static void requireActor(
            JdbcTemplate jdbc, String tenant, String session, String actor) {
        String owner = actor(jdbc, tenant, session);
        if (owner != null
                && (actor == null
                        || !MessageDigest.isEqual(
                                owner.getBytes(StandardCharsets.US_ASCII),
                                DigestUtils.sha256Hex(actor)
                                        .getBytes(StandardCharsets.US_ASCII)))) {
            throw new ManagedAgentException(
                    403,
                    "personal_mcp_actor_required",
                    "Only the personal authorization owner may drive this Session.");
        }
    }

    public static void requireUnattendedAllowed(JdbcTemplate jdbc, String tenant, String session) {
        if (actor(jdbc, tenant, session) != null) {
            throw new ManagedAgentException(
                    409,
                    "personal_mcp_delegation_unsupported",
                    "Personal MCP credentials require an explicit user execution identity.");
        }
    }

    public static String actor(JdbcTemplate jdbc, String tenant, String session) {
        var rows =
                jdbc.query(
                        "SELECT personal_execution_actor_key FROM ma_session WHERE tenant_id=? AND"
                            + " session_id=?",
                        (row, index) -> row.getString(1),
                        tenant,
                        session);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public static void commit(JdbcTemplate jdbc, String tenant, String session, JsonNode body) {
        if (!Set.of("committed", "active", "recovery_required")
                .contains(body.path("phase").asText())) {
            return;
        }
        JsonNode bundle = readBundle(jdbc, tenant, session, body.path("bundleRef"));
        long revision = body.path("configRevision").asLong();
        // Revoking a grant must not prevent the exact committed configuration from settling.
        boolean phaseOnly = followsCommittedConfiguration(jdbc, tenant, session, body);
        boolean restoring = "recoverPrevious".equals(body.path("mode").asText());
        if (restoring) {
            requireRestoredIdentity(jdbc, tenant, session, body, bundle);
        }
        String actorKey = null;
        if (bundle.path("formatVersion").asInt() == 2) {
            JsonNode bindings = bundle.path("mcpAuthBindings");
            ManagedConfigInstall.authBindings(bindings);
            if (!bindings.isEmpty()) {
                actorKey = bundle.path("executionActorKey").asText();
                if (!actorKey.matches("[a-f0-9]{64}")
                        || !restoring && !actorKey.equals(body.path("command").path("actorKey").asText())) {
                    throw invalid();
                }
                if (!phaseOnly) {
                    for (JsonNode binding : bindings) {
                        var grants =
                                jdbc.query(
                                        "SELECT actor_id,generation,state,binding_json FROM"
                                            + " ma_mcp_credential WHERE tenant_id=? AND"
                                            + " workspace_id=(SELECT workspace_id FROM ma_session WHERE"
                                            + " tenant_id=? AND session_id=?) AND credential_id=? FOR"
                                            + " UPDATE",
                                        (row, index) ->
                                                DigestUtils.sha256Hex(row.getString(1))
                                                                .equals(
                                                                        bundle.path("executionActorKey")
                                                                                .asText())
                                                        && row.getLong(2)
                                                                == binding.path("credentialGeneration")
                                                                        .asLong()
                                                        && Set.of("active", "refreshing")
                                                                .contains(row.getString(3))
                                                        && ManagedExtensionRecordStore.parse(
                                                                        row.getString(4))
                                                                .path("serverId")
                                                                .equals(binding.path("serverId")),
                                        tenant,
                                        tenant,
                                        session,
                                        binding.path("credentialId").asText());
                        if (grants.size() != 1 || !grants.getFirst()) {
                            throw invalid();
                        }
                    }
                }
            } else if (!bundle.path("executionActorKey").isNull()) {
                throw invalid();
            }
        } else if (bundle.has("mcpAuthBindings") || bundle.has("executionActorKey")) {
            throw invalid();
        }
        if (bundle.path("configRevision").asLong() != revision) {
            throw invalid();
        }
        if (phaseOnly) {
            String expectedActor = actorKey;
            var projection = jdbc.query("SELECT personal_execution_actor_key,personal_auth_config_revision"
                            + " FROM ma_session WHERE tenant_id=? AND session_id=? FOR UPDATE",
                    (row, index) -> row.getLong(2) == revision
                            && Objects.equals(row.getString(1), expectedActor), tenant, session);
            if (projection.size() != 1 || !projection.getFirst()) {
                throw invalid();
            }
            return;
        }
        int changed =
                jdbc.update(
                        "UPDATE ma_session SET"
                            + " personal_execution_actor_key=?,personal_auth_config_revision=?"
                            + " WHERE tenant_id=? AND session_id=? AND"
                            + " personal_auth_config_revision<=?",
                        actorKey,
                        revision,
                        tenant,
                        session,
                        revision);
        if (changed != 1) {
            throw invalid();
        }
    }

    private static void requireRestoredIdentity(JdbcTemplate jdbc, String tenant, String session,
            JsonNode body, JsonNode bundle) {
        JsonNode restored = readBundle(jdbc, tenant, session, body.path("restoresBundleRef"));
        JsonNode current = ManagedMcpSettings.find(jdbc, tenant, session);
        var records = new com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore(jdbc);
        boolean foundActive = false;
        for (int step = 0; ManagedConfigInstall.isPackageConfig(current); step++) {
            if (step >= 4096) {
                throw invalid();
            }
            ManagedConfigInstall.require(current);
            if ("active".equals(current.path("phase").asText())) {
                if (!ManagedExtensionRecords.same(
                        readBundle(jdbc, tenant, session, current.path("bundleRef")), restored)) {
                    throw invalid();
                }
                foundActive = true;
                break;
            }
            if (current.path("previousRecordRef").isNull()) {
                break;
            }
            current = records.readRecordResource(tenant, session, current.get("previousRecordRef"));
        }
        if (!foundActive && (restored.path("configRevision").asLong(-1) != 0
                || restored.has("mcpAuthBindings") && !restored.path("mcpAuthBindings").isEmpty()
                || restored.has("executionActorKey") && !restored.path("executionActorKey").isNull())) {
            throw invalid();
        }
        if (restored.path("formatVersion").asInt() == 2) {
            if (bundle.path("formatVersion").asInt() != 2
                    || !ManagedExtensionRecords.same(
                            restored.path("mcpAuthBindings"), bundle.path("mcpAuthBindings"))
                    || !restored.path("executionActorKey").equals(bundle.path("executionActorKey"))) {
                throw invalid();
            }
        } else if (bundle.path("formatVersion").asInt() == 2
                && (!bundle.path("mcpAuthBindings").isEmpty() || !bundle.path("executionActorKey").isNull())) {
            throw invalid();
        }
    }

    private static boolean followsCommittedConfiguration(JdbcTemplate jdbc, String tenant,
            String session, JsonNode body) {
        if (!Set.of("active", "recovery_required").contains(body.path("phase").asText())) {
            return false;
        }
        JsonNode previous = ManagedMcpSettings.find(jdbc, tenant, session);
        if (!ManagedConfigInstall.isPackageConfig(previous)
                || !Set.of("committed", "recovery_required").contains(previous.path("phase").asText())) {
            return false;
        }
        try {
            ManagedConfigInstall.successor(previous, body);
        } catch (com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.InvalidRecordException failure) {
            throw invalid();
        }
        if (body.path("revision").asLong() != previous.path("revision").asLong() + 1) {
            throw invalid();
        }
        return true;
    }

    private static JsonNode readBundle(
            JdbcTemplate jdbc, String tenant, String session, JsonNode ref) {
        var rows =
                jdbc.query(
                        "SELECT inline_bytes,sha256,byte_length,kind,schema_version FROM"
                            + " ma_resource WHERE session_scope_key=? AND tenant_id=? AND"
                            + " session_id=? AND resource_id=?",
                        (row, index) -> {
                            byte[] bytes = row.getBytes(1);
                            if (bytes == null
                                    || bytes.length != row.getLong(3)
                                    || bytes.length != ref.path("byteLength").asLong()
                                    || !DigestUtils.sha256Hex(bytes).equals(row.getString(2))
                                    || !row.getString(2).equals(ref.path("digest").asText())
                                    || !"managed-extension-config-bundle".equals(row.getString(4))
                                    || row.getInt(5) != 1) {
                                throw invalid();
                            }
                            return ManagedExtensionRecordStore.parse(
                                    new String(bytes, StandardCharsets.UTF_8));
                        },
                        ManagedSessionStore.sessionScopeKey(tenant, session),
                        tenant,
                        session,
                        ref.path("resourceId").asText());
        if (rows.size() != 1) {
            throw invalid();
        }
        return rows.getFirst();
    }

    private static ManagedAgentException invalid() {
        return new ManagedAgentException(
                409,
                "personal_mcp_binding_conflict",
                "The personal MCP configuration binding is invalid or revoked.");
    }
}
