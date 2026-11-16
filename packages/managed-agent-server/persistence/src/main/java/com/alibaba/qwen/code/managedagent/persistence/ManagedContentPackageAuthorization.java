package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Writer-only package reads, pinned to the original configuration command. */
@Service
public class ManagedContentPackageAuthorization {
    private final JdbcTemplate jdbc;
    private final JdbcManagedSessionStore store;
    private final JdbcManagedExtensionRecordStore records;
    private final JdbcManagedSessionSkills skills;
    private final AgentStateStore sessions;

    public ManagedContentPackageAuthorization(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, JdbcManagedSessionStore store,
            JdbcManagedExtensionRecordStore records, JdbcManagedSessionSkills skills, AgentStateStore sessions) {
        this.jdbc = jdbc;
        this.store = store;
        this.records = records;
        this.skills = skills;
        this.sessions = sessions;
    }

    @Transactional("managedAgentTransactionManager")
    public void authorize(String tenant, String sessionId, String token, String workspaceId,
            String writerId, long writerGeneration, String operationId, Pin pin) {
        if (!ManagedConfigInstall.uuid(operationId) || pin == null || pin.settingsRevision() != null) {
            throw refused();
        }
        JsonNode selected = JournalStoreRows.CSI_JSON.valueToTree(pin);
        ManagedConfigInstall.pins(JournalStoreRows.CSI_JSON.createArrayNode().add(selected));
        store.authorizeOrdinary(tenant, sessionId, token,
                new ManagedSessionStoreModels.AuthorizeLifecycleRequest(workspaceId, writerId, writerGeneration, "configuration:" + operationId));
        var session = sessions.requireSession(tenant, sessionId);
        if (!WorkspaceToolProfiles.EXTERNAL_CONTENT.equals(session.toolProfile()) || session.publicChildAgentsVersion() != 1
                || session.workspace() == null || !workspaceId.equals(session.workspace().getWorkspaceId())
                || !"qwen-code".equals(session.agentId()) || session.agentDefinitionDigest() != null) {
            throw refused();
        }
        JsonNode current = ManagedMcpSettings.find(jdbc, tenant, sessionId);
        if (ManagedConfigInstall.isPackageConfig(current) && current.path("formatVersion").asInt() == 2
                && operationId.equals(current.path("command").path("operationId").asText())
                && !java.util.Set.of("active", "failed").contains(current.path("phase").asText())
                && contains(current.path("command").path("extensions"), selected)) {
            return;
        }
        var initial = skills.initialSelection(tenant, sessionId);
        if (initial != null) {
            JsonNode command = JournalStoreRows.CSI_JSON.valueToTree(initial);
            if (operationId.equals(command.path("operationId").asText()) && contains(command.path("extensions"), selected)) {
                return;
            }
        }
        var lineage = sessions.findChildLineage(tenant, sessionId);
        if (lineage != null) {
            var run = records.findRecord(tenant, lineage.parentSessionId(), "child_run", lineage.parentChildRunId()).orElseThrow(ManagedContentPackageAuthorization::refused);
            JsonNode launch = records.readRecordResource(tenant, lineage.parentSessionId(), run.required("inputRef")).path("publicLaunch");
            if (launch.path("version").asInt() == 2) {
                JsonNode ref = launch.path("extensionAgent").path("bundleRef");
                String expected = ManagedConfigInstall.derivedOperationId("managed-extension-child:", sessionId + ":" + ref.path("digest").asText());
                JsonNode bundle = records.readRecordResource(tenant, lineage.parentSessionId(), ref);
                if (operationId.equals(expected) && bundle.path("formatVersion").asInt() == 2) {
                    for (JsonNode entry : bundle.path("packages")) {
                        if (selected.equals(entry.path("pin"))) {
                            return;
                        }
                    }
                }
            }
        }
        throw refused();
    }

    private static boolean contains(JsonNode pins, JsonNode pin) {
        for (JsonNode selected : pins) {
            if (selected.equals(pin)) {
                return true;
            }
        }
        return false;
    }

    private static ManagedAgentException refused() {
        return new ManagedAgentException(409, "content_package_scope_conflict", "The package is not pinned to this configuration operation");
    }
}
