package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

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
    @Autowired
    private ManagedAgentDefinitionStore definitions;
    @Autowired
    private PlatformTransactionManager transactionManager;

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource({
            "false, default", "false, yolo", "true, default", "true, yolo"
    })
    void shellOptInSelectsOnlyTheBuiltInProfile(boolean shellEnabled,
            String definitionApproval) throws Exception {
        String tenant = tenant();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor", true);
        JsonNode definition = define(tenant, "definition",
                FILES_DEFINITION.replace("\"default\"",
                        "\"" + definitionApproval + "\""));
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(shellEnabled);
        properties.getHarness().setApprovalMode("default");
        var selected = new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(),
                ignored -> {}, registry, properties);
        selected.setManagedAgentDefinitionStore(definitions);
        var transaction = new TransactionTemplate(transactionManager);
        var workspace = new WorkspaceSelection("ws-a", ".");
        String builtin = transaction.execute(status ->
                selected.insertWorkspaceSessionCommand(tenant, "actor",
                        "builtin", "builtin-digest", "qwen-code", null,
                        null, List.of(), null, workspace).sessionId());
        String custom = transaction.execute(status ->
                selected.insertWorkspaceSessionCommand(tenant, "actor",
                        "custom", "custom-digest", definition.get("id").asText(),
                        null, null, List.of(), null, workspace).sessionId());
        assertThat(selected.requireSession(tenant, builtin).toolProfile())
                .isEqualTo(shellEnabled ? "hosted-workspace-shell/1"
                        : "hosted-workspace-files/1");
        var pinned = selected.requireSession(tenant, custom);
        assertThat(pinned.toolProfile()).isEqualTo("hosted-workspace-files/1");
        assertThat(pinned.agentDefinitionDigest())
                .isEqualTo(definition.get("digest").asText());
        assertThat(jdbc.queryForObject("SELECT approval_mode FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, custom)).isEqualTo(definitionApproval);
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"default", "auto-edit"})
    void customShellInitialInputRequiresOptInButEmptyCreationAndReplayDoNot(
            String mode) throws Exception {
        String tenant = tenant();
        register(tenant, "ws-a", "storage-a", WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        grant(tenant, "ws-a", "actor", true);
        JsonNode definition = define(tenant, "definition", FILES_DEFINITION
                .replace("hosted-workspace-files/1", "hosted-workspace-shell/1")
                .replace("\"default\"", "\"" + mode + "\""));
        String agentId = definition.get("id").asText();
        var properties = new ManagedAgentProperties();
        properties.setDefinitionToolProfiles(List.of("hosted-workspace-shell/1"));
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                        tenant, "storage-a", "/workspace")));
        var enabled = new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(),
                ignored -> {}, registry, properties);
        enabled.setManagedAgentDefinitionStore(definitions);
        var transaction = new TransactionTemplate(transactionManager);
        var workspace = new WorkspaceSelection("ws-a", ".");
        var input = List.<Map<String, Object>>of(
                Map.of("type", "input_text", "text", "go"));
        var initial = transaction.execute(status -> enabled.insertWorkspaceSessionCommand(
                tenant, "actor", "initial", "initial-digest", agentId, null,
                null, input, "payload-digest", workspace));
        assertThat(initial.turnId()).isNotNull();
        assertThat(enabled.requireSession(tenant, initial.sessionId()).approvalMode())
                .isEqualTo(mode);
        properties.getHarness().setWorkspaceShellEnabled(false);
        var disabled = new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(),
                ignored -> {}, registry, properties);
        disabled.setManagedAgentDefinitionStore(definitions);
        var empty = transaction.execute(status -> disabled.insertWorkspaceSessionCommand(
                tenant, "actor", "empty", "empty-digest", agentId, null,
                null, List.of(), null, workspace));
        assertThat(empty.turnId()).isNull();
        assertThat(disabled.requireSession(tenant, empty.sessionId()).toolProfile())
                .isEqualTo("hosted-workspace-shell/1");
        assertThat(transaction.execute(status -> disabled.insertWorkspaceSessionCommand(
                tenant, "actor", "initial", "initial-digest", agentId, null,
                null, input, "payload-digest", workspace)).sessionId())
                .isEqualTo(initial.sessionId());
        assertThatThrownBy(() -> transaction.execute(status -> disabled.insertWorkspaceSessionCommand(
                tenant, "actor", "fresh", "fresh-digest", agentId, null,
                null, input, "payload-digest", workspace)))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> transaction.execute(status -> disabled.insertTurnCommand(
                tenant, "SUBMIT_TURN", "later", "later-digest", empty.sessionId(),
                input, "payload-digest")))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'SESSION_CREATE_ACTOR' AND tenant_id = ?",
                Integer.class, tenant)).isEqualTo(2);
    }

    @Test
    void configuredExtensionsStayOnTheAdmittedRevisionAfterAnUpdate() throws Exception {
        String tenant = tenant();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor", true);
        var content = mapper.readTree(FILES_DEFINITION).deepCopy();
        var object = (com.fasterxml.jackson.databind.node.ObjectNode) content;
        object.putArray("skills").addObject().put("name", "review").put("description", "Review changes")
                .put("body", "Original instructions").put("base_directory", ".qwen/skills/review");
        object.putObject("hook_catalog").put("catalog_id", "review").put("catalog_revision", 1)
                .put("definition_digest", "a".repeat(64));
        JsonNode definition = define(tenant, "create", object.toString());
        String agentId = definition.path("id").asText();
        JsonNode created = mapper.readTree(createBound(tenant, agentId, null, "configured")
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString());
        String sessionId = created.path("id").asText();
        var session = store.requireSession(tenant, sessionId);
        assertThat(definitions.pinnedContent(session)).containsKey("skills").containsKey("hook_catalog");
        define(tenant, "update", agentId, object.toString().replace("Original instructions", "New instructions"));
        assertThat(mapper.valueToTree(definitions.pinnedContent(session)).at("/skills/0/body").asText())
                .isEqualTo("Original instructions");
        createBound(tenant, agentId, null, "configured").andExpect(status().isAccepted())
                .andExpect(jsonPath("$.id").value(sessionId)).andExpect(jsonPath("$.agent_revision").value("1"));
        createBound(tenant, agentId, null, "new-configured").andExpect(status().isAccepted())
                .andExpect(jsonPath("$.agent_revision").value("2"));
    }

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
                "SELECT tool_profile FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, sessionId))
                .isEqualTo("hosted-workspace-files/1");
        assertThat(jdbc.queryForObject(
                "SELECT approval_mode FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, sessionId)).isEqualTo("default");
        assertThat(jdbc.queryForObject(
                "SELECT agent_definition_digest FROM ma_session"
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
        var definitions = new com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore(jdbc, new RequestDigests());
        assertThat(definitions.pinnedContent(session).get("instructions"))
                .isEqualTo("Review in Chinese.");
        var resources = new com.alibaba.qwen.code.managedagent.store.ManagedSessionStore(jdbc);
        var first = resources.publishAgentInstructions(tenant, "workspace", session.sessionId(),
                "Review in Chinese.");
        assertThat(resources.publishAgentInstructions(tenant, "workspace", session.sessionId(),
                "Review in Chinese.")).isEqualTo(first);
        assertThat(first.resourceId()).isEqualTo("agent-instructions-" + first.digest());
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource"
                        + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                byte[].class, tenant, session.sessionId(), first.resourceId()))
                .isEqualTo("Review in Chinese.".getBytes(StandardCharsets.UTF_8));
        jdbc.update("UPDATE ma_session SET agent_definition_digest = ?"
                        + " WHERE tenant_id = ? AND session_id = ?", "0".repeat(64), tenant, session.sessionId());
        assertThatThrownBy(() -> definitions.pinnedContent(store.requireSession(tenant, session.sessionId())))
                .isInstanceOf(ApiException.class);
    }

    @Test
    void listsOnlyMetadataFromTheSessionsPinnedSkillRevision() throws Exception {
        String tenant = tenant();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor", true);
        grant(tenant, "ws-a", "reader", false);
        var content = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(FILES_DEFINITION);
        content.putArray("skills").addObject().put("name", "review").put("description", "Original review")
                .put("body", "PRIVATE_PINNED_BODY").put("base_directory", "docs");
        String agentId = define(tenant, "definition", content.toString()).get("id").asText();
        String first = mapper.readTree(createBound(tenant, agentId, null, "first")
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString()).get("id").asText();
        ((com.fasterxml.jackson.databind.node.ObjectNode) content.at("/skills/0"))
                .put("name", "testing").put("description", "New testing").put("body", "NEW_BODY");
        define(tenant, "update", agentId, content.toString());
        String second = mapper.readTree(createBound(tenant, agentId, null, "second")
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString()).get("id").asText();
        JsonNode original = mapper.readTree(querySkills(tenant, "reader", first)
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        assertThat(original).isEqualTo(mapper.readTree(
                "{\"skills\":[{\"name\":\"review\",\"description\":\"Original review\"}]}"));
        querySkills(tenant, "actor", second).andExpect(status().isOk())
                .andExpect(jsonPath("$.skills[0].name").value("testing"));
        querySkills(tenant, null, first).andExpect(status().isUnauthorized());
        querySkills(tenant, "outsider", first).andExpect(status().isNotFound());
        querySkills(tenant(), "actor", first).andExpect(status().isNotFound());
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id = ? AND actor_id = ?", tenant,
                "reader".getBytes(StandardCharsets.UTF_8));
        querySkills(tenant, "reader", first).andExpect(status().isNotFound());
        jdbc.update("UPDATE ma_session SET agent_definition_digest = ? WHERE tenant_id = ? AND session_id = ?",
                "0".repeat(64), tenant, first);
        querySkills(tenant, "actor", first).andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("hosted_agent_definition_conflict"));
        jdbc.update("UPDATE ma_session SET status = 'DELETED' WHERE tenant_id = ? AND session_id = ?", tenant, second);
        querySkills(tenant, "actor", second).andExpect(status().isNotFound());
    }

    @Test
    void returnsAnEmptyCatalogForBuiltInAndSnapshotReadSessions() throws Exception {
        String tenant = tenant();
        register(tenant, "ws-a", "storage-a");
        grant(tenant, "ws-a", "actor", true);
        String builtin = mapper.readTree(createBound(tenant, "qwen-code", null, "builtin-skills")
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString()).get("id").asText();
        querySkills(tenant, "actor", builtin).andExpect(status().isOk())
                .andExpect(jsonPath("$.skills").isEmpty());
        String agentId = define(tenant, "empty-definition", FILES_DEFINITION).get("id").asText();
        String custom = mapper.readTree(createBound(tenant, agentId, null, "custom-skills")
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString()).get("id").asText();
        querySkills(tenant, "actor", custom).andExpect(status().isOk())
                .andExpect(jsonPath("$.skills").isEmpty());
        var content = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(FILES_DEFINITION);
        content.putArray("skills").addObject().put("name", "review").put("description", "Review")
                .put("body", "SNAPSHOT_SKILL_BODY");
        define(tenant, "snapshot-definition", agentId, content.toString());
        String snapshot = mapper.readTree(createBound(tenant, agentId, null, "snapshot-skills")
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString()).get("id").asText();
        querySkills(tenant, "actor", snapshot).andExpect(status().isOk())
                .andExpect(jsonPath("$.skills[0].name").value("review"));
        jdbc.update("UPDATE ma_session SET tool_profile = 'hosted-workspace-read/1'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, snapshot);
        querySkills(tenant, "actor", snapshot).andExpect(status().isOk())
                .andExpect(jsonPath("$.skills").isEmpty());
    }

    private org.springframework.test.web.servlet.ResultActions querySkills(String tenant, String actorId,
            String sessionId) throws Exception {
        var request = post("/api/agent/web-shell/v1/session-skills/query")
                .header(TenantContextFilter.HEADER, tenant).contentType(MediaType.APPLICATION_JSON)
                .content("{\"sessionId\":\"" + sessionId + "\"}");
        if (actorId != null) {
            request.principal(actor(tenant, actorId));
        }
        return mvc.perform(request);
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
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                        + " workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, ?, 1, ?, ?, ?, ?, 'ACTIVE')",
                tenant, id, storageId, id, configRef, policyRef);
        return id;
    }

    private void grant(String tenant, String workspaceId, String actorId,
            boolean canCreate) {
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
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
