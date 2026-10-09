package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

/**
 * D8b and D8c-1 Session admission: a stored AgentDefinition revision pins
 * (agent_id, revision, digest), compiles its approval mode and tool profile
 * into the Session's columns, refuses content that cannot take effect, and
 * replays without re-resolving. The built-in qwen-code path is unchanged.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-agent-definition-admission;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.definition-models=configured"
})
@AutoConfigureMockMvc
class ManagedAgentDefinitionAdmissionTest {
    private static final String FILES_DEFINITION = """
            {"model":{},"instructions":"",
             "tools":[{"type":"hosted_profile",
                       "profile":"hosted-workspace-files/1"}],
             "permission_policy":{"approval_mode":"default"}}
            """;
    private static final String MODEL_ONLY_DEFINITION = """
            {"model":{},"instructions":"","tools":[],
             "permission_policy":{}}
            """;
    @Autowired
    private MockMvc mvc;
    @Autowired
    private ObjectMapper mapper;
    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private ManagedAgentStore store;
    @Autowired
    private ManagedWorkspaceRegistry registry;

    @Test
    void omittedAndExplicitRevisionsPinAndExposeTheDigest() throws Exception {
        String tenant = tenant();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor", true);
        JsonNode definition = define(tenant, "create", FILES_DEFINITION);
        String agentId = definition.get("id").asText();
        String digest = definition.get("digest").asText();
        var response = createBound(tenant, agentId, null, "pin-bound")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.agent_revision").value("1"))
                .andExpect(jsonPath("$.agent_digest").value(digest))
                .andReturn();
        String sessionId = mapper.readTree(response.getResponse()
                .getContentAsString()).get("id").asText();
        assertThat(jdbc.queryForObject(
                "SELECT tool_profile FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, sessionId))
                .isEqualTo("hosted-workspace-files/1");
        assertThat(jdbc.queryForObject(
                "SELECT approval_mode FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, sessionId)).isEqualTo("default");
        assertThat(jdbc.queryForObject(
                "SELECT agent_definition_digest FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, sessionId)).isEqualTo(digest);
        // A second revision supersedes nothing already pinned. The update
        // keeps the bound-compatible shape and flips the approval mode.
        define(tenant, "update", agentId, """
                {"model":{},"instructions":"",
                 "tools":[{"type":"hosted_profile",
                           "profile":"hosted-workspace-files/1"}],
                 "permission_policy":{"approval_mode":"yolo"}}
                """);
        createBound(tenant, agentId, null, "pin-latest")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.agent_revision").value("2"));
        createBound(tenant, agentId, "1", "pin-explicit")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.agent_revision").value("1"))
                .andExpect(jsonPath("$.agent_digest").value(digest));
    }

    @Test
    void replayReturnsThePinnedRevisionWithoutResolvingAgain()
            throws Exception {
        String tenant = tenant();
        String agentId = define(tenant, "create", MODEL_ONLY_DEFINITION)
                .get("id").asText();
        String body = "{\"agent_id\":\"" + agentId + "\",\"input\":[]}";
        String first = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "replay")
                        .principal(actor(tenant, "actor"))
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.agent_revision").value("1"))
                .andReturn().getResponse().getContentAsString();
        JsonNode firstJson = mapper.readTree(first);
        define(tenant, "update", agentId, FILES_DEFINITION);
        String replayed = mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "replay")
                        .principal(actor(tenant, "actor"))
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.agent_revision").value("1"))
                .andReturn().getResponse().getContentAsString();
        // The replay returns the original Session, pinned revision included;
        // background snapshot progress is not part of the receipt.
        JsonNode replayedJson = mapper.readTree(replayed);
        assertThat(replayedJson.get("id")).isEqualTo(firstJson.get("id"));
        assertThat(replayedJson.get("agent_digest"))
                .isEqualTo(firstJson.get("agent_digest"));
    }

    @Test
    void unknownAgentOrRevisionAnswers404AcrossTenants() throws Exception {
        String tenant = tenant();
        String agentId = define(tenant, "create", MODEL_ONLY_DEFINITION)
                .get("id").asText();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor", true);
        createBound(tenant, "agent_" + "f".repeat(32), null, "missing")
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("agent_not_found"));
        createBound(tenant, agentId, "9", "missing-revision")
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("agent_not_found"));
        createBound(tenant, agentId, "abc", "malformed-revision")
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("agent_not_found"));
        // Another tenant cannot resolve the same definition.
        String other = tenant();
        register(other, "ws-a", "storage-a");
        grant(other, "ws-a", "actor", true);
        createBound(other, agentId, null, "cross-tenant")
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("agent_not_found"));
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.MethodSource("unsupportedDefinitions")
    void storedContentThatCannotTakeEffectIsRefusedAtAdmission(
            String definition, String field) throws Exception {
        String tenant = tenant();
        String agentId = define(tenant, "create", definition).get("id")
                .asText();
        createBound(tenant, agentId, null, "unsupported")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("agent_definition_unsupported"))
                .andExpect(jsonPath("$.error.field").value(field));
    }

    private static java.util.stream.Stream<org.junit.jupiter.params.provider.Arguments>
            unsupportedDefinitions() {
        return java.util.stream.Stream.of(
                org.junit.jupiter.params.provider.Arguments.of(
                        "{\"model\":{\"id\":\"qwen3\"},\"instructions\":\"\","
                                + "\"tools\":[],\"permission_policy\":{}}",
                        "model"),
                org.junit.jupiter.params.provider.Arguments.of(
                        "{\"model\":{},\"instructions\":\"" + "界".repeat(21846)
                                + "\",\"tools\":[],\"permission_policy\":{}}",
                        "instructions"),
                org.junit.jupiter.params.provider.Arguments.of(
                        "{\"model\":{},\"instructions\":\"\",\"tools\":[],"
                                + "\"permission_policy\":{\"approval_timeout_ms\":5000}}",
                        "permission_policy"),
                org.junit.jupiter.params.provider.Arguments.of(
                        "{\"model\":{},\"instructions\":\"\",\"tools\":[{"
                                + "\"type\":\"hosted_profile\",\"profile\":"
                                + "\"hosted-workspace-files/2\"}],"
                                + "\"permission_policy\":{}}",
                        "tools"),
                org.junit.jupiter.params.provider.Arguments.of(
                        "{\"model\":{},\"instructions\":\"\",\"tools\":[{"
                                + "\"type\":\"hosted_profile\",\"profile\":"
                                + "\"hosted-workspace-files/1\"}],"
                                + "\"permission_policy\":{},"
                                + "\"skills\":[{\"name\":\"x\"}]}",
                        "skills"),
                org.junit.jupiter.params.provider.Arguments.of(
                        "{\"model\":{},\"instructions\":\"\",\"tools\":[{"
                                + "\"type\":\"hosted_profile\",\"profile\":"
                                + "\"hosted-workspace-files/1\"}],"
                                + "\"permission_policy\":{},"
                                + "\"environment_template_id\":\"tpl\"}",
                        "environment_template_id"));
    }

    @Test
    void aModelOnlyDefinitionCannotBindAWorkspace() throws Exception {
        String tenant = tenant();
        String agentId = define(tenant, "create", MODEL_ONLY_DEFINITION)
                .get("id").asText();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor", true);
        createBound(tenant, agentId, null, "unbound-tools")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code")
                        .value("agent_definition_unsupported"))
                .andExpect(jsonPath("$.error.field").value("tools"));
        // The same definition is admitted without a Workspace.
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "model-only")
                        .principal(actor(tenant, "actor"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"" + agentId
                                + "\",\"input\":[]}"))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.agent_revision").value("1"))
                .andExpect(jsonPath("$.agent_digest").exists());
    }

    @Test
    void theDefinitionCreatorMaySubmitLaterTurnsOfABoundSession() {
        String tenant = tenant();
        register(tenant, "ws-a", "storage-a",
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor", true);
        String agentId;
        try {
            agentId = define(tenant, "create", FILES_DEFINITION).get("id")
                    .asText();
        } catch (Exception error) {
            throw new AssertionError(error);
        }
        String digest = "sha256:" + "a".repeat(64);
        String sessionId = store.insertWorkspaceSessionCommand(tenant,
                "actor", "create", digest, agentId, null, null, List.of(),
                null, new WorkspaceSelection("ws-a", ".")).sessionId();
        UnavailableHarnessConnector harness = new UnavailableHarnessConnector() {
            @Override
            public boolean isWorkspaceFilesAvailable() {
                return true;
            }
        };
        ManagedAgentService service = new ManagedAgentService(store,
                new RequestDigests(), null, harness, registry);
        assertThat(service.getWebShellSession(tenant, "actor", sessionId)
                .capabilities().workspaceTurns()).isTrue();
        // The dispatch is refused only by the unavailable Harness.
        assertThatThrownBy(() -> service.submitTurn(tenant, "actor", "later",
                sessionId, List.of(new InputBlock("text", "go"))))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isNotEqualTo("workspace_unavailable"));
    }

    @Test
    void theBuiltInAgentStaysUnchanged() throws Exception {
        String tenant = tenant();
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "builtin")
                        .principal(actor(tenant, "actor"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\",\"input\":[]}"))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.agent_revision").value("1"))
                .andExpect(jsonPath("$.agent_digest").doesNotExist());
        mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "builtin-revision")
                        .principal(actor(tenant, "actor"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"qwen-code\","
                                + "\"agent_revision\":\"2\",\"input\":[]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code")
                        .value("unsupported_feature"));
    }

    @Test
    void admitsModelInstructionsAndPublishesADigestAddressedResource() throws Exception {
        String tenant = tenant();
        JsonNode definition = define(tenant, "create", """
                {"model":{"id":"configured"},"instructions":"Review in Chinese.",
                 "tools":[],"permission_policy":{"approval_mode":"default"}}
                """);
        JsonNode receipt = mapper.readTree(mvc.perform(post("/v1/agents/sessions")
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", "definition-model")
                        .principal(actor(tenant, "actor"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"agent_id\":\"" + definition.get("id").asText()
                                + "\",\"input\":[]}"))
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString());
        var session = store.requireSession(tenant, receipt.get("id").asText());
        var definitions = new com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore(jdbc);
        assertThat(definitions.pinnedContent(session).get("instructions"))
                .isEqualTo("Review in Chinese.");
        var resources = new com.alibaba.qwen.code.managedagent.store.ManagedSessionStore(jdbc);
        var first = resources.publishAgentInstructions(tenant, "workspace", session.sessionId(),
                "Review in Chinese.");
        assertThat(resources.publishAgentInstructions(tenant, "workspace", session.sessionId(),
                "Review in Chinese.")).isEqualTo(first);
        assertThat(first.resourceId()).isEqualTo("agent-instructions-" + first.digest());
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM qwen_managed_session_resource"
                        + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                byte[].class, tenant, session.sessionId(), first.resourceId()))
                .isEqualTo("Review in Chinese.".getBytes(StandardCharsets.UTF_8));
        jdbc.update("UPDATE managed_agent_session SET agent_definition_digest = ?"
                        + " WHERE tenant_id = ? AND session_id = ?", "0".repeat(64), tenant, session.sessionId());
        assertThatThrownBy(() -> definitions.pinnedContent(store.requireSession(tenant, session.sessionId())))
                .isInstanceOf(ApiException.class);
    }

    private JsonNode define(String tenant, String key, String definition)
            throws Exception {
        return define(tenant, key, null, definition);
    }

    private JsonNode define(String tenant, String key, String agentId,
            String definition) throws Exception {
        String path = "/v1/agents" + (agentId == null ? "" : "/" + agentId);
        var result = mvc.perform(post(path)
                        .header(TenantContextFilter.HEADER, tenant)
                        .header("Idempotency-Key", key)
                        .principal(actor(tenant, "actor"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(definition))
                .andExpect(status().isAccepted()).andReturn();
        return mapper.readTree(result.getResponse().getContentAsString());
    }

    private org.springframework.test.web.servlet.ResultActions createBound(
            String tenant, String agentId, String revision, String key)
            throws Exception {
        String body = "{\"agent_id\":\"" + agentId + "\",\"input\":[],"
                + (revision == null ? ""
                        : "\"agent_revision\":\"" + revision + "\",")
                + "\"workspace\":{\"workspace_id\":\"ws-a\"}}";
        return mvc.perform(post("/v1/agents/sessions")
                .header(TenantContextFilter.HEADER, tenant)
                .header("Idempotency-Key", key)
                .principal(actor(tenant, "actor"))
                .contentType(MediaType.APPLICATION_JSON).content(body));
    }

    private String register(String tenant, String id, String storageId) {
        return register(tenant, id, storageId, "config-" + id,
                "policy-" + id);
    }

    private String register(String tenant, String id, String storageId,
            String configRef, String policyRef) {
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE')",
                tenant, id, storageId, id, configRef, policyRef);
        return id;
    }

    private void grant(String tenant, String workspaceId, String actorId,
            boolean canCreate) {
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                        + " workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, ?)",
                tenant, workspaceId,
                actorId.getBytes(StandardCharsets.UTF_8),
                canCreate ? "OPERATOR" : "READER");
    }

    private static String tenant() {
        return "tenant-" + UUID.randomUUID();
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
