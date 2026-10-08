package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.service.SessionLifecycleCoordinator;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:workspace-retention;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false", "qwen.managed-agent.dispatch.scan-delay=20ms",
        "qwen.managed-agent.dispatch.retry-initial-delay=50ms", "qwen.managed-agent.dispatch.retry-max-delay=100ms"})
@AutoConfigureMockMvc
@Import(WorkspaceSessionRetentionTest.Configuration.class)
class WorkspaceSessionRetentionTest {
    private static final String PUBLIC = "/v1/agents/sessions/";
    private static final String WEB = "/api/agent/web-shell/v1";
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired ManagedAgentStore store;
    @Autowired ManagedSessionStore journal;
    @Autowired JdbcTemplate jdbc;
    @Autowired OnceCloseRuntime runtime;
    @Autowired PlatformTransactionManager transactions;
    @Autowired SessionLifecycleCoordinator lifecycle;

    @Test
    void archivesAndUnarchivesAcrossSurfacesWithoutReopeningOrRepeatingCleanup() throws Exception {
        String tenant = tenant();
        String session = closed(tenant, true);
        request(get(PUBLIC + session), tenant, "owner", null)
                .andExpect(jsonPath("$.capabilities.session_archive").value(true))
                .andExpect(jsonPath("$.capabilities.session_unarchive").value(true))
                .andExpect(jsonPath("$.capabilities.session_delete").value(true))
                .andExpect(jsonPath("$.capabilities.session_lifecycle").value(false));
        JsonNode archive = archive(tenant, session, "archive");
        assertThat(archive.path("status").asText()).isEqualTo("completed");
        web("archive", tenant, session, "owner", "archive").andExpect(status().isAccepted())
                .andExpect(jsonPath("$.operationId").value(archive.path("id").asText()))
                .andExpect(jsonPath("$.replayed").value(true));
        web("unarchive", tenant, session, "owner", "unarchive").andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "false"))
                .andExpect(jsonPath("$.status").value("closed"))
                .andExpect(jsonPath("$.capabilities.sessionArchive").value(true));
        request(post(PUBLIC + session + "/unarchive"), tenant, "owner", "unarchive")
                .andExpect(status().isOk()).andExpect(header().string("X-Qwen-Idempotent-Replay", "true"));
        archive(tenant, session, "archive-again");
        request(post(PUBLIC + session + "/unarchive"), tenant, "owner", "unarchive")
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("archived"));
        assertThatThrownBy(() -> journal.acquireWriter(tenant, session, "b".repeat(43),
                new AcquireWriterRequest("ws", "late", 60_000L))).isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("managed_session_lifecycle_active"));
        assertThat(count(tenant, session, "session.archived")).isEqualTo(2);
        assertThat(count(tenant, session, "session.unarchived")).isEqualTo(1);
        assertThat(runtime.calls.get(session)).isEqualTo(1);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void deletesClosedOrArchivedWithoutRuntimeAndRetiresTheJournal(boolean archived) throws Exception {
        String tenant = tenant();
        String session = closed(tenant, true);
        if (archived) {
            archive(tenant, session, "archive");
        }
        JsonNode deletion = json(web("delete", tenant, session, "owner", "delete")
                .andExpect(status().isAccepted()));
        String id = deletion.path("operationId").asText();
        await().untilAsserted(() -> assertThat(store.findOperation(tenant, session, id).orElseThrow().state())
                .isEqualTo("COMPLETED"));
        request(get(PUBLIC + session), tenant, "owner", null).andExpect(status().isNotFound());
        request(get(PUBLIC + session + "/operations/" + id), tenant, "owner", null)
                .andExpect(status().isOk()).andExpect(jsonPath("$.admission_stage").value("java_durable"));
        request(delete(PUBLIC + session), tenant, "owner", "delete").andExpect(status().isAccepted())
                .andExpect(jsonPath("$.id").value(id)).andExpect(jsonPath("$.replayed").value(true));
        request(delete(PUBLIC + session), tenant, "owner", "fresh").andExpect(status().isNotFound());
        request(post(PUBLIC + session + "/unarchive"), tenant, "owner", "unarchive").andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject("SELECT state FROM qwen_managed_session_journal_head WHERE tenant_id = ?"
                + " AND session_id = ?", String.class, tenant, session)).isEqualTo("DELETED");
        assertThat(jdbc.queryForObject("SELECT operation_id FROM qwen_output_session_retirement WHERE tenant_id = ?"
                + " AND session_id = ?", String.class, tenant, session)).isEqualTo(id);
        assertThat(count(tenant, session, "session.deleted")).isEqualTo(1);
        assertThat(runtime.calls.get(session)).isEqualTo(1);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void recoversDeletionBlockedByAnOlderCoordinatorWithoutRuntime(boolean archived) throws Exception {
        String tenant = tenant();
        String session = closed(tenant, true);
        if (archived) {
            archive(tenant, session, "archive");
        }
        String id = new TransactionTemplate(transactions).execute(ignored -> {
            var admitted = store.beginWorkspaceLifecycle(tenant, session,
                    OperationKind.DELETE,
                    "owner", "actor-digest", "delete", "digest", false);
            var claim = store.claimOperation(tenant, session, admitted.operation().operationId(),
                    "old-worker", Duration.ofMinutes(1)).orElseThrow();
            store.blockLifecycleOperation(tenant, session, claim.operationId(), "old-worker",
                    claim.claimGeneration(), "workspace_close_identity_unverified",
                    System.currentTimeMillis() + Duration.ofDays(1).toMillis());
            return claim.operationId();
        });
        assertThat(store.findOperation(tenant, session, id).orElseThrow().state()).isEqualTo("RECOVERY_BLOCKED");
        assertThat(store.findDeliverableOperations(Long.MAX_VALUE, 100)).noneMatch(target -> id.equals(target.operationId()));
        assertThat(store.claimOperation(tenant, session, id, "early-worker", Duration.ofMinutes(1))).isEmpty();
        jdbc.update("UPDATE managed_agent_operation SET available_at = 0 WHERE tenant_id = ? AND operation_id = ?", tenant, id);
        lifecycle.recoverOperations();
        await().untilAsserted(() -> assertThat(store.findOperation(tenant, session, id).orElseThrow().state()).isEqualTo("COMPLETED"));
        var completed = store.findOperation(tenant, session, id).orElseThrow();
        assertThat(completed.claimGeneration()).isEqualTo(2);
        assertThat(completed.failureCode()).isNull();
        assertThat(completed.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("DELETED");
        assertThat(jdbc.queryForObject("SELECT operation_id FROM qwen_output_session_retirement WHERE tenant_id = ?"
                + " AND session_id = ?", String.class, tenant, session)).isEqualTo(id);
        assertThat(count(tenant, session, "session.deleted")).isEqualTo(1);
        assertThat(runtime.calls.get(session)).isEqualTo(1);
    }

    @Test
    void unarchiveKeysAreScopedBySessionAndCaseAndCannotReplayAfterDeletion() throws Exception {
        String tenant = tenant();
        String first = closed(tenant, false);
        String second = closed(tenant, false);
        for (String session : new String[] {first, second}) {
            archive(tenant, session, "archive");
            web("unarchive", tenant, session, "owner", "same").andExpect(status().isOk())
                    .andExpect(header().string("X-Qwen-Idempotent-Replay", "false"));
        }
        archive(tenant, first, "Archive");
        web("unarchive", tenant, first, "owner", "Same").andExpect(status().isOk())
                .andExpect(header().string("X-Qwen-Idempotent-Replay", "false"));
        String id = json(request(delete(PUBLIC + first), tenant, "owner", "delete")
                .andExpect(status().isAccepted())).path("id").asText();
        await().untilAsserted(() -> assertThat(store.findOperation(tenant, first, id).orElseThrow().state())
                .isEqualTo("COMPLETED"));
        web("unarchive", tenant, first, "owner", "same").andExpect(status().isNotFound());
        assertThat(count(tenant, first, "session.unarchived")).isEqualTo(2);
    }

    @Test
    void permissionsAreRecheckedForMutationsReplaysAndTombstoneOperations() throws Exception {
        String tenant = tenant();
        String session = closed(tenant, false);
        grant(tenant, "reader");
        for (String operation : new String[] {"archive", "unarchive", "delete"}) {
            web(operation, tenant, session, "reader", "key").andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.error.code").value("session_operation_forbidden"));
            web(operation, tenant, session, "unknown", "key").andExpect(status().isNotFound());
        }
        JsonNode archive = archive(tenant, session, "archive");
        jdbc.update("DELETE FROM managed_workspace_access WHERE tenant_id = ? AND actor_id = ?",
                tenant, "owner".getBytes(StandardCharsets.UTF_8));
        web("archive", tenant, session, "owner", "archive").andExpect(status().isNotFound());
        request(get(PUBLIC + session + "/operations/" + archive.path("id").asText()), tenant, "reader", null)
                .andExpect(status().isOk());
        grant(tenant, "owner");
        String id = json(web("delete", tenant, session, "owner", "delete").andExpect(status().isAccepted()))
                .path("operationId").asText();
        await().untilAsserted(() -> assertThat(store.requireSession(tenant, session).status()).isEqualTo("DELETED"));
        request(get(PUBLIC + session + "/operations/" + id), tenant, "reader", null).andExpect(status().isOk());
        request(get(PUBLIC + session + "/operations/" + id), tenant(), "owner", null).andExpect(status().isNotFound());
    }

    @Test
    void archiveAndUnarchiveSourceStatesAndMissingCloseProofAreRefused() throws Exception {
        String tenant = tenant();
        String session = create(tenant);
        for (String operation : new String[] {"archive", "unarchive"}) {
            web(operation, tenant, session, "owner", "key").andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code").value("session_state_conflict"));
        }
        jdbc.update("UPDATE managed_agent_session SET status = 'CLOSED' WHERE tenant_id = ? AND session_id = ?",
                tenant, session);
        for (String operation : new String[] {"archive", "delete"}) {
            web(operation, tenant, session, "owner", "key").andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code").value("workspace_unavailable"));
        }
        jdbc.update("UPDATE managed_agent_session SET status = 'ARCHIVED' WHERE tenant_id = ? AND session_id = ?",
                tenant, session);
        web("unarchive", tenant, session, "owner", "key").andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("workspace_unavailable"));
        request(get(PUBLIC + session), tenant, "owner", null)
                .andExpect(jsonPath("$.capabilities.session_archive").value(false));
    }

    @ParameterizedTest
    @ValueSource(strings = {"contains space", "trailing ", "\tcontrol"})
    void invalidKeysAreRejectedWithoutNormalization(String key) throws Exception {
        String tenant = tenant();
        String session = closed(tenant, false);
        web("archive", tenant, session, "owner", key).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_idempotency_key"));
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSED");
    }

    @Test
    void metadataSurvivesRuntimeSupportRemoval() throws Exception {
        String tenant = tenant();
        String session = closed(tenant, false);
        runtime.supportRemoved = true;
        try {
            archive(tenant, session, "archive");
            web("unarchive", tenant, session, "owner", "unarchive").andExpect(status().isOk())
                    .andExpect(jsonPath("$.capabilities.sessionClose").value(false))
                    .andExpect(jsonPath("$.capabilities.sessionArchive").value(true));
            String id = json(web("delete", tenant, session, "owner", "delete").andExpect(status().isAccepted()))
                    .path("operationId").asText();
            await().untilAsserted(() -> assertThat(store.findOperation(tenant, session, id).orElseThrow().state()).isEqualTo("COMPLETED"));
            assertThat(runtime.calls.get(session)).isEqualTo(1);
        } finally {
            runtime.supportRemoved = false;
        }
    }

    @Test
    void pendingStatesAndBlockedOperationsRejectFreshMetadataRequests() throws Exception {
        String tenant = tenant();
        String session = closed(tenant, false);
        for (String state : new String[] {"CLOSING", "DELETING"}) {
            jdbc.update("UPDATE managed_agent_session SET status = ? WHERE tenant_id = ? AND session_id = ?", state, tenant, session);
            for (String operation : new String[] {"archive", "unarchive", "delete"}) {
                web(operation, tenant, session, "owner", "fresh").andExpect(status().isConflict())
                        .andExpect(jsonPath("$.error.code").value("session_state_conflict"));
            }
        }
        jdbc.update("UPDATE managed_agent_session SET status = 'CLOSED' WHERE tenant_id = ? AND session_id = ?", tenant, session);
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id, session_id, operation_id, operation_kind,"
                + " actor_digest, idempotency_key, request_digest, state, admission_stage, delivery_state,"
                + " session_status_before, available_at, created_at, updated_at)"
                + " VALUES (?, ?, ?, 'CLOSE', '', 'blocked', 'digest', 'RECOVERY_BLOCKED', 'JAVA_DURABLE',"
                + " 'BLOCKED', 'ACTIVE', ?, 0, 0)", tenant, session, "op_" + UUID.randomUUID(), Long.MAX_VALUE);
        web("archive", tenant, session, "owner", "fresh").andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("session_operation_active"));
        web("delete", tenant, session, "owner", "fresh").andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("session_operation_active"));
        jdbc.update("UPDATE managed_agent_session SET status = 'ARCHIVED' WHERE tenant_id = ? AND session_id = ?", tenant, session);
        web("unarchive", tenant, session, "owner", "fresh").andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("session_operation_active"));
    }

    @Test
    void maximumLengthKeyIsAcceptedAndOversizedKeysAreRejectedByEachAdapter() throws Exception {
        String tenant = tenant();
        String session = closed(tenant, false);
        request(post(PUBLIC + session + "/archive"), tenant, "owner", "a".repeat(129)).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_idempotency_key"));
        web("archive", tenant, session, "owner", "a".repeat(129)).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_request"));
        archive(tenant, session, "a".repeat(128));
        web("unarchive", tenant, session, "owner", "a".repeat(128)).andExpect(status().isOk());
    }

    private String closed(String tenant, boolean withJournal) throws Exception {
        String session = create(tenant);
        if (withJournal) {
            String token = "a".repeat(43);
            var writer = journal.acquireWriter(tenant, session, token, new AcquireWriterRequest("ws", "original", 60_000L));
            journal.sealWriter(tenant, session, token, new SealWriterRequest("ws", "original", writer.writerGeneration()));
        }
        request(post(PUBLIC + session + "/close"), tenant, "owner", "close").andExpect(status().isAccepted());
        await().untilAsserted(() -> assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSED"));
        return session;
    }

    private String create(String tenant) throws Exception {
        if (jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_registry WHERE tenant_id = ?", Integer.class, tenant) == 0) {
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation, storage_id,"
                    + " display_name, config_ref, policy_ref, state) VALUES (?, 'ws', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                    tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            grant(tenant, "owner");
        }
        return json(request(post("/v1/agents/sessions").contentType(MediaType.APPLICATION_JSON)
                .content("{\"agent_id\":\"qwen-code\",\"input\":[],\"workspace\":{\"workspace_id\":\"ws\"}}"),
                tenant, "owner", UUID.randomUUID().toString()).andExpect(status().isAccepted())).path("id").asText();
    }

    private JsonNode archive(String tenant, String session, String key) throws Exception {
        return json(request(post(PUBLIC + session + "/archive"), tenant, "owner", key).andExpect(status().isAccepted()));
    }

    private ResultActions web(String operation, String tenant, String session, String actor, String key) throws Exception {
        return request(post(WEB + "/sessions/" + operation).contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(java.util.Map.of("sessionId", session, "idempotencyKey", key))), tenant, actor, null);
    }

    private ResultActions request(MockHttpServletRequestBuilder request, String tenant, String actor, String key) throws Exception {
        request.header(TenantContextFilter.HEADER, tenant).principal(actor(tenant, actor));
        if (key != null) { request.header("Idempotency-Key", key); }
        return mvc.perform(request);
    }

    private JsonNode json(ResultActions result) throws Exception { return mapper.readTree(result.andReturn().getResponse().getContentAsString()); }
    private String tenant() { return "retention-" + UUID.randomUUID(); }
    private int count(String tenant, String session, String type) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event WHERE tenant_id = ? AND session_id = ? AND event_type = ?",
                Integer.class, tenant, session, type);
    }
    private void grant(String tenant, String actor) {
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create) VALUES (?, 'ws', ?, TRUE, TRUE)",
                tenant, actor.getBytes(StandardCharsets.UTF_8));
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
                public void detachLifecycle(com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord operation) {}
            };
        }
        @Bean @Primary OnceCloseRuntime retentionRuntime() { return new OnceCloseRuntime(); }
        @Bean @Primary ManagedAgentStore retentionStore(JdbcTemplate jdbc, ObjectMapper mapper, ManagedWorkspaceRegistry registry) {
            var properties = new ManagedAgentProperties();
            properties.getHarness().setWorkspaceFilesEnabled(true);
            return new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(), ignored -> {}, registry, properties);
        }
    }

    static class OnceCloseRuntime implements RuntimeWarmer {
        final ConcurrentHashMap<String, Integer> calls = new ConcurrentHashMap<>();
        public boolean isEnabled() { return false; }
        volatile boolean supportRemoved;
        public boolean supportsWorkspaceClose() {
            return !supportRemoved;
        }
        public CompletionStage<Void> warm(String id) { throw new AssertionError("Unexpected warm"); }
        public CompletionStage<Void> drain(String id) { throw new AssertionError("Unexpected drain"); }
        public void requestWorkspaceClose(String tenant, String id) { throw new AssertionError("Unexpected legacy close"); }
        public CompletionStage<Void> closeWorkspace(String tenant, String id) { record(id); return CompletableFuture.completedFuture(null); }
        private void record(String id) {
            if (calls.merge(id, 1, Integer::sum) > 1) { throw new AssertionError("Cleanup repeated after close"); }
        }
    }
}
