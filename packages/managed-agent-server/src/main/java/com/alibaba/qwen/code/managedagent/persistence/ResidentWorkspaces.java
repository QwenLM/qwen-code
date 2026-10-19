package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.HashSet;
import java.util.List;

/** Explicit administrator selection; a CSI registration alone never enables public execution. */
public final class ResidentWorkspaces {
    private final List<ResidentWorkspace> configured;

    public ResidentWorkspaces(List<ResidentWorkspace> configured) {
        this.configured = List.copyOf(configured);
        var workspaces = new HashSet<List<String>>();
        var aliases = new HashSet<String>();
        var physical = new HashSet<String>();
        for (var entry : configured) {
            if (!workspaces.add(List.of(entry.registration().tenantId(), entry.workspaceId()))
                    || !aliases.add(entry.registration().aliasKey()) || !physical.add(entry.registration().physicalKey())) {
                throw new IllegalArgumentException("Resident Workspace ownership is duplicated");
            }
        }
    }

    public ResidentWorkspace find(ContextBinding binding) {
        if (binding == null) {
            return null;
        }
        return configured.stream().filter(value -> value.registration().tenantId().equals(binding.getTenantId())
                && value.workspaceId().equals(binding.getWorkspaceId())
                && value.workspaceGeneration() == binding.getWorkspaceGeneration()
                && value.registration().storageId().equals(binding.getStorageId())
                && WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(binding.getContextConfigRef()))
                .findFirst().orElse(null);
    }

    public ResidentWorkspace require(RuntimeScope scope) {
        if (!ResidentWorkspaceProfile.selects(scope)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return configured.stream().filter(value -> value.registration().tenantId().equals(scope.getTenantId())
                && value.workspaceId().equals(scope.getWorkspaceId())
                && Long.toString(value.workspaceGeneration()).equals(scope.getWorkspaceGeneration())
                && value.registration().mountRoot().equals(scope.getCanonicalCwd()))
                .findFirst().orElseThrow(WorkspaceExecutionStore::unavailable);
    }

    public RuntimeProvisionRequest request(ContextBinding binding) {
        var selected = find(binding);
        if (selected == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return new RuntimeProvisionRequest(scope(selected), null, WorkspaceCsiReservationStore.PROVISIONER_KIND,
                selected.registration().storageId());
    }

    public static RuntimeScope scope(ResidentWorkspace selected) {
        return new RuntimeScope(selected.registration().tenantId(), selected.workspaceId(),
                Long.toString(selected.workspaceGeneration()), selected.registration().mountRoot(),
                ResidentWorkspaceProfile.CAPABILITY_DIGEST, "workspace");
    }

    public void requireCreation(JdbcTemplate jdbc, ContextBinding binding, String profile) {
        var selected = find(binding);
        if (selected == null || !WorkspaceToolProfiles.FILES.equals(profile)) {
            throw WorkspaceExecutionStore.unavailable();
        }
        requireRegistration(jdbc, selected);
        // The caller already owns ma_workspace FOR UPDATE. Use locking reads under RR.
        if (!jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ? AND workspace_id = ?"
                + " AND session_kind = 'PUBLIC' AND status NOT IN ('CLOSED', 'ARCHIVED', 'DELETED') FOR UPDATE", String.class,
                binding.getTenantId(), binding.getWorkspaceId()).isEmpty()
                || !jdbc.queryForList("SELECT rs.runtime_session_id FROM ma_runtime_session rs"
                + " JOIN ma_runtime_binding b ON b.binding_id = rs.binding_id"
                + " WHERE b.tenant_id = ? AND b.workspace_id = ? AND rs.session_state <> 'RELEASED' FOR UPDATE",
                String.class, binding.getTenantId(), binding.getWorkspaceId()).isEmpty()) {
            throw WorkspaceExecutionStore.busy();
        }
    }

    public static void requireRegistration(JdbcTemplate jdbc, ResidentWorkspace selected) {
        var registration = selected.registration();
        var rows = jdbc.queryForList("SELECT registration_json FROM ma_storage WHERE alias_key = ?"
                + " AND tenant_id = ? AND storage_id = ? AND physical_key = ? AND storage_kind = 'CSI'"
                + " AND registration_state = 'REGISTERED' AND registration_revision = ?",
                String.class, registration.aliasKey(), registration.tenantId(), registration.storageId(),
                registration.physicalKey(), registration.revision());
        try {
            if (rows.size() != 1 || !registration.equals(new com.fasterxml.jackson.databind.ObjectMapper()
                    .enable(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                    .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                    .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .readValue(rows.getFirst(), WorkspaceCsiRegistration.class))) {
                throw WorkspaceExecutionStore.unavailable();
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    public boolean verifyClosed(JdbcTemplate jdbc, String tenantId, String sessionId) {
        if (configured.isEmpty()) {
            return false;
        }
        var sessions = jdbc.query("SELECT workspace_id, workspace_generation, workspace_storage_id, cwd_relative,"
                + " context_config_ref, context_revision, tool_profile, status, parent_session_id FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", (row, index) -> {
                    if (row.getString("workspace_id") == null) {
                        return null;
                    }
                    return new ContextBinding(tenantId, row.getString("workspace_id"), row.getLong("workspace_generation"),
                            row.getString("workspace_storage_id"), row.getString("cwd_relative"),
                            row.getString("context_config_ref"), row.getLong("context_revision"));
                }, tenantId, sessionId);
        if (sessions.size() != 1 || find(sessions.getFirst()) == null) {
            if (sessions.size() == 1 && sessions.getFirst() != null) {
                WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenantId, sessions.getFirst().getStorageId());
            }
            return false;
        }
        var binding = sessions.getFirst();
        var selected = find(binding);
        if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                + " AND session_kind = 'PUBLIC' AND parent_session_id IS NULL AND tool_profile = ?"
                + " AND status IN ('CLOSING', 'DELETING')", Long.class, tenantId, sessionId, WorkspaceToolProfiles.FILES) != 1) {
            throw WorkspaceExecutionStore.unavailable();
        }
        requireRegistration(jdbc, selected);
        var originals = jdbc.query("SELECT b.binding_id, b.runtime_generation FROM ma_runtime_binding b"
                + " JOIN ma_runtime_slot slot ON slot.active_binding_id = b.binding_id AND slot.request_key = b.request_key"
                + " WHERE b.request_key = ? AND b.tenant_id = ? AND b.workspace_id = ? AND b.workspace_generation = ?"
                + " AND b.canonical_cwd = ? AND b.storage_id = ? AND b.capability_digest = ?"
                + " AND b.isolation_class = 'workspace' AND b.isolation_key IS NULL"
                + " AND b.provisioner_kind = 'kubernetes-workspace' AND b.binding_state = 'READY'"
                + " AND b.drain_requested = FALSE AND b.resource_handle_json IS NOT NULL"
                + " AND b.provision_seed_ciphertext IS NOT NULL AND b.attestation_generation > 0 FOR UPDATE",
                (row, index) -> new Original(row.getString(1), row.getLong(2)), request(binding).requestKey(), tenantId,
                binding.getWorkspaceId(), Long.toString(binding.getWorkspaceGeneration()), selected.registration().mountRoot(),
                binding.getStorageId(), ResidentWorkspaceProfile.CAPABILITY_DIGEST);
        var owners = jdbc.queryForList("SELECT binding_id FROM ma_runtime_session WHERE tenant_id = ?"
                + " AND harness_session_id = ? FOR UPDATE", String.class, tenantId, sessionId);
        if (originals.isEmpty()) {
            if (!owners.isEmpty() || !jdbc.queryForList("SELECT binding_id FROM ma_runtime_binding WHERE request_key = ? FOR UPDATE",
                    String.class, request(binding).requestKey()).isEmpty()) {
                throw WorkspaceExecutionStore.unavailable();
            }
            return true;
        }
        if (originals.size() != 1) {
            throw WorkspaceExecutionStore.unavailable();
        }
        var original = originals.getFirst();
        if (owners.stream().anyMatch(value -> !original.id().equals(value))
                || !jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session WHERE tenant_id = ?"
                    + " AND harness_session_id = ? AND (binding_id <> ? OR runtime_generation <> ?"
                    + " OR workspace_id <> ? OR workspace_generation <> ? OR capability_digest <> ?"
                    + " OR canonical_cwd <> ? OR isolation_class <> 'workspace' OR session_state <> 'RELEASED') FOR UPDATE",
                    String.class, tenantId, sessionId, original.id(), original.generation(), binding.getWorkspaceId(),
                    Long.toString(binding.getWorkspaceGeneration()), ResidentWorkspaceProfile.CAPABILITY_DIGEST,
                    selected.registration().mountRoot()).isEmpty()
                || !jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session WHERE binding_id = ?"
                    + " AND runtime_generation = ? AND session_state <> 'RELEASED' FOR UPDATE", String.class,
                    original.id(), original.generation()).isEmpty()
                || jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'CSI'"
                    + " AND csi_phase = 'RESERVED' AND csi_revision = 1 AND binding_id = ? AND runtime_generation = ?"
                    + " AND csi_registration_key = ? AND csi_registration_revision = ? AND holder_key IS NULL"
                    + " AND runtime_session_id IS NULL", Long.class, selected.registration().physicalKey(),
                    original.id(), original.generation(), selected.registration().aliasKey(), selected.registration().revision()) != 1
                || !jdbc.queryForList("SELECT execution_call_id FROM ma_tool_execution WHERE binding_id = ?"
                    + " AND runtime_generation = ? AND execution_state <> 'SETTLED' FOR UPDATE",
                    String.class, original.id(), original.generation()).isEmpty()) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return true;
    }

    private record Original(String id, long generation) { }
}
