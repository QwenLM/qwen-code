package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.ManagedMcpSettings;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-mcp-settings;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedMcpSettingsStoreTest {
    @Autowired private ManagedSessionStore store;
    @Autowired private AgentStateStore sessions;
    @Qualifier("managedJdbcTemplate")
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ObjectMapper json;
    @Qualifier("managedAgentTransactionManager")
    @Autowired private PlatformTransactionManager transactionManager;

    @Test
    void settingsSurviveReaderRecreationAndDisabledSelectionsRetainTheMcpOwnerObligation() throws Exception {
        String id = UUID.randomUUID().toString();
        var journal = publicJournal(id);
        ObjectNode first = settings(1, "enabled", null);
        var request = journal.requestOrdinary(first.path("operationId").asText(), "config_install", first,
                event -> {}, records -> records, 0);
        journal.commit(request);
        journal.committed(request);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id)).isEqualTo(json.readTree(first.toString()));
        ObjectNode disabled = settings(2, "disabled", first);
        var disable = journal.requestOrdinary(disabled.path("operationId").asText(), "config_install", disabled,
                event -> {}, records -> records, 0);
        journal.commit(disable);
        journal.committed(disable);
        assertThat(ManagedMcpSettings.find(new JdbcTemplate(jdbc.getDataSource()), "tenant", id)).isEqualTo(json.readTree(disabled.toString()));
        assertThat(ManagedMcpSettings.find(jdbc, "other-tenant", id)).isNull();
        SessionRecord session = mock(SessionRecord.class);
        when(session.tenantId()).thenReturn("tenant");
        when(session.sessionId()).thenReturn(id);
        when(session.toolProfile()).thenReturn("hosted-workspace-shell/1");
        assertThat(sessions.hasMcpServers(session)).isTrue();
        when(session.agentDefinitionDigest()).thenReturn("a".repeat(64));
        when(session.agentId()).thenReturn("missing-definition");
        when(session.agentRevision()).thenReturn("1");
        assertThatThrownBy(() -> sessions.hasMcpServers(session)).isInstanceOf(ManagedAgentException.class);
        when(session.agentDefinitionDigest()).thenReturn(null);
        when(session.toolProfile()).thenReturn("hosted-workspace-read/1");
        assertThat(sessions.hasMcpServers(session)).isFalse();
        ObjectNode stale = settings(2, "removed", first);
        var staleRequest = journal.requestOrdinary(stale.path("operationId").asText(), "config_install", stale,
                event -> {}, records -> records, 0);
        assertThatThrownBy(() -> journal.commit(staleRequest)).isInstanceOf(ManagedAgentException.class);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id)).isEqualTo(json.readTree(disabled.toString()));
        jdbc.update("UPDATE ma_resource SET inline_bytes=? WHERE tenant_id=? AND session_id=? AND resource_id=?",
                new byte[] {1}, "tenant", id, ExtensionRecordJournal.resourceId(ExtensionRecordJournal.bytes(disabled)));
        assertThatThrownBy(() -> ManagedMcpSettings.find(jdbc, "tenant", id)).isInstanceOf(RuntimeException.class);
    }

    @Test
    void recipesAndBrokenPredecessorsCannotCommitAnOverride() throws Exception {
        String id = UUID.randomUUID().toString();
        var journal = publicJournal(id);
        ObjectNode invalid = settings(1, "enabled", null);
        ((ObjectNode) invalid.path("servers").get(0)).put("command", "private-recipe");
        var request = journal.requestOrdinary(invalid.path("operationId").asText(), "config_install", invalid,
                event -> {}, records -> records, 0);
        assertThatThrownBy(() -> journal.commit(request)).isInstanceOf(ManagedAgentException.class);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id)).isNull();
        ObjectNode first = settings(1, "enabled", null);
        var committed = journal.requestOrdinary(first.path("operationId").asText(), "config_install", first,
                event -> {}, records -> records, 0);
        journal.commit(committed);
        journal.committed(committed);
        ObjectNode invalidPrevious = settings(2, "disabled", first);
        ((ObjectNode) invalidPrevious.path("previousRecordRef")).put("digest", "c".repeat(64));
        var broken = journal.requestOrdinary(invalidPrevious.path("operationId").asText(), "config_install", invalidPrevious,
                event -> {}, records -> records, 0);
        assertThatThrownBy(() -> journal.commit(broken)).isInstanceOf(ManagedAgentException.class);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id)).isEqualTo(json.readTree(first.toString()));
    }

    @Test
    void intentWaitsForThePlanAdmissionRowLockAndReadsItsCommittedWinner() throws Exception {
        String id = UUID.randomUUID().toString();
        var journal = publicJournal(id);
        ObjectNode first = settings(1, "enabled", null);
        var request = journal.requestOrdinary(first.path("operationId").asText(), "config_install", first,
                event -> {}, records -> records, 0);
        var started = new CountDownLatch(1);
        var pending = new AtomicReference<Future<?>>();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                jdbc.queryForObject("SELECT session_id FROM ma_session WHERE tenant_id=? AND session_id=? FOR UPDATE",
                        String.class, "tenant", id);
                jdbc.update("UPDATE ma_session SET plan_enabled=TRUE, selected_approval_mode='default', approval_revision=1"
                        + " WHERE tenant_id=? AND session_id=?", "tenant", id);
                pending.set(executor.submit(() -> {
                    started.countDown();
                    return journal.commit(request);
                }));
                try {
                    assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new AssertionError(error);
                }
                assertThatThrownBy(() -> pending.get().get(100, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            });
            assertThatThrownBy(() -> pending.get().get(10, TimeUnit.SECONDS)).isInstanceOfSatisfying(ExecutionException.class,
                    error -> assertThat(error.getCause()).isInstanceOfSatisfying(ManagedAgentException.class,
                            refusal -> assertThat(refusal.getCode()).isEqualTo("unsupported_feature")));
        }
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id)).isNull();
    }

    @Test
    void settingsIntentRechecksPlanAndTurnAdmissionBeforeItCommits() throws Exception {
        String id = UUID.randomUUID().toString();
        var journal = publicJournal(id);
        ObjectNode first = settings(1, "enabled", null);
        var request = journal.requestOrdinary(first.path("operationId").asText(), "config_install", first,
                event -> {}, records -> records, 0);
        jdbc.update("UPDATE ma_session SET plan_enabled=TRUE, selected_approval_mode='default', approval_revision=1"
                + " WHERE tenant_id=? AND session_id=?", "tenant", id);
        assertThatThrownBy(() -> journal.commit(request)).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo("unsupported_feature"));
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id)).isNull();
        jdbc.update("UPDATE ma_session SET plan_enabled=FALSE WHERE tenant_id=? AND session_id=?", "tenant", id);
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest, status, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'turn', ?, '[]', 'digest', 'ACCEPTED', 1, 1)", "tenant", id, UUID.randomUUID().toString());
        assertThatThrownBy(() -> journal.commit(request)).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo("turn_active"));
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id)).isNull();
        jdbc.update("UPDATE ma_turn SET status='COMPLETED' WHERE tenant_id=? AND session_id=?", "tenant", id);
        journal.commit(request);
        assertThat(ManagedMcpSettings.find(jdbc, "tenant", id)).isEqualTo(json.readTree(first.toString()));
    }

    private ExtensionRecordJournal publicJournal(String id) {
        var journal = new ExtensionRecordJournal(store, "tenant", "workspace", id).open();
        jdbc.update("UPDATE ma_session SET session_kind='PUBLIC', agent_id='qwen-code', workspace_id=?,"
                + " workspace_generation=1, workspace_storage_id='storage', cwd_relative='.', context_config_ref=?,"
                + " context_revision=1, workspace_config_ref=?, workspace_policy_ref=?,"
                + " tool_profile='hosted-workspace-shell/1' WHERE tenant_id=? AND session_id=?",
                "workspace", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF, "tenant", id);
        return journal;
    }

    private ObjectNode settings(long revision, String state, JsonNode previous) throws Exception {
        String operation = UUID.randomUUID().toString();
        ObjectNode result = json.createObjectNode().put("kind", "hosted-mcp-settings").put("schemaVersion", 1)
                .put("operationId", operation).put("revision", revision);
        result.putArray("servers").addObject().put("serverId", "docs").put("serverRevision", 1)
                .put("definitionDigest", "a".repeat(64)).put("state", state);
        var command = result.putObject("command").put("operationId", operation).put("actorKey", "b".repeat(64))
                .put("action", revision == 1 ? "add" : "disable").put("serverId", "docs").put("expectedRevision", revision - 1);
        if (revision == 1) {
            command.putObject("server").put("serverId", "docs").put("serverRevision", 1).put("definitionDigest", "a".repeat(64));
        }
        if (previous == null) {
            result.putNull("previousRecordRef");
        } else {
            byte[] bytes = json.writeValueAsBytes(previous);
            result.putObject("previousRecordRef").put("resourceId", ExtensionRecordJournal.resourceId(bytes))
                    .put("kind", "managed-config_install").put("schemaVersion", 1).put("byteLength", bytes.length)
                    .put("digest", DigestUtils.sha256Hex(bytes));
        }
        return result;
    }
}
