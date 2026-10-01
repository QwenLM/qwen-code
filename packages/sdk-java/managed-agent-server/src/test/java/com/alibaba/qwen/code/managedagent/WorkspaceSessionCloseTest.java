package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.*;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletionStage;
import org.junit.jupiter.api.Test;
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
    @Autowired ManagedSessionStore journal;
    @Autowired JdbcTemplate jdbc;
    @Autowired CloseRuntime runtime;

    @Test
    void bothSurfacesReplayOneCloseAndWaitForDurableCleanupAfterRevocation() throws Exception {
        String tenant = "close-" + UUID.randomUUID();
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
        assertThatThrownBy(() -> journal.acquireWriter(tenant, session, "a".repeat(43),
                new AcquireWriterRequest("ws", "writer", 10_000L))).hasMessageContaining("closing");
        mvc.perform(post("/api/agent/web-shell/v1/sessions/close").header(TenantContextFilter.HEADER, tenant)
                .principal(actor(tenant, "owner")).contentType(MediaType.APPLICATION_JSON)
                .content("{\"sessionId\":\"" + session + "\",\"idempotencyKey\":\"close\"}"))
                .andExpect(status().isAccepted()).andExpect(jsonPath("$.operationId").value(operation))
                .andExpect(jsonPath("$.replayed").value(true));
        jdbc.update("DELETE FROM managed_workspace_access WHERE tenant_id = ?", tenant);
        close.complete(null);
        await().untilAsserted(() -> assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSED"));
        assertThat(store.findOperation(tenant, session, operation).orElseThrow().state()).isEqualTo("COMPLETED");
        grant(tenant, "owner");
        mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "close").principal(actor(tenant, "owner")))
                .andExpect(status().isAccepted()).andExpect(jsonPath("$.id").value(operation));
        mvc.perform(get("/v1/agents/sessions/" + session + "/events").header(TenantContextFilter.HEADER, tenant)
                .principal(actor(tenant, "owner"))).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT state FROM managed_workspace_registry WHERE tenant_id = ?",
                String.class, tenant)).isEqualTo("ACTIVE");
    }

    @Test
    void readerCannotCloseAndActiveOrPendingApprovalTurnsRemainGated() throws Exception {
        String tenant = "close-" + UUID.randomUUID();
        String session = create(tenant);
        grant(tenant, "reader");
        mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "reader").principal(actor(tenant, "reader")))
                .andExpect(status().isForbidden());
        mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "other").principal(actor(tenant, "other")))
                .andExpect(status().isNotFound());
        jdbc.update("INSERT INTO managed_agent_action (tenant_id, session_id, action_id, state, options_json, created_at)"
                + " VALUES (?, ?, ?, 'requested', ?, 0)", tenant, session,
                "tool_approval_" + UUID.randomUUID().toString().replace("-", ""),
                mapper.writeValueAsString(java.util.Map.of("expiresAt", System.currentTimeMillis() + 86_400_000L,
                        "inputRevision", 1, "policyRevision", "policy")));
        mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "approval").principal(actor(tenant, "owner")))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("turn_active"));
        jdbc.update("DELETE FROM managed_agent_action WHERE tenant_id = ?", tenant);
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id, turn_id, prompt_id, input_json,"
                + " payload_digest, status, created_at, updated_at) VALUES (?, ?, 'turn', ?, '[]', 'digest', 'CANCELLING', 0, 0)",
                tenant, session, UUID.randomUUID().toString());
        mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", "active").principal(actor(tenant, "owner")))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("turn_active"));
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("ACTIVE");
        assertThat(runtime.fenced).doesNotContainKey(session);
    }

    @Test
    void expiredOrUndecidableApprovalDoesNotPreventClose() throws Exception {
        for (String options : java.util.List.of("{\"expiresAt\":1}", "{}")) {
            String tenant = "close-expired-" + UUID.randomUUID();
            String session = create(tenant);
            jdbc.update("INSERT INTO managed_agent_action (tenant_id, session_id, action_id, state, options_json, created_at)"
                    + " VALUES (?, ?, ?, 'requested', ?, 0)", tenant, session,
                    "tool_approval_" + UUID.randomUUID().toString().replace("-", ""), options);
            mvc.perform(post("/v1/agents/sessions/" + session + "/close").header(TenantContextFilter.HEADER, tenant)
                    .header("Idempotency-Key", "expired").principal(actor(tenant, "owner")))
                    .andExpect(status().isAccepted());
            await().untilAsserted(() -> assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSED"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_action WHERE tenant_id = ?",
                    Integer.class, tenant)).isEqualTo(1);
        }
    }

    @Test
    void liveOriginalWriterPreventsCompletionUntilItSeals() throws Exception {
        String tenant = "close-writer-" + UUID.randomUUID();
        String session = create(tenant);
        String token = "a".repeat(43);
        var grant = journal.acquireWriter(tenant, session, token, new AcquireWriterRequest("ws", "original", 60_000L));
        var admitted = mvc.perform(post("/v1/agents/sessions/" + session + "/close")
                .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", "close")
                .principal(actor(tenant, "owner"))).andExpect(status().isAccepted()).andReturn();
        String operation = mapper.readTree(admitted.getResponse().getContentAsString()).path("id").asText();
        await().untilAsserted(() -> assertThat(jdbc.queryForObject("SELECT attempt_count FROM managed_agent_operation"
                + " WHERE operation_id = ?", Integer.class, operation)).isGreaterThan(0));
        assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSING");
        assertThat(journal.hasLiveWriter(tenant, session)).isTrue();
        journal.sealWriter(tenant, session, token, new SealWriterRequest("ws", "original", grant.writerGeneration()));
        await().untilAsserted(() -> assertThat(store.requireSession(tenant, session).status()).isEqualTo("CLOSED"));
    }

    @Test
    void uncertainStopIsObservableAndNeverCompletesUntilEvidenceArrives() throws Exception {
        String tenant = "close-" + UUID.randomUUID();
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

    private String create(String tenant) throws Exception {
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation, storage_id,"
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
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                + " VALUES (?, 'ws', ?, TRUE, TRUE)", tenant, actor.getBytes(StandardCharsets.UTF_8));
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
        @Bean @Primary CloseRuntime closeRuntime() { return new CloseRuntime(); }
        @Bean @Primary ManagedAgentStore closeStore(JdbcTemplate jdbc, ObjectMapper mapper,
                com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry registry) {
            var properties = new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties();
            properties.getHarness().setWorkspaceFilesEnabled(true);
            return new ManagedAgentStore(jdbc, mapper, java.time.Clock.systemUTC(), ignored -> {}, registry, properties);
        }
    }

    static class CloseRuntime implements RuntimeWarmer {
        final ConcurrentHashMap<String, CompletableFuture<Void>> results = new ConcurrentHashMap<>();
        final ConcurrentHashMap<String, String> fenced = new ConcurrentHashMap<>();
        public boolean isEnabled() { return false; }
        public boolean supportsWorkspaceClose() { return true; }
        public CompletionStage<Void> warm(String id) { return CompletableFuture.completedFuture(null); }
        public CompletionStage<Void> drain(String id) { return CompletableFuture.completedFuture(null); }
        public void requestWorkspaceClose(String tenant, String id) { fenced.put(id, tenant); }
        public CompletionStage<Void> closeWorkspace(String tenant, String id) {
            return results.computeIfAbsent(id, ignored -> CompletableFuture.completedFuture(null));
        }
    }
}
