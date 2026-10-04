package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
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
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

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

    @Autowired
    private ManagedWorkspaceRegistry registry;

    @Autowired
    private PlatformTransactionManager transactionManager;

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
        jdbc.update("INSERT INTO managed_workspace_default"
                + " (tenant_id, workspace_id) VALUES (?, ?)", tenant,
                "d-default");
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
        jdbc.update("UPDATE managed_workspace_registry SET state = 'DRAINING'"
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
        jdbc.update("UPDATE managed_workspace_registry SET state = 'REMOVED'"
                + " WHERE tenant_id = ? AND workspace_id = ?", tenant,
                "d-default");
        mvc.perform(get("/v1/agents/workspaces")
                        .header(TenantContextFilter.HEADER, tenant)
                        .principal(actor(tenant, "actor-a")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.default_workspace").value((Object) null));
        jdbc.update("UPDATE managed_workspace_access SET can_read = FALSE"
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
                "key", "sha256:" + "a".repeat(64), "qwen-code", null, null,
                List.of(), null, null);
        jdbc.update("UPDATE managed_workspace_default SET workspace_id = ?"
                + " WHERE tenant_id = ?", "ws-b", tenant);
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
                .isInstanceOfSatisfying(ApiException.class, error ->
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
        ManagedAgentStore upgraded = new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {
                }, registry, changed);

        assertThat(upgraded.insertWorkspaceSessionCommand(tenant, "actor-a",
                "key", digest, "qwen-code", "1", null, List.of(), null,
                selection).sessionId()).isEqualTo(first.sessionId());
        assertThatThrownBy(() -> upgraded.insertWorkspaceSessionCommand(
                tenant, "actor-a", "new-key", digest, "qwen-code", "1", null,
                List.of(), null, selection))
                .isInstanceOfSatisfying(ApiException.class, error ->
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
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        var created = store.insertWorkspaceSessionCommand(tenant, "actor-a",
                "empty", "digest", "qwen-code", null, null, List.of(), null,
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
        ManagedAgentStore gated = new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {
                }, registry, enabled);
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);
        var admission = transaction.execute(status ->
                gated.insertTurnCommand(tenant, "SUBMIT", "later", digest,
                        sessionId, input, digest));
        assertThat(admission.sessionId()).isEqualTo(sessionId);
        assertThat(admission.turnId()).isNotBlank();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_turn WHERE tenant_id = ?"
                        + " AND session_id = ?",
                Integer.class, tenant, sessionId)).isEqualTo(1);
        // Unarchive stays gated for bound Sessions even under the opt-in.
        // It throws before any command row is written, so the rename probe
        // after it cannot collide with a leftover PENDING operation.
        assertThatThrownBy(() -> transaction.execute(status ->
                gated.beginSessionMutation(tenant, "UNARCHIVE_SESSION",
                        "unarchive-1", digest, sessionId,
                        SessionMutationKind.UNARCHIVE)))
                .isInstanceOfSatisfying(ApiException.class, error ->
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
    void emptyBoundCreationOutsideTheProfileIsNotAdmittedForLaterTurns() {
        String tenant = "tenant-" + UUID.randomUUID();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor-a", true);
        String digest = "sha256:" + "a".repeat(64);
        // Empty bound creation skips the execution-profile validation by
        // design, so a non qwen-code agent_id can be bound; the later-Turn
        // admission gate is what must refuse it.
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor-a", "create", digest, "another-agent", null, null,
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
                new RequestDigests(), null, enabledHarness, registry);

        assertThat(enabled.getWebShellSession(tenant, "actor-a", sessionId)
                .capabilities().workspaceTurns()).isFalse();
        assertThat(enabled.getWebShellSession(tenant, "actor-a", driftedId)
                .capabilities().workspaceTurns()).isFalse();
        assertThatThrownBy(() -> enabled.submitTurn(tenant, "actor-a",
                "later", sessionId,
                List.of(new InputBlock("text", "go"))))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        // The same shape on the frozen profile with the qwen-code agent
        // stays admitted.
        assertThat(enabled.getWebShellSession(tenant, "actor-a", controlId)
                .capabilities().workspaceTurns()).isTrue();
        ManagedAgentService disabled = new ManagedAgentService(store,
                new RequestDigests(), null, new UnavailableHarnessConnector(), registry);
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
        ManagedAgentStore gated = new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {
                }, registry, enabled);
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
                            throw WorkspaceExecutionStore.unavailable();
                        }
                        return new Attachment("boot");
                    }

                    @Override
                    public void rename(String tenantId, String sessionId,
                            String title) {
                    }
                };
        ManagedAgentService service = new ManagedAgentService(gated,
                new RequestDigests(), null, harness, registry);
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);

        // The refusal answers its own permanent status, and the command row
        // it wrote must not survive to wedge every later rename.
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-a", "rename-1", sessionId, "first"))
                        .isInstanceOfSatisfying(ApiException.class, error -> {
                            assertThat(error.getStatus())
                                    .isEqualTo(HttpStatus.CONFLICT);
                            assertThat(error.getCode())
                                    .isEqualTo("workspace_unavailable");
                        }));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_command WHERE tenant_id = ?"
                        + " AND session_id = ? AND command_status = 'PENDING'",
                Integer.class, tenant, sessionId)).isZero();

        transaction.executeWithoutResult(status -> gated.beginSessionMutation(
                tenant, "RENAME_SESSION", "rename-blocker", digest, sessionId,
                SessionMutationKind.RENAME));
        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-a", "rename-1", sessionId, "first"))
                        .isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode()).isEqualTo("session_operation_active")));
        assertThat(jdbc.queryForObject("SELECT command_status FROM managed_agent_command"
                        + " WHERE tenant_id = ? AND operation = 'RENAME_SESSION' AND idempotency_key = 'rename-1'",
                String.class, tenant)).isEqualTo("FAILED");
        transaction.executeWithoutResult(status -> gated.completeSessionMutation(
                tenant, "RENAME_SESSION", "rename-blocker", sessionId,
                SessionMutationKind.RENAME, "intermediate", "boot"));

        // The freed key stays re-usable: a same-key retry re-attempts the
        // mutation instead of colliding on the requested event the refused
        // attempt already published.
        transaction.executeWithoutResult(status -> service.renameSession(
                tenant, "actor-a", "rename-1", sessionId, "first"));
        assertThat(jdbc.queryForObject("SELECT title FROM"
                        + " managed_agent_session WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, tenant,
                sessionId)).isEqualTo("first");

        transaction.executeWithoutResult(status -> service.renameSession(
                tenant, "actor-a", "rename-2", sessionId, "second"));
        assertThat(jdbc.queryForObject("SELECT title FROM"
                        + " managed_agent_session WHERE tenant_id = ?"
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
        ManagedAgentStore gated = new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {
                }, registry, enabled);
        // A Harness that lost the Session answers the rename with a 4xx,
        // which the client surfaces as a DaemonHttpException — a permanent
        // failure, but not a broker refusal.
        DaemonHttpException lost = mock(DaemonHttpException.class);
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
                    public void rename(String tenantId, String sessionId,
                            String title) {
                        if (renames++ == 0) {
                            throw lost;
                        }
                    }
                };
        ManagedAgentService service = new ManagedAgentService(gated,
                new RequestDigests(), null, harness, registry);
        TransactionTemplate transaction = new TransactionTemplate(
                transactionManager);

        transaction.executeWithoutResult(status ->
                assertThatThrownBy(() -> service.renameSession(tenant,
                        "actor-a", "rename-1", sessionId, "first"))
                        .isInstanceOfSatisfying(ApiException.class, error -> {
                            assertThat(error.getStatus())
                                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                            assertThat(error.getCode())
                                    .isEqualTo("hosted_harness_unavailable");
                        }));
        // The answered mutation retired its command row too, so a fresh key
        // is admitted instead of wedging on session_operation_active.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_command WHERE tenant_id = ?"
                        + " AND session_id = ? AND command_status = 'PENDING'",
                Integer.class, tenant, sessionId)).isZero();

        transaction.executeWithoutResult(status -> service.renameSession(
                tenant, "actor-a", "rename-2", sessionId, "second"));
        assertThat(jdbc.queryForObject("SELECT title FROM"
                        + " managed_agent_session WHERE tenant_id = ?"
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
        ManagedAgentStore gated = new ManagedAgentStore(jdbc, mapper,
                Clock.systemUTC(), ignored -> {
                }, registry, enabled);
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
                    .isInstanceOfSatisfying(ApiException.class, error -> {
                        // The store's message, not the registry's "Workspace is
                        // unavailable.", ties the refusal to the store guard.
                        assertThat(error.getMessage()).isEqualTo(
                                "Hosted Workspace execution is not available.");
                        assertThat(error.getStatus())
                                .isEqualTo(HttpStatus.CONFLICT);
                        assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable");
                    });
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_session WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_turn WHERE tenant_id = ?",
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
        assertThat(jdbc.queryForObject("SELECT tool_profile FROM managed_agent_session"
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
                "actor-a", "key", "digest", "qwen-code", null, null, List.of(), null,
                selection)).isInstanceOfSatisfying(ApiException.class, error ->
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
        register(tenant, id, storageId, "config-" + id, "policy-" + id);
    }

    private void register(String tenant, String id, String storageId,
            String configRef, String policyRef) {
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE')",
                tenant, id, storageId, id, configRef, policyRef);
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
