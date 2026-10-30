package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:workspace-admission;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
@AutoConfigureMockMvc
class ManagedWorkspaceAdmissionTest {
    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper mapper;

    @Autowired
    private @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc;

    @Autowired
    private ManagedAgentStore store;

    @Autowired
    private ManagedAgentService service;

    @Autowired
    private ManagedWorkspaceRegistry registry;

    @Autowired
    @Qualifier("managedAgentTransactionManager")
    private PlatformTransactionManager transactionManager;

    @Test
    void publicChildrenKeepLaunchPolicyAndModelAfterParentChangesAndDeploymentDisable() throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-public-child", "storage-public-child", WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-public-child", "actor-a", true);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(true);
        assertThat(properties.getHarness().isWorkspaceChildAgentsEnabled()).isTrue();
        properties.getHarness().setApprovalMode("default");
        var enabled = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        var tx = new TransactionTemplate(transactionManager);
        var selection = new WorkspaceSelection("ws-public-child", ".");
        var old = tx.execute(status -> enabled.insertWorkspaceSessionCommand(tenant, "actor-a", "old", "old-digest",
                "qwen-code", null, null, List.of(), null, selection));
        assertThat(enabled.requireSession(tenant, old.sessionId()).publicChildAgentsVersion()).isZero();
        var parent = tx.execute(status -> enabled.insertWorkspaceSessionCommand(tenant, "actor-a", "public", "public-digest",
                "qwen-code", null, null, List.of(), null, selection, null, true, null, true, List.of(), true));
        assertThat(enabled.requireSession(tenant, parent.sessionId()).publicChildAgentsVersion()).isEqualTo(1);
        var snapshot = mapper.readTree("""
                {"version":1,"sourcePromptId":"source-1","approvalMode":"auto-edit","approvalRevision":2,
                 "modelId":"launch-model","modelRevision":4,"skillsRef":null,
                 "modelRoute":{"authType":"openai","endpointDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                 "providerPin":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                 "origin":{"modelId":"source-model","authType":"openai","endpointDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                 "providerPin":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}}
                """);
        jdbc.update("UPDATE ma_session SET selected_approval_mode = 'auto', approval_revision = 3 WHERE tenant_id = ? AND session_id = ?",
                tenant, parent.sessionId());
        properties.getHarness().setWorkspaceChildAgentsEnabled(false);
        var disabled = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        var lineage = new com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage(parent.sessionId(), parent.sessionId(), "run-public", 1);
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "write a file"));
        var autoSnapshot = ((com.fasterxml.jackson.databind.node.ObjectNode) snapshot.deepCopy()).put("approvalMode", "auto");
        assertThatThrownBy(() -> tx.execute(status -> disabled.insertPublicChildSessionCommand(tenant, parent.sessionId(), "auto-launch", "auto-digest",
                "child", input, "payload", lineage, autoSnapshot))).isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("child_launch_snapshot_invalid"));
        var child = tx.execute(status -> disabled.insertPublicChildSessionCommand(tenant, parent.sessionId(), "launch", "launch-digest",
                "child", input, "payload", lineage, snapshot));
        assertThat(disabled.requireSession(tenant, child.sessionId()).publicChildAgentsVersion()).isEqualTo(1);
        assertThat(disabled.requireSession(tenant, child.sessionId()).approvalMode()).isEqualTo("auto-edit");
        var model = disabled.findTurnModelSelection(tenant, child.sessionId(), disabled.findTurn(tenant, child.sessionId(), child.turnId()).orElseThrow().promptId());
        assertThat(model.modelId()).isEqualTo("launch-model");
        assertThat(model.revision()).isEqualTo(1);
        assertThat(tx.execute(status -> disabled.insertPublicChildSessionCommand(tenant, parent.sessionId(), "launch", "launch-digest",
                "child", input, "payload", lineage, snapshot)).sessionId()).isEqualTo(child.sessionId());
        assertThatThrownBy(() -> tx.execute(status -> disabled.insertTurnCommand(tenant, "actor-a", "new-child-turn", "digest",
                child.sessionId(), input, "payload"))).isInstanceOf(ManagedAgentException.class);
        var fresh = tx.execute(status -> disabled.insertWorkspaceSessionCommand(tenant, "actor-a", "disabled", "disabled-digest",
                "qwen-code", null, null, List.of(), null, selection, null, true, null, true, List.of(), true));
        assertThat(disabled.requireSession(tenant, fresh.sessionId()).publicChildAgentsVersion()).isZero();
    }

    @ParameterizedTest
    @CsvSource({"false, yolo", "false, default", "false, auto-edit", "true, default", "true, auto-edit"})
    void internalTeamLeadPinsPrivatePolicyAndSeparatesPublicReplay(boolean shellEnabled, String mode) {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-lead", "storage-lead", WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-lead", "actor-a", true);
        grant(tenant, "ws-lead", "reader", false);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(shellEnabled);
        properties.getHarness().setApprovalMode(mode);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(tenant, "storage-lead", "/workspace")));
        var admitted = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        var transaction = new TransactionTemplate(transactionManager);
        var selection = new WorkspaceSelection("ws-lead", ".");
        var first = transaction.execute(status -> admitted.insertInternalTeamLeadSessionCommand(
                tenant, "actor-a", "internal", "digest", "lead", selection));
        var session = admitted.requireSession(tenant, first.sessionId());
        assertThat(session.agentId()).isEqualTo("qwen-code");
        assertThat(session.agentRevision()).isEqualTo(properties.getAgentRevision());
        assertThat(session.agentDefinitionDigest()).isNull();
        assertThat(session.approvalMode()).isEqualTo(mode);
        assertThat(session.toolProfile()).isEqualTo(WorkspaceToolProfiles.INTERNAL_TEAM_LEAD);
        assertThat(first.turnId()).isNull();
        assertThat(WorkspaceToolProfiles.isPublicShell(session.toolProfile())).isFalse();
        byte[] actorKey = "actor-a".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                + " AND creator_actor_key = ? AND owner_actor_key = ?", Integer.class,
                tenant, first.sessionId(), actorKey, actorKey)).isEqualTo(1);
        properties.setAgentRevision("new-deployment");
        properties.getHarness().setApprovalMode("default");
        properties.getHarness().setWorkspaceShellEnabled(!shellEnabled);
        properties.getHarness().setWorkspaceFilesEnabled(false);
        var changed = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        var replay = transaction.execute(status -> changed.insertInternalTeamLeadSessionCommand(
                tenant, "actor-a", "internal", "digest", "ignored", selection));
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.sessionId()).isEqualTo(first.sessionId());
        assertThat(changed.requireSession(tenant, first.sessionId())).isEqualTo(session);
        assertRefused(() -> transaction.execute(status -> changed.insertInternalTeamLeadSessionCommand(
                tenant, "actor-a", "fresh-disabled", "digest", null, selection)), "workspace_unavailable");
        assertRefused(() -> transaction.execute(status -> changed.insertInternalTeamLeadSessionCommand(
                tenant, "actor-a", "internal", "different", null, selection)), "idempotency_conflict");
        assertRefused(() -> transaction.execute(status -> admitted.insertWorkspaceSessionCommand(tenant, "actor-a",
                "internal", "digest", "qwen-code", null, null, List.of(), null, selection)), "idempotency_conflict");
        assertRefused(() -> admitted.replayWorkspaceSessionCommand(tenant, "actor-a", "internal", "digest"),
                "idempotency_conflict");
        var publicSession = transaction.execute(status -> admitted.insertWorkspaceSessionCommand(tenant, "actor-a",
                "public", "digest", "qwen-code", null, null, List.of(), null, selection));
        assertThat(admitted.requireSession(tenant, publicSession.sessionId()).toolProfile())
                .isEqualTo(shellEnabled ? WorkspaceToolProfiles.SHELL : WorkspaceToolProfiles.FILES);
        assertRefused(() -> transaction.execute(status -> admitted.insertInternalTeamLeadSessionCommand(
                tenant, "actor-a", "public", "digest", null, selection)), "idempotency_conflict");
        var turn = transaction.execute(status -> admitted.insertTurnCommand(tenant, "SUBMIT_TURN", "lead-turn",
                "turn-digest", first.sessionId(), List.of(Map.of("type", "text", "text", "go")), "turn-digest"));
        assertThat(turn.turnId()).isNotNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(1);
        var projection = new ManagedAgentService(admitted, new RequestDigests(), mock(HarnessCoordinator.class),
                new UnavailableHarnessConnector(), registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        assertThat(projection.getPublicSession(tenant, "actor-a", first.sessionId()).capabilities().foregroundShell()).isNull();
        var lineage = new com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage(
                first.sessionId(), first.sessionId(), "member-run", 1);
        var child = transaction.execute(status -> admitted.insertChildSessionCommand(tenant, first.sessionId(),
                "member-create", "member-digest", "member", List.of(), null, lineage));
        var childRow = admitted.requireSession(tenant, child.sessionId());
        assertThat(childRow.toolProfile()).isEqualTo(WorkspaceToolProfiles.INTERNAL_TEAM_LEAD);
        assertThat(childRow.approvalMode()).isEqualTo(mode);
        assertThat(admitted.findChildLineage(tenant, child.sessionId())).isEqualTo(lineage);
        jdbc.update("UPDATE ma_turn SET status = 'COMPLETED' WHERE tenant_id = ? AND session_id = ?",
                tenant, first.sessionId());
        var close = transaction.execute(status -> admitted.beginWorkspaceLifecycle(tenant, first.sessionId(),
                com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.CLOSE,
                "actor-a", "actor-digest", "close-lead", "close-digest", true, 0));
        assertThat(close.operation().lifecycleProtocolVersion()).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"files-off", "reader", "missing-mount", "config", "policy", "registry", "migration"})
    void internalTeamLeadCannotMintWithoutWorkspaceExecutionPrerequisites(String refusal) {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-lead", "storage-lead",
                "config".equals(refusal) ? "other" : WorkspaceExecutionProfile.CONFIG_REF,
                "policy".equals(refusal) ? "other" : WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-lead", "actor-a", !"reader".equals(refusal));
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(!"files-off".equals(refusal));
        if (!"missing-mount".equals(refusal)) {
            properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                    new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(tenant, "storage-lead", "/workspace")));
        }
        if ("registry".equals(refusal)) {
            jdbc.update("UPDATE ma_workspace SET state = 'DRAINING' WHERE tenant_id = ?", tenant);
        }
        if ("migration".equals(refusal)) {
            fenceStorage(tenant, "storage-lead");
        }
        var defensive = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        assertThatThrownBy(() -> new TransactionTemplate(transactionManager).execute(status ->
                defensive.insertInternalTeamLeadSessionCommand(tenant, "actor-a", "internal", "digest", null,
                        new WorkspaceSelection("ws-lead", "."))))
                .isInstanceOfAny(ManagedAgentException.class, com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'SESSION_CREATE_ACTOR' AND tenant_id = ?",
                Integer.class, tenant)).isZero();
    }

    @ParameterizedTest
    @CsvSource({"true, yolo", "true, unknown", "true, plan", "true, ''", "false, default", "false, auto-edit"})
    void foregroundShellRequiresFilesAndPersistedAskingApproval(boolean filesEnabled, String mode) {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-shell", "storage-shell", WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-shell", "actor-a", true);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(true);
        properties.getHarness().setApprovalMode("default");
        var enabled = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        String session = new TransactionTemplate(transactionManager).execute(status ->
                enabled.insertWorkspaceSessionCommand(tenant, "actor-a", "create", "digest", "qwen-code",
                        null, null, List.of(), null, new WorkspaceSelection("ws-shell", ".")).sessionId());
        jdbc.update("UPDATE ma_session SET approval_mode = ? WHERE tenant_id = ? AND session_id = ?", mode, tenant, session);
        properties.getHarness().setWorkspaceFilesEnabled(filesEnabled);
        var defensive = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        var projection = new ManagedAgentService(defensive, new RequestDigests(), mock(HarnessCoordinator.class),
                new UnavailableHarnessConnector(), registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        assertThat(projection.getPublicSession(tenant, "actor-a", session).capabilities().foregroundShell()).isFalse();
        assertThat(projection.getWebShellSession(tenant, "actor-a", session).capabilities().foregroundShell()).isFalse();
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void sessionReadsOmitForegroundShellForFilesAndUnbound(boolean bound) throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        if (bound) {
            register(tenant, "ws-a", "storage-a");
            grant(tenant, "ws-a", "actor-a", true);
        }
        String body = bound
                ? "{\"agent_id\":\"qwen-code\",\"workspace\":{\"workspace_id\":\"ws-a\"}}"
                : "{\"agent_id\":\"qwen-code\"}";
        var created = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "create")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.capabilities").isMap())
                .andExpect(jsonPath("$.capabilities.foreground_shell").doesNotHaveJsonPath())
                .andReturn();
        String session = mapper.readTree(created.getResponse().getContentAsString()).get("id").asText();
        assertThat(store.requireSession(tenant, session).toolProfile())
                .isEqualTo(bound ? "hosted-workspace-files/1" : null);
        mvc.perform(get("/v1/agents/sessions/" + session)
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capabilities").isMap())
                .andExpect(jsonPath("$.capabilities.foreground_shell").doesNotHaveJsonPath());
        mvc.perform(post("/api/agent/web-shell/v1/sessions/get")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + session + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capabilities").isMap())
                .andExpect(jsonPath("$.capabilities.foregroundShell").doesNotHaveJsonPath());
    }

    @ParameterizedTest
    @ValueSource(strings = {"default", "auto-edit"})
    void shellFlagChangesPreserveCreationAndTurnReplayButBlockFreshWorkAndLifecycle(String mode) {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-shell", "storage-shell", WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-shell", "actor-a", true);
        grant(tenant, "ws-shell", "reader", false);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(true);
        properties.getHarness().setApprovalMode(mode);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(tenant, "storage-shell", "/workspace")));
        ManagedAgentStore enabled = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        var transaction = new TransactionTemplate(transactionManager);
        String digest = "sha256:" + "a".repeat(64);
        var selection = new WorkspaceSelection("ws-shell", ".");
        String session = transaction.execute(status -> enabled.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create-shell", digest, "qwen-code", null, null, List.of(), null, selection)).sessionId();
        var initial = transaction.execute(status -> enabled.insertWorkspaceSessionCommand(tenant,
                "actor-a", "initial-shell", digest, "qwen-code", null, null,
                List.of(Map.of("type", "text", "text", "initial")), digest, selection));
        byte[] actorKey = "actor-a".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        for (String id : List.of(session, initial.sessionId())) {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                    + " AND creator_actor_key = ? AND owner_actor_key = ?", Integer.class,
                    tenant, id, actorKey, actorKey)).isEqualTo(1);
            assertThat(enabled.requireSession(tenant, id).toolProfile()).isEqualTo("hosted-workspace-shell/1");
            assertThat(enabled.requireSession(tenant, id).approvalMode()).isEqualTo(mode);
        }
        UnavailableHarnessConnector harness = new UnavailableHarnessConnector() {
            @Override
            public boolean isAvailable() { return true; }
            @Override
            public boolean isWorkspaceFilesAvailable() { return true; }
        };
        var coordinator = mock(com.alibaba.qwen.code.managedagent.session.HarnessCoordinator.class);
        ManagedAgentService admitted = new ManagedAgentService(enabled, new RequestDigests(), coordinator, harness, registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        List<InputBlock> input = List.of(new InputBlock("text", "go"));
        var original = transaction.execute(status -> admitted.submitTurn(tenant, "actor-a", "original", session, input));
        assertThat(admitted.getPublicSession(tenant, "actor-a", session).capabilities().foregroundShell()).isTrue();
        properties.getHarness().setWorkspaceShellEnabled(false);
        ManagedAgentStore disabled = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        ManagedAgentService stopped = new ManagedAgentService(disabled, new RequestDigests(), coordinator, harness, registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        assertThat(transaction.execute(status -> disabled.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create-shell", digest, "qwen-code", null, null, List.of(), null, selection)).sessionId())
                .isEqualTo(session);
        assertThat(transaction.execute(status -> stopped.submitTurn(tenant, "actor-a", "original", session, input)).turnId())
                .isEqualTo(original.turnId());
        assertThatThrownBy(() -> transaction.execute(status -> stopped.submitTurn(tenant, "actor-a", "fresh", session, input)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> stopped.submitTurn(tenant, "reader", "original", session, input))
                .isInstanceOf(ManagedAgentException.class);
        var capabilities = stopped.getWebShellSession(tenant, "actor-a", session).capabilities();
        assertThat(capabilities.workspaceTurns()).isTrue();
        assertThat(capabilities.foregroundShell()).isFalse();
        assertThat(capabilities.sessionClose()).isFalse();
        assertThat(capabilities.sessionDelete()).isFalse();
        var cancellation = transaction.execute(status -> stopped.cancelTurn(tenant, "actor-a", "cancel", session, original.turnId()));
        assertThat(cancellation.turnId()).isEqualTo(original.turnId());
        assertThat(jdbc.queryForObject("SELECT status FROM ma_turn WHERE tenant_id = ? AND turn_id = ?",
                String.class, tenant, original.turnId())).isEqualTo("CANCELLING");
        verify(coordinator).cancel(tenant, session, original.turnId());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                Integer.class, tenant, session)).isEqualTo(1);
        for (String state : List.of("ACTIVE", "CLOSED", "ARCHIVED")) {
            jdbc.update("UPDATE ma_session SET status = ? WHERE tenant_id = ? AND session_id = ?", state, tenant, session);
            for (var kind : List.of(com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.CLOSE,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.ARCHIVE,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.DELETE)) {
                assertThatThrownBy(() -> transaction.execute(status -> disabled.beginWorkspaceLifecycle(tenant, session,
                        kind, "actor-a", digest, state + kind, digest, true, 1))).isInstanceOf(ManagedAgentException.class);
            }
            assertThatThrownBy(() -> transaction.execute(status -> disabled.unarchiveWorkspaceSession(tenant, session,
                    "actor-a", "unarchive-" + state, digest))).isInstanceOf(ManagedAgentException.class);
            var read = stopped.getPublicSession(tenant, "actor-a", session).capabilities();
            assertThat(read.sessionArchive()).isFalse();
            assertThat(read.sessionUnarchive()).isFalse();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_kind NOT IN ('SUBMIT_INPUT', 'CANCEL')", Integer.class, tenant, session)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_kind IN ('SUBMIT_INPUT', 'CANCEL')", Integer.class, tenant, session)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ? AND session_id = ?",
                Integer.class, tenant, session)).isEqualTo(2);
        String files = transaction.execute(status -> disabled.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create-files", digest, "qwen-code", null, null, List.of(), null, selection)).sessionId();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                + " AND creator_actor_key = ? AND owner_actor_key = ?", Integer.class,
                tenant, files, actorKey, actorKey)).isEqualTo(1);
        assertThat(disabled.requireSession(tenant, files).toolProfile()).isEqualTo("hosted-workspace-files/1");
        assertThat(stopped.getPublicSession(tenant, "actor-a", files).capabilities().foregroundShell()).isNull();
        var fileTurn = transaction.execute(status -> stopped.submitTurn(tenant, "actor-a", "files-turn", files, input));
        assertThat(fileTurn).isNotNull();
    }

    @Test
    void migrationFenceBlocksNewTurnsAndMutationsButPreservesReceipts() throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-migration", "storage-migration",
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-migration", "actor-a", true);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore enabled = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        var transaction = new TransactionTemplate(transactionManager);
        String digest = "sha256:" + "a".repeat(64);
        String session = transaction.execute(status -> enabled.insertWorkspaceSessionCommand(
                tenant, "actor-a", "create-migration", digest, "qwen-code", null, null,
                List.of(), null, new WorkspaceSelection("ws-migration", "."))).sessionId();
        var original = transaction.execute(status -> enabled.insertTurnCommand(tenant, "SUBMIT_TURN",
                "original-turn", digest, session, List.of(Map.of("type", "text", "text", "go")), digest));
        jdbc.update("UPDATE ma_turn SET status = 'SUCCEEDED' WHERE tenant_id = ? AND session_id = ?",
                tenant, session);
        transaction.executeWithoutResult(status -> {
            enabled.beginSessionMutation(tenant, "RENAME_SESSION", "original-rename", digest, session,
                    SessionMutationKind.RENAME);
            enabled.completeSessionMutation(tenant, "RENAME_SESSION", "original-rename", session,
                    SessionMutationKind.RENAME, "original", null);
        });
        fenceStorage(tenant, "storage-migration");
        assertThat(transaction.execute(status -> enabled.insertTurnCommand(tenant, "SUBMIT_TURN",
                "original-turn", digest, session, List.of(), digest)).turnId()).isEqualTo(original.turnId());
        assertThat(transaction.execute(status -> enabled.beginSessionMutation(tenant, "RENAME_SESSION",
                "original-rename", digest, session, SessionMutationKind.RENAME)).replayed()).isTrue();
        assertThatThrownBy(() -> transaction.execute(status -> enabled.insertTurnCommand(tenant, "SUBMIT_TURN",
                "new-turn", digest, session, List.of(), digest))).isInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class)
                .hasMessage("Workspace execution authority is unavailable.");
        assertThatThrownBy(() -> transaction.execute(status -> enabled.beginSessionMutation(tenant, "RENAME_SESSION",
                "new-rename", digest, session, SessionMutationKind.RENAME))).isInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class)
                .hasMessage("Workspace execution authority is unavailable.");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?",
                Long.class, tenant, session)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT title FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, session)).isEqualTo("original");
    }

    @Test
    void discoveryFiltersBeforePagingAndKeepsDefaultOutsidePage()
            throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "a-hidden", "physical-a");
        register(tenant, "b-visible", "physical-b");
        register(tenant, "c-readonly", "physical-c");
        register(tenant, "d-default", "physical-d");
        grant(tenant, "a-hidden", "other", true);
        grant(tenant, "b-visible", "actor-a", true);
        grant(tenant, "c-readonly", "actor-a", false);
        grant(tenant, "d-default", "actor-a", true);
        setDefaultWorkspace(tenant, "d-default");
        var response = mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .param("limit", "1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].id")
                        .value("b-visible"))
                .andExpect(jsonPath("$.data[0].object")
                        .value("agent.workspace"))
                .andExpect(jsonPath("$.data[0].state").value("active"))
                .andExpect(jsonPath("$.default_workspace.id")
                        .value("d-default"))
                .andExpect(jsonPath("$.default_workspace.object")
                        .value("agent.workspace"))
                .andExpect(jsonPath("$.has_more").value(true))
                .andExpect(jsonPath("$.capabilities.workspace_binding")
                        .value(true))
                .andExpect(jsonPath("$.capabilities.workspace_context")
                        .value(false))
                .andReturn();
        assertThat(response.getResponse().getHeader("Cache-Control"))
                .contains("no-store");
        assertThat(response.getResponse().getContentAsString())
                .doesNotContain("physical-b", "config-b-visible",
                        "policy-b-visible");
        String cursor = mapper.readTree(response.getResponse()
                .getContentAsString()).get("next_cursor").asText();
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .param("limit", "1").param("cursor", cursor))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].id")
                        .value("c-readonly"))
                .andExpect(jsonPath("$.data[0].can_create_session")
                        .value(false));
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "other"))
                        .param("limit", "1").param("cursor", cursor))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .param("limit", "2").param("cursor", cursor))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code")
                        .value("invalid_workspace_cursor"));
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/query")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "limit", 2, "cursor", cursor))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code")
                        .value("invalid_workspace_cursor"));
        String longActor = "界".repeat(512);
        grant(tenant, "b-visible", longActor, true);
        grant(tenant, "d-default", longActor, true);
        var longActorPage = mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, longActor))
                        .param("limit", "1"))
                .andExpect(status().isOk()).andReturn();
        String longActorCursor = mapper.readTree(longActorPage.getResponse()
                .getContentAsString()).get("next_cursor").asText();
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, longActor))
                        .param("limit", "1")
                        .param("cursor", longActorCursor))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].id")
                        .value("d-default"));
        mvc.perform(get("/v1/agents/workspaces/a-hidden")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isNotFound());
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/query")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"limit\":1}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].workspaceId")
                        .value("b-visible"))
                .andExpect(jsonPath("$.data[0].state").value("active"))
                .andExpect(jsonPath("$.defaultWorkspace.workspaceId")
                        .value("d-default"))
                .andExpect(jsonPath("$.defaultWorkspace.state")
                        .value("active"));
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/get")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"workspaceId\":\"b-visible\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.workspaceId").value("b-visible"))
                .andExpect(jsonPath("$.state").value("active"));
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant))
                .andExpect(status().isUnauthorized());
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor("another-tenant", "actor-a")))
                .andExpect(status().isForbidden());
        jdbc.update("UPDATE ma_workspace SET state = 'DRAINING'"
                + " WHERE tenant_id = ? AND workspace_id = ?", tenant,
                "b-visible");
        mvc.perform(get("/v1/agents/workspaces/b-visible")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value("b-visible"))
                .andExpect(jsonPath("$.object").value("agent.workspace"))
                .andExpect(jsonPath("$.state").value("draining"))
                .andExpect(jsonPath("$.can_create_session").value(false));
        jdbc.update("UPDATE ma_workspace SET state = 'REMOVED'"
                + " WHERE tenant_id = ? AND workspace_id = ?", tenant,
                "d-default");
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.default_workspace").value((Object) null));
        jdbc.update("DELETE FROM ma_workspace_access"
                        + " WHERE tenant_id = ? AND workspace_id = ?",
                tenant, "b-visible");
        mvc.perform(get("/v1/agents/workspaces/b-visible")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isNotFound());
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(2))
                .andExpect(jsonPath("$.data[0].id")
                        .value("c-readonly"))
                .andExpect(jsonPath("$.data[1].id")
                        .value("d-default"));
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/query")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(2))
                .andExpect(jsonPath("$.data[0].workspaceId")
                        .value("c-readonly"))
                .andExpect(jsonPath("$.data[1].workspaceId")
                        .value("d-default"));
    }

    @ParameterizedTest
    @ValueSource(ints = {0, 101})
    void discoveryRejectsOutOfRangePageSizes(int limit) throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .param("limit", Integer.toString(limit)))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/agent/web-shell/v1/workspaces/query")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("limit", limit))))
                .andExpect(status().isBadRequest());
    }

    @Test
    void publicCreationPinsSevenFieldBindingAndReplaysAfterRegistryChange()
            throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        String body = """
                {"agent_id":"qwen-code","input":[],
                 "workspace":{"workspace_id":"ws-a",
                              "cwd_relative":"services/./api"}}
                """;
        var first = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "create-a")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.workspace.workspace_id")
                        .value("ws-a"))
                .andExpect(jsonPath("$.workspace.cwd_relative")
                        .value("services/api"))
                .andReturn();
        String sessionId = mapper.readTree(first.getResponse()
                .getContentAsString()).get("id").asText();
        ContextBinding binding = store.requireSession(tenant, sessionId)
                .workspace();
        assertThat(store.requireSession(tenant, sessionId).toolProfile())
                .isEqualTo("hosted-workspace-files/1");
        assertThat(binding.getTenantId()).isEqualTo(tenant);
        assertThat(binding.getWorkspaceGeneration()).isEqualTo(1);
        assertThat(binding.getStorageId()).isEqualTo("storage-a");
        assertThat(binding.getContextRevision()).isEqualTo(1);
        assertThat(binding.getContextConfigRef()).isEqualTo(
                "sha256:6ed28bc26a1bf7f36cb3943d200ca1352a29fcc5867683a8a62845f1d32d1cab");
        assertThat(binding.getContextDigest()).startsWith("sha256:");
        assertThat(jdbc.queryForObject("SELECT workspace_config_ref FROM"
                + " ma_session WHERE session_id = ?",
                String.class, sessionId)).isEqualTo("config-ws-a");
        assertThat(jdbc.queryForObject("SELECT workspace_policy_ref FROM"
                + " ma_session WHERE session_id = ?",
                String.class, sessionId)).isEqualTo("policy-ws-a");

        jdbc.update("UPDATE ma_workspace SET"
                        + " workspace_generation = 2, state = 'DRAINING'"
                        + " WHERE tenant_id = ? AND workspace_id = ?",
                tenant, "ws-a");
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "create-a")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.id").value(sessionId));
        assertThat(store.requireSession(tenant, sessionId).workspace())
                .isEqualTo(binding);
        assertThat(store.requireSession(tenant, sessionId).toolProfile())
                .isEqualTo("hosted-workspace-files/1");
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "create-b")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("workspace_unavailable"));
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "create-c")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("actor_required"));
    }

    @Test
    void revocationHidesBoundSessionAndBlocksRetry() throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        String body = """
                {"agent_id":"qwen-code","input":[],
                 "workspace":{"workspace_id":"ws-a"}}
                """;
        var first = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "create")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isAccepted()).andReturn();
        String sessionId = mapper.readTree(first.getResponse()
                .getContentAsString()).get("id").asText();
        mvc.perform(post("/v1/agents/sessions/" + sessionId + "/events")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "turn")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"type":"agent.session.input.message",
                                 "input":[{"type":"text","text":"hello"}]}
                                """))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("workspace_unavailable"));
        mvc.perform(patch("/v1/agents/sessions/" + sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "rename")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"new title\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("workspace_unavailable"));
        mvc.perform(get("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].id").value(sessionId));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_request_receipt WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ?"
                        + " AND session_id = ?", Integer.class, tenant,
                sessionId)).isZero();
        jdbc.update("DELETE FROM ma_workspace_access"
                        + " WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND actor_id = ?", tenant, "ws-a",
                "actor-a".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        for (String suffix : List.of("/items", "/events")) {
            mvc.perform(get("/v1/agents/sessions/" + sessionId + suffix)
                            .header(TenantContextFilter.HEADER, tenant)
                            .principal(actor(tenant, "actor-a")))
                    .andExpect(status().isNotFound());
        }
        mvc.perform(post("/api/agent/web-shell/v1/transcript/query")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("sessionId", sessionId))))
                .andExpect(status().isNotFound());
        mvc.perform(get("/v1/agents/sessions/" + sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isNotFound());
        mvc.perform(get("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").isEmpty());
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "create")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isNotFound());
        // The WebShell create route has no post-service re-read that could
        // mask the replay probe: with the grant revoked, the recorded
        // creation command must answer 404 here, never a 202 replay.
        mvc.perform(post("/api/agent/web-shell/v1/sessions/create")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"idempotencyKey":"create",
                                 "agentId":"qwen-code","input":[],
                                 "workspace":{"workspaceId":"ws-a"}}
                                """))
                .andExpect(status().isNotFound());
        mvc.perform(patch("/v1/agents/sessions/" + sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "rename")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"new title\"}"))
                .andExpect(status().isNotFound());
        assertThatThrownBy(() -> service.renameSession(tenant, "actor-a",
                "invalid-rename", sessionId, ""))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode()).isEqualTo("session_not_found"));
    }

    @Test
    void aRecordedSubmitAnswersOnlyToAnActorAuthorizedForTheSession() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        grant(tenant, "ws-a", "actor-b", true);
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", "sha256:" + "a".repeat(64), "qwen-code",
                null, null, List.of(), null, new WorkspaceSelection("ws-a",
                        "."))
                .sessionId();
        ManagedAgentProperties enabled = new ManagedAgentProperties();
        enabled.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, enabled, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        UnavailableHarnessConnector harness =
                new UnavailableHarnessConnector() {
                    @Override
                    public boolean isAvailable() {
                        return true;
                    }

                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        return true;
                    }
                };
        ManagedAgentService service = new ManagedAgentService(gated,
                new RequestDigests(), mock(HarnessCoordinator.class), harness,
                registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        // The plain store instance is no Spring proxy, so its @Transactional
        // boundaries come from the template.
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        List<InputBlock> input = List.of(new InputBlock("text", "go"));
        transaction.executeWithoutResult(status -> assertThat(
                service.submitTurn(tenant, "actor-a", "submit", sessionId,
                        input).replayed()).isFalse());
        // The creator's own retry replays the recorded outcome.
        transaction.executeWithoutResult(status -> assertThat(
                service.submitTurn(tenant, "actor-a", "submit", sessionId,
                        input).replayed()).isTrue());

        // A second actor in the same tenant must never see it — not with
        // the same body, and not with a different one (which would turn the
        // 409 into an oracle confirming the key is live).
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.submitTurn(tenant, "actor-b",
                        "submit", sessionId, input))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.submitTurn(tenant, "actor-b",
                        "submit", sessionId, List.of(new InputBlock("text",
                                "other"))))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("workspace_unavailable")));
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.submitTurn(tenant, "actor-c",
                        "submit", sessionId, input))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("session_not_found")));
    }

    @Test
    void aBoundRenameReplaysItsRecordedOutcomeAfterTheSessionWasDeleted() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        grant(tenant, "ws-a", "actor-b", true);
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", "sha256:" + "a".repeat(64), "qwen-code",
                null, null, List.of(), null, new WorkspaceSelection("ws-a",
                        "."))
                .sessionId();
        ManagedAgentProperties enabled = new ManagedAgentProperties();
        enabled.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, enabled, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        UnavailableHarnessConnector harness =
                new UnavailableHarnessConnector() {
                    @Override
                    public boolean isAvailable() {
                        return true;
                    }

                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        return true;
                    }

                    @Override
                    public Attachment createOrLoad(String tenantId,
                            String sessionId, boolean loadExisting) {
                        return new Attachment("boot");
                    }

                    @Override
                    public boolean supportsFencedTitles() {
                        return true;
                    }

                    @Override
                    public void rename(String tenantId, String sessionId,
                            String title) {
                    }
                };
        ManagedAgentService service = new ManagedAgentService(gated,
                new RequestDigests(), mock(HarnessCoordinator.class), harness,
                registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        transaction.executeWithoutResult(status -> assertThat(
                service.renameSession(tenant, "actor-a", "rename", sessionId,
                        "new title").replayed()).isFalse());

        // The delete flow's durable footprint for a bound Session: the
        // operation row records the last-visible status — CLOSED or
        // ARCHIVED, the two pre-delete states a bound delete admits — and
        // the Session row becomes a tombstone.
        recordDelete(tenant, sessionId, "CLOSED");

        // The recorded rename answers with the Session as last visible —
        // its pre-delete status — rather than a 404 or a 409.
        transaction.executeWithoutResult(status -> {
            var replay = service.renameSession(tenant, "actor-a", "rename",
                    sessionId, "new title");
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.body().status()).isEqualTo("closed");
        });

        // The outcome answers only to the Session's own actor: on a
        // tombstone a readable non-creator meets the reads' not-found —
        // workspace_unavailable is the live-Session refusal — and an actor
        // without a grant gets the same not-found.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-b", "rename", sessionId, "new title"))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("session_not_found")));
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-c", "rename", sessionId, "new title"))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                                assertThat(error.getCode())
                                        .isEqualTo("session_not_found")));
    }

    // The grant-less arm of the rename replay gate: with the key recorded
    // as a completed rename of the Session, every title shape — over-long,
    // blank, control-bearing — must answer the same 404 a fresh key
    // answers, never the invalid_title the digest evaluation would throw
    // ahead of the actor gates.
    @Test
    void aRecordedRenameAnswers404ToAGrantlessActorForEveryTitleShape() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", "sha256:" + "a".repeat(64), "qwen-code",
                null, null, List.of(), null, new WorkspaceSelection("ws-a",
                        "."))
                .sessionId();
        ManagedAgentProperties enabled = new ManagedAgentProperties();
        enabled.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, enabled, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        UnavailableHarnessConnector harness =
                new UnavailableHarnessConnector() {
                    @Override
                    public boolean isAvailable() {
                        return true;
                    }

                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        return true;
                    }

                    @Override
                    public Attachment createOrLoad(String tenantId,
                            String sessionId, boolean loadExisting) {
                        return new Attachment("boot");
                    }

                    @Override
                    public boolean supportsFencedTitles() {
                        return true;
                    }

                    @Override
                    public void rename(String tenantId, String sessionId,
                            String title) {
                    }
                };
        ManagedAgentService service = new ManagedAgentService(gated,
                new RequestDigests(), mock(HarnessCoordinator.class), harness,
                registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        transaction.executeWithoutResult(status -> assertThat(
                service.renameSession(tenant, "actor-a", "rename", sessionId,
                        "new title").replayed()).isFalse());

        // actor-z holds no grant row at all: the recorded key and a fresh
        // key answer alike for every title shape.
        for (String title : new String[] {"t".repeat(300), "",
                "bad\ntitle", "new title"}) {
            assertNotFound(service, transaction, tenant, sessionId, "rename",
                    title);
            assertNotFound(service, transaction, tenant, sessionId, "fresh",
                    title);
        }
    }

    private void assertNotFound(ManagedAgentService service,
            TransactionTemplate transaction, String tenant, String sessionId,
            String key, String title) {
        transaction.executeWithoutResult(status -> assertThatThrownBy(
                () -> service.renameSession(tenant, "actor-z", key, sessionId,
                        title))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.NOT_FOUND.value());
                    assertThat(error.getCode())
                            .isEqualTo("session_not_found");
                }));
    }

    // The rename key is tenant-global — its SESSION_COMMAND receipt is
    // keyed by (tenant, operation, idempotency key), with no session and no
    // actor — so a key actor-a's Session X consumed is not actor-b's request
    // for his own Session Y, and the replay probe must not fire on it. The
    // fall-through answers idempotency_conflict, which tells the client to
    // retry under a fresh key; the pre-guard probe instead ran the actor
    // gate against the recorded Session X and answered session_not_found for
    // a Session that exists and is actor-b's.
    @Test
    void aKeyConsumedByAnotherSessionAnswersIdempotencyConflict() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        register(tenant, "ws-b", "storage-b",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        grant(tenant, "ws-b", "actor-b", true);
        String sessionX = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create-x", "sha256:" + "a".repeat(64),
                "qwen-code", null, null, List.of(), null,
                new WorkspaceSelection("ws-a", ".")).sessionId();
        String sessionY = store.insertWorkspaceSessionCommand(tenant,
                "actor-b", "create-y", "sha256:" + "b".repeat(64),
                "qwen-code", null, null, List.of(), null,
                new WorkspaceSelection("ws-b", ".")).sessionId();
        ManagedAgentService service = boundServiceWithWorkingHarness();
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        transaction.executeWithoutResult(status -> assertThat(
                service.renameSession(tenant, "actor-a", "rename", sessionX,
                        "new title").replayed()).isFalse());

        // Same key and same title, but a different Session: not the
        // recorded request, so no replay — and Y keeps its title.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-b", "rename", sessionY, "new title"))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                            assertThat(error.getCode())
                                    .isEqualTo("idempotency_conflict");
                            assertThat(error.getStatus())
                                    .isEqualTo(HttpStatus.CONFLICT.value());
                        }));
        assertThat(jdbc.queryForObject(
                "SELECT title FROM ma_session WHERE tenant_id = ?"
                        + " AND session_id = ?",
                String.class, tenant, sessionY)).isNull();
    }

    // The recorded rename's actor gate covers the UNFINISHED row too, not
    // only the completed outcome: beginSessionRename compares key, Session
    // and digest, never the actor, so without the gate a non-recorder
    // OPERATOR replaying the key while the row is PENDING claims the
    // recorder's delivery, drives harness.rename, flips the row to
    // COMPLETED and answers 200 replayed — the recorded outcome the
    // contract reserves for the actor who recorded it.
    @Test
    void aPendingRenameReplayKeepsTheRecorderGate() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        grant(tenant, "ws-a", "actor-b", true);
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", "sha256:" + "a".repeat(64), "qwen-code",
                null, null, List.of(), null, new WorkspaceSelection("ws-a",
                        "."))
                .sessionId();
        ManagedAgentService service = boundServiceWithWorkingHarness();
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        // The recorder's unfinished row, written exactly as the service
        // writes it but never driven to completion. The autowired store
        // runs the default workspace-disabled profile, whose rename gate
        // refuses, so the row is written through an enabled one.
        ManagedAgentProperties enabled = new ManagedAgentProperties();
        enabled.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, enabled, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        String digest = new RequestDigests().digest(Map.of("sessionId",
                sessionId, "title", "new title"));
        transaction.executeWithoutResult(status -> gated.beginSessionRename(
                tenant, "rename", digest, sessionId, "new title", "actor-a"));

        // The non-recorder OPERATOR's same-title replay meets the same
        // refusal the completed outcome answers, and the recorder's row
        // and delivery stay untouched.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-b", "rename", sessionId, "new title"))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                            assertThat(error.getStatus())
                                    .isEqualTo(HttpStatus.CONFLICT.value());
                            assertThat(error.getCode())
                                    .isEqualTo("workspace_unavailable");
                        }));
        assertThat(jdbc.queryForObject("SELECT state FROM"
                        + " ma_request_receipt WHERE namespace ="
                        + " 'SESSION_COMMAND' AND tenant_id = ?"
                        + " AND operation = 'RENAME_SESSION'"
                        + " AND idempotency_key = ?", String.class,
                tenant, "rename")).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT attempt_count FROM"
                        + " ma_operation WHERE operation_kind = 'RENAME'"
                        + " AND tenant_id = ? AND session_id = ?",
                Integer.class, tenant, sessionId)).isZero();

        // The recorder's own retry resumes the delivery to completion.
        transaction.executeWithoutResult(status -> assertThat(
                service.renameSession(tenant, "actor-a", "rename", sessionId,
                        "new title").replayed()).isTrue());
        assertThat(jdbc.queryForObject("SELECT title FROM"
                        + " ma_session WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, tenant,
                sessionId)).isEqualTo("new title");
    }

    // A different-title replay of the same unfinished row answers the
    // uniform refusal too: without the gate, beginSessionMutation's
    // idempotency_conflict names the live key the answer must keep hidden.
    @Test
    void aPendingRenameReplayWithADifferentTitleKeepsTheUniformRefusal() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        grant(tenant, "ws-a", "actor-b", true);
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", "sha256:" + "a".repeat(64), "qwen-code",
                null, null, List.of(), null, new WorkspaceSelection("ws-a",
                        "."))
                .sessionId();
        ManagedAgentService service = boundServiceWithWorkingHarness();
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        ManagedAgentProperties enabled = new ManagedAgentProperties();
        enabled.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, enabled, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        String digest = new RequestDigests().digest(Map.of("sessionId",
                sessionId, "title", "new title"));
        transaction.executeWithoutResult(status -> gated.beginSessionRename(
                tenant, "rename", digest, sessionId, "new title", "actor-a"));

        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-b", "rename", sessionId, "other title"))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                            assertThat(error.getStatus())
                                    .isEqualTo(HttpStatus.CONFLICT.value());
                            assertThat(error.getCode())
                                    .isEqualTo("workspace_unavailable");
                        }));
    }

    @Test
    void retryOfOmittedSelectionKeepsOriginalDefault() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        register(tenant, "ws-b", "storage-b");
        grant(tenant, "ws-a", "actor-a", true);
        grant(tenant, "ws-b", "actor-a", true);
        setDefaultWorkspace(tenant, "ws-a");
        var first = store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "key", "sha256:" + "a".repeat(64), "qwen-code", null, null,
                List.of(), null, null);
        setDefaultWorkspace(tenant, "ws-b");
        var retry = store.replayWorkspaceSessionCommand(tenant, "actor-a",
                "key", "sha256:" + "a".repeat(64));
        assertThat(retry.sessionId()).isEqualTo(first.sessionId());
        assertThat(store.requireSession(tenant, first.sessionId())
                .workspace().getWorkspaceId()).isEqualTo("ws-a");
        var second = store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "new-key", "sha256:" + "a".repeat(64), "qwen-code", null,
                null, List.of(), null, null);
        assertThat(store.requireSession(tenant, second.sessionId())
                .workspace().getWorkspaceId()).isEqualTo("ws-b");
        assertThatThrownBy(() -> store.replayWorkspaceSessionCommand(tenant,
                "actor-a", "key", "sha256:" + "b".repeat(64)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("idempotency_conflict"));
    }

    @Test
    void boundRetriesReplayBeforeCheckingTheRevision() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        WorkspaceSelection selection = new WorkspaceSelection("ws-a", ".");
        String digest = "sha256:" + "a".repeat(64);
        var first = store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "key", digest, "qwen-code", "1", null, List.of(), null,
                selection);
        ManagedAgentProperties changed = new ManagedAgentProperties();
        changed.setAgentRevision("2");
        ManagedAgentStore upgraded = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, changed, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));

        assertThat(upgraded.insertWorkspaceSessionCommand(tenant, "actor-a",
                "key", digest, "qwen-code", "1", null, List.of(), null,
                selection).sessionId()).isEqualTo(first.sessionId());
        assertThatThrownBy(() -> upgraded.insertWorkspaceSessionCommand(
                tenant, "actor-a", "new-key", digest, "qwen-code", "1", null,
                List.of(), null, selection))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("unsupported_feature"));
    }

    @Test
    void storeCannotCreateOrDispatchBoundTurnsWhenServiceIsBypassed() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        var selection = new WorkspaceSelection("ws-a", ".");
        List<Map<String, Object>> input = List.of(
                Map.of("type", "text", "text", "go"));
        assertThatThrownBy(() -> store.insertWorkspaceSessionCommand(
                tenant, "actor-a", "nonempty", "digest", "qwen-code", null,
                null, input, "payload", selection))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        var created = store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "empty", "digest", "qwen-code", null, null, List.of(), null,
                selection);
        String sessionId = created.sessionId();
        assertThatThrownBy(() -> store.insertTurnCommand(tenant, "SUBMIT",
                "turn", "digest", sessionId, input, "payload"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> store.insertCancelCommand(tenant, "CANCEL",
                "cancel", "digest", sessionId, "turn-id"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> store.beginSessionMutation(tenant,
                "RENAME", "rename", "digest", sessionId,
                SessionMutationKind.RENAME))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> store.completeSessionMutation(tenant,
                "RENAME", "rename", sessionId, SessionMutationKind.RENAME,
                "new title", "boot"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_turn WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_request_receipt WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ?",
                Integer.class, tenant)).isZero();
    }

    // An out-of-enum stored role — reachable only by an out-of-band write
    // past V53's CHECK — fails closed at the unfiltered role reads: the
    // plain access read answers NONE (the invisible-404 shape a caller
    // already meets below a valid role) and creation keeps its domain
    // 404, instead of a valueOf IllegalArgumentException surfacing a 500.
    @Test
    void anOutOfEnumStoredRoleFailsClosedAtEveryRoleRead() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        String digest = "sha256:" + "a".repeat(64);
        store.insertWorkspaceSessionCommand(tenant, "actor-a", "create",
                digest, "qwen-code", null, null, List.of(), null,
                new WorkspaceSelection("ws-a", "."));
        jdbc.update("ALTER TABLE ma_workspace_access DROP CONSTRAINT ck_ma_access_role");
        try {
            jdbc.update("UPDATE ma_workspace_access SET role = 'BROKEN'"
                            + " WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                    tenant, "ws-a", "actor-a".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertThat(registry.accessOf(tenant, "actor-a", "ws-a"))
                    .isEqualTo(com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess.NONE);
            assertThat(registry.canRead(tenant, "actor-a", "ws-a")).isFalse();
            assertRefused(() -> store.insertWorkspaceSessionCommand(tenant,
                            "actor-a", "create-2", digest, "qwen-code", null, null,
                            List.of(), null, new WorkspaceSelection("ws-a", ".")),
                    "workspace_not_found");
        } finally {
            jdbc.update("UPDATE ma_workspace_access SET role = 'OPERATOR'"
                            + " WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                    tenant, "ws-a", "actor-a".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String constraint = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.ddl()
                    .lines().filter(line -> line.contains("CONSTRAINT ck_ma_access_role CHECK"))
                    .findFirst().orElseThrow().trim().replaceFirst(",$", "");
            jdbc.update("ALTER TABLE ma_workspace_access ADD " + constraint);
        }
    }

    @Test
    void aSessionWithNoPersistedOwnerFailsClosed() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        grant(tenant, "ws-a", "actor-b", true);
        String digest = "sha256:" + "a".repeat(64);
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", digest, "qwen-code", null, null,
                List.of(), null, new WorkspaceSelection("ws-a", "."))
                .sessionId();
        jdbc.update("UPDATE ma_session SET owner_actor_key ="
                + " NULL, creator_actor_key = NULL WHERE tenant_id = ?"
                + " AND session_id = ?", tenant, sessionId);
        assertThat(registry.isSessionOwner(tenant, "actor-a", sessionId))
                .isFalse();
        assertThat(registry.isSessionOwner(tenant, "actor-b", sessionId))
                .isFalse();
    }

    @Test
    void enabledStoreAdmitsALaterTurnForTheBoundSessionCreator() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        grant(tenant, "ws-a", "actor-b", true);
        String digest = "sha256:" + "a".repeat(64);
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", digest, "qwen-code", null, null,
                List.of(), null, new WorkspaceSelection("ws-a", "."))
                .sessionId();
        List<Map<String, Object>> input = List.of(
                Map.of("type", "text", "text", "again"));

        // The creator lookup gates the service; other readers are not creators.
        assertThat(registry.createdSession(tenant, "actor-a", sessionId))
                .isTrue();
        assertThat(registry.createdSession(tenant, "actor-b", sessionId))
                .isFalse();
        assertThat(registry.createdSession("tenant-" + UUID.randomUUID(),
                "actor-a", sessionId)).isFalse();
        // The lookup pins this Session, not any bound Session the actor
        // created in the tenant: actor-b's own Session does not admit
        // actor-a, and vice versa.
        String otherSession = store.insertWorkspaceSessionCommand(tenant,
                "actor-b", "create-b", digest, "qwen-code", null, null,
                List.of(), null, new WorkspaceSelection("ws-a", "."))
                .sessionId();
        assertThat(registry.createdSession(tenant, "actor-a", otherSession))
                .isFalse();

        ManagedAgentProperties enabled = new ManagedAgentProperties();
        enabled.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, enabled, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        var admission = transaction.execute(status ->
                gated.insertTurnCommand(tenant, "SUBMIT", "later", digest,
                        sessionId, input, digest));
        assertThat(admission.sessionId()).isEqualTo(sessionId);
        assertThat(admission.turnId()).isNotBlank();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_turn WHERE tenant_id = ?"
                        + " AND session_id = ?",
                Integer.class, tenant, sessionId)).isEqualTo(1);
        // Unarchive stays gated for bound Sessions even under the opt-in.
        // It throws before any command row is written, so the rename probe
        // after it cannot collide with a leftover PENDING operation.
        assertThatThrownBy(() -> transaction.execute(status ->
                gated.beginSessionMutation(tenant, "UNARCHIVE_SESSION",
                        "unarchive-1", digest, sessionId,
                        SessionMutationKind.UNARCHIVE)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        // Rename is the one lifecycle-adjacent mutation the enabled store
        // opens for a bound Session: it begins PENDING and completes with
        // the new title.
        var rename = transaction.execute(status ->
                gated.beginSessionMutation(tenant, "RENAME_SESSION",
                        "rename-1", digest, sessionId,
                        SessionMutationKind.RENAME));
        assertThat(rename.status()).isEqualTo("PENDING");
        assertThat(transaction.execute(status ->
                gated.completeSessionMutation(tenant, "RENAME_SESSION",
                        "rename-1", sessionId, SessionMutationKind.RENAME,
                        "renamed title", "boot")).title())
                .isEqualTo("renamed title");
        // Cancel stays open for a bound Session under the opt-in.
        assertThat(gated.insertCancelCommand(tenant, "CANCEL", "cancel-1",
                digest, sessionId, admission.turnId()).turnId())
                .isEqualTo(admission.turnId());
    }

    @Test
    void boundLaterTurnAdmissionReadsTheAgentPinAndFrozenProfile() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        String digest = "sha256:" + "a".repeat(64);
        // A Session pinned to a compiled stored definition (D8c-1) passes
        // the later-Turn gate exactly like qwen-code.
        String agentId = "agent_" + "b".repeat(32);
        new ManagedAgentDefinitionStore(jdbc, new RequestDigests()).create(tenant, "def",
                "def-digest", agentId, "c".repeat(64),
                "{\"model\":{},\"instructions\":\"\","
                        + "\"tools\":[{\"type\":\"hosted_profile\","
                        + "\"profile\":\"hosted-workspace-files/1\"}],"
                        + "\"permission_policy\":{}}", 1L);
        String pinnedId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", digest, agentId, null, null,
                List.of(), null, new WorkspaceSelection("ws-a", "."))
                .sessionId();
        // A Session whose snapshotted profile refs are not the frozen pair
        // is refused too, even with the qwen-code agent.
        register(tenant, "ws-drift", "storage-drift");
        grant(tenant, "ws-drift", "actor-a", true);
        String driftedId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create-drift", digest, "qwen-code", null, null,
                List.of(), null, new WorkspaceSelection("ws-drift", "."))
                .sessionId();
        String controlId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create-control", digest, "qwen-code", null, null,
                List.of(), null, new WorkspaceSelection("ws-a", "."))
                .sessionId();
        UnavailableHarnessConnector enabledHarness =
                new UnavailableHarnessConnector() {
                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        return true;
                    }
                };
        ManagedAgentService enabled = new ManagedAgentService(store,
                new RequestDigests(), null, enabledHarness, registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());

        assertThat(enabled.getWebShellSession(tenant, "actor-a", pinnedId)
                .capabilities().workspaceTurns()).isTrue();
        assertThat(enabled.getWebShellSession(tenant, "actor-a", driftedId)
                .capabilities().workspaceTurns()).isFalse();
        assertThatThrownBy(() -> enabled.submitTurn(tenant, "actor-a",
                "later", driftedId,
                List.of(new InputBlock("text", "go"))))
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        // The same shape on the frozen profile with the qwen-code agent
        // stays admitted.
        assertThat(enabled.getWebShellSession(tenant, "actor-a", controlId)
                .capabilities().workspaceTurns()).isTrue();
        ManagedAgentService disabled = new ManagedAgentService(store,
                new RequestDigests(), null, new UnavailableHarnessConnector(), registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        assertThat(disabled.getWebShellSession(tenant, "actor-a", controlId)
                .capabilities().workspaceTurns()).isFalse();
    }

    @Test
    void refusedRenameRetiresItsCommandAndAdmitsTheNextOne() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        String digest = "sha256:" + "a".repeat(64);
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", digest, "qwen-code", null, null,
                List.of(), null, new WorkspaceSelection("ws-a", "."))
                .sessionId();
        ManagedAgentProperties enabled = new ManagedAgentProperties();
        enabled.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, enabled, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        // The Workspace authority refuses the first attach and admits the
        // second, so a rename after the refused one is observable.
        UnavailableHarnessConnector harness =
                new UnavailableHarnessConnector() {
                    private int attaches;

                    @Override
                    public boolean isAvailable() {
                        return true;
                    }

                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        return true;
                    }

                    @Override
                    public Attachment createOrLoad(String tenantId,
                            String sessionId, boolean loadExisting) {
                        if (attaches++ == 0) {
                            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
                        }
                        return new Attachment("boot");
                    }

                    @Override
                    public boolean supportsFencedTitles() {
                        return true;
                    }

                    @Override
                    public void rename(String tenantId, String sessionId,
                            String title) {
                    }
                };
        ManagedAgentService service = new ManagedAgentService(gated,
                new RequestDigests(), null, harness, registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);

        // The refusal answers its own permanent status, and the command row
        // it wrote must not survive to wedge every later rename.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-a", "rename-1", sessionId, "first"))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                            assertThat(error.getStatus())
                                    .isEqualTo(HttpStatus.CONFLICT.value());
                            assertThat(error.getCode())
                                    .isEqualTo("workspace_unavailable");
                        }));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_request_receipt WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ?"
                        + " AND session_id = ? AND state = 'PENDING'",
                Integer.class, tenant, sessionId)).isZero();

        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> gated.beginWorkspaceClose(tenant, sessionId, "actor-a",
                        "actor-digest", "close-while-rename-pending", digest, true))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                                assertThat(error.getCode()).isEqualTo("session_operation_active")));
        assertThat(jdbc.queryForObject("SELECT state FROM ma_request_receipt WHERE namespace = 'SESSION_COMMAND'"
                        + " AND tenant_id = ? AND operation = 'RENAME_SESSION' AND idempotency_key = ?",
                String.class, tenant, "rename-1")).isEqualTo("FAILED");

        // The freed key stays re-usable: a same-key retry re-attempts the
        // mutation instead of colliding on the requested event the refused
        // attempt already published.
        transaction.executeWithoutResult(status -> service.renameSession(
                tenant, "actor-a", "rename-1", sessionId, "first"));
        assertThat(jdbc.queryForObject("SELECT title FROM"
                        + " ma_session WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, tenant,
                sessionId)).isEqualTo("first");

        var blocker = transaction.execute(status -> gated.beginWorkspaceClose(tenant, sessionId,
                "actor-a", "actor-digest", "close-blocker", digest, true)).operation();
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-a", "rename-2", sessionId, "second"))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                                assertThat(error.getCode()).isEqualTo("workspace_unavailable")));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'SESSION_COMMAND'"
                        + " AND tenant_id = ? AND operation = 'RENAME_SESSION' AND idempotency_key = ?",
                Integer.class, tenant, "rename-2")).isZero();
        transaction.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM ma_operation WHERE tenant_id = ? AND session_id = ?"
                    + " AND operation_kind = 'CLOSE' AND operation_id = ?", tenant, sessionId, blocker.operationId());
            jdbc.update("UPDATE ma_session SET status = 'ACTIVE' WHERE tenant_id = ? AND session_id = ?", tenant, sessionId);
        });

        transaction.executeWithoutResult(status -> service.renameSession(
                tenant, "actor-a", "rename-2", sessionId, "second"));
        assertThat(jdbc.queryForObject("SELECT title FROM"
                        + " ma_session WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, tenant,
                sessionId)).isEqualTo("second");
    }

    @Test
    void aRenameFailureThatIsNotABrokerRefusalStillRetiresItsCommand() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        String digest = "sha256:" + "a".repeat(64);
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", digest, "qwen-code", null, null,
                List.of(), null, new WorkspaceSelection("ws-a", "."))
                .sessionId();
        ManagedAgentProperties enabled = new ManagedAgentProperties();
        enabled.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, enabled, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        // A Harness that lost the Session answers the rename with a 4xx,
        // which the client surfaces as a HarnessHttpFailure — a permanent
        // failure, but not a broker refusal.
        HarnessHttpFailure lost = mock(HarnessHttpFailure.class);
        UnavailableHarnessConnector harness =
                new UnavailableHarnessConnector() {
                    private int renames;

                    @Override
                    public boolean isAvailable() {
                        return true;
                    }

                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        return true;
                    }

                    @Override
                    public Attachment createOrLoad(String tenantId,
                            String sessionId, boolean loadExisting) {
                        return new Attachment("boot");
                    }

                    @Override
                    public boolean supportsFencedTitles() {
                        return true;
                    }

                    @Override
                    public void rename(String tenantId, String sessionId,
                            String title) {
                        if (renames++ == 0) {
                            throw lost;
                        }
                    }
                };
        ManagedAgentService service = new ManagedAgentService(gated,
                new RequestDigests(), null, harness, registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);

        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-a", "rename-1", sessionId, "first"))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                            assertThat(error.getStatus())
                                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE.value());
                            assertThat(error.getCode())
                                    .isEqualTo("hosted_harness_unavailable");
                        }));
        // The answered mutation retired its command row too, so a fresh key
        // is admitted instead of wedging on session_operation_active.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_request_receipt WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ?"
                        + " AND session_id = ? AND state = 'PENDING'",
                Integer.class, tenant, sessionId)).isZero();

        transaction.executeWithoutResult(status -> service.renameSession(
                tenant, "actor-a", "rename-2", sessionId, "second"));
        assertThat(jdbc.queryForObject("SELECT title FROM"
                        + " ma_session WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, tenant,
                sessionId)).isEqualTo("second");
    }

    @Test
    void enabledCreationRefusesPolicyDriftAndAnotherTenantsMount() {
        String tenant = "tenant-" + UUID.randomUUID();
        String otherTenant = "tenant-" + UUID.randomUUID();
        // Each Workspace differs from the admitted one in exactly one guard.
        register(tenant, "ws-valid", "storage-valid",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        register(tenant, "ws-policy", "storage-policy",
                WorkspaceExecutionProfile.CONFIG_REF,
                "preapproved-workspace-tools/2");
        register(tenant, "ws-tenant", "storage-shared",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        for (String workspace : List.of("ws-valid", "ws-policy", "ws-tenant")) {
            grant(tenant, workspace, "actor-a", true);
        }
        ManagedAgentProperties enabled = new ManagedAgentProperties();
        enabled.getHarness().setWorkspaceFilesEnabled(true);
        enabled.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                        tenant, "storage-valid", "/unused/valid"),
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                        tenant, "storage-policy", "/unused/policy"),
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                        otherTenant, "storage-shared", "/unused/shared")));
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, enabled, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        // An unproxied store has no @Transactional; creation resolves the
        // Workspace only inside a transaction, as the Spring bean provides.
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        List<Map<String, Object>> input = List.of(
                Map.of("type", "text", "text", "go"));
        String digest = "sha256:" + "a".repeat(64);

        for (String workspace : List.of("ws-policy", "ws-tenant")) {
            // Captured first so the label survives when nothing is thrown.
            Throwable thrown = catchThrowable(() -> transaction.execute(status ->
                    gated.insertWorkspaceSessionCommand(tenant, "actor-a",
                            workspace, digest, "qwen-code", null, null, input,
                            digest, new WorkspaceSelection(workspace, "."))));
            assertThat(thrown).as(workspace)
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                        // The store's message, not the registry's "Workspace is
                        // unavailable.", ties the refusal to the store guard.
                        assertThat(error.getMessage()).isEqualTo(
                                "Hosted Workspace execution is not available.");
                        assertThat(error.getStatus())
                                .isEqualTo(HttpStatus.CONFLICT.value());
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable");
                    });
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_session WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_turn WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();

        // The same store admits the Workspace that passes every guard, so the
        // refusals above come from the policy and mount-tenant checks alone.
        assertThat(transaction.execute(status ->
                gated.insertWorkspaceSessionCommand(tenant, "actor-a",
                        "ws-valid", digest, "qwen-code", null, null, input,
                        digest, new WorkspaceSelection("ws-valid", ".")))
                .sessionId()).isNotBlank();
    }

    @Test
    void webShellCreationIsMetadataOnlyUntilExecutionIsWired()
            throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        var created = mvc.perform(post(
                        "/api/agent/web-shell/v1/sessions/create")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"idempotencyKey":"web-create",
                                 "agentId":"qwen-code","input":[],
                                 "workspace":{"workspaceId":"ws-a",
                                              "cwdRelative":"services/./api"}}
                                """))
                .andExpect(status().isAccepted())
                .andReturn();
        String sessionId = mapper.readTree(created.getResponse()
                .getContentAsString()).get("sessionId").asText();
        assertThat(store.requireSession(tenant, sessionId).toolProfile())
                .isEqualTo("hosted-workspace-files/1");
        mvc.perform(post("/api/agent/web-shell/v1/sessions/get")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + sessionId + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.workspace.workspaceId")
                        .value("ws-a"))
                .andExpect(jsonPath("$.workspace.cwdRelative").value("services/api"))
                // The opt-in is off and the 3-arg registration's profile
                // refs are drifted, so the refusal is over-determined and
                // cannot isolate the isWorkspaceFilesAvailable clause.
                .andExpect(jsonPath("$.capabilities.workspaceTurns")
                        .value(false));
        mvc.perform(post("/api/agent/web-shell/v1/sessions/create")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"idempotencyKey":"web-turn",
                                 "agentId":"qwen-code",
                                 "input":[{"type":"text","text":"go"}],
                                 "workspace":{"workspaceId":"ws-a"}}
                                """))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("workspace_unavailable"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_session WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(1);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void rejectsIdempotencyKeyReuseAcrossCreationShapes(boolean boundFirst)
            throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        String unbound = "{\"agent_id\":\"qwen-code\"}";
        String bound = """
                {"agent_id":"qwen-code","workspace":{"workspace_id":"ws-a"}}
                """;
        for (int attempt = 0; attempt < 2; attempt++) {
            String body = (attempt == 0) == boundFirst ? bound : unbound;
            var response = mvc.perform(post("/v1/agents/sessions")
                    .header(TenantContextFilter.HEADER, tenant)
                    .header("Idempotency-Key", "same-key")
                    .principal(actor(tenant, "actor-a"))
                    .contentType(MediaType.APPLICATION_JSON).content(body));
            if (attempt == 0) {
                response.andExpect(status().isAccepted());
            } else {
                response.andExpect(status().isConflict())
                        .andExpect(jsonPath("$.error.code").value("idempotency_conflict"));
            }
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session"
                + " WHERE tenant_id = ?", Integer.class, tenant)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT tool_profile FROM ma_session"
                + " WHERE tenant_id = ?", String.class, tenant))
                .isEqualTo(boundFirst ? "hosted-workspace-files/1" : null);
    }

    @Test
    void concurrentCreationShapesCannotBothCommit() throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        CyclicBarrier start = new CyclicBarrier(2);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var futures = List.of(false, true).stream().map(bound -> executor.submit(() -> {
                start.await();
                try {
                    if (bound) {
                        store.insertWorkspaceSessionCommand(tenant, "actor-a", "key",
                                "bound-digest", "qwen-code", null, null, List.of(), null,
                                new WorkspaceSelection("ws-a", "."));
                    } else {
                        store.insertSessionCommand(tenant, "CREATE_SESSION", "key",
                                "legacy-digest", "qwen-code", null, null, List.of(), null);
                    }
                    return "created";
                } catch (ManagedAgentException error) {
                    return error.getCode();
                }
            })).toList();
            assertThat(List.of(futures.get(0).get(5, TimeUnit.SECONDS),
                    futures.get(1).get(5, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder("created", "idempotency_conflict");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session"
                + " WHERE tenant_id = ?", Integer.class, tenant)).isEqualTo(1);
    }

    @Test
    void changingWorkspaceIntentConflictsAndActorsKeepSeparateReceipts()
            throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        register(tenant, "ws-b", "storage-b");
        grant(tenant, "ws-a", "actor-a", true);
        grant(tenant, "ws-a", "actor-b", true);
        grant(tenant, "ws-b", "actor-a", true);
        for (String actorId : List.of("actor-a", "actor-b")) {
            mvc.perform(post("/v1/agents/sessions")
                            .header(TenantContextFilter.HEADER, tenant)
                            .header("Idempotency-Key", "same-key")
                            .principal(actor(tenant, actorId))
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("""
                                    {"agent_id":"qwen-code",
                                     "workspace":{"workspace_id":"ws-a"}}
                                    """))
                    .andExpect(status().isAccepted());
        }
        for (Map<String, String> workspace : List.of(
                Map.of("workspace_id", "ws-b"),
                Map.of("workspace_id", "ws-a", "cwd_relative", "src"))) {
            mvc.perform(post("/v1/agents/sessions")
                            .header(TenantContextFilter.HEADER, tenant)
                            .header("Idempotency-Key", "same-key")
                            .principal(actor(tenant, "actor-a"))
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(mapper.writeValueAsString(Map.of(
                                    "agent_id", "qwen-code", "workspace", workspace))))
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code").value("idempotency_conflict"));
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session"
                + " WHERE tenant_id = ?", Integer.class, tenant)).isEqualTo(2);
    }

    @Test
    void rejectsNullWorkspaceOnBothCreationRoutes() throws Exception {
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, "tenant-null")
                        .header("Idempotency-Key", "null")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"workspace\":null}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_request"));
        mvc.perform(post("/api/agent/web-shell/v1/sessions/create")
                        .header(TenantContextFilter.HEADER, "tenant-null")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"agentId":"qwen-code","idempotencyKey":"null",
                                 "workspace":null}
                                """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_request"));
    }

    @Test
    void rejectsMissingGrantsCreateDenialAndRemovedWorkspace() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        var selection = new WorkspaceSelection("ws-a", ".");
        assertCreateError(tenant, selection, "workspace_not_found");
        grant(tenant, "ws-a", "actor-a", false);
        assertCreateError(tenant, selection, "workspace_forbidden");
        jdbc.update("DELETE FROM ma_workspace_access"
                + " WHERE tenant_id = ?", tenant);
        assertCreateError(tenant, selection, "workspace_not_found");
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES (?, 'ws-a', ?,"
                + " 'OPERATOR')", tenant,
                "actor-a".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        jdbc.update("UPDATE ma_workspace SET state = 'REMOVED'"
                + " WHERE tenant_id = ?", tenant);
        assertCreateError(tenant, selection, "workspace_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session"
                + " WHERE tenant_id = ?", Integer.class, tenant)).isZero();
    }

    // The widening and its creator-keyed limit in one witness: while the
    // creator keeps OPERATOR, a second operator submits; once only the
    // creator drops, submit and rename meet the family's domain 409 — and
    // cancel, exempt from the facts, still aborts that live Turn.
    @Test
    void aSecondOperatorSubmitsUntilTheCreatorsFactsFail() {
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        grant(tenant, "ws-a", "operator2", true);
        ManagedAgentService service = boundServiceWithWorkingHarness();
        List<InputBlock> input = List.of(new InputBlock("text", "go"));

        CommandAdmission admitted = service.submitTurn(tenant, "operator2",
                "submit-1", sessionId, input);
        assertThat(admitted.replayed()).isFalse();
        assertThat(service.getWebShellSession(tenant, "operator2", sessionId)
                .capabilities().workspaceTurns()).isTrue();

        jdbc.update("UPDATE ma_workspace_access SET role = 'READER'"
                + " WHERE tenant_id = ? AND workspace_id = X'77732d61'"
                + " AND actor_id = ?", tenant,
                "actor-a".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(service.getWebShellSession(tenant, "operator2", sessionId)
                .capabilities().workspaceTurns()).isFalse();
        assertRefused(() -> service.submitTurn(tenant, "operator2",
                "submit-2", sessionId, input), "workspace_unavailable");
        assertRefused(() -> service.renameSession(tenant, "operator2",
                "rename-1", sessionId, "still other title"),
                "workspace_unavailable");
        // Cancel is the exception that needs no facts: admission reaches
        // the Turn lookup for the operator even after the creator falls.
        assertRefused(() -> service.cancelTurn(tenant, "operator2",
                "cancel-1", sessionId, "turn_missing"), "turn_not_found");
    }

    @Test
    void compressionCapabilityAllowsResidentWorkspacesAndRequiresTheOperatorAndFrozenFacts() {
        String tenant = "tenant-" + UUID.randomUUID();
        String session = boundSession(tenant);
        grant(tenant, "ws-a", "operator2", true);
        grant(tenant, "ws-a", "reader", false);
        HarnessConnector harness = mock(HarnessConnector.class);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(harness.supportsContextCompression()).thenReturn(true);
        var enabled = boundServiceWith(harness);
        org.springframework.test.util.ReflectionTestUtils.setField(enabled, "runtimeWarmer",
                mock(com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer.class));
        var summary = enabled.getWebShellSession(tenant, "operator2", session);
        assertThat(summary.capabilities().cwdChange()).isFalse();
        assertThat(summary.capabilities().contextCompression()).isTrue();
        assertThat(summary.compactionRevision()).isZero();
        assertThat(enabled.getWebShellSession(tenant, "reader", session).capabilities().contextCompression()).isFalse();
        jdbc.update("UPDATE ma_workspace_access SET role='READER' WHERE tenant_id=? AND actor_id=?", tenant,
                "actor-a".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(enabled.getWebShellSession(tenant, "operator2", session).capabilities().contextCompression()).isFalse();
    }

    @Test
    void renameCapabilityUsesTheRoleAndFrozenFactsIndependentlyOfTurnApprovalSupport() {
        String tenant = "tenant-" + UUID.randomUUID();
        String session = boundSession(tenant);
        grant(tenant, "ws-a", "operator2", true);
        grant(tenant, "ws-a", "reader", false);
        ManagedAgentService enabled = boundServiceWithWorkingHarness();
        assertThat(enabled.getWebShellSession(tenant, "operator2", session).capabilities().rename()).isTrue();
        assertThat(enabled.getWebShellSession(tenant, "reader", session).capabilities().rename()).isFalse();

        jdbc.update("UPDATE ma_session SET selected_approval_mode='default', approval_revision=1"
                + " WHERE tenant_id=? AND session_id=?", tenant, session);
        var summary = enabled.getWebShellSession(tenant, "operator2", session);
        assertThat(summary.capabilities().workspaceTurns()).isFalse();
        assertThat(summary.capabilities().rename()).isTrue();

        jdbc.update("UPDATE ma_workspace_access SET role='READER' WHERE tenant_id=? AND actor_id=?", tenant,
                "actor-a".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(enabled.getWebShellSession(tenant, "operator2", session).capabilities().rename()).isFalse();
    }

    @ParameterizedTest
    @ValueSource(strings = {"workspace_generation=workspace_generation+1", "storage_id='replacement'", "state='DRAINING'"})
    void renameCapabilityRefusesAChangedWorkspaceBinding(String changedFact) {
        String tenant = "tenant-" + UUID.randomUUID();
        String session = boundSession(tenant);
        ManagedAgentService enabled = boundServiceWithWorkingHarness();
        assertThat(enabled.getWebShellSession(tenant, "actor-a", session).capabilities().rename()).isTrue();
        jdbc.update("UPDATE ma_workspace SET " + changedFact + " WHERE tenant_id=?", tenant);
        assertThat(enabled.getWebShellSession(tenant, "actor-a", session).capabilities().rename()).isFalse();
    }

    @ParameterizedTest
    @CsvSource({"false,true,true", "true,false,true", "true,true,false", "true,true,true"})
    void renameCapabilityRequiresAvailableFencedTitlesAndWorkspaceFiles(boolean available,
            boolean fencedTitles, boolean workspaceFiles) {
        String tenant = "tenant-" + UUID.randomUUID();
        String session = boundSession(tenant);
        HarnessConnector harness = mock(HarnessConnector.class);
        when(harness.isAvailable()).thenReturn(available);
        when(harness.supportsFencedTitles()).thenReturn(fencedTitles);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(workspaceFiles);
        var enabled = boundServiceWith(harness);
        assertThat(enabled.getWebShellSession(tenant, "actor-a", session).capabilities().rename())
                .isEqualTo(available && fencedTitles && workspaceFiles);
    }

    @Test
    void cancellationNeedsOnlyTheRoleWhileNewWorkNeedsTheFacts() {
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        grant(tenant, "ws-a", "actor-b", true);
        ManagedAgentService enabled = boundService(true);
        ManagedAgentService optedOut = boundService(false);
        assertThat(enabled.getWebShellSession(tenant, "actor-a", sessionId)
                .capabilities().workspaceTurns()).isTrue();
        // The opt-in clause: the same caller and Session without it.
        assertThat(optedOut.getWebShellSession(tenant, "actor-a", sessionId)
                .capabilities().workspaceTurns()).isFalse();

        // Only the creator drops; actor-b keeps OPERATOR and the Workspace
        // drains, so the Session's creator-keyed facts fail while the
        // second operator's own role is intact.
        jdbc.update("UPDATE ma_workspace_access SET role = 'READER'"
                + " WHERE tenant_id = ? AND workspace_id = X'77732d61'"
                + " AND actor_id = ?", tenant,
                "actor-a".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        jdbc.update("UPDATE ma_workspace SET state = 'DRAINING'"
                + " WHERE tenant_id = ?", tenant);
        assertThat(enabled.getWebShellSession(tenant, "actor-a", sessionId)
                .capabilities().workspaceTurns()).isFalse();
        assertThat(enabled.getWebShellSession(tenant, "actor-b", sessionId)
                .capabilities().workspaceTurns()).isFalse();
        // New work splits the readable-below-OPERATOR 403 from the
        // admitted-OPERATOR 409 domain refusal.
        assertRefused(() -> enabled.submitTurn(tenant, "actor-a", "submit",
                sessionId, List.of(new InputBlock("text", "go"))),
                "session_operation_forbidden");
        assertRefused(() -> enabled.submitTurn(tenant, "actor-b",
                "submit-b", sessionId, List.of(new InputBlock("text", "go"))),
                "workspace_unavailable");
        // Cancelling aborts work already running and needs role and shape
        // alone: the OPERATOR passes admission and meets the missing Turn.
        assertRefused(() -> enabled.cancelTurn(tenant, "actor-b", "cancel-b",
                sessionId, "turn_missing"), "turn_not_found");
        assertRefused(() -> enabled.cancelTurn(tenant, "actor-a", "cancel",
                sessionId, "turn_missing"), "session_operation_forbidden");
        assertRefused(() -> optedOut.cancelTurn(tenant, "actor-b",
                "cancel-off", sessionId, "turn_missing"),
                "workspace_unavailable");
    }

    @Test
    void cancelRefusesABoundSessionThatCanNoLongerExecute() {
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        ManagedAgentService service = boundServiceWithWorkingHarness();
        String turnId = service.submitTurn(tenant, "actor-a", "submit-1",
                sessionId, List.of(new InputBlock("text", "go"))).turnId();

        // Cancelling cites the admission shape, so closing the Session
        // restores the legacy refusal instead of writing a CANCEL command
        // for a Turn that can no longer run.
        jdbc.update("UPDATE ma_session SET status = 'CLOSED'"
                + " WHERE tenant_id = ? AND session_id = ?",
                tenant, sessionId);
        assertRefused(() -> service.cancelTurn(tenant, "actor-a", "cancel-1",
                sessionId, turnId), "workspace_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_request_receipt WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ?"
                + " AND operation = 'CANCEL_TURN'", Integer.class, tenant))
                .isZero();
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void reRegistrationRefusesLaterWorkBeforeAnyCommandIsWritten(boolean storageOnly) {
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        ManagedAgentService enabled = boundService(true);
        jdbc.update("UPDATE ma_workspace SET"
                + (storageOnly ? " storage_id = X'7265706c6163656d656e742d73746f72616765'"
                        : " workspace_generation = workspace_generation + 1")
                + " WHERE tenant_id = ?", tenant);

        assertThat(enabled.getWebShellSession(tenant, "actor-a", sessionId)
                .capabilities().workspaceTurns()).isFalse();
        assertRefused(() -> enabled.submitTurn(tenant, "actor-a", "submit",
                sessionId, List.of(new InputBlock("text", "go"))),
                "workspace_unavailable");
        assertRefused(() -> enabled.renameSession(tenant, "actor-a",
                "rename", sessionId, "Renamed"), "workspace_unavailable");
        // The rename was refused before its command was written, so no
        // PENDING command blocks a later operation.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_request_receipt WHERE namespace = 'SESSION_COMMAND' AND tenant_id = ? AND"
                + " state = 'PENDING'", Integer.class, tenant))
                .isZero();
        assertRefused(() -> enabled.cancelTurn(tenant, "actor-a", "cancel",
                sessionId, "turn_missing"), "turn_not_found");
    }

    @Test
    void sameKeySubmitReplayRequiresWorkspaceReadAccess() {
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        ManagedAgentService service = boundServiceWithWorkingHarness();
        List<InputBlock> input = List.of(new InputBlock("text", "go"));
        CommandAdmission first = service.submitTurn(tenant, "actor-a",
                "submit-1", sessionId, input);
        assertThat(first.replayed()).isFalse();
        assertThat(first.turnId()).isNotBlank();

        assertRefused(() -> service.submitTurn(tenant, "actor-b",
                "submit-1", sessionId, input), "session_not_found");
    }

    @Test
    void sameKeyReplayStaysBehindTheRoleGate() {
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        grant(tenant, "ws-a", "actor-b", false);
        ManagedAgentService service = boundServiceWithWorkingHarness();
        List<InputBlock> input = List.of(new InputBlock("text", "go"));
        CommandAdmission first = service.submitTurn(tenant, "actor-a",
                "submit-1", sessionId, input);
        assertThat(first.replayed()).isFalse();
        service.renameSession(tenant, "actor-a", "rename-1", sessionId,
                "renamed title");

        // The submitter family's command replay is not actor-scoped, so the
        // role gate runs before any recorded key is honoured: a READER
        // retrying another caller's key with identical content is refused
        // 403, and the OPERATOR's own retry replays its recorded admission.
        assertRefused(() -> service.submitTurn(tenant, "actor-b",
                "submit-1", sessionId, input), "session_operation_forbidden");
        assertRefused(() -> service.submitTurn(tenant, "actor-b",
                "submit-1", sessionId,
                List.of(new InputBlock("text", "other"))),
                "session_operation_forbidden");
        assertRefused(() -> service.renameSession(tenant, "actor-b",
                "rename-1", sessionId, "renamed title"),
                "session_operation_forbidden");
        CommandAdmission replay = service.submitTurn(tenant, "actor-a",
                "submit-1", sessionId, input);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.turnId()).isEqualTo(first.turnId());
    }

    @Test
    void sameKeySubmitReplaysTheRecordedAdmissionAfterReRegistration() {
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        ManagedAgentService service = boundServiceWithWorkingHarness();

        CommandAdmission first = service.submitTurn(tenant, "actor-a",
                "submit-1", sessionId,
                List.of(new InputBlock("text", "go")));
        assertThat(first.replayed()).isFalse();
        assertThat(first.turnId()).isNotBlank();

        // Re-registration flips the admission gate off; the recorded
        // admission must still answer the same-key retry — replay is a read
        // of the record, not a re-admission.
        jdbc.update("UPDATE ma_workspace SET"
                + " workspace_generation = workspace_generation + 1"
                + " WHERE tenant_id = ?", tenant);
        assertThat(service.getWebShellSession(tenant, "actor-a", sessionId)
                .capabilities().workspaceTurns()).isFalse();

        CommandAdmission second = service.submitTurn(tenant, "actor-a",
                "submit-1", sessionId,
                List.of(new InputBlock("text", "go")));
        assertThat(second.replayed()).isTrue();
        assertThat(second.turnId()).isEqualTo(first.turnId());
    }

    @Test
    void sameKeyRenameReplaysTheRecordedOutcomeAfterReRegistration() {
        String tenant = "tenant-" + UUID.randomUUID();
        String sessionId = boundSession(tenant);
        ManagedAgentService service = boundServiceWithWorkingHarness();

        var first = service.renameSession(tenant, "actor-a", "rename-1",
                sessionId, "renamed title");
        assertThat(first.replayed()).isFalse();
        assertThat(first.body().metadata())
                .containsEntry("title", "renamed title");

        jdbc.update("UPDATE ma_workspace SET"
                + " workspace_generation = workspace_generation + 1"
                + " WHERE tenant_id = ?", tenant);
        assertRefused(() -> service.renameSession(tenant, "actor-a",
                "rename-fresh", sessionId, "other"), "workspace_unavailable");

        var second = service.renameSession(tenant, "actor-a", "rename-1",
                sessionId, "renamed title");
        assertThat(second.replayed()).isTrue();
        assertThat(second.body().metadata())
                .containsEntry("title", "renamed title");
    }

    @Test
    void aRecordedWorkspaceCreateReplaysWhileWorkspaceFilesAreOff() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        var selection = new WorkspaceSelection("ws-a", ".");
        List<InputBlock> input = List.of(new InputBlock("text", "go"));
        // Workspace resolution runs inside the creation transaction.
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        CommandAdmission first = transaction.execute(status ->
                workspaceFilesService(tenant, true).createWorkspaceSession(
                        tenant, "actor-a", "create-1", "qwen-code", null,
                        "a title", null, input, selection));
        assertThat(first.replayed()).isFalse();
        // The recorded create answers through a files outage; only a fresh
        // key meets the availability refusal.
        CommandAdmission replay = transaction.execute(status ->
                workspaceFilesService(tenant, false).createWorkspaceSession(
                        tenant, "actor-a", "create-1", "qwen-code", null,
                        "a title", null, input, selection));
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.sessionId()).isEqualTo(first.sessionId());
        assertRefused(() -> transaction.execute(status ->
                workspaceFilesService(tenant, false).createWorkspaceSession(
                        tenant, "actor-a", "create-2", "qwen-code", null,
                        "a title", null, input, selection)),
                "workspace_unavailable");
    }

    @Test
    void onlyAWorkspaceCreateWithoutInputRequestsTheSessionCreateWarm() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        var selection = new WorkspaceSelection("ws-a", ".");
        HarnessCoordinator coordinator = mock(HarnessCoordinator.class);
        ManagedAgentService warming = workspaceFilesService(tenant, true,
                coordinator);
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        CommandAdmission empty = transaction.execute(status ->
                warming.createWorkspaceSession(tenant, "actor-a",
                        "create-empty", "qwen-code", null, "empty", null,
                        List.of(), selection));
        CommandAdmission prompted = transaction.execute(status ->
                warming.createWorkspaceSession(tenant, "actor-a",
                        "create-prompted", "qwen-code", null, "prompted",
                        null, List.of(new InputBlock("text", "go")),
                        selection));
        assertThat(empty.turnId()).isNull();
        assertThat(prompted.turnId()).isNotNull();
        verify(coordinator).warmSession(tenant, empty.sessionId());
        verify(coordinator, never()).warmSession(tenant,
                prompted.sessionId());
    }

    private ManagedAgentService workspaceFilesService(String tenant,
            boolean workspaceFiles) {
        return workspaceFilesService(tenant, workspaceFiles, null);
    }

    @Test
    void preparingWorktreesProjectTheirTargetWithoutAdmittingMoreInput() throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        String session = boundSession(tenant);
        persistWorktree(tenant, session, "PREPARING");
        ManagedAgentService enabled = boundServiceWithWorkingHarness();
        var summary = enabled.getWebShellSession(tenant, "actor-a", session);
        assertThat(summary.workspace().state()).isEqualTo("changing");
        assertThat(summary.workspace().cwdRelative()).startsWith(".qwen-managed-worktrees/");
        assertThat(summary.worktree().state()).isEqualTo("preparing");
        assertThat(summary.capabilities().workspaceTurns()).isFalse();
        assertRefused(() -> enabled.submitTurn(tenant, "actor-a", "next", session,
                List.of(new InputBlock("text", "go"))), "worktree_preparing");
        mvc.perform(get("/v1/agents/sessions/{sessionId}", session).header(TenantContextFilter.HEADER, tenant).principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.worktree.session_id").value(session))
                .andExpect(jsonPath("$.worktree.base_commit").value("a".repeat(40)))
                .andExpect(jsonPath("$.worktree.state").value("preparing"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"PREPARING", "FAILED", "BLOCKED", "REMOVING", "REMOVED"})
    void unreadyWorktreesAllowQueueManagementButKeepRuntimeActionsGated(String state) throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        String session = boundSession(tenant);
        grant(tenant, "ws-a", "operator2", true);
        grant(tenant, "ws-a", "reader", false);
        HarnessConnector harness = mock(HarnessConnector.class);
        when(harness.isAvailable()).thenReturn(true);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(harness.supportsFencedTitles()).thenReturn(true);
        when(harness.supportsUserMessageQueue()).thenReturn(true);
        var enabled = boundServiceWith(harness);
        var messages = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedUserMessageStore(jdbc, mapper, new RequestDigests(), enabled));
        var transaction = new TransactionTemplate(transactionManager);
        var input = List.of(new InputBlock("text", "queued"));
        var first = transaction.execute(status -> messages.command(tenant, "actor-a", session, "seed",
                new ManagedUserMessageStore.Command("submit", null, null, input))).messages().getFirst();
        persistWorktree(tenant, session, state);

        assertThat(transaction.execute(status -> messages.queryMessages(tenant, "operator2", session)).messages()).hasSize(1);
        var edited = transaction.execute(status -> messages.command(tenant, "operator2", session, "edit",
                new ManagedUserMessageStore.Command("edit", first.id(), 1L, List.of(new InputBlock("text", "edited")))));
        assertThat(edited.messages().getFirst().revision()).isEqualTo(2);
        assertThat(edited.messages().getFirst().input().getFirst().get("text")).isEqualTo("edited");
        assertRefused(() -> transaction.execute(status -> messages.command(tenant, "operator2", session, "new",
                new ManagedUserMessageStore.Command("submit", null, null, input))), "worktree_" + state.toLowerCase(java.util.Locale.ROOT));
        assertRefused(() -> transaction.execute(status -> messages.command(tenant, "operator2", session, "resume",
                new ManagedUserMessageStore.Command("resume", null, null, null))), "worktree_" + state.toLowerCase(java.util.Locale.ROOT));
        assertThat(transaction.execute(status -> messages.command(tenant, "operator2", session, "withdraw",
                new ManagedUserMessageStore.Command("withdraw", first.id(), 2L, null))).messages()).isEmpty();
        assertRefused(() -> enabled.submitTurn(tenant, "operator2", "submit", session, input),
                "worktree_" + state.toLowerCase(java.util.Locale.ROOT));
        assertRefused(() -> enabled.renameSession(tenant, "operator2", "rename", session, "renamed"),
                "worktree_" + state.toLowerCase(java.util.Locale.ROOT));
        assertThat(enabled.getWebShellSession(tenant, "operator2", session).capabilities().rename()).isFalse();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?", Integer.class, tenant, session)).isZero();
        verify(harness, never()).createOrLoad(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyBoolean(), org.mockito.ArgumentMatchers.anyBoolean());
        assertRefused(() -> enabled.authorizeUserMessages(tenant, "reader", session), "session_operation_forbidden");
        jdbc.update("UPDATE ma_workspace_access SET role = 'READER' WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                tenant, "ws-a", com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenant, "actor-a"));
        assertRefused(() -> enabled.authorizeUserMessages(tenant, "operator2", session), "workspace_unavailable");
    }

    @Test
    void sessionPagesPreserveWorktreeGatingAndBlockInvalidReadyIdentities() throws Exception {
        for (String state : List.of("PREPARING", "FAILED", "READY")) {
            String tenant = "tenant-" + UUID.randomUUID();
            String session = boundSession(tenant);
            persistWorktree(tenant, session, state);
            var enabled = boundServiceWithWorkingHarness();
            var publicPage = enabled.listPublicSessions(tenant, "actor-a", null, 1).data();
            assertThat(publicPage).hasSize(1);
            String expected = "READY".equals(state) ? "blocked" : state.toLowerCase(java.util.Locale.ROOT);
            assertThat(publicPage.getFirst().worktree().sessionId()).isEqualTo(session);
            assertThat(publicPage.getFirst().worktree().state()).isEqualTo(expected);
            var page = enabled.listWebShellSessions(tenant, "actor-a", null, 1).data();
            assertThat(page).hasSize(1);
            assertThat(page.getFirst().worktree().state()).isEqualTo(expected);
            assertThat(page.getFirst().capabilities().workspaceTurns()).isFalse();
            if ("READY".equals(state)) {
                assertThat(jdbc.queryForObject("SELECT state FROM ma_session_worktree WHERE tenant_id = ? AND session_id = ?",
                        String.class, tenant, session)).isEqualTo("BLOCKED");
            }
        }
    }

    @Test
    void worktreePreparationGatesDispatchButPreservesCancellation() throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        String session = boundSession(tenant);
        var enabled = boundServiceWithWorkingHarness();
        var admission = enabled.submitTurn(tenant, "actor-a", "initial", session, List.of(new InputBlock("text", "go")));
        persistWorktree(tenant, session, "PREPARING");
        assertThat(store.findDispatchable(System.currentTimeMillis(), 1000))
                .noneMatch(target -> target.sessionId().equals(session));
        assertThat(store.claimTurn(tenant, session, admission.turnId(), "owner", Duration.ofSeconds(30))).isEmpty();

        enabled.cancelTurn(tenant, "actor-a", "cancel-initial", session, admission.turnId());
        assertThat(store.findDispatchable(System.currentTimeMillis(), 1000))
                .anyMatch(target -> target.sessionId().equals(session));
        assertThat(store.claimTurn(tenant, session, admission.turnId(), "owner", Duration.ofSeconds(30))).isPresent();
        store.cancelBeforeAdmission(tenant, session, admission.turnId(), "owner");
        assertThat(store.findTurn(tenant, session, admission.turnId()).orElseThrow().status()).isEqualTo("CANCELLED");
    }

    @Test
    @Transactional("managedAgentTransactionManager")
    void failedAndBlockedWorktreesStillAllowCancellation() throws Exception {
        for (String state : List.of("FAILED", "BLOCKED")) {
            String tenant = "tenant-" + UUID.randomUUID();
            String session = boundSession(tenant);
            var enabled = boundServiceWithWorkingHarness();
            var admission = enabled.submitTurn(tenant, "actor-a", "initial", session, List.of(new InputBlock("text", "go")));
            persistWorktree(tenant, session, state);
            enabled.cancelTurn(tenant, "actor-a", "cancel-initial", session, admission.turnId());
            assertThat(store.findTurn(tenant, session, admission.turnId()).orElseThrow().status()).isEqualTo("CANCELLING");
        }
    }

    @Test
    void failedWorktreePreparationSettlesInitialInputOnce() throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        String session = boundSession(tenant);
        var admission = boundServiceWithWorkingHarness().submitTurn(tenant, "actor-a", "initial", session,
                List.of(new InputBlock("text", "go")));
        persistWorktree(tenant, session, "FAILED");
        store.failWorktreeInitialTurns(tenant, session, "worktree_prepare_failed");
        store.failWorktreeInitialTurns(tenant, session, "worktree_prepare_failed");
        assertThat(store.findTurn(tenant, session, admission.turnId()).orElseThrow().status()).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE tenant_id = ? AND session_id = ?"
                + " AND event_type = 'turn.failed'", Integer.class, tenant, session)).isEqualTo(1);
    }

    private void persistWorktree(String tenant, String session, String state) throws Exception {
        String id = UUID.randomUUID().toString().replace("-", "");
        String cwd = ".qwen-managed-worktrees/" + id;
        var binding = store.requireSession(tenant, session).workspace();
        var plan = new SessionWorktreeStore.Plan(tenant, "ws-a", 1, "storage-a", ".",
                binding.getContextConfigRef(), 1, "/workspace", "root-identity", ".", ".",
                "/workspace/.git", "common-identity", "main", "a".repeat(40), id, cwd, cwd, "qwen/" + id);
        jdbc.update("UPDATE ma_session SET cwd_relative = ? WHERE tenant_id = ? AND session_id = ?", cwd, tenant, session);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, operation_id, operation_kind, tenant_id,"
                + " session_id, target_kind, target_key, request_digest, request_json, state, phase, gmt_create, gmt_modified)"
                + " VALUES (?, ?, ?, 'SESSION_WORKTREE', ?, ?, 'SESSION', ?, 'digest', '{}', ?, ?, 1, 1)",
                ManagedSchemaKeys.key(tenant, id), ManagedSchemaKeys.key(tenant), id, tenant, session,
                ManagedSchemaKeys.key(session), state, state);
        jdbc.update("INSERT INTO ma_session_worktree (tenant_id, session_id, workspace_id, storage_id, physical_key,"
                + " worktree_id, owner_actor_key, state, revision, plan_json, operation_id, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'ws-a', 'storage-a', ?, ?, ?, ?, 1, ?, ?, 1, 1)", tenant, session,
                "a".repeat(64), id, com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(tenant, "actor-a"), state, mapper.writeValueAsString(plan), id);
    }

    private ManagedAgentService workspaceFilesService(String tenant,
            boolean workspaceFiles, HarnessCoordinator coordinator) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(workspaceFiles);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(tenant,
                        "storage-a", "/workspace")));
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        return new ManagedAgentService(gated, new RequestDigests(), coordinator,
                new UnavailableHarnessConnector() {
                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        return workspaceFiles;
                    }
                }, registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
    }

    private ManagedAgentService boundServiceWithWorkingHarness() {
        return boundServiceWith(new UnavailableHarnessConnector() {
            @Override
            public boolean isAvailable() {
                return true;
            }

            @Override
            public boolean isWorkspaceFilesAvailable() {
                return true;
            }

            @Override
            public Attachment createOrLoad(String tenantId, String sessionId,
                    boolean loadExisting) {
                return new Attachment("boot");
            }

            @Override
            public boolean supportsFencedTitles() {
                return true;
            }

            @Override
            public void rename(String tenantId, String sessionId,
                    String title) {
            }
        });
    }

    private ManagedAgentService boundServiceWith(HarnessConnector harness) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        HarnessCoordinator noopCoordinator = new HarnessCoordinator(null,
                null, null, null, null, Clock.systemUTC(),
                new ManagedAgentProperties()) {
            @Override
            public void dispatch(String tenantId, String sessionId,
                    String turnId) {
            }

            @Override
            public void cancel(String tenantId, String sessionId,
                    String turnId) {
            }
        };
        return new ManagedAgentService(gated, new RequestDigests(),
                noopCoordinator, harness, registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
    }

    private String boundSession(String tenant) {
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        return store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "create", "sha256:" + "a".repeat(64), "qwen-code", null, null,
                List.of(), null, new WorkspaceSelection("ws-a", "."))
                .sessionId();
    }

    private ManagedAgentService boundService(boolean workspaceFiles) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(workspaceFiles);
        ManagedAgentStore gated = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {}, registry, properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
        return new ManagedAgentService(gated, new RequestDigests(), null,
                new UnavailableHarnessConnector() {
                    @Override
                    public boolean isWorkspaceFilesAvailable() {
                        return workspaceFiles;
                    }
                }, registry, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
    }

    private static void assertRefused(ThrowingCallable call, String code) {
        assertThatThrownBy(call).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }

    private void assertCreateError(String tenant, WorkspaceSelection selection,
            String expected) {
        assertThatThrownBy(() -> store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "key", "digest", "qwen-code", null, null, List.of(), null,
                selection)).isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode()).isEqualTo(expected));
    }

    @Test
    void rejectsIncompleteBindingsAndIdentifiesDescriptorDrift() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        String session = store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "key", "digest", "qwen-code", null, null, List.of(), null,
                new WorkspaceSelection("ws-a", ".")).sessionId();
        for (String column : List.of("workspace_generation", "context_revision")) {
            assertThatThrownBy(() -> jdbc.update("UPDATE ma_session SET "
                    + column + " = NULL WHERE session_id = ?", session))
                    .isInstanceOf(DataIntegrityViolationException.class);
        }
        jdbc.update("UPDATE ma_session SET workspace_config_ref = 'changed'"
                + " WHERE session_id = ?", session);
        try {
            assertThatThrownBy(() -> store.requireSession(tenant, session))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining(session).hasMessageContaining(tenant);
        } finally {
            jdbc.update("UPDATE ma_session SET workspace_config_ref = 'config-ws-a'"
                    + " WHERE session_id = ?", session);
        }
    }

    @Test
    void invalidRegistryDataIsReportedAsServerFailure() throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "invalid storage");
        grant(tenant, "ws-a", "actor-a", true);
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "bad-registry")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"agent_id":"qwen-code",
                                 "workspace":{"workspace_id":"ws-a"}}
                                """))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.error.code").value("internal_error"));
    }

    private void fenceStorage(String tenant, String storageId) {
        jdbc.update("INSERT INTO ma_storage"
                        + " (alias_key,tenant_key,storage_key,tenant_id,storage_id,fence_operation_id)"
                        + " VALUES (?,?,?,?,?,?)",
                com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.storageAliasKey(tenant, storageId),
                com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.storageFenceKey(tenant),
                com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.storageFenceKey(storageId),
                tenant, storageId, UUID.randomUUID().toString());
    }

    private void setDefaultWorkspace(String tenant, String workspaceId) {
        new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
            jdbc.update("UPDATE ma_workspace SET is_default = FALSE WHERE tenant_id = ?", tenant);
            jdbc.update("UPDATE ma_workspace SET is_default = TRUE"
                    + " WHERE tenant_id = ? AND workspace_id = ?", tenant, workspaceId);
        });
    }

    private void register(String tenant, String id, String storageId) {
        register(tenant, id, storageId, "config-" + id, "policy-" + id);
    }

    private void register(String tenant, String id, String storageId,
            String configRef, String policyRef) {
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE')",
                tenant, id, storageId, id, configRef, policyRef);
    }

    private void grant(String tenant, String workspaceId, String actorId,
            boolean canCreate) {
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, ?)",
                tenant, workspaceId,
                actorId.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                canCreate ? "OPERATOR" : "READER");
    }

    private static AuthenticatedTenantActor actor(String tenant,
            String actorId) {
        return new AuthenticatedTenantActor() {
            @Override
            public String getName() {
                return actorId;
            }

            @Override
            public String tenantId() {
                return tenant;
            }

            @Override
            public String actorId() {
                return actorId;
            }
        };
    }

    // The delete flow's durable footprint, as the lifecycle admission
    // writes it: a DELETE operation row naming the last-visible status,
    // then the Session row as a tombstone.
    private void recordDelete(String tenant, String sessionId,
            String statusBefore) {
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, sessionId);
        String target = ManagedSchemaKeys.key(sessionId);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key,"
                        + " session_scope_key, operation_id, operation_kind,"
                        + " tenant_id, session_id, target_kind, target_key,"
                        + " target_id, actor_digest, idempotency_key,"
                        + " idempotency_digest, request_digest, request_json,"
                        + " state, phase, admission_stage, delivery_state,"
                        + " session_status_before, available_at, gmt_create,"
                        + " gmt_modified, completed_at) VALUES (?, ?, ?,"
                        + " 'op-del', 'DELETE', ?, ?, 'SESSION', ?, ?, '',"
                        + " 'delete', ?, 'delete-digest', '{}', 'COMPLETED',"
                        + " 'COMPLETED', 'JAVA_DURABLE', 'CONFIRMED', ?, 0, 0,"
                        + " 0, 0)",
                ManagedSchemaKeys.operationKey(
                        ManagedSchemaContract.OperationKind.DELETE, scope,
                        target, "op-del"),
                scope, scope, tenant, sessionId, target, sessionId,
                ManagedSchemaKeys.key("delete"), statusBefore);
        jdbc.update("UPDATE ma_session SET status = 'DELETED',"
                        + " deleted_at = 1, gmt_modified = 1, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ?",
                tenant, sessionId);
    }
}
