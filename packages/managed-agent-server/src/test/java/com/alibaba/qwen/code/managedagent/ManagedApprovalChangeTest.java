package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellApprovalChangeResult;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellApprovalSelection;
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
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
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
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:approval-change;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedApprovalChangeTest {
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
        tenant = "approval-change-" + UUID.randomUUID();
        jdbc.update("INSERT INTO ma_workspace (tenant_id,workspace_id,workspace_generation,storage_id,"
                + "display_name,config_ref,policy_ref,state) VALUES (?,'ws',1,'storage','Workspace',?,?,'ACTIVE')",
                tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        grant("actor", "OWNER");
        store = store();
        harness = mock(HarnessConnector.class);
        when(harness.supportsApprovalSelection()).thenReturn(true);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        service = service(store);
        session = transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "create",
                "qwen-code", null, null, null, List.of(), new WorkspaceSelection("ws", "."))).sessionId();
    }

    @Test
    void publishesExplicitFullAccessAndPreservesTheInitialPolicyAcrossRoundTrips() {
        assertThat(service.queryWebShellSessionOptions(tenant, "actor", "qwen-code").availableApprovalModes())
                .containsExactly("default", "auto-edit", "yolo");
        assertThat(service.queryWebShellSessionApproval(tenant, "actor", session).supported()).isTrue();
        var first = change("actor", "first", "yolo", 0);
        assertThat(first.approvalRevision()).isEqualTo(1);
        var summary = service.getWebShellSession(tenant, "actor", session);
        assertThat(summary.approvalMode()).isEqualTo("yolo");
        assertThat(summary.initialApprovalMode()).isEqualTo("default");
        assertThat(summary.approvalRevision()).isEqualTo(1);
        assertThat(summary.capabilities().actions()).isTrue();
        assertThat(summary.capabilities().foregroundShell()).isTrue();
        change("actor", "second", "auto-edit", 1);
        change("actor", "third", "default", 2);
        assertThat(store.requireSession(tenant, session).approvalMode()).isEqualTo("default");
        assertThat(service.listWebShellSessions(tenant, "actor", null, 100).data()).singleElement()
                .satisfies(row -> assertThat(row.approvalRevision()).isEqualTo(3));
    }

    @Test
    void explicitlyCreatesFullAccessAndCanReturnToAskingWithoutChangingInitialPolicy() {
        var created = transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "full-access",
                "qwen-code", null, null, null, List.of(), new WorkspaceSelection("ws", "."), "yolo"));
        assertThat(store.requireSession(tenant, created.sessionId()).approvalMode()).isEqualTo("yolo");
        transaction().execute(status -> service.changeWebShellSessionApproval(tenant, "actor", created.sessionId(),
                "ask", "default", 0));
        var summary = service.getWebShellSession(tenant, "actor", created.sessionId());
        assertThat(summary.approvalMode()).isEqualTo("default");
        assertThat(summary.initialApprovalMode()).isEqualTo("yolo");
        assertThat(summary.capabilities().actions()).isTrue();
        when(harness.supportsApprovalSelection()).thenReturn(false);
        assertCode(() -> transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "old-host",
                "qwen-code", null, null, null, List.of(), new WorkspaceSelection("ws", "."), "yolo")), "unsupported_approval_mode");
    }

    @Test
    void receiptsDoNotChangeTheSelectionAgainAndRequireCurrentOwnerAndOperator() {
        var first = change("actor", "first", "yolo", 0);
        change("actor", "second", "auto-edit", 1);
        when(harness.supportsApprovalSelection()).thenReturn(false);
        assertThat(change("actor", "first", "yolo", 0))
                .isEqualTo(new WebShellApprovalChangeResult(session, "yolo", first.approvalRevision(), true));
        assertThat(service.getWebShellSession(tenant, "actor", session).approvalMode()).isEqualTo("auto-edit");
        assertCode(() -> change("actor", "first", "default", 0), "idempotency_conflict");
        grant("operator", "OPERATOR");
        assertCode(() -> change("operator", "other", "yolo", 2), "session_operation_forbidden");
        grant("actor", "READER");
        assertCode(() -> change("actor", "first", "yolo", 0), "session_operation_forbidden");
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id=? AND actor_id=?", tenant, "actor");
        assertCode(() -> change("actor", "first", "yolo", 0), "session_not_found");
    }

    @Test
    void snapshotsBothTheFirstAndLaterTurnsAndNeverRewritesOldSnapshots() {
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "hello"));
        var initial = transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "with-input",
                "qwen-code", null, null, null, List.of(new ApiModels.InputBlock("input_text", "hello")),
                new WorkspaceSelection("ws", "."), "auto-edit"));
        String firstPrompt = store.findTurn(tenant, initial.sessionId(), initial.turnId()).orElseThrow().promptId();
        assertThat(store.findTurnApprovalSelection(tenant, initial.sessionId(), firstPrompt))
                .isEqualTo(new WebShellApprovalSelection("auto-edit", 0));
        change("actor", "yolo", "yolo", 0);
        var turn = transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "turn-a", "digest-a",
                session, input, SubmitHarnessTurn.computePayloadDigest(input)));
        String prompt = store.findTurn(tenant, session, turn.turnId()).orElseThrow().promptId();
        assertThat(store.findTurnApprovalSelection(tenant, session, prompt)).isEqualTo(new WebShellApprovalSelection("yolo", 1));
        assertCode(() -> change("actor", "busy", "default", 1), "turn_active");
        jdbc.update("UPDATE ma_turn SET status='COMPLETED' WHERE tenant_id=? AND turn_id=?", tenant, turn.turnId());
        change("actor", "auto", "auto-edit", 1);
        assertThat(store.findTurnApprovalSelection(tenant, session, prompt)).isEqualTo(new WebShellApprovalSelection("yolo", 1));
        assertThat(transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "turn-a", "digest-a",
                session, input, SubmitHarnessTurn.computePayloadDigest(input))).replayed()).isTrue();
    }

    @Test
    void keepsStoredDefinitionsFixedAndRejectsUnknownModes() {
        assertCode(() -> change("actor", "invalid", "auto", 0), "unsupported_approval_mode");
        jdbc.update("UPDATE ma_session SET agent_definition_digest=? WHERE tenant_id=? AND session_id=?", "a".repeat(64), tenant, session);
        assertCode(() -> change("actor", "custom", "yolo", 0), "unsupported_feature");
        assertThat(service.getWebShellSession(tenant, "actor", session).capabilities().approvalModeChange()).isFalse();
    }

    @Test
    void fallsBackForLegacyTurnsOnlyBeforeAnyPolicyOverride() {
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "hello"));
        var admitted = transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "legacy", "legacy-digest",
                session, input, SubmitHarnessTurn.computePayloadDigest(input)));
        var turn = store.findTurn(tenant, session, admitted.turnId()).orElseThrow();
        jdbc.update("UPDATE ma_turn SET approval_mode=NULL, approval_revision=NULL, status='COMPLETED'"
                + " WHERE tenant_id=? AND turn_id=?", tenant, admitted.turnId());
        assertThat(store.findTurnApprovalSelection(tenant, session, turn.promptId()))
                .isNull();
        assertThat(store.requireSession(tenant, session).approvalMode()).isEqualTo("default");
        change("actor", "selected", "yolo", 0);
        assertCode(() -> store.findTurnApprovalSelection(tenant, session, turn.promptId()), "approval_snapshot_missing");
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void serializesTurnAdmissionAndPolicyChangeUnderTheSessionLock(boolean changeFirst) throws Exception {
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "hello"));
        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> transaction().execute(status -> {
                String result;
                if (changeFirst) {
                    service.changeWebShellSessionApproval(tenant, "actor", session, "race", "yolo", 0);
                    result = "changed";
                } else {
                    result = store.insertTurnCommand(tenant, "SUBMIT_TURN", "race-turn", "race-digest",
                            session, input, SubmitHarnessTurn.computePayloadDigest(input)).turnId();
                }
                held.countDown();
                try {
                    if (!release.await(10, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("The test did not release the Session transaction");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
                return result;
            }));
            try {
                assertThat(held.await(10, TimeUnit.SECONDS)).isTrue();
                var second = executor.submit(() -> {
                    if (changeFirst) {
                        return transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "race-turn", "race-digest",
                                session, input, SubmitHarnessTurn.computePayloadDigest(input)).turnId());
                    }
                    try {
                        change("actor", "race", "yolo", 0);
                        return "unexpected-change";
                    } catch (ApiException conflict) {
                        return conflict.getCode();
                    }
                });
                release.countDown();
                String initial = first.get(10, TimeUnit.SECONDS);
                String after = second.get(10, TimeUnit.SECONDS);
                if (!changeFirst) {
                    assertThat(after).isEqualTo("turn_active");
                }
                var turn = store.findTurn(tenant, session, changeFirst ? after : initial).orElseThrow();
                assertThat(store.findTurnApprovalSelection(tenant, session, turn.promptId()))
                        .isEqualTo(new WebShellApprovalSelection(changeFirst ? "yolo" : "default", changeFirst ? 1 : 0));
            } finally {
                release.countDown();
            }
        }
    }

    @Test
    void concurrentChangesCannotBothWinTheSameRevision() throws Exception {
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            Callable<String> call = () -> {
                start.await();
                try {
                    return Long.toString(change("actor", UUID.randomUUID().toString(), "yolo", 0).approvalRevision());
                } catch (ApiException conflict) {
                    return conflict.getCode();
                }
            };
            var first = executor.submit(call);
            var second = executor.submit(call);
            start.countDown();
            assertThat(List.of(first.get(), second.get())).containsExactlyInAnyOrder("1", "approval_selection_conflict");
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"reader", "stranger", "protocol", "revision", "approval", "recovery", "turn-recovery", "cwd", "closed"})
    void refusesUnpublishedUnauthorizedOrBusyChangesWithoutAReceipt(String shape) {
        grant("reader", "READER");
        String actor = shape.equals("reader") ? "reader" : shape.equals("stranger") ? "stranger" : "actor";
        if (shape.equals("protocol")) {
            when(harness.supportsApprovalSelection()).thenReturn(false);
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
            case "revision" -> "approval_selection_conflict";
            case "approval" -> "turn_active";
            case "closed" -> "session_state_conflict";
            default -> "session_context_busy";
        };
        assertCode(() -> change(actor, "refused", "yolo",
                shape.equals("revision") ? 1 : 0), expected);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE tenant_id=? AND operation='SET_APPROVAL'",
                Integer.class, tenant)).isZero();
        assertThat(store.findApprovalSelections(tenant, List.of(session)).get(session))
                .isEqualTo(new WebShellApprovalSelection("default", 0));
    }

    private ManagedAgentStore store() {
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(true);
        properties.getHarness().setApprovalMode("default");
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(tenant, "storage", "/tmp")));
        return new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {}, registry, properties);
    }

    private ManagedAgentService service(ManagedAgentStore source) {
        return new ManagedAgentService(source, new RequestDigests(), mock(HarnessCoordinator.class), harness, registry);
    }

    private WebShellApprovalChangeResult change(String actor, String key, String mode, long revision) {
        return transaction().execute(status -> service.changeWebShellSessionApproval(tenant, actor, session, key, mode, revision));
    }

    private void grant(String actor, String role) {
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id=? AND workspace_id=? AND actor_id=?", tenant, "ws", actor);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,workspace_id,actor_id,role) VALUES (?,?,?,?)",
                tenant, "ws", actor.getBytes(java.nio.charset.StandardCharsets.UTF_8), role);
    }

    private TransactionTemplate transaction() { return new TransactionTemplate(manager); }

    private void assertCode(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }
}
