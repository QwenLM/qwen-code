package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(
        properties = {
            "spring.datasource.url=jdbc:h2:mem:approval-selection;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
            "spring.datasource.driver-class-name=org.h2.Driver",
            "spring.datasource.username=sa",
            "spring.datasource.password=",
            "qwen.managed-agent.harness.enabled=false"
        })
@AutoConfigureMockMvc
class ManagedApprovalSelectionTest {
    private static final String BASE = "/api/agent/web-shell/v1";
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ObjectMapper json;
    @Autowired private MockMvc mvc;
    @Autowired private ManagedWorkspaceRegistry registry;
    @Autowired private ManagedAgentDefinitionStore definitions;
    @Autowired private PlatformTransactionManager manager;

    @ParameterizedTest
    @ValueSource(strings = {"default", "auto-edit", "yolo"})
    void filesPersistTheSelectedMode(String mode) {
        String tenant = workspace();
        var store = store(false, "yolo");
        assertThat(store.workspaceSessionOptions(tenant, "qwen-code").availableApprovalModes())
                .containsExactly("default", "auto-edit", "yolo");
        var admitted = create(store, tenant, "key", "qwen-code", mode);
        assertThat(store.requireSession(tenant, admitted.sessionId()).approvalMode())
                .isEqualTo(mode);
    }

    @ParameterizedTest
    @ValueSource(strings = {"default", "auto-edit"})
    void shellOffersOnlyModesThatKeepCommandApproval(String mode) {
        String tenant = workspace();
        var store = store(true, "default");
        var options = store.workspaceSessionOptions(tenant, "qwen-code");
        assertThat(options.approvalMode()).isEqualTo("default");
        assertThat(options.availableApprovalModes()).containsExactly("default", "auto-edit");
        var admitted = create(store, tenant, "key", "qwen-code", mode);
        var session = store.requireSession(tenant, admitted.sessionId());
        assertThat(session.approvalMode()).isEqualTo(mode);
        assertThat(session.toolProfile()).isEqualTo("hosted-workspace-shell/1");
        assertThatThrownBy(() -> create(store, tenant, "yolo", "qwen-code", "yolo"))
                .isInstanceOfSatisfying(
                        ApiException.class,
                        error ->
                                assertThat(error.getCode()).isEqualTo("unsupported_approval_mode"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"auto", "plan", "", "DEFAULT", "unknown"})
    void unsupportedModesNeverCreateARegistrySession(String mode) {
        String tenant = workspace();
        assertThatThrownBy(() -> create(store(false, "yolo"), tenant, "key", "qwen-code", mode))
                .isInstanceOfSatisfying(
                        ApiException.class,
                        error ->
                                assertThat(error.getCode()).isEqualTo("unsupported_approval_mode"));
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?",
                                Integer.class,
                                tenant))
                .isZero();
    }

    @Test
    void replayKeepsModeAndOldDigestAfterDeploymentChanges() {
        String tenant = workspace();
        var files = store(false, "yolo");
        var selected = create(files, tenant, "selected", "qwen-code", "yolo");
        var omitted = create(files, tenant, "omitted", "qwen-code", null);
        var shell = store(true, "default");
        assertThat(create(shell, tenant, "selected", "qwen-code", "yolo").sessionId())
                .isEqualTo(selected.sessionId());
        assertThat(create(shell, tenant, "omitted", "qwen-code", null).sessionId())
                .isEqualTo(omitted.sessionId());
        assertThat(shell.requireSession(tenant, selected.sessionId()).approvalMode())
                .isEqualTo("yolo");
        for (String changed : List.of("default", "auto-edit")) {
            assertThatThrownBy(() -> create(shell, tenant, "selected", "qwen-code", changed))
                    .isInstanceOfSatisfying(
                            ApiException.class,
                            error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        }
        assertThatThrownBy(() -> create(shell, tenant, "omitted", "qwen-code", "yolo"))
                .isInstanceOfSatisfying(
                        ApiException.class,
                        error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
    }

    @Test
    void definitionPolicyIsFixedAndReplaysItsOriginalPin() throws Exception {
        String tenant = workspace();
        define(tenant, "default");
        var store = store(false, "yolo");
        var options =
                transaction().execute(status -> store.workspaceSessionOptions(tenant, "model"));
        assertThat(options.approvalMode()).isEqualTo("default");
        assertThat(options.availableApprovalModes()).containsExactly("default");
        var admitted = create(store, tenant, "key", "model", "default");
        assertThatThrownBy(() -> create(store, tenant, "other", "model", "auto-edit"))
                .isInstanceOfSatisfying(
                        ApiException.class,
                        error ->
                                assertThat(error.getCode()).isEqualTo("unsupported_approval_mode"));
        define(tenant, "auto-edit");
        assertThat(create(store, tenant, "key", "model", "default").sessionId())
                .isEqualTo(admitted.sessionId());
        var pinned = store.requireSession(tenant, admitted.sessionId());
        assertThat(pinned.agentRevision()).isEqualTo("1");
        assertThat(pinned.approvalMode()).isEqualTo("default");
        assertThat(
                        transaction()
                                .execute(status -> store.workspaceSessionOptions(tenant, "model"))
                                .availableApprovalModes())
                .containsExactly("auto-edit");
        assertThatThrownBy(
                        () ->
                                transaction()
                                        .execute(
                                                status ->
                                                        store.workspaceSessionOptions(
                                                                "another-tenant", "model")))
                .isInstanceOfSatisfying(
                        ApiException.class,
                        error -> assertThat(error.getCode()).isEqualTo("agent_not_found"));
    }

    @Test
    void optionsRequireActorAndAdvertiseCompatibility() throws Exception {
        String tenant = workspace();
        mvc.perform(
                        post(BASE + "/session-options/query")
                                .header(TenantContextFilter.HEADER, tenant)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"agentId\":\"qwen-code\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("actor_required"));
        mvc.perform(
                        post(BASE + "/session-options/query")
                                .header(TenantContextFilter.HEADER, tenant)
                                .principal(actor(tenant))
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"agentId\":\"qwen-code\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.approvalMode").value("yolo"))
                .andExpect(jsonPath("$.availableApprovalModes.length()").value(3));
        mvc.perform(
                        post(BASE + "/session-options/query")
                                .header(TenantContextFilter.HEADER, tenant)
                                .principal(actor("other"))
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"agentId\":\"qwen-code\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("actor_scope_mismatch"));
        mvc.perform(
                        post(BASE + "/workspaces/query")
                                .header(TenantContextFilter.HEADER, tenant)
                                .principal(actor(tenant))
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capabilities.approvalModeSelection").value(true));
    }

    @Test
    void apiReadsTheSavedModeAndRejectsUnboundSelection() throws Exception {
        String tenant = workspace();
        String body =
                "{\"agentId\":\"qwen-code\",\"idempotencyKey\":\"api\","
                        + "\"approvalMode\":\"auto-edit\",\"workspace\":{\"workspaceId\":\"ws\"}}";
        String response =
                mvc.perform(
                                post(BASE + "/sessions/create")
                                        .header(TenantContextFilter.HEADER, tenant)
                                        .principal(actor(tenant))
                                        .contentType(MediaType.APPLICATION_JSON)
                                        .content(body))
                        .andExpect(status().isAccepted())
                        .andReturn()
                        .getResponse()
                        .getContentAsString();
        String id = json.readTree(response).path("sessionId").asText();
        mvc.perform(
                        post(BASE + "/sessions/get")
                                .header(TenantContextFilter.HEADER, tenant)
                                .principal(actor(tenant))
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"sessionId\":\"" + id + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.approvalMode").value("auto-edit"));
        mvc.perform(
                        post(BASE + "/sessions/create")
                                .header(TenantContextFilter.HEADER, tenant)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(
                                        "{\"agentId\":\"qwen-code\",\"idempotencyKey\":\"unbound\",\"approvalMode\":\"default\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("unsupported_approval_mode"));
        String legacy =
                mvc.perform(
                                post(BASE + "/sessions/create")
                                        .header(TenantContextFilter.HEADER, tenant)
                                        .contentType(MediaType.APPLICATION_JSON)
                                        .content(
                                                "{\"agentId\":\"qwen-code\",\"idempotencyKey\":\"legacy\"}"))
                        .andExpect(status().isAccepted())
                        .andReturn()
                        .getResponse()
                        .getContentAsString();
        String legacyId = json.readTree(legacy).path("sessionId").asText();
        mvc.perform(
                        post(BASE + "/sessions/get")
                                .header(TenantContextFilter.HEADER, tenant)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"sessionId\":\"" + legacyId + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.approvalMode").doesNotExist());
    }

    @Test
    void storeImplementationsWithoutSelectionFailClosed() {
        AgentStateStore legacy = mock(AgentStateStore.class, CALLS_REAL_METHODS);
        assertThatThrownBy(
                        () ->
                                legacy.insertWorkspaceSessionCommand(
                                        "tenant",
                                        "actor",
                                        "key",
                                        "digest",
                                        "qwen-code",
                                        null,
                                        null,
                                        List.of(),
                                        null,
                                        new WorkspaceSelection("ws", "."),
                                        "default"))
                .isInstanceOf(UnsupportedOperationException.class);
    }

    private String workspace() {
        String tenant = "approval-" + UUID.randomUUID();
        jdbc.update(
                "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, 'ws',"
                    + " 1, 'storage', 'Workspace', 'config', 'policy', 'ACTIVE')",
                tenant);
        jdbc.update(
                "INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES"
                    + " (?, 'ws', ?, 'OWNER')",
                tenant,
                "actor".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return tenant;
    }

    private ManagedAgentStore store(boolean shell, String mode) {
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(shell);
        properties.getHarness().setApprovalMode(mode);
        var result =
                new ManagedAgentStore(
                        jdbc, json, Clock.systemUTC(), ignored -> {}, registry, properties);
        result.setManagedAgentDefinitionStore(definitions);
        return result;
    }

    private CommandAdmission create(
            ManagedAgentStore store, String tenant, String key, String agent, String mode) {
        var service =
                new ManagedAgentService(
                        store,
                        new RequestDigests(),
                        mock(HarnessCoordinator.class),
                        mock(HarnessConnector.class),
                        registry);
        return transaction()
                .execute(
                        status ->
                                service.createWorkspaceSession(
                                        tenant,
                                        "actor",
                                        key,
                                        agent,
                                        null,
                                        null,
                                        null,
                                        List.of(),
                                        new WorkspaceSelection("ws", "."),
                                        mode));
    }

    private void define(String tenant, String mode) throws Exception {
        String body =
                "{\"model\":{},\"instructions\":\"\",\"tools\":[{\"type\":\"hosted_profile\",\"profile\":\"hosted-workspace-files/1\"}],"
                    + "\"permission_policy\":{\"approval_mode\":\""
                        + mode
                        + "\"}}";
        String digest = new RequestDigests().digest(json.readTree(body));
        if (definitions.latest(tenant, "model").isEmpty()) {
            definitions.create(
                    tenant, "definition-" + mode, digest, "model", digest.substring(7), body, 1);
        } else {
            definitions.update(
                    tenant, "definition-" + mode, digest, "model", digest.substring(7), body, 2);
        }
    }

    private TransactionTemplate transaction() {
        return new TransactionTemplate(manager);
    }

    private static AuthenticatedTenantActor actor(String tenant) {
        return new AuthenticatedTenantActor() {
            public String getName() {
                return "actor";
            }

            public String tenantId() {
                return tenant;
            }

            public String actorId() {
                return "actor";
            }
        };
    }
}
