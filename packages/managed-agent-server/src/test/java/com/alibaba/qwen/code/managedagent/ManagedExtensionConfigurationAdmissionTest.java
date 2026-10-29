package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.persistence.ManagedMcpSettings;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.AopTestUtils;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-extension-admission;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedExtensionConfigurationAdmissionTest {
    @Autowired private ManagedSessionStore store;
    @Autowired private AgentStateStore sessions;
    @Qualifier("managedJdbcTemplate")
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ObjectMapper json;
    @Qualifier("managedAgentTransactionManager")
    @Autowired private PlatformTransactionManager transactionManager;

    @BeforeEach
    void enableOnlyTheStoreAdmissionBranch() {
        Object target = AopTestUtils.getUltimateTargetObject(sessions);
        ReflectionTestUtils.setField(target, "workspaceFilesEnabled", true);
    }

    @Test
    void liveChildBlocksBothOperatorSelectionAndConfigurationCommitButNotASiblingSession() throws Exception {
        String workspace = registerWorkspace();
        String parent = UUID.randomUUID().toString();
        String sibling = UUID.randomUUID().toString();
        var journal = publicJournal(parent, workspace);
        publicJournal(sibling, workspace);
        ObjectNode child = ManagedChildRunRecordContractTest.fixtures().required("templates").required("child_agent").deepCopy();
        child.put("childRunId", "live-child").put("rootSessionId", parent);
        byte[] inputBytes = "{}".getBytes(StandardCharsets.UTF_8);
        var input = new CommitResource("child-input", "managed-input", 1, inputBytes.length, DigestUtils.sha256Hex(inputBytes),
                Base64.getEncoder().encodeToString(inputBytes));
        child.putObject("inputRef").put("resourceId", input.resourceId()).put("kind", input.kind()).put("schemaVersion", input.schemaVersion())
                .put("byteLength", input.byteLength()).put("digest", input.digest());
        commitChild(journal, child, input, "admitted", 1_000);
        String operation = UUID.randomUUID().toString();
        ObjectNode content = ManagedConfigInstallContractTest.record(ManagedConfigInstallContractTest.content("nullable_preparing"), 1);
        assertBusy(() -> transaction(() -> sessions.requireExtensionManagement("tenant", "actor", parent, operation, true)));
        assertBusy(() -> transaction(() -> {
            sessions.requireConfigurationCommit("tenant", workspace, parent, content);
            return null;
        }));
        assertThatCode(() -> transaction(() -> sessions.requireExtensionManagement("tenant", "actor", sibling, operation, true))).doesNotThrowAnyException();
        assertThatCode(() -> transaction(() -> {
            sessions.requireConfigurationCommit("tenant", workspace, sibling, content);
            return null;
        })).doesNotThrowAnyException();
        child.put("stopRequested", true).put("stopReason", "stop_requested");
        ((ObjectNode) child.required("run")).put("state", "cancelled").put("execution", "not_started_proven");
        ((ObjectNode) child.path("run").required("delivery")).put("state", "cancelled");
        commitChild(journal, child, input, "cancelled", 1_001);
        assertThatCode(() -> transaction(() -> sessions.requireExtensionManagement("tenant", "actor", parent, operation, true))).doesNotThrowAnyException();
    }

    private void commitChild(ExtensionRecordJournal journal, ObjectNode child, CommitResource input, String phase, long occurredAt) {
        var request = journal.request("commitDomainRecord", "live-child:" + phase, ExtensionRecordJournal.bytes(child), occurredAt,
                event -> ((ObjectNode) event.path("payload")).put("operationId", "live-child"), records -> records,
                0, "child_run", List.of(input));
        journal.commit(request);
        journal.committed(request);
    }

    @Test
    void committedPhaseRequiresAtomicMatchingConfigBindingAndItsBarrierStaysSessionScoped() throws Exception {
        String workspace = registerWorkspace();
        String id = UUID.randomUUID().toString();
        String sibling = UUID.randomUUID().toString();
        var journal = publicJournal(id, workspace);
        publicJournal(sibling, workspace);
        ObjectNode preparing = phase("nullable_preparing", 1, null);
        commit(journal, id, workspace, preparing, false, false);
        ObjectNode prepared = phase("prepared", 2, preparing);
        commit(journal, id, workspace, prepared, false, false);
        ObjectNode committed = phase("prepared", 3, prepared).put("phase", "committed");
        assertThatThrownBy(() -> commit(journal, id, workspace, committed, false, false)).isInstanceOf(ManagedAgentException.class);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id).path("phase").asText()).isEqualTo("prepared");
        assertThatThrownBy(() -> commit(journal, id, workspace, committed, true, true)).isInstanceOf(ManagedAgentException.class);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id).path("phase").asText()).isEqualTo("prepared");
        commit(journal, id, workspace, committed, true, false);
        assertThat(transaction(() -> ManagedConfigInstall.blocked(jdbc, "tenant", id))).isTrue();
        assertThat(transaction(() -> ManagedConfigInstall.blocked(jdbc, "tenant", sibling))).isFalse();
        assertThatCode(() -> transaction(() -> sessions.requireExtensionManagement("tenant", "actor", sibling, UUID.randomUUID().toString(), true))).doesNotThrowAnyException();
        assertThatThrownBy(() -> transaction(() -> sessions.requireExtensionManagement("tenant", "actor", id, UUID.randomUUID().toString(), true)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("session_config_recovery_required"));
    }

    private void commit(ExtensionRecordJournal journal, String id, String workspace, ObjectNode body,
            boolean binding, boolean mismatch) {
        String operation = body.path("operationId").asText();
        var request = journal.request("commitDomainRecord", operation + ":phase:" + body.path("revision").asLong(), ExtensionRecordJournal.bytes(body), 1000,
                event -> ((ObjectNode) event.path("payload")).put("operationId", operation), records -> {
                    if (!binding) {
                        return records;
                    }
                    ObjectNode event = json.createObjectNode().put("v", 1).put("sequence", journal.committedSequence() + 2)
                            .put("eventId", "config-bound:" + body.path("revision").asLong()).put("kind", "config.bound").put("occurredAt", 1000);
                    event.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", workspace).put("sessionId", id);
                    ObjectNode payload = event.putObject("payload").put("revision", mismatch ? 99 : body.path("configRevision").asLong());
                    payload.putNull("previousRevision").set("bundleRef", body.get("bundleRef"));
                    payload.set("rootSnapshotRef", body.get("rootSnapshotRef"));
                    int cut = records.indexOf('\n') + 1;
                    return records.substring(0, cut) + ExtensionRecordJournal.line(id, "managed_session_event_v1", event) + records.substring(cut);
                }, binding ? 1 : 0, "config_install", resources());
        journal.commit(request);
        journal.committed(request);
    }

    private ObjectNode phase(String name, long revision, JsonNode previous) throws Exception {
        ObjectNode body = ManagedConfigInstallContractTest.record(ManagedConfigInstallContractTest.content(name), revision);
        if (previous != null) {
            byte[] bytes = ExtensionRecordJournal.bytes(previous);
            body.putObject("previousRecordRef").put("resourceId", ExtensionRecordJournal.resourceId(bytes)).put("kind", "managed-config_install")
                    .put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", DigestUtils.sha256Hex(bytes));
        }
        for (String field : List.of("rootSnapshotRef", "bundleRef")) {
            if (!body.path(field).isNull()) {
                ((ObjectNode) body.path(field)).put("digest", DigestUtils.sha256Hex("{}"));
            }
        }
        for (String field : List.of("stageAckRefs", "enableAckRefs")) {
            for (JsonNode ref : body.path(field)) {
                ((ObjectNode) ref).put("digest", DigestUtils.sha256Hex("{}"));
            }
        }
        return body;
    }

    private List<CommitResource> resources() {
        List<CommitResource> resources = new ArrayList<>();
        for (String id : List.of("root", "bundle", "hstage", "rstage", "henable", "renable")) {
            resources.add(new CommitResource(id, "managed-test", 1, 2, DigestUtils.sha256Hex("{}"), Base64.getEncoder().encodeToString("{}".getBytes(StandardCharsets.UTF_8))));
        }
        return resources;
    }

    private String registerWorkspace() {
        String workspace = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                        + " VALUES ('tenant', ?, 1, 'storage', ?, ?, ?, 'ACTIVE')", workspace, workspace, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES ('tenant', ?, ?, 'OPERATOR')", workspace, "actor".getBytes(StandardCharsets.UTF_8));
        return workspace;
    }

    private ExtensionRecordJournal publicJournal(String id, String workspace) {
        var journal = new ExtensionRecordJournal(store, "tenant", workspace, id).open();
        jdbc.update("UPDATE ma_session SET session_kind='PUBLIC', agent_id='qwen-code', workspace_id=?, workspace_generation=1, workspace_storage_id='storage',"
                + " cwd_relative='.', context_config_ref=?, context_revision=1, workspace_config_ref=?, workspace_policy_ref=?, creator_actor_key=?,"
                + " tool_profile='hosted-workspace-shell/1' WHERE tenant_id=? AND session_id=?", workspace, WorkspaceExecutionProfile.CONTEXT_CONFIG_REF,
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF, "actor".getBytes(StandardCharsets.UTF_8),
                "tenant".getBytes(StandardCharsets.UTF_8), id.getBytes(StandardCharsets.UTF_8));
        return journal;
    }

    private <T> T transaction(java.util.function.Supplier<T> work) { return new TransactionTemplate(transactionManager).execute(status -> work.get()); }
    private void assertBusy(org.assertj.core.api.ThrowableAssert.ThrowingCallable work) {
        assertThatThrownBy(work).isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("session_context_busy"));
    }
}
