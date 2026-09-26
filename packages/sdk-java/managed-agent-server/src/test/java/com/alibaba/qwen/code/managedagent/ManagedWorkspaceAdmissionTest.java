package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

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
    private JdbcTemplate jdbc;

    @Autowired
    private ManagedAgentStore store;

    @Autowired
    private ManagedAgentService service;

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
        assertThat(binding.getTenantId()).isEqualTo(tenant);
        assertThat(binding.getWorkspaceGeneration()).isEqualTo(1);
        assertThat(binding.getStorageId()).isEqualTo("storage-a");
        assertThat(binding.getContextRevision()).isEqualTo(1);
        assertThat(binding.getContextConfigRef()).isEqualTo(
                "sha256:6ed28bc26a1bf7f36cb3943d200ca1352a29fcc5867683a8a62845f1d32d1cab");
        assertThat(binding.getContextDigest()).startsWith("sha256:");
        assertThat(jdbc.queryForObject("SELECT workspace_config_ref FROM"
                + " managed_agent_session WHERE session_id = ?",
                String.class, sessionId)).isEqualTo("config-ws-a");
        assertThat(jdbc.queryForObject("SELECT workspace_policy_ref FROM"
                + " managed_agent_session WHERE session_id = ?",
                String.class, sessionId)).isEqualTo("policy-ws-a");

        jdbc.update("UPDATE managed_workspace_registry SET"
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
                        + " managed_agent_command WHERE tenant_id = ?"
                        + " AND session_id = ?", Integer.class, tenant,
                sessionId)).isZero();
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE"
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
        mvc.perform(patch("/v1/agents/sessions/" + sessionId)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "rename")
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"new title\"}"))
                .andExpect(status().isNotFound());
        assertThatThrownBy(() -> service.renameSession(tenant, "actor-a",
                "invalid-rename", sessionId, ""))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("session_not_found"));
    }

    @Test
    void retryOfOmittedSelectionKeepsOriginalDefault() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        register(tenant, "ws-b", "storage-b");
        grant(tenant, "ws-a", "actor-a", true);
        grant(tenant, "ws-b", "actor-a", true);
        jdbc.update("INSERT INTO managed_workspace_default"
                + " (tenant_id, workspace_id) VALUES (?, ?)", tenant,
                "ws-a");
        var first = store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "key", "sha256:" + "a".repeat(64), "qwen-code", null,
                List.of(), null, null);
        jdbc.update("UPDATE managed_workspace_default SET workspace_id = ?"
                + " WHERE tenant_id = ?", "ws-b", tenant);
        var retry = store.replayWorkspaceSessionCommand(tenant, "actor-a",
                "key", "sha256:" + "a".repeat(64));
        assertThat(retry.sessionId()).isEqualTo(first.sessionId());
        assertThat(store.requireSession(tenant, first.sessionId())
                .workspace().getWorkspaceId()).isEqualTo("ws-a");
        var second = store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "new-key", "sha256:" + "a".repeat(64), "qwen-code",
                null, List.of(), null, null);
        assertThat(store.requireSession(tenant, second.sessionId())
                .workspace().getWorkspaceId()).isEqualTo("ws-b");
        assertThatThrownBy(() -> store.replayWorkspaceSessionCommand(tenant,
                "actor-a", "key", "sha256:" + "b".repeat(64)))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("idempotency_conflict"));
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
                tenant, "actor-a", "nonempty", "digest", "qwen-code",
                null, input, "payload", selection))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        var created = store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "empty", "digest", "qwen-code", null, List.of(), null,
                selection);
        String sessionId = created.sessionId();
        assertThatThrownBy(() -> store.insertTurnCommand(tenant, "SUBMIT",
                "turn", "digest", sessionId, input, "payload"))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> store.insertCancelCommand(tenant, "CANCEL",
                "cancel", "digest", sessionId, "turn-id"))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> store.beginSessionMutation(tenant,
                "RENAME", "rename", "digest", sessionId,
                SessionMutationKind.RENAME))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> store.completeSessionMutation(tenant,
                "RENAME", "rename", sessionId, SessionMutationKind.RENAME,
                "new title", "boot"))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_turn WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_command WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
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
        mvc.perform(post("/api/agent/web-shell/v1/sessions/get")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"" + sessionId + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.workspace.workspaceId")
                        .value("ws-a"))
                .andExpect(jsonPath("$.workspace.cwdRelative").value("services/api"));
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
                        + " managed_agent_session WHERE tenant_id = ?",
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
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_session"
                + " WHERE tenant_id = ?", Integer.class, tenant)).isEqualTo(1);
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
                                "bound-digest", "qwen-code", null, List.of(), null,
                                new WorkspaceSelection("ws-a", "."));
                    } else {
                        store.insertSessionCommand(tenant, "CREATE_SESSION", "key",
                                "legacy-digest", "qwen-code", null, List.of(), null);
                    }
                    return "created";
                } catch (ApiException error) {
                    return error.getCode();
                }
            })).toList();
            assertThat(List.of(futures.get(0).get(5, TimeUnit.SECONDS),
                    futures.get(1).get(5, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder("created", "idempotency_conflict");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_session"
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
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_session"
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
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE"
                + " WHERE tenant_id = ?", tenant);
        assertCreateError(tenant, selection, "workspace_not_found");
        jdbc.update("UPDATE managed_workspace_access SET can_read = TRUE, can_create = TRUE"
                + " WHERE tenant_id = ?", tenant);
        jdbc.update("UPDATE managed_workspace_registry SET state = 'REMOVED'"
                + " WHERE tenant_id = ?", tenant);
        assertCreateError(tenant, selection, "workspace_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_session"
                + " WHERE tenant_id = ?", Integer.class, tenant)).isZero();
    }

    private void assertCreateError(String tenant, WorkspaceSelection selection,
            String expected) {
        assertThatThrownBy(() -> store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "key", "digest", "qwen-code", null, List.of(), null,
                selection)).isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(expected));
    }

    @Test
    void rejectsIncompleteBindingsAndIdentifiesDescriptorDrift() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor-a", true);
        String session = store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "key", "digest", "qwen-code", null, List.of(), null,
                new WorkspaceSelection("ws-a", ".")).sessionId();
        for (String column : List.of("workspace_generation", "context_revision")) {
            assertThatThrownBy(() -> jdbc.update("UPDATE managed_agent_session SET "
                    + column + " = NULL WHERE session_id = ?", session))
                    .isInstanceOf(DataIntegrityViolationException.class);
        }
        jdbc.update("UPDATE managed_agent_session SET workspace_config_ref = 'changed'"
                + " WHERE session_id = ?", session);
        try {
            assertThatThrownBy(() -> store.requireSession(tenant, session))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining(session).hasMessageContaining(tenant);
        } finally {
            jdbc.update("UPDATE managed_agent_session SET workspace_config_ref = 'config-ws-a'"
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

    private void register(String tenant, String id, String storageId) {
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE')",
                tenant, id, storageId, id, "config-" + id,
                "policy-" + id);
    }

    private void grant(String tenant, String workspaceId, String actorId,
            boolean canCreate) {
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, ?)",
                tenant, workspaceId,
                actorId.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                canCreate);
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
}
