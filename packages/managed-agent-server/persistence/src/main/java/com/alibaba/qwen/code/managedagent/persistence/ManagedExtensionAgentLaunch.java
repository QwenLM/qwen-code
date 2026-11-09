package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/** Resolves an immutable package descriptor under the locked parent Session. */
public final class ManagedExtensionAgentLaunch {
    private ManagedExtensionAgentLaunch() { }

    public static void require(JdbcTemplate jdbc, ManagedExtensionRecordStore records,
            SessionRecord parent, JsonNode launch) {
        try {
            ManagedExtensionRecords.closed(launch, Set.of("version", "sourcePromptId", "approvalMode", "approvalRevision",
                    "modelId", "modelRevision", "modelRoute", "skillsRef", "extensionAgent"), "Package agent launch");
            JsonNode agent = launch.get("extensionAgent");
            ManagedExtensionRecords.closed(agent, Set.of("configRevision", "bundleRef", "pin", "contributionsRef", "agentName", "toolNames"), "Package agent binding");
            ManagedConfigStore.requireOpen(jdbc, parent.tenantId(), parent.sessionId());
            JsonNode current = ManagedMcpSettings.find(jdbc, parent.tenantId(), parent.sessionId());
            for (int step = 0; ManagedConfigInstall.isPackageConfig(current) && !"active".equals(current.path("phase").asText()); step++) {
                if (step >= 4096 || current.path("previousRecordRef").isNull()) {
                    throw refused();
                }
                current = records.readRecordResource(parent.tenantId(), parent.sessionId(), current.get("previousRecordRef"));
            }
            if (!ManagedConfigInstall.isPackageConfig(current) || !current.get("configRevision").equals(agent.get("configRevision"))
                    || !current.get("bundleRef").equals(agent.get("bundleRef"))) {
                throw refused();
            }
            JsonNode ownerRef = current.get("rootSnapshotRef");
            if (!"managed-extension-root".equals(ownerRef.path("kind").asText()) || ownerRef.path("schemaVersion").asInt() != 1) {
                throw refused();
            }
            requireRuntimeOwner(jdbc, parent, records.readRecordResource(parent.tenantId(), parent.sessionId(), ownerRef));
            JsonNode bundle = records.readRecordResource(parent.tenantId(), parent.sessionId(), agent.get("bundleRef"));
            JsonNode selected = null;
            for (JsonNode entry : bundle.path("packages")) {
                if (entry.path("pin").equals(agent.get("pin"))) {
                    selected = entry;
                }
            }
            if (selected == null || !selected.path("contributionsRef").equals(agent.get("contributionsRef"))) {
                throw refused();
            }
            JsonNode contributions = readContributions(records, parent.tenantId(), parent.sessionId(), agent.get("contributionsRef"));
            JsonNode descriptor = null;
            for (JsonNode entry : contributions.path("agents")) {
                if (entry.path("name").equals(agent.get("agentName"))) {
                    descriptor = entry;
                }
            }
            if (descriptor == null || !descriptor.path("systemPrompt").isTextual() || descriptor.path("systemPrompt").asText().isBlank()) {
                throw refused();
            }
            JsonNode tools = agent.get("toolNames");
            if (tools == null || !tools.isArray() || tools.size() > 256) {
                throw refused();
            }
            Set<String> seen = new HashSet<>();
            Set<String> allow = names(descriptor.path("tools"));
            Set<String> deny = names(descriptor.path("disallowedTools"));
            for (JsonNode tool : tools) {
                String name = tool.asText();
                if (!tool.isTextual() || !seen.add(name) || !profileTool(parent.toolProfile(), name)
                        || !allow.isEmpty() && !allow.contains(name) || deny.contains(name)) {
                    throw refused();
                }
            }
            var policies = jdbc.queryForList("SELECT COALESCE(selected_approval_mode, approval_mode) AS mode, approval_revision"
                    + " FROM ma_session WHERE tenant_id=? AND session_id=? FOR UPDATE", parent.tenantId(), parent.sessionId());
            if (policies.size() != 1 || !launch.path("approvalMode").asText().equals(policies.getFirst().get("mode"))
                    || !(policies.getFirst().get("approval_revision") instanceof Number revision)
                    || launch.path("approvalRevision").asLong(-1) != revision.longValue()) {
                throw refused();
            }
        } catch (ManagedExtensionRecords.InvalidRecordException error) {
            throw refused();
        }
    }

    static void requireRuntimeOwner(JdbcTemplate jdbc, SessionRecord parent, JsonNode owner) {
        JsonNode runtime = owner.path("runtime");
        String generation = runtime.path("generation").asText();
        if (parent.workspace() == null || !runtime.path("bindingId").isTextual()
                || runtime.path("bindingId").asText().isBlank() || !runtime.path("generation").isTextual()
                || !runtime.path("workspaceGeneration").isTextual() || !generation.matches("[1-9][0-9]{0,18}")
                || !Long.toString(parent.workspace().getWorkspaceGeneration()).equals(runtime.path("workspaceGeneration").asText())) {
            throw refused();
        }
        long selectedGeneration;
        try {
            selectedGeneration = Long.parseLong(generation);
        } catch (NumberFormatException invalid) {
            throw refused();
        }
        var capabilities = jdbc.queryForList("SELECT b.capability_digest FROM ma_runtime_binding b"
                + " JOIN ma_runtime_slot s ON s.request_key=b.request_key AND s.active_binding_id=b.binding_id"
                + " AND s.last_generation=b.runtime_generation WHERE b.binding_id=? AND b.runtime_generation=?"
                + " AND b.tenant_id=? AND b.workspace_id=? AND b.workspace_generation=? AND b.storage_id=?"
                + " AND b.isolation_class='session' AND b.isolation_key=? AND b.binding_state='READY'"
                + " AND b.drain_requested=FALSE AND b.runtime_instance_id IS NOT NULL AND b.runtime_lease_id IS NOT NULL FOR UPDATE",
                String.class, runtime.path("bindingId").asText(), selectedGeneration, parent.tenantId(),
                parent.workspace().getWorkspaceId(), Long.toString(parent.workspace().getWorkspaceGeneration()),
                parent.workspace().getStorageId(), parent.sessionId());
        if (capabilities.size() != 1) {
            throw refused();
        }
        String capability = capabilities.getFirst();
        String mode = owner.path("executionMode").asText();
        if (!(com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile.LINUX_CAPABILITY_DIGEST.equals(capability)
                        && "linux-cgroup".equals(mode)
                || com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST.equals(capability)
                        && "developer-process-group".equals(mode))) {
            throw refused();
        }
    }

    public static JsonNode readContributions(ManagedExtensionRecordStore records, String tenant, String session, JsonNode ref) {
        JsonNode manifest = records.readRecordResource(tenant, session, ref);
        ManagedExtensionRecords.closed(manifest, Set.of("kind", "formatVersion", "byteLength", "digest", "parts"), "Contribution manifest");
        long length = ManagedExtensionRecords.count(manifest.get("byteLength"), 1, 2 * 1024 * 1024, "Contribution length");
        if (!"managed-extension-contributions".equals(manifest.path("kind").asText()) || manifest.path("formatVersion").asInt() != 1
                || !manifest.path("parts").isArray() || manifest.path("parts").isEmpty() || manifest.path("parts").size() > 32) {
            throw refused();
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Set<String> ids = new HashSet<>();
        for (JsonNode part : manifest.get("parts")) {
            if (!"managed-extension-contributions-part".equals(part.path("kind").asText()) || !ids.add(part.path("resourceId").asText())) {
                throw refused();
            }
            var resource = records.readCommittedResource(tenant, session, part);
            if (resource.byteLength() > ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES || output.size() + resource.byteLength() > length) {
                throw refused();
            }
            output.writeBytes(resource.bytes());
        }
        byte[] bytes = output.toByteArray();
        if (bytes.length != length || !DigestUtils.sha256Hex(bytes).equals(manifest.path("digest").asText())) {
            throw refused();
        }
        JsonNode contributions = com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.parse(new String(bytes, StandardCharsets.UTF_8));
        if (contributions == null) {
            throw refused();
        }
        return contributions;
    }

    private static Set<String> names(JsonNode values) {
        Set<String> result = new HashSet<>();
        if (values.isMissingNode()) {
            return result;
        }
        if (!values.isArray()) {
            throw refused();
        }
        for (JsonNode value : values) {
            if (!value.isTextual()) {
                throw refused();
            }
            result.add(value.asText());
        }
        return result;
    }

    private static boolean profileTool(String profile, String name) {
        if (Set.of("read_file", "glob", "skill").contains(name)) {
            return true;
        }
        if (WorkspaceToolProfiles.READ.equals(profile)) {
            return false;
        }
        if (Set.of("write_file", "edit", "todo_write").contains(name)) {
            return true;
        }
        if (WorkspaceToolProfiles.SHELL.equals(profile) && Set.of("run_shell_command", "monitor", "web_fetch").contains(name)) {
            return true;
        }
        return WorkspaceToolProfiles.isShellOrMcp(profile) && name.matches("mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+");
    }

    private static ManagedAgentException refused() {
        return new ManagedAgentException(409, "child_launch_snapshot_invalid", "The package agent does not belong to the parent's active configuration.");
    }
}
