package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellModelChangeResult;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellModelSelection;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionLineage;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.when;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:model-selection;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedModelSelectionTest {
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ObjectMapper json;
    @Autowired private ManagedWorkspaceRegistry registry;
    @Autowired private PlatformTransactionManager manager;
    private String tenant;
    private String session;
    private ManagedAgentStore store;
    private ManagedAgentService service;
    private HarnessConnector harness;

    @BeforeEach
    void setup() {
        tenant = "model-selection-" + UUID.randomUUID();
        jdbc.update("INSERT INTO ma_workspace (tenant_id,workspace_id,workspace_generation,storage_id,"
                + "display_name,config_ref,policy_ref,state) VALUES (?,'ws',1,'storage','Workspace',?,?,'ACTIVE')",
                tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        grant("actor", "OWNER");
        store = store(true);
        harness = mock(HarnessConnector.class);
        when(harness.supportsModelSelection()).thenReturn(true);
        service = service(store);
        session = transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "create",
                "qwen-code", null, null, null, List.of(), new WorkspaceSelection("ws", "."))).sessionId();
    }

    @Test
    void publishesOnlyHostCatalogAndPersistsSelectionWithoutChangingAgentIdentity() {
        var before = store.requireSession(tenant, session);
        var options = service.queryWebShellSessionModels(tenant, "actor", session);
        assertThat(options.supported()).isTrue();
        assertThat(options.models()).extracting(option -> option.modelId()).containsExactly("model-a", "model-b");
        assertThat(options.modelSelection()).isEqualTo(new WebShellModelSelection(null, 0));
        var changed = change("actor", "first", "model-a", 0);
        assertThat(changed.modelSelection()).isEqualTo(new WebShellModelSelection("model-a", 1));
        assertThat(changed.replayed()).isFalse();
        var after = store.requireSession(tenant, session);
        assertThat(after.agentId()).isEqualTo(before.agentId());
        assertThat(after.agentRevision()).isEqualTo(before.agentRevision());
        assertThat(after.agentDefinitionDigest()).isEqualTo(before.agentDefinitionDigest());
        assertThat(after.approvalMode()).isEqualTo(before.approvalMode());
        assertThat(store(true).findModelSelections(tenant, List.of(session))).containsEntry(session, changed.modelSelection());
        var summary = service.getWebShellSession(tenant, "actor", session);
        assertThat(summary.modelSelection()).isEqualTo(changed.modelSelection());
        assertThat(summary.capabilities().modelChange()).isTrue();
        assertThat(service.listWebShellSessions(tenant, "actor", null, 100).data()).singleElement()
                .satisfies(row -> assertThat(row.modelSelection()).isEqualTo(changed.modelSelection()));
    }

    @Test
    void workflowChildFirstTurnDoesNotInheritTheParentsSelectedModel() {
        change("actor", "selected-parent", "model-a", 0);
        var input = List.<Map<String, Object>>of(Map.of("type", "workflow_launch"));
        var child = transaction().execute(status -> store.insertChildSessionCommand(
                tenant, session, "workflow-child", "child-digest", "Workflow", input,
                SubmitHarnessTurn.computePayloadDigest(input),
                new SessionLineage(session, session, "workflow-run", 1)));
        assertThat(child.turnId()).isNotNull();
        var firstTurn = store.findTurn(tenant, child.sessionId(), child.turnId()).orElseThrow();
        assertThat(jdbc.queryForMap("SELECT model_id, model_revision FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, child.sessionId()))
                .containsEntry("model_id", null).containsEntry("model_revision", 0L);
        assertThat(store.findTurnModelSelection(tenant, child.sessionId(), firstTurn.promptId())).isNull();
        assertThat(store.findModelSelections(tenant, List.of(session)))
                .containsEntry(session, new WebShellModelSelection("model-a", 1));
    }

    @Test
    void completedReplayPrecedesCurrentCatalogRoleAndRevisionGates() {
        var original = change("actor", "first", "model-a", 0);
        change("actor", "second", "model-b", 1);
        grant("actor", "READER");
        when(harness.supportsModelSelection()).thenReturn(false);
        var disabled = service(store(false));
        var replayed = transaction().execute(status -> disabled.changeWebShellSessionModel(
                tenant, "actor", session, "first", "model-a", 0));
        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.modelSelection()).isEqualTo(original.modelSelection());
        assertThat(store.findModelSelections(tenant, List.of(session)).get(session))
                .isEqualTo(new WebShellModelSelection("model-b", 2));
        assertThatThrownBy(() -> change("actor", "first", "model-b", 0))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
    }

    @Test
    void actorsHaveIndependentKeysAndRevocationCannotReplayWithoutReadAccess() {
        change("actor", "shared", "model-a", 0);
        grant("operator", "OPERATOR");
        assertThat(change("operator", "shared", "model-b", 1).modelSelection().revision()).isEqualTo(2);
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id=? AND actor_id=?", tenant, "operator");
        assertCode(() -> change("operator", "shared", "model-b", 1), "session_not_found");
    }

    @Test
    void activeTurnPinsItsModelAndFutureTurnsTakeTheNewSelection() {
        change("actor", "first", "model-a", 0);
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "hello"));
        var turn = transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "turn-a",
                "digest-a", session, input, SubmitHarnessTurn.computePayloadDigest(input)));
        String prompt = store.findTurn(tenant, session, turn.turnId()).orElseThrow().promptId();
        assertCode(() -> change("actor", "blocked", "model-b", 1), "turn_active");
        assertThat(store.findTurnModelSelection(tenant, session, prompt))
                .isEqualTo(new WebShellModelSelection("model-a", 1));
        jdbc.update("UPDATE ma_turn SET status='COMPLETED' WHERE tenant_id=? AND turn_id=?", tenant, turn.turnId());
        change("actor", "second", "model-b", 1);
        assertThat(store(true).findTurnModelSelection(tenant, session, prompt))
                .isEqualTo(new WebShellModelSelection("model-a", 1));
        var next = transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "turn-b",
                "digest-b", session, input, SubmitHarnessTurn.computePayloadDigest(input)));
        String nextPrompt = store.findTurn(tenant, session, next.turnId()).orElseThrow().promptId();
        assertThat(store.findTurnModelSelection(tenant, session, nextPrompt))
                .isEqualTo(new WebShellModelSelection("model-b", 2));
        assertThat(transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "turn-a",
                "digest-a", session, input, SubmitHarnessTurn.computePayloadDigest(input))).replayed()).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"reader", "stranger", "protocol", "model", "revision", "approval", "recovery", "turn-recovery", "cwd", "closed"})
    void refusesUnpublishedUnauthorizedOrBusyChangesWithoutAReceipt(String shape) {
        grant("reader", "READER");
        String actor = shape.equals("reader") ? "reader" : shape.equals("stranger") ? "stranger" : "actor";
        if (shape.equals("protocol")) {
            when(harness.supportsModelSelection()).thenReturn(false);
        }
        if (shape.equals("approval")) {
            jdbc.update("INSERT INTO ma_session_record (session_scope_key,record_key,tenant_id,session_id,"
                    + "domain,record_id,revision,gmt_create,record_kind,state,action_id,action_version,options_json)"
                    + " VALUES (?,?,?,?,'action','action',1,1,'ACTION','requested','action',1,?)",
                    ManagedSessionStore.sessionScopeKey(tenant, session), "a".repeat(64), tenant, session,
                    "{\"expiresAt\":" + (System.currentTimeMillis() + 100_000) + "}");
        }
        if (shape.equals("recovery")) {
            transaction().execute(status -> new ManagedSessionStore(jdbc).acquireWriter(tenant, session,
                    "model-selection-writer-token-0123456789", new AcquireWriterRequest("ws", "writer", 60_000L)));
            jdbc.update("UPDATE ma_session_head SET recovery_status='BLOCKED' WHERE tenant_id=?", tenant);
        }
        if (shape.equals("turn-recovery")) {
            var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "hello"));
            transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "parked", "digest",
                    session, input, SubmitHarnessTurn.computePayloadDigest(input)));
            jdbc.update("UPDATE ma_turn SET status='RECOVERY_BLOCKED' WHERE tenant_id=?", tenant);
        }
        if (shape.equals("cwd")) {
            transaction().execute(status -> store.beginCwdChangeOperation(tenant, session, "actor", "actor-digest",
                    "cwd", "digest-cwd", "sub", 1));
        }
        if (shape.equals("closed")) {
            jdbc.update("UPDATE ma_session SET status='CLOSED' WHERE tenant_id=?", tenant);
        }
        String expected = switch (shape) {
            case "reader" -> "session_operation_forbidden";
            case "stranger" -> "session_not_found";
            case "protocol" -> "unsupported_feature";
            case "model" -> "unsupported_model";
            case "revision" -> "model_selection_conflict";
            case "approval" -> "turn_active";
            case "closed" -> "session_state_conflict";
            default -> "session_context_busy";
        };
        assertCode(() -> change(actor, "refused", shape.equals("model") ? "unpublished" : "model-a",
                shape.equals("revision") ? 1 : 0), expected);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE tenant_id=? AND operation='SET_MODEL'",
                Integer.class, tenant)).isZero();
        assertThat(store.findModelSelections(tenant, List.of(session))).isEmpty();
    }

    @Test
    void concurrentChangesCannotBothWinTheSameRevision() throws Exception {
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            Callable<String> change = () -> {
                start.await();
                try {
                    return Long.toString(change("actor", UUID.randomUUID().toString(), "model-a", 0).modelSelection().revision());
                } catch (ApiException conflict) {
                    return conflict.getCode();
                }
            };
            var first = executor.submit(change);
            var second = executor.submit(change);
            start.countDown();
            assertThat(List.of(first.get(), second.get())).containsExactlyInAnyOrder("1", "model_selection_conflict");
        }
    }

    @Test
    void aSelectionCommittedDuringSummaryReadCannotReviveThePreviousContext() {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String record = com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.recordKey(session,
                "hosted_context_usage", "latest");
        byte[] bytes = "{\"version\":1,\"model\":\"model-a\",\"attempts\":[{\"promptTokenCount\":12,\"contextWindowSize\":100}]}"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,workspace_id,"
                + "session_id,resource_id,kind,schema_version,byte_length,sha256,storage_kind,inline_bytes,"
                + "state,gmt_create) VALUES (?,?,?,'ws',?,'usage','managed-hosted-model-usage',1,?,?,"
                + "'MYSQL_INLINE',?,'REFERENCED'," + ManagedSchemaTime.SQL_NOW + ")", "f".repeat(64), scope, tenant, session,
                bytes.length, ExtensionRecordJournal.sha256(bytes), bytes);
        jdbc.update("INSERT INTO ma_session_record (session_scope_key,record_key,tenant_id,workspace_id,"
                + "session_id,domain,record_id,revision,record_resource_id,gmt_create,settled_at)"
                + " VALUES (?,?,?,'ws',?,'hosted_context_usage','latest',1,'usage',1,1)", scope, record, tenant, session);
        assertThat(store.findModelContexts(tenant, List.of(session))).containsKey(session);
        var raced = spy(store);
        doAnswer(invocation -> {
            change("actor", "selected-during-read", "model-a", 0);
            return invocation.callRealMethod();
        }).when(raced).findModelSelections(tenant, List.of(session));
        var summary = service(raced).getWebShellSession(tenant, "actor", session);
        assertThat(summary.modelSelection()).isEqualTo(new WebShellModelSelection("model-a", 1));
        assertThat(summary.modelContext()).isNull();
    }

    @Test
    void switchingClearsOnlyTheLatestUsageProjectionAndNeverReplaysTheClear() {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String record = com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.recordKey(session,
                "hosted_context_usage", "latest");
        jdbc.update("INSERT INTO ma_session_record (session_scope_key,record_key,tenant_id,workspace_id,"
                + "session_id,domain,record_id,revision,record_resource_id,gmt_create,settled_at)"
                + " VALUES (?,?,?,'ws',?,'hosted_context_usage','latest',1,'usage',1,1)", scope, record, tenant, session);
        change("actor", "a", "model-a", 0);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE session_scope_key=?",
                Integer.class, scope)).isZero();
        change("actor", "b", "model-b", 1);
        change("actor", "again-a", "model-a", 2);
        jdbc.update("INSERT INTO ma_session_record (session_scope_key,record_key,tenant_id,workspace_id,"
                + "session_id,domain,record_id,revision,record_resource_id,gmt_create,settled_at)"
                + " VALUES (?,?,?,'ws',?,'hosted_context_usage','latest',2,'new-usage',2,2)", scope, record, tenant, session);
        assertThat(change("actor", "again-a", "model-a", 2).replayed()).isTrue();
        assertThat(jdbc.queryForObject("SELECT record_resource_id FROM ma_session_record WHERE session_scope_key=?",
                String.class, scope)).isEqualTo("new-usage");
    }

    private ManagedAgentStore store(boolean catalog) {
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        if (catalog) {
            properties.setModelCatalog(List.of(option("model-a"), option("model-b")));
        }
        return new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {}, registry, properties);
    }

    private ManagedAgentProperties.ModelOption option(String id) {
        var option = new ManagedAgentProperties.ModelOption();
        option.setModelId(id);
        option.setLabel("Label " + id);
        return option;
    }

    private ManagedAgentService service(ManagedAgentStore source) {
        return new ManagedAgentService(source, new RequestDigests(), mock(HarnessCoordinator.class), harness, registry);
    }

    private WebShellModelChangeResult change(String actor, String key, String model, long revision) {
        return transaction().execute(status -> service.changeWebShellSessionModel(tenant, actor, session, key, model, revision));
    }

    private void grant(String actor, String role) {
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id=? AND workspace_id=? AND actor_id=?",
                tenant, "ws", actor);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,workspace_id,actor_id,role)"
                + " VALUES (?,?,?,?)", tenant, "ws", actor.getBytes(java.nio.charset.StandardCharsets.UTF_8), role);
    }

    private TransactionTemplate transaction() { return new TransactionTemplate(manager); }

    private void assertCode(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }
}
