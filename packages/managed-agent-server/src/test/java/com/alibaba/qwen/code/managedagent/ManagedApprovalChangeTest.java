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
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
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
    @Autowired private ManagedAgentDefinitionStore definitions;
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
        when(harness.supportsAgentDefinitionApprovalSelection()).thenReturn(true);
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

    @ParameterizedTest
    @ValueSource(strings = {"hosted-workspace-files/1", "hosted-workspace-shell/1", "hosted-workspace-shell/2"})
    void persistsPlanIndependentlyAndFreezesItWithTheTurnPolicy(String profile) throws Exception {
        when(harness.supportsPlanMode()).thenReturn(true);
        session = customSession(profile, "default");
        var initial = store.requireSession(tenant, session);
        var enabled = transaction().execute(status -> service.changeWebShellSessionApproval(tenant, "actor", session,
                "enable-plan", "default", 0, true));
        assertThat(enabled.planMode()).isTrue();
        assertThat(enabled.approvalRevision()).isEqualTo(1);
        assertThat(service.getWebShellSession(tenant, "actor", session).planMode()).isTrue();
        assertThat(service.queryWebShellSessionApproval(tenant, "actor", session).planModeSupported()).isTrue();
        assertThat(service.queryWebShellSessionOptions(tenant, "actor", initial.agentId()).planModeSupported()).isTrue();
        assertThat(change("actor", "permission-only", "yolo", 1).planMode()).isTrue();
        assertThat(transaction().execute(status -> service.changeWebShellSessionApproval(tenant, "actor", session,
                "enable-plan", "default", 0, true)).replayed()).isTrue();
        assertCode(() -> transaction().execute(status -> service.changeWebShellSessionApproval(tenant, "actor", session,
                "stale", "default", 0, false)), "approval_selection_conflict");
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "make a plan"));
        var turn = transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "plan-turn", "plan-digest",
                session, input, SubmitHarnessTurn.computePayloadDigest(input)));
        var prompt = store.findTurn(tenant, session, turn.turnId()).orElseThrow().promptId();
        assertThat(store.findTurnApprovalSelection(tenant, session, prompt)).isEqualTo(new WebShellApprovalSelection("yolo", 2, true));
        assertCode(() -> transaction().execute(status -> service.changeWebShellSessionApproval(tenant, "actor", session,
                "active", "yolo", 2, false)), "turn_active");
        when(harness.supportsPlanMode()).thenReturn(false);
        assertThat(service.getWebShellSession(tenant, "actor", session).capabilities().workspaceTurns()).isFalse();
        when(harness.supportsPlanMode()).thenReturn(true);
        jdbc.update("UPDATE ma_turn SET status='COMPLETED' WHERE tenant_id=? AND turn_id=?", tenant, turn.turnId());
        assertThat(transaction().execute(status -> service.changeWebShellSessionApproval(tenant, "actor", session,
                "manual-off", "yolo", 2, false)).planMode()).isFalse();
        assertThat(store.findTurnApprovalSelection(tenant, session, prompt).planMode()).isTrue();
        assertThat(store.requireSession(tenant, session).agentDefinitionDigest()).isEqualTo(initial.agentDefinitionDigest());
        assertThat(store.requireSession(tenant, session).approvalMode()).isEqualTo("default");
    }

    @Test
    void initializesPlanBeforeTheFirstTurnAndReservesARevisionForItsApprovalExit() {
        when(harness.supportsPlanMode()).thenReturn(true);
        var created = transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "initial-plan",
                "qwen-code", null, null, null, List.of(new ApiModels.InputBlock("input_text", "plan this")),
                new WorkspaceSelection("ws", "."), "yolo", true));
        var turn = store.findTurn(tenant, created.sessionId(), created.turnId()).orElseThrow();
        assertThat(store.findTurnApprovalSelection(tenant, created.sessionId(), turn.promptId()))
                .isEqualTo(new WebShellApprovalSelection("yolo", 1, true));
        assertThat(service.getWebShellSession(tenant, "actor", created.sessionId()).planMode()).isTrue();
        jdbc.update("UPDATE ma_session SET selected_approval_mode='default',approval_revision=9007199254740990 WHERE tenant_id=? AND session_id=?", tenant, session);
        assertCode(() -> transaction().execute(status -> service.changeWebShellSessionApproval(tenant, "actor", session,
                "overflow-plan", "default", 9_007_199_254_740_990L, true)), "approval_selection_conflict");
        when(harness.supportsPlanMode()).thenReturn(false);
        assertCode(() -> transaction().execute(status -> service.changeWebShellSessionApproval(tenant, "actor", session,
                "unsupported-plan", "default", 9_007_199_254_740_990L, true)), "unsupported_feature");
    }

    @Test
    void keepsHookDefinitionsOutsidePublicPlanWhilePreservingApprovalChanges() throws Exception {
        when(harness.supportsPlanMode()).thenReturn(true);
        var definition = define("hosted-workspace-files/1", "default");
        Map<String, Object> content = json.readValue(definition.definitionJson(),
                new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() { });
        content.put("hook_catalog", Map.of("catalog_id", "review", "catalog_revision", 1,
                "definition_digest", "a".repeat(64)));
        var digest = new RequestDigests().digest(content);
        definitions.update(tenant, "hook-definition", digest, definition.agentId(), digest.substring(7), json.writeValueAsString(content), 2);
        session = transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "hook-session",
                definition.agentId(), null, null, null, List.of(), new WorkspaceSelection("ws", "."))).sessionId();
        assertThat(service.queryWebShellSessionOptions(tenant, "actor", definition.agentId()).planModeSupported()).isFalse();
        assertThat(service.getWebShellSession(tenant, "actor", session).planModeSupported()).isFalse();
        assertCode(() -> transaction().execute(status -> service.changeWebShellSessionApproval(tenant, "actor", session,
                "hook-plan", "default", 0, true)), "unsupported_feature");
        assertThat(change("actor", "hook-permission", "auto-edit", 0).approvalRevision()).isEqualTo(1);
        assertCode(() -> transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "hook-create-plan",
                definition.agentId(), null, null, null, List.of(), new WorkspaceSelection("ws", "."), "default", true)),
                "unsupported_feature");
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

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void receiptsDoNotChangeTheSelectionAgainAndRequireCurrentOwnerAndOperator(boolean custom) throws Exception {
        if (custom) {
            session = customSession("hosted-workspace-shell/1", "default");
        }
        var first = change("actor", "first", "yolo", 0);
        change("actor", "second", "auto-edit", 1);
        when(harness.supportsApprovalSelection()).thenReturn(false);
        assertThat(change("actor", "first", "yolo", 0))
                .isEqualTo(new WebShellApprovalChangeResult(session, "yolo", first.approvalRevision(), true));
        assertThat(service.getWebShellSession(tenant, "actor", session).approvalMode()).isEqualTo("auto-edit");
        assertCode(() -> change("actor", "first", "default", 0), "idempotency_conflict");
        grant("operator", "OPERATOR");
        assertCode(() -> change("operator", "other", "yolo", 2), "session_operation_forbidden");
        grant("operator", "OWNER");
        assertCode(() -> change("operator", "other", "yolo", 2), "session_operation_forbidden");
        grant("actor", "READER");
        assertCode(() -> change("actor", "first", "yolo", 0), "session_operation_forbidden");
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id=? AND actor_id=?", tenant, "actor");
        assertCode(() -> change("actor", "first", "yolo", 0), "session_not_found");
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void snapshotsBothTheFirstAndLaterTurnsAndNeverRewritesOldSnapshots(boolean custom) throws Exception {
        String agent = "qwen-code";
        if (custom) {
            session = customSession("hosted-workspace-shell/1", "default");
            agent = define("hosted-workspace-shell/1", "auto-edit").agentId();
        }
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "hello"));
        String initialAgent = agent;
        var initial = transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "with-input",
                initialAgent, null, null, null, List.of(new ApiModels.InputBlock("input_text", "hello")),
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
    void rejectsUnknownModesAndAMalformedBuiltInDefinitionPin() {
        assertCode(() -> change("actor", "invalid", "auto", 0), "unsupported_approval_mode");
        jdbc.update("UPDATE ma_session SET agent_definition_digest=? WHERE tenant_id=? AND session_id=?", "a".repeat(64), tenant, session);
        assertCode(() -> change("actor", "custom", "yolo", 0), "unsupported_feature");
        assertThat(service.getWebShellSession(tenant, "actor", session).capabilities().approvalModeChange()).isFalse();
    }

    @ParameterizedTest
    @ValueSource(strings = {"hosted-workspace-files/1", "hosted-workspace-shell/1", "hosted-workspace-shell/2"})
    void changesStoredDefinitionSessionsWithoutChangingTheirInitialIdentityOrCreationOptions(String profile) throws Exception {
        session = customSession(profile, "default");
        var initial = store.requireSession(tenant, session);
        var content = definitions.pinnedContent(initial);
        assertThat(service.queryWebShellSessionOptions(tenant, "actor", initial.agentId()).availableApprovalModes())
                .containsExactly("default");
        var options = service.queryWebShellSessionApproval(tenant, "actor", session);
        assertThat(options.supported()).isTrue();
        assertThat(options.availableApprovalModes()).containsExactly("default", "auto-edit", "yolo");
        assertCode(() -> transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "override-create",
                initial.agentId(), null, null, null, List.of(), new WorkspaceSelection("ws", "."), "yolo")), "unsupported_approval_mode");
        int revision = 0;
        for (String mode : List.of("yolo", "auto-edit", "default")) {
            assertThat(change("actor", "mode-" + mode, mode, revision).approvalRevision()).isEqualTo(++revision);
            var summary = service.getWebShellSession(tenant, "actor", session);
            assertThat(summary.approvalMode()).isEqualTo(mode);
            assertThat(summary.initialApprovalMode()).isEqualTo("default");
            assertThat(summary.approvalRevision()).isEqualTo(revision);
            assertThat(summary.capabilities().approvalModeChange()).isTrue();
            assertThat(summary.capabilities().actions()).isTrue();
            assertThat(service.listWebShellSessions(tenant, "actor", null, 100).data())
                    .filteredOn(row -> row.sessionId().equals(session)).singleElement()
                    .satisfies(row -> assertThat(row.approvalMode()).isEqualTo(mode));
        }
        var retained = store.requireSession(tenant, session);
        assertThat(retained.agentRevision()).isEqualTo(initial.agentRevision());
        assertThat(retained.agentDefinitionDigest()).isEqualTo(initial.agentDefinitionDigest());
        assertThat(retained.approvalMode()).isEqualTo(initial.approvalMode());
        assertThat(definitions.pinnedContent(retained)).isEqualTo(content);
        assertThat(service.queryWebShellSessionOptions(tenant, "actor", initial.agentId()).availableApprovalModes())
                .containsExactly("default");
    }

    @Test
    void childCreationKeepsTheStoredDefinitionInitialPolicyAfterParentSelection() throws Exception {
        session = customSession("hosted-workspace-files/1", "default");
        var parent = store.requireSession(tenant, session);
        change("actor", "parent-yolo", "yolo", 0);
        var created = transaction().execute(status -> service.createChildSession(tenant, session,
                "child-policy-inheritance", "Review", "Review the project"));
        var child = store.requireSession(tenant, created.sessionId());
        assertThat(child.approvalMode()).isEqualTo("default");
        assertThat(child.agentId()).isEqualTo(parent.agentId());
        assertThat(child.agentRevision()).isEqualTo(parent.agentRevision());
        assertThat(child.agentDefinitionDigest()).isEqualTo(parent.agentDefinitionDigest());
        assertThat(definitions.pinnedContent(child)).isEqualTo(definitions.pinnedContent(parent));
        assertThat(store.findApprovalSelections(tenant, List.of(child.sessionId())).get(child.sessionId()))
                .isEqualTo(new WebShellApprovalSelection("default", 0));
        assertThat(jdbc.queryForObject("SELECT selected_approval_mode FROM ma_session WHERE tenant_id=? AND session_id=?",
                String.class, tenant, child.sessionId())).isNull();
        var turn = store.findTurn(tenant, child.sessionId(), created.turnId()).orElseThrow();
        assertThat(store.findTurnApprovalSelection(tenant, child.sessionId(), turn.promptId()))
                .isEqualTo(new WebShellApprovalSelection("default", 0));
        assertThat(store.findApprovalSelections(tenant, List.of(session)).get(session))
                .isEqualTo(new WebShellApprovalSelection("yolo", 1));
    }

    @ParameterizedTest
    @CsvSource({"false,false", "true,false", "false,true", "true,true"})
    void requiresBothCapabilitiesForCustomChangesInsideTheStore(boolean generic, boolean custom) throws Exception {
        session = customSession("hosted-workspace-shell/1", "default");
        when(harness.supportsApprovalSelection()).thenReturn(generic);
        when(harness.supportsAgentDefinitionApprovalSelection()).thenReturn(custom);
        assertThat(service.queryWebShellSessionApproval(tenant, "actor", session).supported()).isEqualTo(generic && custom);
        if (generic && custom) {
            assertThat(change("actor", "selected", "yolo", 0).approvalRevision()).isEqualTo(1);
        } else {
            assertCode(() -> change("actor", "selected", "yolo", 0), "unsupported_feature");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE tenant_id=? AND operation='SET_APPROVAL'",
                    Integer.class, tenant)).isZero();
        }
    }

    @Test
    void initialYoloFilesCanAskAndRetainTheirSelectionWhenCustomCapabilityDisappears() throws Exception {
        session = customSession("hosted-workspace-files/1", "yolo");
        assertThat(service.getWebShellSession(tenant, "actor", session).capabilities().actions()).isTrue();
        change("actor", "asking", "default", 0);
        var summary = service.getWebShellSession(tenant, "actor", session);
        assertThat(summary.approvalMode()).isEqualTo("default");
        assertThat(summary.initialApprovalMode()).isEqualTo("yolo");
        assertThat(summary.capabilities().actions()).isTrue();
        assertThat(summary.capabilities().workspaceTurns()).isTrue();
        when(harness.supportsAgentDefinitionApprovalSelection()).thenReturn(false);
        var unsupported = service.getWebShellSession(tenant, "actor", session);
        assertThat(unsupported.approvalMode()).isEqualTo("default");
        assertThat(unsupported.approvalRevision()).isEqualTo(1);
        assertThat(unsupported.capabilities().approvalModeChange()).isFalse();
        assertThat(unsupported.capabilities().workspaceTurns()).isFalse();
        assertThat(unsupported.capabilities().cwdChange()).isFalse();
        assertThat(unsupported.capabilities().actions()).isTrue();
        assertThat(change("actor", "asking", "default", 0).replayed()).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"hosted-workspace-files/2", "hosted-workspace-read/1"})
    void storedDefinitionsWithOtherProfilesRemainFixed(String profile) throws Exception {
        session = customSession(profile, "default");
        assertThat(service.queryWebShellSessionApproval(tenant, "actor", session).supported()).isFalse();
        assertCode(() -> change("actor", "selected", "yolo", 0), "unsupported_feature");
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "hello"));
        var admitted = transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "turn-other", "digest-other",
                session, input, SubmitHarnessTurn.computePayloadDigest(input)));
        var turn = store.findTurn(tenant, session, admitted.turnId()).orElseThrow();
        assertThat(store.findTurnApprovalSelection(tenant, session, turn.promptId())).isNull();
    }

    @Test
    void completedCustomCreationAndSubmitReplayDoNotAcquireExecutionAfterASelection() throws Exception {
        when(harness.isAvailable()).thenReturn(true);
        var definition = define("hosted-workspace-shell/1", "default");
        var input = List.of(new ApiModels.InputBlock("input_text", "hello"));
        var created = transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "legacy-create",
                definition.agentId(), null, null, null, input, new WorkspaceSelection("ws", ".")));
        session = created.sessionId();
        jdbc.update("UPDATE ma_turn SET status='COMPLETED',approval_mode=NULL,approval_revision=NULL,plan_enabled=NULL WHERE tenant_id=? AND session_id=?",
                tenant, session);
        var submitted = transaction().execute(status -> service.submitTurn(tenant, "actor", "legacy-submit", session, input));
        jdbc.update("UPDATE ma_turn SET status='COMPLETED',approval_mode=NULL,approval_revision=NULL,plan_enabled=NULL WHERE tenant_id=? AND session_id=?",
                tenant, session);
        change("actor", "new-policy", "yolo", 0);
        assertThat(transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "legacy-create",
                definition.agentId(), null, null, null, input, new WorkspaceSelection("ws", "."))).replayed()).isTrue();
        assertThat(transaction().execute(status -> service.submitTurn(tenant, "actor", "legacy-submit", session, input)).replayed()).isTrue();
        for (String turnId : List.of(created.turnId(), submitted.turnId())) {
            var claimed = transaction().execute(status -> store.claimTurn(tenant, session, turnId, "dispatcher", java.time.Duration.ofSeconds(30)));
            assertThat(claimed).isEmpty();
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void fallsBackForLegacyTurnsOnlyBeforeAnyPolicyOverride(boolean custom) throws Exception {
        if (custom) {
            session = customSession("hosted-workspace-shell/1", "default");
        }
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "hello"));
        var admitted = transaction().execute(status -> store.insertTurnCommand(tenant, "SUBMIT_TURN", "legacy", "legacy-digest",
                session, input, SubmitHarnessTurn.computePayloadDigest(input)));
        var turn = store.findTurn(tenant, session, admitted.turnId()).orElseThrow();
        jdbc.update("UPDATE ma_turn SET approval_mode=NULL, approval_revision=NULL, plan_enabled=NULL, status='COMPLETED'"
                + " WHERE tenant_id=? AND turn_id=?", tenant, admitted.turnId());
        assertThat(store.findTurnApprovalSelection(tenant, session, turn.promptId()))
                .isNull();
        assertThat(store.requireSession(tenant, session).approvalMode()).isEqualTo("default");
        change("actor", "selected", "yolo", 0);
        assertCode(() -> store.findTurnApprovalSelection(tenant, session, turn.promptId()), "approval_snapshot_missing");
    }

    @ParameterizedTest
    @CsvSource({"true,false", "false,false", "true,true", "false,true"})
    void serializesTurnAdmissionAndPolicyChangeUnderTheSessionLock(boolean changeFirst, boolean custom) throws Exception {
        if (custom) {
            session = customSession("hosted-workspace-shell/1", "default");
        }
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

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void concurrentChangesCannotBothWinTheSameRevision(boolean custom) throws Exception {
        if (custom) {
            session = customSession("hosted-workspace-shell/1", "default");
        }
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
    @CsvSource({"reader,false", "stranger,false", "protocol,false", "revision,false", "approval,false", "recovery,false",
            "turn-recovery,false", "cwd,false", "closed,false", "reader,true", "stranger,true", "protocol,true",
            "revision,true", "approval,true", "recovery,true", "turn-recovery,true", "cwd,true", "closed,true"})
    void refusesUnpublishedUnauthorizedOrBusyChangesWithoutAReceipt(String shape, boolean custom) throws Exception {
        if (custom) {
            session = customSession("hosted-workspace-shell/1", "default");
        }
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
        properties.setDefinitionToolProfiles(List.of("hosted-workspace-files/1", "hosted-workspace-shell/1",
                "hosted-workspace-shell/2", "hosted-workspace-files/2", "hosted-workspace-read/1"));
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(true);
        properties.getHarness().setApprovalMode("default");
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(tenant, "storage", "/tmp")));
        var result = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {}, registry, properties);
        result.setManagedAgentDefinitionStore(definitions);
        return result;
    }

    private ManagedAgentDefinitionStore.DefinitionRevision define(String profile, String mode) throws Exception {
        String agent = "agent_" + UUID.randomUUID().toString().replace("-", "");
        var content = Map.of("model", Map.of(), "instructions", "Review the project",
                "tools", List.of(Map.of("type", "hosted_profile", "profile", profile)),
                "permission_policy", Map.of("approval_mode", mode));
        String body = json.writeValueAsString(content);
        String digest = new RequestDigests().digest(content);
        return definitions.create(tenant, "definition-" + agent, digest, agent, digest.substring(7), body, 1).revision();
    }

    private String customSession(String profile, String mode) throws Exception {
        var definition = define(profile, mode);
        return transaction().execute(status -> service.createWorkspaceSession(tenant, "actor", "create-" + definition.agentId(),
                definition.agentId(), null, null, null, List.of(), new WorkspaceSelection("ws", "."))).sessionId();
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
