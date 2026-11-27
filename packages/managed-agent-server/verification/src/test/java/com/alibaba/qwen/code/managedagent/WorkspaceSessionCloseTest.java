package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration.ExternalStorageIdentity;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration.StorageAlias;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore.RetiredWorkspace;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistrationStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.JdbcSessionWorktreeStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceLifecycleStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.session.SessionLifecycleService;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentMatchers;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Lazy;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.lang.Nullable;
import org.springframework.test.web.servlet.MockMvc;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;

import static org.assertj.core.api.Assertions.*;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:workspace-close;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.dispatch.scan-delay=20ms", "qwen.managed-agent.dispatch.retry-initial-delay=50ms",
        "qwen.managed-agent.dispatch.retry-max-delay=100ms"})
@AutoConfigureMockMvc
@Import(WorkspaceSessionCloseTest.Configuration.class)
class WorkspaceSessionCloseTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired ManagedAgentStore store;
    @Autowired JdbcManagedSessionStore journal;
    @Autowired @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc;
    @Autowired CloseRuntime runtime;

    @Autowired SessionLifecycleService lifecycle;
    @Autowired ExternalStorageRegistrationStore registrations;
    @Autowired RuntimeBindingRepository bindings;

    @Test
    void retiredWorkspaceDeleteCompletesTheOriginalSessionWithoutContactingItsWorker() throws Exception {
        String tenant = UUID.randomUUID().toString();
        String workspace = "ws";
        String owner = "owner";
        var principal = new SessionPrincipal(tenant, owner, null);
        var retired = new RetiredWorkspace(workspace, 1, "delete-instance");
        var registration = new ExternalStorageRegistration(
                new ExternalStorageIdentity("host", tenant, 1),
                new StorageAlias(workspace, "/" + tenant, "/workspace", "workspace"));
        registrations.registerExternalStorage(tenant, "register", registration);
        String session = create(tenant);
        String sibling = mapper.readTree(mvc.perform(post("/v1/agents/sessions").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "sibling").principal(actor(tenant, owner)).contentType(MediaType.APPLICATION_JSON)
                .content("{\"agent_id\":\"qwen-code\",\"input\":[],\"workspace\":{\"workspace_id\":\"ws\"}}"))
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString()).path("id").asText();
        jdbc.update("UPDATE ma_workspace SET storage_id = ? WHERE tenant_id = ? AND workspace_id = ?", workspace, tenant, workspace);
        jdbc.update("UPDATE ma_session SET workspace_storage_id = ?, tool_profile = ? WHERE tenant_id = ? AND workspace_id = ?", workspace,
                WorkspaceToolProfiles.EXTERNAL_FILES, tenant, workspace);
        recordInitializedSession(tenant, session);
        var scope = new RuntimeScope(tenant, workspace, "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace");
        var request = new RuntimeProvisionRequest(scope, null, "external-workspace", workspace);
        var created = bindings.findOrCreate(request);
        var claimed = bindings.claimOperation(created.getBindingId(), "host", Duration.ofMinutes(1));
        var seed = claimed.getProvisionSeed();
        var now = Instant.now();
        var ready = bindings.compareAndSet(claimed, claimed.withAttestation(new RuntimeLease(
                seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:1"), seed.getToken(), seed.getLeaseId(), seed.getEpoch()),
                new RuntimeResourceHandle("external-workspace", 1, Map.of("worker", "original")), now, now));
        var runtimeSessions = new JdbcRuntimeSessionRepository(jdbc.getDataSource());
        var member = runtimeSessions.findOrCreate(new RuntimeSessionRecord(
                new RuntimeSession(session, "runtime-s2", "bootstrap", scope), ready.getBindingId(), ready.getGeneration(),
                RuntimeSessionRecord.State.ACQUIRING, 0, now));
        bindings.requestStorageFence(tenant, workspace, retired.storageFenceOperationId());
        var delete = OperationKind.DELETE;
        assertThatThrownBy(() -> lifecycle.admitPublic(principal, "delete", session, delete))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> lifecycle.admitRetiredWorkspaceDelete(principal, "delete", session, retired))
                .hasMessageContaining("blocked");
        var draining = bindings.compareAndSet(ready, ready.withDrainRequested(true, now));
        var receipt = new RuntimeDrainReceipt(draining.getBindingId(), draining.getGeneration(),
                seed.getProvisionRequestId(), draining.getResourceHandle(), now);
        bindings.compareAndSet(draining, draining.withDrainReceipt(receipt).withState(
                RuntimeBindingRecord.State.RELEASED, draining.getLease(), now));
        runtimeSessions.compareAndSet(member, member.withState(RuntimeSessionRecord.State.RELEASED, now));
        mvc.perform(get("/v1/agents/sessions/" + session).header(TenantContextFilter.HEADER, tenant).principal(actor(tenant, owner)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(session));
        var wrongFence = new RetiredWorkspace(workspace, 1, "migration");
        assertThatThrownBy(() -> lifecycle.admitRetiredWorkspaceDelete(principal, "delete", session, wrongFence)).hasMessageContaining("blocked");
        grant(tenant, "another");
        assertThatThrownBy(() -> lifecycle.admitRetiredWorkspaceDelete(new SessionPrincipal(tenant, "another", null),
                "delete", session, retired)).isInstanceOf(ManagedAgentException.class);
        var transport = Mockito.mock(RuntimeTransport.class);
        var provisioner = Mockito.mock(RuntimeProvisioner.class);
        try (var broker = new RuntimeBrokerService(
                ignored -> { throw new AssertionError("retired Worker was resolved"); }, provisioner, transport, bindings, runtimeSessions,
                new JdbcToolExecutionRepository(jdbc.getDataSource()), "broker",
                Duration.ofMinutes(1), Duration.ofMinutes(1))) {
            runtime.retired.put(session, broker);
            var operation = lifecycle.admitRetiredWorkspaceDelete(principal, "delete", session, retired);
            await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                    assertThat(store.findOperation(tenant, session, operation.id()).orElseThrow().state()).isEqualTo("COMPLETED"));
            assertThat(store.requireSession(tenant, session).status()).isEqualTo("DELETED");
            assertThat(store.requireSession(tenant, sibling).status()).isEqualTo("ACTIVE");
            assertThat(lifecycle.admitRetiredWorkspaceDelete(principal, "delete", session, retired).id()).isEqualTo(operation.id());
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_binding WHERE tenant_id = ?", Integer.class, tenant)).isOne();
            Mockito.verifyNoInteractions(transport);
            Mockito.verify(provisioner, Mockito.never()).provision(ArgumentMatchers.any());
            Mockito.verify(provisioner, Mockito.never()).provision(ArgumentMatchers.any(), ArgumentMatchers.any());
        } finally {
            runtime.retired.remove(session);
        }
    }

    private void recordInitializedSession(String tenant, String session) throws Exception {
        String token = "a".repeat(43);
        var writer = journal.acquireWriter(tenant, session, token, new AcquireWriterRequest("ws", "original", 60_000L));
        byte[] definition = "{\"toolProfile\":\"hosted-workspace-external-files/1\"}".getBytes(StandardCharsets.UTF_8);
        String digest = DigestUtils.sha256Hex(definition);
        var header = mapper.createObjectNode().put("subtype", "managed_session_header_v1");
        header.putObject("managedSession").putObject("definitionRef").put("resourceId", "definition").put("kind", "managed-session-definition")
                .put("schemaVersion", 1).put("byteLength", definition.length).put("digest", digest);
        byte[] bytes = ("{\"subtype\":\"session_execution_engine\"}\n" + header + "\n").getBytes(StandardCharsets.UTF_8);
        var resource = new CommitResource(
                "definition", "managed-session-definition", 1, definition.length, digest, Base64.getEncoder().encodeToString(definition));
        journal.commit(tenant, session, token, new CommitTransactionRequest(
                "ws", "original", writer.writerGeneration(), 0, 0, "transaction", "session.create", "command", "a".repeat(64),
                0, 0, 0, null, null, null, 0, null, 2, Base64.getEncoder().encodeToString(bytes),
                DigestUtils.sha256Hex(bytes), List.of(resource)));
        journal.sealWriter(tenant, session, token, new SealWriterRequest("ws", "original", writer.writerGeneration()));
    }

    @Test
    void bothSurfacesReplayOneCloseAndWaitForDurableCleanupAfterRevocation() throws Exception {
        String tenant = UUID.randomUUID().toString();
        String session = create(tenant);
        var close = runtime.results.computeIfAbsent(session, ignored -> new CompletableFuture<>());
        mvc.perform(get("/v1/agents/sessions/" + session).header(TenantContextFilter.HEADER, tenant)
                .principal(actor(tenant, "owner"))).andExpect(jsonPath("$.capabilities.session_close").value(true))
                .andExpect(jsonPath("$.capabilities.session_lifecycle").value(false));
        var admitted = mvc.perform(post("/v1/agents/sessions/" + session + "/close")
                .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", "close")
                .principal(actor(tenant, "owner"))).andExpect(status().isAccepted()).andReturn();
        String operation = mapper.readTree(admitted.getResponse().getContentAsString()).path("id").asText();
        await().untilAsserted(() -> assertThat(runtime.fenced).containsKey(session));
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSING");
        // D3: files closes on v2, so the claim gate names the fence
        // (workspace_lifecycle_claim_fenced) ahead of the v1 admission-closed code.
        assertThatThrownBy(() -> journal.acquireWriter(tenant, session, "a".repeat(43),
                new AcquireWriterRequest("ws", "writer", 10_000L))).isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_lifecycle_claim_fenced"));
        mvc.perform(post("/api/agent/web-shell/v1/sessions/close").header(TenantContextFilter.HEADER, tenant)
                .principal(actor(tenant, "owner")).contentType(MediaType.APPLICATION_JSON)
                .content("{\"sessionId\":\"" + session + "\",\"idempotencyKey\":\"close\"}"))
                .andExpect(status().isAccepted()).andExpect(jsonPath("$.operationId").value(operation))
                .andExpect(jsonPath("$.replayed").value(true));
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id = ?", tenant);
        close.complete(null);
        await().untilAsserted(() -> assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSED"));
        assertThat(store.findOperation(tenant, session, operation).orElseThrow().state()).isEqualTo("COMPLETED");
        grant(tenant, "owner");
        mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "close").principal(actor(tenant, "owner")))
                .andExpect(status().isAccepted()).andExpect(jsonPath("$.id").value(operation));
        mvc.perform(get("/v1/agents/sessions/" + session + "/events").header(TenantContextFilter.HEADER, tenant)
                .principal(actor(tenant, "owner"))).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT state FROM ma_workspace WHERE tenant_id = ?",
                String.class, tenant)).isEqualTo("ACTIVE");
    }

    @Test
    void readerCannotCloseAndActiveOrPendingApprovalTurnsRemainGated() throws Exception {
        String tenant = UUID.randomUUID().toString();
        String session = create(tenant);
        grant(tenant, "reader");
        mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "reader").principal(actor(tenant, "reader")))
                .andExpect(status().isForbidden());
        mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "other").principal(actor(tenant, "other")))
                .andExpect(status().isNotFound());
        seedAction(tenant, session, mapper.writeValueAsString(Map.of(
                "expiresAt", System.currentTimeMillis() + 86_400_000L,
                "inputRevision", 1, "policyRevision", "policy")));
        mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "approval").principal(actor(tenant, "owner")))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("turn_active"));
        jdbc.update("DELETE FROM ma_session_record WHERE record_kind = 'ACTION' AND tenant_id = ?", tenant);
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json,"
                + " payload_digest, status, gmt_create, gmt_modified) VALUES (?, ?, 'turn', ?, '[]', 'digest', 'CANCELLING', 0, 0)",
                tenant, session, UUID.randomUUID().toString());
        mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "active").principal(actor(tenant, "owner")))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("turn_active"));
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("ACTIVE");
        assertThat(runtime.fenced).doesNotContainKey(session);
    }

    @Test
    void expiredOrUndecidableApprovalDoesNotPreventClose() throws Exception {
        for (String options : List.of("{\"expiresAt\":1}", "{}")) {
            String tenant = UUID.randomUUID().toString();
            String session = create(tenant);
            seedAction(tenant, session, options);
            mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                    .header("Idempotency-Key", "expired").principal(actor(tenant, "owner")))
                    .andExpect(status().isAccepted());
            await().untilAsserted(() -> assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSED"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE record_kind = 'ACTION' AND tenant_id = ?",
                    Integer.class, tenant)).isEqualTo(1);
        }
    }

    @Test
    void liveOriginalWriterPreventsCompletionUntilItSeals() throws Exception {
        String tenant = UUID.randomUUID().toString();
        String session = create(tenant);
        // D3: the original writer seals itself without lifecycle authority,
        // which is v1 single-phase behavior; external-files keeps protocol 1
        // (ordinary files is v2 now, where a seal must carry the claim).
        jdbc.update("UPDATE ma_session SET tool_profile = ? WHERE tenant_id = ? AND session_id = ?",
                WorkspaceToolProfiles.EXTERNAL_FILES, tenant, session);
        String token = "a".repeat(43);
        var grant = journal.acquireWriter(tenant, session, token, new AcquireWriterRequest("ws", "original", 60_000L));
        var admitted = mvc.perform(post("/v1/agents/sessions/" + session + "/close")
                .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", "close")
                .principal(actor(tenant, "owner"))).andExpect(status().isAccepted()).andReturn();
        String operation = mapper.readTree(admitted.getResponse().getContentAsString()).path("id").asText();
        await().untilAsserted(() -> assertThat(jdbc.queryForObject("SELECT attempt_count FROM ma_operation"
                + " WHERE operation_kind = 'CLOSE' AND tenant_id = ? AND session_id = ? AND operation_id = ?", Integer.class, tenant, session, operation)).isGreaterThan(0));
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSING");
        assertThat(journal.hasLiveWriter(tenant, session)).isTrue();
        journal.sealWriter(tenant, session, token, new SealWriterRequest("ws", "original", grant.writerGeneration()));
        await().untilAsserted(() -> assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSED"));
    }

    @Test
    void uncertainStopIsObservableAndNeverCompletesUntilEvidenceArrives() throws Exception {
        String tenant = UUID.randomUUID().toString();
        String session = create(tenant);
        runtime.results.put(session, CompletableFuture.failedFuture(new RuntimeBrokerException(409,
                "workspace_close_identity_unverified", "Original identity unavailable", false)));
        var result = mvc.perform(post("/v1/agents/sessions/" + session + "/close")
                .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", "close")
                .principal(actor(tenant, "owner"))).andExpect(status().isAccepted()).andReturn();
        String operation = mapper.readTree(result.getResponse().getContentAsString()).path("id").asText();
        await().untilAsserted(() -> assertThat(store.findOperation(tenant, session, operation).orElseThrow().state())
                .isEqualTo("RECOVERY_BLOCKED"));
        mvc.perform(get("/v1/agents/sessions/" + session + "/operations/" + operation)
                .header(TenantContextFilter.HEADER, tenant).principal(actor(tenant, "owner")))
                .andExpect(status().isOk()).andExpect(jsonPath("$.failure_code").value("workspace_close_identity_unverified"));
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSING");
        runtime.results.put(session, CompletableFuture.completedFuture(null));
        await().untilAsserted(() -> assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSED"));
        assertThat(store.findOperation(tenant, session, operation).orElseThrow().failureCode()).isNull();
    }

    private void seedAction(String tenant, String session, String options) {
        String action = "tool_approval_" + UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO ma_session_record (tenant_id,session_id,record_kind,"
                        + "domain,record_id,action_id,revision,action_version,state,options_json,gmt_create,first_sequence)"
                        + " VALUES (?,?,'ACTION','action',?,?,1,1,'requested',?,0,1)",
                tenant, session, action, action, options);
    }

    private String create(String tenant) throws Exception {
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES (?, 'ws', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "owner");
        var result = mvc.perform(post("/v1/agents/sessions").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "create").principal(actor(tenant, "owner"))
                .contentType(MediaType.APPLICATION_JSON).content("{\"agent_id\":\"qwen-code\",\"input\":[],"
                        + "\"workspace\":{\"workspace_id\":\"ws\"}}"))
                .andExpect(status().isAccepted()).andReturn();
        return mapper.readTree(result.getResponse().getContentAsString()).path("id").asText();
    }

    private void grant(String tenant, String actor) {
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES (?, 'ws', ?, 'OPERATOR')", tenant, actor.getBytes(StandardCharsets.UTF_8));
    }

    private AuthenticatedTenantActor actor(String tenant, String id) {
        return new AuthenticatedTenantActor() {
            public String getName() { return id; }
            public String tenantId() { return tenant; }
            public String actorId() { return id; }
        };
    }

    @TestConfiguration
    static class Configuration {
        @Bean RuntimeBindingRepository lifecycleBindings(javax.sql.DataSource source) {
            return new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        }
        @Bean @Primary HarnessConnector uninitializedHarness() {
            return new UnavailableHarnessConnector() {
                public boolean supportsLifecycle() { return true; }
                // D3: the live-writer witness rides external-files (v1), whose
                // saved lifecycle the default connector does not advertise.
                public boolean supportsSavedLifecycle(String profile) {
                    return WorkspaceToolProfiles.EXTERNAL_FILES.equals(profile)
                            || super.supportsSavedLifecycle(profile);
                }
                public void detachLifecycle(com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord operation) {}
            };
        }
        @Bean @Primary CloseRuntime closeRuntime() { return new CloseRuntime(); }
        @Bean @Primary ManagedAgentStore closeStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
                ObjectMapper mapper,
                JdbcManagedWorkspaceRegistry registry,
                WorktreeFiles worktreeFiles, JdbcManagedSessionSkills skills, ExtensionPackages extensions,
                @Nullable JdbcWorkspaceLifecycleStore lifecycle, @Nullable JdbcManagedAgentDefinitionStore definitions,
                @Nullable JdbcSessionWorktreeStore worktrees,
                @Lazy @Nullable JdbcManagedExtensionRecordStore records) {
            var properties = new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties();
            properties.getHarness().setWorkspaceFilesEnabled(true);
            return new ManagedAgentStore(jdbc, mapper, java.time.Clock.systemUTC(), ignored -> {}, registry,
                    properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules(), worktreeFiles,
                    skills, extensions, lifecycle, definitions, worktrees, records);
        }
    }

    static class CloseRuntime implements RuntimeWarmer {
        final ConcurrentHashMap<String, CompletableFuture<Void>> results = new ConcurrentHashMap<>();
        final ConcurrentHashMap<String, RuntimeBrokerService> retired = new ConcurrentHashMap<>();
        final ConcurrentHashMap<String, String> fenced = new ConcurrentHashMap<>();
        public boolean isEnabled() { return false; }
        public boolean supportsWorkspaceClose() { return true; }
        public CompletionStage<Void> warm(String id) {
            if (retired.containsKey(id)) {
                throw new AssertionError("retired Worker was warmed");
            }
            return CompletableFuture.completedFuture(null);
        }
        public CompletionStage<Void> drain(String id) { return CompletableFuture.completedFuture(null); }
        public void requestWorkspaceClose(String tenant, String id) { throw new AssertionError("Unexpected legacy close"); }
        public CompletionStage<Void> closeWorkspace(String tenant, String id) {
            fenced.put(id, tenant);
            var broker = retired.get(id);
            if (broker != null) {
                return broker.drainHarnessSession(tenant, id);
            }
            return results.computeIfAbsent(id, ignored -> CompletableFuture.completedFuture(null));
        }
    }
}
