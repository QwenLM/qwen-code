package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackageService;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionSkills;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Answers.RETURNS_DEFAULTS;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:session-creation-skills;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa",
        "spring.datasource.password=", "qwen.managed-agent.harness.enabled=false"
})
@AutoConfigureMockMvc
class ManagedSessionCreationSkillsTest {
    @Autowired private MockMvc mvc;
    @Qualifier("managedJdbcTemplate")
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ObjectMapper json;
    @Autowired private ManagedAgentStore store;
    @Autowired private ManagedSessionSkills snapshots;
    @Autowired private ManagedAgentProperties properties;
    @Autowired private ManagedExtensionPackageService extensionPackages;
    @Qualifier("managedAgentTransactionManager")
    @Autowired private org.springframework.transaction.PlatformTransactionManager transactionManager;
    @TempDir private Path archiveDirectory;
    @TestBean(methodName = "createHarness") private HarnessConnector harness;
    private static volatile boolean sessionSkillsSupported;
    private static volatile boolean sessionExtensionsSupported;
    private static volatile boolean mcpLifecycleSupported;
    private static volatile boolean publicChildAgentsSupported;
    private String tenant;
    private Boolean previousShellEnabled;
    private final Map<String, Object> skill = Map.of("name", "review", "description", "Review changes",
            "body", "ORIGINAL_INSTRUCTIONS", "base_directory", "docs");

    // Scheduled availability reads share this mock; configure capability answers
    // at creation instead of mutating Mockito stubbing while those reads run.
    static HarnessConnector createHarness() {
        return mock(HarnessConnector.class, call -> switch (call.getMethod().getName()) {
            case "supportsSessionSkills" -> sessionSkillsSupported;
            case "supportsSessionExtensions" -> sessionExtensionsSupported;
            case "supportsPublicChildAgents" -> publicChildAgentsSupported;
            case "supportsLifecycle" -> call.getArguments().length == 1
                    && ("hosted-workspace-shell/1".equals(call.getArgument(0))
                    || mcpLifecycleSupported && "hosted-workspace-mcp/1".equals(call.getArgument(0)));
            default -> RETURNS_DEFAULTS.answer(call);
        });
    }

    @BeforeEach
    void setup() {
        tenant = "skills-" + UUID.randomUUID();
        sessionSkillsSupported = true;
        sessionExtensionsSupported = true;
        mcpLifecycleSupported = false;
        publicChildAgentsSupported = false;
        properties.getExtensions().setEnabled(false);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES (?, 'ws', 1, 'storage', 'Test', 'config', 'policy', 'ACTIVE')", tenant);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'ws', ?, 'OPERATOR')",
                tenant, "actor".getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void pinsInitialPackagesInTheCreationReceiptAndOnlyPermitsTheirFirstBootstrap() throws Exception {
        enableBuiltinShell();
        properties.getExtensions().setEnabled(true);
        properties.getExtensions().setArtifactDirectory(archiveDirectory.toString());
        properties.getExtensions().setAllowedActors(List.of("actor"));
        byte[] archive = "source archive".getBytes(StandardCharsets.UTF_8);
        var published = extensionPackages.publish(tenant, "actor", "ws", null,
                org.apache.commons.codec.digest.DigestUtils.sha256Hex(archive), "publication",
                new ManagedExtensionPackages.Manifest(1, 1, "context", "1.0", new ManagedExtensionPackages.Target("linux", "any"), List.of("context")),
                new java.io.ByteArrayInputStream(archive));
        var pins = List.of(new ManagedExtensionPackages.Pin(published.extensionId(), 1, published.packageDigest(), null));
        var body = request("qwen-code", List.of(skill));
        body.set("extensionPins", json.valueToTree(pins));
        String session = create(body, "with-extensions", true).required("sessionId").asText();
        assertThat(store.requireSession(tenant, session).toolProfile()).isEqualTo("hosted-workspace-shell/1");
        assertThat(create(body, "with-extensions", true).required("sessionId").asText()).isEqualTo(session);
        assertThat(snapshots.effective(store.requireSession(tenant, session))).containsExactly(skill);
        var initial = snapshots.initialSelection(tenant, session);
        assertThat(initial).containsEntry("expectedRevision", 0);
        JsonNode selectedPins = json.valueToTree(initial.get("extensions"));
        assertThat(selectedPins).isEqualTo(json.readTree(json.writeValueAsString(pins)));
        var bootstrap = json.createObjectNode().put("mode", "apply").put("previousConfigRevision", 0).put("configRevision", 1);
        bootstrap.set("command", json.valueToTree(initial));
        var transaction = new org.springframework.transaction.support.TransactionTemplate(transactionManager);
        transaction.executeWithoutResult(ignored -> store.requireConfigurationCommit(tenant, "ws", session, bootstrap));
        bootstrap.put("mode", "recoverPrevious").put("previousConfigRevision", 1).put("configRevision", 2);
        transaction.executeWithoutResult(ignored -> store.requireConfigurationCommit(tenant, "ws", session, bootstrap));
        bootstrap.put("configRevision", 3);
        assertThatThrownBy(() -> transaction.executeWithoutResult(ignored -> store.requireConfigurationCommit(tenant, "ws", session, bootstrap)))
                .hasMessageContaining("creation receipt");
        bootstrap.put("mode", "apply").put("previousConfigRevision", 0).put("configRevision", 1);
        ((com.fasterxml.jackson.databind.node.ObjectNode) bootstrap.get("command")).put("expectedRevision", 1);
        assertThatThrownBy(() -> transaction.executeWithoutResult(ignored -> store.requireConfigurationCommit(tenant, "ws", session, bootstrap)))
                .hasMessageContaining("creation receipt");
        body.set("extensionPins", json.createArrayNode());
        submit(body, "with-extensions", true).andExpect(status().isConflict());
        jdbc.update("UPDATE ma_request_receipt SET result_json=REPLACE(result_json, ?, ?)"
                + " WHERE tenant_id=? AND session_id=? AND namespace='SESSION_CREATE_ACTOR'",
                published.packageDigest(), "b".repeat(64), tenant, session);
        assertThatThrownBy(() -> snapshots.initialSelection(tenant, session)).isInstanceOf(RuntimeException.class);
    }

    @Test
    void explicitEmptySelectionUsesTheNewContractAndStillRequiresDeploymentPermission() throws Exception {
        enableBuiltinShell();
        var body = request("qwen-code", List.of());
        body.putArray("extensionPins");
        submit(body, "denied", true).andExpect(status().isForbidden());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=?", Long.class, tenant)).isZero();
        properties.getExtensions().setEnabled(true);
        properties.getExtensions().setArtifactDirectory(archiveDirectory.toString());
        properties.getExtensions().setAllowedActors(List.of("actor"));
        String session = create(body, "empty", false).required("id").asText();
        assertThat(snapshots.initialSelection(tenant, session).get("extensions")).isEqualTo(List.of());
        assertThat(snapshots.snapshot(tenant, session)).isNull();
        sessionExtensionsSupported = false;
        submit(body, "unsupported-package-harness", true).andExpect(status().isConflict());
        body.remove("workspace");
        submit(body, "unbound-package", true).andExpect(status().isBadRequest());
    }

    @Test
    void refusesInitialSelectionsOnFilesProfilesBeforeCreatingASessionOrReceipt() throws Exception {
        properties.getExtensions().setEnabled(true);
        properties.getExtensions().setArtifactDirectory(archiveDirectory.toString());
        properties.getExtensions().setAllowedActors(List.of("actor"));
        var body = request("qwen-code", List.of());
        body.putArray("extensionPins");
        for (boolean web : List.of(true, false)) {
            submit(body, "unsupported-profile-" + web, web).andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code").value("unsupported_feature"));
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=?", Long.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE tenant_id=?", Long.class, tenant)).isZero();
        body.remove("extensionPins");
        String ordinary = create(body, "ordinary-files", true).required("sessionId").asText();
        assertThat(store.requireSession(tenant, ordinary).toolProfile()).isEqualTo("hosted-workspace-files/1");
    }

    @Test
    void requiresTheActualMcpLifecycleNegotiationBeforePersistingAnInitialSelection() throws Exception {
        properties.getExtensions().setEnabled(true);
        properties.getExtensions().setArtifactDirectory(archiveDirectory.toString());
        properties.getExtensions().setAllowedActors(List.of("actor"));
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        Object profiles = org.springframework.test.util.ReflectionTestUtils.getField(target, "definitionToolProfiles");
        org.springframework.test.util.ReflectionTestUtils.setField(target, "definitionToolProfiles", List.of("hosted-workspace-mcp/1"));
        try {
            var definition = json.createObjectNode();
            definition.putObject("model");
            definition.put("instructions", "");
            definition.putArray("tools").addObject().put("type", "hosted_profile").put("profile", "hosted-workspace-mcp/1");
            definition.putArray("mcp_servers").addObject().put("server_id", "docs").put("server_revision", 1)
                    .put("definition_digest", "a".repeat(64));
            definition.putObject("permission_policy").put("approval_mode", "default");
            var response = mvc.perform(post("/v1/agents").principal(actor("actor"))
                            .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", "mcp-definition")
                            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(definition)))
                    .andExpect(status().isAccepted()).andReturn();
            String agent = json.readTree(response.getResponse().getContentAsString()).required("id").asText();
            var body = request(agent, List.of());
            body.putArray("extensionPins");
            for (boolean web : List.of(true, false)) {
                submit(body, "unnegotiated-mcp-" + web, web).andExpect(status().isConflict())
                        .andExpect(jsonPath("$.error.code").value("unsupported_feature"));
            }
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=?", Long.class, tenant)).isZero();
            mcpLifecycleSupported = true;
            String session = create(body, "negotiated-mcp", true).required("sessionId").asText();
            assertThat(store.requireSession(tenant, session).toolProfile()).isEqualTo("hosted-workspace-mcp/1");
            assertThat(snapshots.initialSelection(tenant, session).get("extensions")).isEqualTo(List.of());
        } finally {
            org.springframework.test.util.ReflectionTestUtils.setField(target, "definitionToolProfiles", profiles);
        }
    }

    @Test
    void newExtensionShellDefinitionsFreezeChildAdmissionWithoutPromotingOlderOrFilesSessions() throws Exception {
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        Map<String, Object> values = Map.of("workspaceFilesEnabled", true, "workspaceShellEnabled", true,
                "workspaceChildAgentsEnabled", true, "managedExtensionExecutionEnabled", false,
                "definitionToolProfiles", List.of("hosted-workspace-files/1", "hosted-workspace-shell/1"));
        Map<String, Object> previous = new java.util.LinkedHashMap<>();
        for (var entry : values.entrySet()) {
            previous.put(entry.getKey(), org.springframework.test.util.ReflectionTestUtils.getField(target, entry.getKey()));
            org.springframework.test.util.ReflectionTestUtils.setField(target, entry.getKey(), entry.getValue());
        }
        boolean previousManaged = properties.getManagedExtensions().isEnabled();
        try {
            publicChildAgentsSupported = true;
            var definition = json.createObjectNode();
            definition.putObject("model");
            definition.put("instructions", "");
            definition.putArray("tools").addObject().put("type", "hosted_profile").put("profile", "hosted-workspace-shell/1");
            definition.putObject("permission_policy").put("approval_mode", "default");
            var created = mvc.perform(post("/v1/agents").principal(actor("actor"))
                            .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", "shell-definition")
                            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(definition)))
                    .andExpect(status().isAccepted()).andReturn();
            String agent = json.readTree(created.getResponse().getContentAsString()).required("id").asText();
            String legacy = create(request(agent, List.of()), "old-shell", false).required("id").asText();
            assertThat(store.requireSession(tenant, legacy).publicChildAgentsVersion()).isZero();
            properties.getExtensions().setEnabled(true);
            properties.getManagedExtensions().setEnabled(true);
            properties.getExtensions().setArtifactDirectory(archiveDirectory.toString());
            properties.getExtensions().setAllowedActors(List.of("actor"));
            org.springframework.test.util.ReflectionTestUtils.setField(target, "managedExtensionExecutionEnabled", true);
            var selection = request(agent, List.of());
            selection.putArray("extensionPins");
            String selected = create(selection, "extension-shell", false).required("id").asText();
            assertThat(store.requireSession(tenant, selected).publicChildAgentsVersion()).isEqualTo(1);
            assertThat(store.requireSession(tenant, selected).toolProfile()).isEqualTo("hosted-workspace-shell/1");
            assertThat(store.requireSession(tenant, legacy).publicChildAgentsVersion()).isZero();
            ((com.fasterxml.jackson.databind.node.ObjectNode) definition.withArray("tools").get(0)).put("profile", "hosted-workspace-files/1");
            var files = mvc.perform(post("/v1/agents").principal(actor("actor"))
                            .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", "files-definition")
                            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(definition)))
                    .andExpect(status().isAccepted()).andReturn();
            String filesAgent = json.readTree(files.getResponse().getContentAsString()).required("id").asText();
            String filesSession = create(request(filesAgent, List.of()), "files-session", false).required("id").asText();
            assertThat(store.requireSession(tenant, filesSession).publicChildAgentsVersion()).isZero();
        } finally {
            for (var entry : previous.entrySet()) {
                org.springframework.test.util.ReflectionTestUtils.setField(target, entry.getKey(), entry.getValue());
            }
            properties.getManagedExtensions().setEnabled(previousManaged);
            properties.getExtensions().setEnabled(false);
        }
    }

    @Test
    void builtinSnapshotParticipatesInIdempotencyAndMetadataCatalog() throws Exception {
        var body = request("qwen-code", List.of(skill));
        String session = create(body, "key", true).get("sessionId").asText();
        assertThat(create(body, "key", true).get("sessionId").asText()).isEqualTo(session);
        assertThat(snapshots.effective(store.requireSession(tenant, session))).containsExactly(skill);
        mvc.perform(post("/api/agent/web-shell/v1/session-skills/query").principal(actor("actor"))
                        .header(TenantContextFilter.HEADER, tenant).contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsBytes(Map.of("sessionId", session))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.skills[0].name").value("review"))
                .andExpect(jsonPath("$.skills[0].body").doesNotExist());
        ((com.fasterxml.jackson.databind.node.ObjectNode) body.withArray("skills").get(0)).put("body", "CHANGED");
        submit(body, "key", true).andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("idempotency_conflict"));
        sessionSkillsSupported = false;
        create(request("qwen-code", List.of(skill)), "key", true);
        assertThat(snapshots.effective(store.requireSession(tenant, session))).containsExactly(skill);
        jdbc.update("UPDATE ma_request_receipt SET result_json = REPLACE(result_json, 'ORIGINAL_INSTRUCTIONS', 'TAMPERED')"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, session);
        assertThatThrownBy(() -> snapshots.effective(store.requireSession(tenant, session)))
                .hasMessageContaining("snapshot is invalid");
    }

    @Test
    void importsTheFullEnabledCatalogAndPreservesInvocationPolicy() throws Exception {
        var skills = new java.util.ArrayList<Map<String, Object>>();
        for (int i = 0; i < 42; i++) {
            var entry = new java.util.LinkedHashMap<String, Object>();
            entry.put("name", "enabled-" + i);
            entry.put("description", "Enabled Skill");
            entry.put("body", i == 0 ? "x".repeat(404465) : "Instruction");
            if (i == 1) {
                entry.put("model_invocable", false);
            }
            if (i == 2) {
                entry.put("user_invocable", false);
            }
            skills.add(entry);
        }
        String session = create(request("qwen-code", skills), "full-catalog", true).get("sessionId").asText();
        assertThat(snapshots.effective(store.requireSession(tenant, session))).isEqualTo(skills);
        mvc.perform(post("/api/agent/web-shell/v1/session-skills/query").principal(actor("actor"))
                        .header(TenantContextFilter.HEADER, tenant).contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsBytes(Map.of("sessionId", session))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.skills.length()").value(41))
                .andExpect(result -> assertThat(OpenApiContract.load().validate(
                        "/components/schemas/WebShellSessionSkills",
                        json.readTree(result.getResponse().getContentAsString()))).isEmpty());
    }

    @Test
    void customDefinitionMergesAndPinsWithoutChangingItsIdentity() throws Exception {
        var definition = json.createObjectNode();
        definition.putObject("model");
        definition.put("instructions", "");
        definition.putArray("tools").addObject().put("type", "hosted_profile").put("profile", "hosted-workspace-files/1");
        definition.putObject("permission_policy");
        definition.set("skills", json.valueToTree(List.of(Map.of("name", "default", "description", "Default", "body", "DEFAULT"))));
        var created = mvc.perform(post("/v1/agents").principal(actor("actor"))
                        .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", "definition")
                        .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(definition)))
                .andExpect(status().isAccepted()).andReturn();
        var agent = json.readTree(created.getResponse().getContentAsString());
        String session = create(request(agent.get("id").asText(), List.of(skill)), "custom", false).get("id").asText();
        assertThat(snapshots.effective(store.requireSession(tenant, session))).hasSize(2);
        assertThat(store.requireSession(tenant, session).agentDefinitionDigest()).isEqualTo(agent.get("digest").asText());
        var duplicate = Map.<String, Object>of("name", "default", "description", "Duplicate", "body", "duplicate");
        submit(request(agent.get("id").asText(), List.of(duplicate)), "duplicate", false)
                .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?", Long.class, tenant)).isEqualTo(1);
    }

    @Test
    void refusesUnsupportedUnauthorizedAndInvalidRequestsBeforeCreatingAnything() throws Exception {
        var body = request("qwen-code", List.of(skill));
        sessionSkillsSupported = false;
        submit(body, "unsupported", true).andExpect(status().isConflict());
        sessionSkillsSupported = true;
        submit(request("qwen-code", List.of(skill, skill)), "duplicate", true).andExpect(status().isConflict());
        var unbound = request("qwen-code", List.of(skill));
        unbound.remove("workspace");
        submit(unbound, "unbound", true).andExpect(status().isBadRequest());
        mvc.perform(post("/api/agent/web-shell/v1/sessions/create").principal(actor("outsider"))
                        .header(TenantContextFilter.HEADER, tenant).contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsBytes(body.put("idempotencyKey", "outsider"))))
                .andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id = ?", Long.class, tenant)).isZero();
    }

    private void enableBuiltinShell() {
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        previousShellEnabled = (Boolean) org.springframework.test.util.ReflectionTestUtils.getField(target, "workspaceShellEnabled");
        org.springframework.test.util.ReflectionTestUtils.setField(target, "workspaceShellEnabled", true);
    }

    @AfterEach
    void restoreBuiltinShell() {
        if (previousShellEnabled != null) {
            Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
            org.springframework.test.util.ReflectionTestUtils.setField(target, "workspaceShellEnabled", previousShellEnabled);
            previousShellEnabled = null;
        }
    }

    private com.fasterxml.jackson.databind.node.ObjectNode request(String agent, List<Map<String, Object>> skills) {
        var request = json.createObjectNode().put("agentId", agent).put("agent_id", agent);
        request.putArray("input");
        request.putObject("workspace").put("workspaceId", "ws");
        request.set("skills", json.valueToTree(skills));
        return request;
    }

    private JsonNode create(com.fasterxml.jackson.databind.node.ObjectNode body, String key, boolean web) throws Exception {
        return json.readTree(submit(body, key, web).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString());
    }

    private org.springframework.test.web.servlet.ResultActions submit(com.fasterxml.jackson.databind.node.ObjectNode body,
            String key, boolean web) throws Exception {
        var value = body.deepCopy();
        value.remove(web ? "agent_id" : "agentId");
        if (web) {
            value.put("idempotencyKey", key);
        } else if (value.has("workspace")) {
            value.withObject("workspace").remove("workspaceId");
            value.withObject("workspace").put("workspace_id", "ws");
        }
        return mvc.perform(post(web ? "/api/agent/web-shell/v1/sessions/create" : "/v1/agents/sessions")
                .principal(actor("actor")).header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(value)));
    }

    private AuthenticatedTenantActor actor(String id) {
        return new AuthenticatedTenantActor() {
            @Override public String tenantId() { return tenant; }
            @Override public String actorId() { return id; }
            @Override public String getName() { return id; }
        };
    }
}
