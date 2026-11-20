package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedSkillCatalogSource;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackageService;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
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

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Answers.RETURNS_DEFAULTS;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
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
    @Autowired private JdbcManagedSessionSkills snapshots;
    @Autowired private com.alibaba.qwen.code.managedagent.persistence.JdbcChildWorkspaceStore childWorkspaces;
    @Autowired private ManagedAgentProperties properties;
    @Autowired private ManagedExtensionPackageService extensionPackages;
    @Autowired private ManagedAgentService sessions;
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
    private ManagedSkillCatalogSource catalogSource;
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
    void sourceImportFreezesAdmissionAndReplaysCreationAfterRevocation() throws Exception {
        enableBuiltinShell();
        properties.getExtensions().setEnabled(true);
        properties.getExtensions().setSelfServiceEnabled(true);
        properties.getExtensions().setArtifactDirectory(archiveDirectory.toString());
        properties.getExtensions().setAllowedActors(List.of("actor"));
        var source = mock(com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource.class);
        org.mockito.Mockito.when(source.id()).thenReturn("business");
        org.mockito.Mockito.when(source.resolve(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any())).thenAnswer(call -> {
            assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            return new com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource.Resolved(call.getArgument(1), "private/archive", null);
        });
        org.mockito.Mockito.when(source.open(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                .thenAnswer(call -> new java.io.ByteArrayInputStream("skill ZIP".getBytes(StandardCharsets.UTF_8)));
        var preparation = mock(HarnessConnector.class);
        org.mockito.Mockito.when(preparation.supportsPackagePreparation()).thenReturn(true);
        byte[] archive = "compiled bytes".getBytes(StandardCharsets.UTF_8);
        var manifest = new ManagedExtensionPackages.Manifest(1, 1, "source-skill", "1", new ManagedExtensionPackages.Target("linux", "any"), List.of("skills"));
        org.mockito.Mockito.when(preparation.preparePackage(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                .thenAnswer(call -> new HarnessConnector.PreparedPackage(Map.of("manifest", manifest,
                        "packageDigest", org.apache.commons.codec.digest.DigestUtils.sha256Hex(archive)), new java.io.ByteArrayInputStream(archive)));
        extensionPackages.configureSources(List.of(source));
        extensionPackages.configurePreparation(preparation);
        try {
            var command = new ManagedExtensionPackages.SourceImport(
                    new com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource.Reference("business", "skill", "skill_1", "1"), manifest.target());
            var response = mvc.perform(post("/v1/agents/workspaces/ws/extensions/source-imports").principal(actor("actor"))
                            .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", "source-import")
                            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(command)))
                    .andExpect(status().isOk()).andExpect(jsonPath("$.state").value("settled")).andReturn();
            var pin = json.readTree(response.getResponse().getContentAsString()).required("pin");
            var body = request("qwen-code", List.of());
            body.putArray("extensionPins").add(pin);
            String session = create(body, "source-session", true).required("sessionId").asText();
            org.mockito.Mockito.doThrow(new com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource.Failure(
                    com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource.Failure.Reason.NOT_FOUND, null))
                    .when(source).resolve(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
            assertThat(create(body, "source-session", true).required("sessionId").asText()).isEqualTo(session);
            submit(body, "new-source-session", true).andExpect(status().isNotFound());
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=?", Long.class, tenant)).isEqualTo(1);
        } finally {
            extensionPackages.configureSources(List.of());
            extensionPackages.configurePreparation(harness);
            properties.getExtensions().setSelfServiceEnabled(false);
        }
    }

    @Test
    void catalogDefaultsArePinnedAcrossRevisionChangesAndRevocation() throws Exception {
        configureSkillCatalog();
        var body = request("qwen-code", List.of());
        body.remove("skills");
        when(catalogSource.catalog(any())).thenReturn(List.of(catalogEntry("1", true), catalogEntry("unused", false)));
        String first = create(body, "default-one", true).required("sessionId").asText();
        JsonNode firstPins = json.valueToTree(snapshots.initialSelection(tenant, first).get("extensions"));
        assertThat(firstPins.size()).isEqualTo(1);
        assertThat(firstPins.get(0).required("packageDigest").asText())
                .isEqualTo(org.apache.commons.codec.digest.DigestUtils.sha256Hex("1"));
        assertThat(snapshots.snapshot(tenant, first)).isNull();
        assertThat(sessionSkillCatalog(first)).isEqualTo(json.valueToTree(List.of(
                Map.of("name", "review:review", "description", "Review changes 1"))));

        when(catalogSource.catalog(any())).thenReturn(List.of(catalogEntry("2", true)));
        String second = create(request("qwen-code", List.of()), "default-two", false).required("id").asText();
        JsonNode secondPins = json.valueToTree(snapshots.initialSelection(tenant, second).get("extensions"));
        assertThat(secondPins.get(0).required("packageDigest").asText())
                .isEqualTo(org.apache.commons.codec.digest.DigestUtils.sha256Hex("2"));
        assertThat(sessionSkillCatalog(second).get(0).required("description").asText()).isEqualTo("Review changes 2");
        assertThat(sessionSkillCatalog(first).get(0).required("description").asText()).isEqualTo("Review changes 1");

        when(catalogSource.resolve(any(), any())).thenThrow(new ManagedExtensionSource.Failure(
                ManagedExtensionSource.Failure.Reason.NOT_FOUND, null));
        submit(body, "revoked", true).andExpect(status().isNotFound());
        when(catalogSource.catalog(any())).thenThrow(new java.io.IOException("catalog unavailable"));
        assertThat(create(body, "default-one", true).required("sessionId").asText()).isEqualTo(first);
        assertThat(sessionSkillCatalog(first).get(0).required("description").asText()).isEqualTo("Review changes 1");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=?", Integer.class, tenant)).isEqualTo(2);
    }

    @Test
    void catalogDefaultsRespectExplicitSelectionsAndProviderScope() throws Exception {
        configureSkillCatalog();
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'ws', ?, 'OPERATOR')",
                tenant, "teammate".getBytes(StandardCharsets.UTF_8));
        var hidden = catalogEntry("hidden", true);
        var optional = catalogEntry("optional", false);
        when(catalogSource.catalog(any())).thenReturn(List.of(hidden, catalogEntry("another-revision", true)));
        submit(request("qwen-code", List.of()), "conflicting-defaults", true).andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("extension_source_invalid"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=?", Integer.class, tenant)).isZero();
        when(catalogSource.catalog(any())).thenAnswer(call -> {
            ManagedExtensionSource.Context context = call.getArgument(0);
            assertThat(context.tenantId()).isEqualTo(tenant);
            assertThat(context.workspaceId()).isEqualTo("ws");
            assertThat(context.requestId()).isNotBlank();
            context.checkDeadline();
            assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            return switch (context.actorId()) {
                case "actor" -> List.of(hidden, optional);
                case "teammate" -> List.of(optional);
                default -> throw new AssertionError(context.actorId());
            };
        });
        assertThat(extensionPackages.skillCatalog(tenant, "teammate", "ws", "discovery")).containsExactly(optional);
        String modelOnly = create(request("qwen-code", List.of()), "hidden-default", true).required("sessionId").asText();
        assertThat(snapshots.initialSelection(tenant, modelOnly).get("extensions")).asList().hasSize(1);
        assertThat(sessionSkillCatalog(modelOnly).size()).isZero();

        org.mockito.Mockito.doThrow(new AssertionError("explicit selections must skip discovery")).when(catalogSource).catalog(any());
        var emptyPins = request("qwen-code", List.of());
        emptyPins.putArray("extensionPins");
        String optedOut = create(emptyPins, "explicit-pins", true).required("sessionId").asText();
        assertThat(snapshots.initialSelection(tenant, optedOut).get("extensions")).isEqualTo(List.of());
        String explicit = create(request("qwen-code", List.of(skill)), "explicit-skills", true).required("sessionId").asText();
        assertThat(snapshots.effective(store.requireSession(tenant, explicit))).containsExactly(skill);
        assertThat(snapshots.initialSelection(tenant, explicit)).isNull();

        extensionPackages.configureSources(List.of());
        String ordinary = create(request("qwen-code", List.of()), "no-provider", true).required("sessionId").asText();
        assertThat(snapshots.initialSelection(tenant, ordinary)).isNull();
        assertThat(sessionSkillCatalog(ordinary).size()).isZero();
    }

    @Test
    void rejectsDefaultSkillThatConflictsWithThePinnedAgentBeforeAdmission() throws Exception {
        configureSkillCatalog();
        when(catalogSource.catalog(any())).thenReturn(List.of(catalogEntry("1", true)));
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        Object profiles = VerificationFixtures.agentStoreField(target, "definitionToolProfiles");
        VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", List.of("hosted-workspace-shell/1"));
        try {
            String agent = defineProfile("hosted-workspace-shell/1", "custom-shell",
                    List.of(Map.of("name", "review:review", "description", "Local review", "body", "Read")));
            submit(request(agent, List.of()), "conflicting-name", true).andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code").value("extension_skill_unavailable"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=?", Long.class, tenant)).isZero();
        } finally {
            VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", profiles);
        }
    }

    @Test
    void refusesAnOversizedCombinedSkillCatalogBeforeCreatingTheSession() throws Exception {
        var preparer = configureSkillCatalog();
        var target = new ManagedExtensionPackages.Target("linux", "any");
        var defaults = java.util.stream.IntStream.range(0, 6).mapToObj(index -> {
            String name = "capacity-" + index;
            return new ManagedSkillCatalogSource.Entry(new ManagedExtensionSource.Reference("business", "skill", name, name),
                    target, name, "Capacity test", true);
        }).toList();
        org.mockito.Mockito.doAnswer(call -> {
            InputStream input = call.getArgument(1);
            byte[] archive = input.readAllBytes();
            String name = new String(archive, StandardCharsets.UTF_8);
            var manifest = new ManagedExtensionPackages.Manifest(1, 1, name, "1.0.0", target, List.of("skills"));
            var skill = compiledSkill(name, "Capacity test", "x".repeat(400 * 1024), true);
            return new HarnessConnector.PreparedPackage(Map.of("manifest", manifest, "standaloneSkill", skill,
                    "packageDigest", org.apache.commons.codec.digest.DigestUtils.sha256Hex(archive)), new ByteArrayInputStream(archive));
        }).when(preparer).preparePackage(any(), any());

        var body = request("qwen-code", List.of());
        when(catalogSource.catalog(any())).thenReturn(defaults.subList(0, 5));
        String session = create(body, "five-defaults", true).required("sessionId").asText();
        var pins = snapshots.initialSelection(tenant, session).get("extensions");
        assertThat(pins).asList().hasSize(5);
        when(catalogSource.catalog(any())).thenReturn(defaults);
        submit(body, "six-defaults", true).andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("extension_skill_unavailable"));

        var mixed = request("qwen-code", List.of(Map.of("name", "base", "description", "Base", "body", "y".repeat(50 * 1024))));
        mixed.set("extensionPins", json.valueToTree(pins));
        submit(mixed, "five-plus-static", true).andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("extension_skill_unavailable"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=?", Integer.class, tenant)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE tenant_id=? AND namespace='SESSION_CREATE_ACTOR'",
                Integer.class, tenant)).isEqualTo(1);
    }

    @Test
    void retryAfterHarnessUpgradeCanPublishAPreviouslyUnsupportedDefault() throws Exception {
        var current = configureSkillCatalog();
        var entry = catalogEntry("1", true);
        when(catalogSource.catalog(any())).thenReturn(List.of(entry));
        var legacy = mock(HarnessConnector.class);
        when(legacy.supportsPackagePreparation()).thenReturn(true);
        when(legacy.preparePackage(any(), any())).thenAnswer(call -> {
            var manifest = new ManagedExtensionPackages.Manifest(1, 1, "review", "1.0.0", entry.target(), List.of("skills"));
            byte[] archive = "1".getBytes(StandardCharsets.UTF_8);
            return new HarnessConnector.PreparedPackage(Map.of("manifest", manifest,
                    "packageDigest", org.apache.commons.codec.digest.DigestUtils.sha256Hex(archive)), new ByteArrayInputStream(archive));
        });
        extensionPackages.configurePreparation(legacy);
        var body = request("qwen-code", List.of());
        submit(body, "upgrade", true).andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_package WHERE tenant_id=?", Integer.class, tenant)).isZero();
        extensionPackages.configurePreparation(current);
        String id = create(body, "upgrade", true).required("sessionId").asText();
        assertThat(sessionSkillCatalog(id).get(0).required("name").textValue()).isEqualTo("review:review");
    }

    @Test
    void filesProfileSkipsDefaultDiscoveryWithoutPackageWrites() throws Exception {
        configureSkillCatalog(false);
        org.mockito.Mockito.doThrow(new AssertionError("FILES creations must skip discovery")).when(catalogSource).catalog(any());
        var body = request("qwen-code", List.of());
        body.remove("skills");
        String id = create(body, "files-default", true).required("sessionId").asText();
        assertThat(store.requireSession(tenant, id).toolProfile()).isEqualTo("hosted-workspace-files/1");
        assertThat(snapshots.initialSelection(tenant, id)).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_package WHERE tenant_id=?", Integer.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_source_import WHERE tenant_id=?", Integer.class, tenant)).isZero();
    }

    @Test
    void disabledSelfServiceSkipsDefaultDiscovery() throws Exception {
        configureSkillCatalog();
        properties.getExtensions().setSelfServiceEnabled(false);
        org.mockito.Mockito.doThrow(new AssertionError("unsupported imports must skip discovery")).when(catalogSource).catalog(any());
        var body = request("qwen-code", List.of());
        body.remove("skills");
        String id = create(body, "self-service-off", true).required("sessionId").asText();
        assertThat(snapshots.initialSelection(tenant, id)).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_package WHERE tenant_id=?", Integer.class, tenant)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_source_import WHERE tenant_id=?", Integer.class, tenant)).isZero();
    }

    @Test
    void emptyDefaultsKeepTheOmittedWorkspaceSelection() throws Exception {
        configureSkillCatalog();
        jdbc.update("UPDATE ma_workspace SET is_default = TRUE WHERE tenant_id = ? AND workspace_id = ?",
                tenant.getBytes(StandardCharsets.UTF_8), "ws".getBytes(StandardCharsets.UTF_8));
        when(catalogSource.catalog(any())).thenReturn(List.of(catalogEntry("optional", false)));
        var admitted = sessions.createWorkspaceSession(tenant, "actor", "empty-defaults",
                "qwen-code", null, null, null, List.of(), null, null);
        assertThat(store.requireSession(tenant, admitted.sessionId()).workspace().getWorkspaceId()).isEqualTo("ws");
        assertThat(snapshots.initialSelection(tenant, admitted.sessionId())).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_extension_package WHERE tenant_id=?", Integer.class, tenant)).isZero();
    }

    private ManagedSkillCatalogSource.Entry catalogEntry(String revision, boolean preinstall) {
        var reference = new ManagedExtensionSource.Reference("business", "skill",
                preinstall ? "review" : "optional", revision);
        return new ManagedSkillCatalogSource.Entry(reference, new ManagedExtensionPackages.Target("linux", "any"),
                reference.resourceId(), "Business catalog " + revision, preinstall);
    }

    private JsonNode sessionSkillCatalog(String session) throws Exception {
        var response = mvc.perform(post("/api/agent/web-shell/v1/session-skills/query").principal(actor("actor"))
                        .header(TenantContextFilter.HEADER, tenant).contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsBytes(Map.of("sessionId", session))))
                .andExpect(status().isOk()).andReturn();
        return json.readTree(response.getResponse().getContentAsString()).required("skills");
    }

    private HarnessConnector configureSkillCatalog() throws Exception {
        return configureSkillCatalog(true);
    }

    private HarnessConnector configureSkillCatalog(boolean shell) throws Exception {
        if (shell) {
            enableBuiltinShell();
        }
        properties.getExtensions().setEnabled(true);
        properties.getExtensions().setSelfServiceEnabled(true);
        properties.getExtensions().setArtifactDirectory(archiveDirectory.toString());
        properties.getExtensions().setAllowedActors(List.of("actor", "teammate"));
        catalogSource = mock(ManagedSkillCatalogSource.class);
        when(catalogSource.id()).thenReturn("business");
        when(catalogSource.resolve(any(), any())).thenAnswer(call ->
                new ManagedExtensionSource.Resolved(call.getArgument(1), "private/archive", null));
        when(catalogSource.open(any(), any())).thenAnswer(call -> {
            ManagedExtensionSource.Resolved resolved = call.getArgument(1);
            return new ByteArrayInputStream(resolved.reference().revision().getBytes(StandardCharsets.UTF_8));
        });
        var preparer = mock(HarnessConnector.class);
        when(preparer.supportsPackagePreparation()).thenReturn(true);
        when(preparer.preparePackage(any(), any())).thenAnswer(call -> {
            InputStream input = call.getArgument(1);
            byte[] archive = input.readAllBytes();
            String revision = new String(archive, StandardCharsets.UTF_8);
            var manifest = new ManagedExtensionPackages.Manifest(1, 1, "review", "1.0.0",
                    new ManagedExtensionPackages.Target("linux", "any"), List.of("skills"));
            var metadata = compiledSkill("review", "Review changes " + revision, "Review this change.", !"hidden".equals(revision));
            return new HarnessConnector.PreparedPackage(Map.of("manifest", manifest, "standaloneSkill", metadata,
                    "packageDigest", org.apache.commons.codec.digest.DigestUtils.sha256Hex(archive)), new ByteArrayInputStream(archive));
        });
        extensionPackages.configureSources(List.of(catalogSource));
        extensionPackages.configurePreparation(preparer);
        return preparer;
    }

    private ManagedExtensionPackages.StandaloneSkill compiledSkill(String name, String description, String body, boolean userInvocable)
            throws com.fasterxml.jackson.core.JsonProcessingException {
        String qualified = name + ":" + name;
        var entry = Map.of("name", qualified, "description", description, "body", body, "model_invocable", true,
                "user_invocable", userInvocable, "asset_directory", "extension://ext_00000000-0000-4000-8000-000000000000/skills/" + name + "/");
        int catalogEntryBytes = json.writeValueAsString(entry).getBytes(StandardCharsets.UTF_8).length;
        return new ManagedExtensionPackages.StandaloneSkill(qualified, description, userInvocable, catalogEntryBytes);
    }

    @AfterEach
    void restoreSkillCatalog() {
        if (catalogSource != null) {
            extensionPackages.configureSources(List.of());
            extensionPackages.configurePreparation(harness);
            properties.getExtensions().setSelfServiceEnabled(false);
        }
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
        Object profiles = com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, "definitionToolProfiles");
        com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", List.of("hosted-workspace-mcp/1"));
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
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", profiles);
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
            previous.put(entry.getKey(), com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, entry.getKey()));
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, entry.getKey(), entry.getValue());
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
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "managedExtensionExecutionEnabled", true);
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
                com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, entry.getKey(), entry.getValue());
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
                .hasMessageContaining("snapshot is invalid")
                .extracting(error -> ((com.alibaba.qwen.code.managedagent.exception.ManagedAgentException) error).getCode())
                .isEqualTo("session_skills_conflict");
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
    void injectsTheManagedLoopSkillByProfileEvenWithNoCallerSkills() throws Exception {
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        Object previousProfiles = com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, "definitionToolProfiles");
        com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles",
                List.of("hosted-workspace-files/1", "hosted-workspace-files/4"));
        try {
            // A cron-only profile (files/4) with an empty caller catalog still
            // receives the server loop skill.
            String cronAgent = defineProfile("hosted-workspace-files/4", "cron-loop-agent", List.of());
            String cronSession = create(request(cronAgent, List.of()), "cron-loop", false).get("id").asText();
            var cronCatalog = snapshots.effective(store.requireSession(tenant, cronSession));
            assertThat(cronCatalog).hasSize(1);
            assertThat(cronCatalog.getFirst().get("name")).isEqualTo("loop");
            assertThat((String) cronCatalog.getFirst().get("body"))
                    .contains("CronCreate").doesNotContain("LoopWakeup");
            // Replay reproduces the same session and the same injected catalog.
            assertThat(create(request(cronAgent, List.of()), "cron-loop", false).get("id").asText())
                    .isEqualTo(cronSession);
            assertThat(snapshots.effective(store.requireSession(tenant, cronSession))).isEqualTo(cronCatalog);
            // A profile with no loop creator receives no loop skill.
            String filesAgent = defineProfile("hosted-workspace-files/1", "files-no-loop", List.of());
            String filesSession = create(request(filesAgent, List.of()), "files-no-loop", false).get("id").asText();
            assertThat(snapshots.effective(store.requireSession(tenant, filesSession))).isEmpty();
            // The Web Shell imports the bundled "loop" verbatim; the authoritative
            // server variant replaces it rather than refusing the creation.
            var localLoop = Map.<String, Object>of("name", "loop", "description", "Local", "body", bundledLoopBody());
            String overrideSession = create(request(cronAgent, List.of(localLoop)), "override-loop", false).get("id").asText();
            var overrideCatalog = snapshots.effective(store.requireSession(tenant, overrideSession));
            assertThat(overrideCatalog).hasSize(1);
            assertThat(overrideCatalog.getFirst().get("name")).isEqualTo("loop");
            assertThat((String) overrideCatalog.getFirst().get("body")).contains("CronCreate").doesNotContain("LOCAL");
            // A pinned definition with stored skills plus an empty caller catalog
            // keeps its own skills alongside the injected loop (no shadowing).
            var storedSkill = Map.<String, Object>of("name", "default", "description", "Default", "body", "DEFAULT");
            String defAgent = defineProfile("hosted-workspace-files/4", "def-with-skills", List.of(storedSkill));
            String defSession = create(request(defAgent, List.of()), "def-skills-loop", false).get("id").asText();
            var defCatalog = snapshots.effective(store.requireSession(tenant, defSession));
            assertThat(defCatalog).extracting(s -> s.get("name")).containsExactlyInAnyOrder("default", "loop");
            // Without the negotiated Session Skills capability the server injects
            // nothing and writes no row, keeping the creation-time behavior.
            sessionSkillsSupported = false;
            String gatedSession = create(request(cronAgent, List.of()), "gated-loop", false).get("id").asText();
            assertThat(snapshots.snapshot(tenant, gatedSession)).isNull();
            sessionSkillsSupported = true;
        } finally {
            sessionSkillsSupported = true;
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", previousProfiles);
        }
    }

    @Test
    void injectionStripsCallerImportedLoopOnCreatorLessProfiles() throws Exception {
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        Object previousProfiles = com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, "definitionToolProfiles");
        com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles",
                List.of("hosted-workspace-files/1", "hosted-workspace-files/4"));
        try {
            // A creator-less profile strips a caller-imported bundled loop so it
            // never publishes a body naming tools the profile lacks.
            String filesAgent = defineProfile("hosted-workspace-files/1", "strip-agent", List.of());
            var localLoop = Map.<String, Object>of("name", "loop", "description", "Local", "body", bundledLoopBody());
            String stripSession = create(request(filesAgent, List.of(localLoop)), "strip-loop", false).get("id").asText();
            assertThat(snapshots.effective(store.requireSession(tenant, stripSession))).isEmpty();
        } finally {
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", previousProfiles);
        }
    }

    @Test
    void aUserAuthoredCallerLoopIsPreservedNotReplacedOrDropped() throws Exception {
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        Object previousProfiles = com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, "definitionToolProfiles");
        com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles",
                List.of("hosted-workspace-files/1", "hosted-workspace-files/4"));
        try {
            // A caller loop whose body is not the bundled import is user-authored:
            // it is preserved on a creator-bearing profile (no server variant) and
            // on a creator-less profile (only the bundled import would be dropped).
            var userLoop = Map.<String, Object>of("name", "loop", "description", "Mine", "body", "MY_CUSTOM_LOOP_BODY");
            String cronAgent = defineProfile("hosted-workspace-files/4", "user-loop-cron", List.of());
            String cronSession = create(request(cronAgent, List.of(userLoop)), "user-loop-cron", false).get("id").asText();
            var cronCatalog = snapshots.snapshot(tenant, cronSession);
            assertThat(cronCatalog).extracting(s -> s.get("name")).containsExactly("loop");
            assertThat(loopBody(cronCatalog)).isEqualTo("MY_CUSTOM_LOOP_BODY");
            String filesAgent = defineProfile("hosted-workspace-files/1", "user-loop-files", List.of());
            String filesSession = create(request(filesAgent, List.of(userLoop)), "user-loop-files", false).get("id").asText();
            var filesCatalog = snapshots.snapshot(tenant, filesSession);
            assertThat(filesCatalog).extracting(s -> s.get("name")).containsExactly("loop");
            assertThat(loopBody(filesCatalog)).isEqualTo("MY_CUSTOM_LOOP_BODY");
        } finally {
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", previousProfiles);
        }
    }

    @Test
    void aDefinitionAuthoredLoopSkillSurvivesAdmission() throws Exception {
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        Object previousProfiles = com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, "definitionToolProfiles");
        com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles",
                List.of("hosted-workspace-files/1", "hosted-workspace-files/4"));
        try {
            // A definition-authored loop is the author's artifact: the server neither
            // drops it on a creator-less profile nor replaces it on a creator-bearing one.
            // A caller skill forces a persisted row, so the assertion reads the saved
            // catalog (snapshot), not the definition fallback (effective).
            var defLoop = Map.<String, Object>of("name", "loop", "description", "Definition loop", "body", "DEFINITION_LOOP_BODY");
            var callerSkill = Map.<String, Object>of("name", "review", "description", "Caller", "body", "CALLER_BODY");
            String filesAgent = defineProfile("hosted-workspace-files/1", "def-loop-files", List.of(defLoop));
            String filesSession = create(request(filesAgent, List.of(callerSkill)), "def-loop-files", false).get("id").asText();
            var filesCatalog = snapshots.snapshot(tenant, filesSession);
            assertThat(filesCatalog).extracting(s -> s.get("name")).containsExactlyInAnyOrder("loop", "review");
            assertThat(loopBody(filesCatalog)).isEqualTo("DEFINITION_LOOP_BODY");
            String cronAgent = defineProfile("hosted-workspace-files/4", "def-loop-cron", List.of(defLoop));
            String cronSession = create(request(cronAgent, List.of(callerSkill)), "def-loop-cron", false).get("id").asText();
            var cronCatalog = snapshots.snapshot(tenant, cronSession);
            assertThat(cronCatalog).extracting(s -> s.get("name")).containsExactlyInAnyOrder("loop", "review");
            assertThat(loopBody(cronCatalog)).isEqualTo("DEFINITION_LOOP_BODY");
        } finally {
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", previousProfiles);
        }
    }

    @Test
    void overCapacityCreationDropsTheBundledLoopAndStillSucceeds() throws Exception {
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        Object previousProfiles = com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, "definitionToolProfiles");
        com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles",
                List.of("hosted-workspace-files/4"));
        try {
            // A definition skill plus a full caller catalog (255 + the bundled loop)
            // puts the merged catalog over the entry cap once the variant is added.
            // The creation must still succeed: the bundled import is dropped rather
            // than restored, leaving a within-cap catalog the admission accepts.
            var defSkill = Map.<String, Object>of("name", "default", "description", "Default", "body", "DEFAULT");
            String agent = defineProfile("hosted-workspace-files/4", "over-cap-agent", List.of(defSkill));
            var caller = new java.util.ArrayList<Map<String, Object>>();
            for (int i = 0; i < 255; i++) {
                caller.add(Map.of("name", "s" + i, "description", "d", "body", "b"));
            }
            caller.add(Map.<String, Object>of("name", "loop", "description", "Local", "body", bundledLoopBody()));
            String session = create(request(agent, caller), "over-cap", false).get("id").asText();
            var catalog = snapshots.snapshot(tenant, session);
            assertThat(catalog).hasSize(256);
            assertThat(catalog).extracting(s -> s.get("name")).doesNotContain("loop");
        } finally {
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", previousProfiles);
        }
    }

    private static String loopBody(List<Map<String, Object>> catalog) {
        return (String) catalog.stream().filter(s -> "loop".equals(s.get("name")))
                .findFirst().orElseThrow().get("body");
    }

    /** The verbatim bundled loop body the Web Shell imports (the only caller loop
     * the server may replace); read from the committed reference sidecar. */
    private static String bundledLoopBody() throws Exception {
        try (InputStream stream = ManagedSessionCreationSkillsTest.class
                .getResourceAsStream("/contracts/managed-loop-skill-bundled-body.json")) {
            assertThat(stream).isNotNull();
            return (String) new ObjectMapper()
                    .readValue(new String(stream.readAllBytes(), StandardCharsets.UTF_8), Map.class)
                    .get("body");
        }
    }

    @Test
    void aSnapshotChildReselectsTheLoopByItsOwnProfile() throws Exception {
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        Object previousProfiles = com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, "definitionToolProfiles");
        com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles",
                List.of("hosted-workspace-files/4"));
        try {
            // A creator-bearing parent with a caller skill persists the server loop.
            String agent = defineProfile("hosted-workspace-files/4", "snap-parent-agent", List.of());
            var callerSkill = Map.<String, Object>of("name", "review", "description", "d", "body", "CALLER");
            String parent = create(request(agent, List.of(callerSkill)), "snap-parent", false).get("id").asText();
            assertThat(snapshots.snapshot(tenant, parent)).extracting(s -> s.get("name")).contains("loop");
            String childCwd = ".qwen-child-workspaces/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            readySnapshotChildWorkspace(parent, "run-snap", childCwd);
            var lineage = new com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage(parent, parent, "run-snap", 1);
            var child = store.insertChildSessionCommand(tenant, parent, UUID.randomUUID().toString(),
                    "snap-child-digest", "audit", List.of(), null, lineage, childCwd);
            assertThat(store.requireSession(tenant, child.sessionId()).toolProfile()).isEqualTo("hosted-workspace-read/1");
            // The READ child drops the server loop; the caller skill inherits.
            assertThat(snapshots.snapshot(tenant, child.sessionId()))
                    .extracting(s -> s.get("name")).containsExactly("review");

            // A loop-only parent (empty caller) resolves to no child row at all.
            String loopAgent = defineProfile("hosted-workspace-files/4", "snap-loopy-agent", List.of());
            String loopParent = create(request(loopAgent, List.of()), "snap-loopy-parent", false).get("id").asText();
            assertThat(snapshots.snapshot(tenant, loopParent)).extracting(s -> s.get("name")).containsExactly("loop");
            String childCwd2 = ".qwen-child-workspaces/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            readySnapshotChildWorkspace(loopParent, "run-snap-2", childCwd2);
            var child2 = store.insertChildSessionCommand(tenant, loopParent, UUID.randomUUID().toString(),
                    "snap-child-digest-2", "audit", List.of(), null,
                    new com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage(loopParent, loopParent, "run-snap-2", 1), childCwd2);
            assertThat(snapshots.snapshot(tenant, child2.sessionId())).isNull();

            // A parent definition that OWNS a loop: the READ child inherits that
            // definition-authored loop (parentDefinitionHasLoop=true), unlike the
            // server variant above which the READ child drops. Forcing the flag to
            // false loses the definition loop here and reddens this case.
            var defLoop = Map.<String, Object>of("name", "loop", "description", "def", "body", "DEFINITION_LOOP_BODY");
            String defLoopAgent = defineProfile("hosted-workspace-files/4", "snap-defloop-agent", List.of(defLoop));
            String defLoopParent = create(request(defLoopAgent, List.of(callerSkill)), "snap-defloop-parent", false).get("id").asText();
            assertThat(snapshots.snapshot(tenant, defLoopParent))
                    .extracting(s -> s.get("name")).containsExactlyInAnyOrder("loop", "review");
            String childCwd3 = ".qwen-child-workspaces/cccccccccccccccccccccccccccccccc";
            readySnapshotChildWorkspace(defLoopParent, "run-snap-3", childCwd3);
            var child3 = store.insertChildSessionCommand(tenant, defLoopParent, UUID.randomUUID().toString(),
                    "snap-child-digest-3", "audit", List.of(), null,
                    new com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage(defLoopParent, defLoopParent, "run-snap-3", 1), childCwd3);
            var child3Catalog = snapshots.snapshot(tenant, child3.sessionId());
            assertThat(child3Catalog).extracting(s -> s.get("name")).containsExactlyInAnyOrder("loop", "review");
            assertThat(loopBody(child3Catalog)).isEqualTo("DEFINITION_LOOP_BODY");

            // R7-1: a parent whose only loop is a user-authored caller skill (the
            // definition owns none) must pass that loop into the READ snapshot
            // child, not delete it by name.
            var userLoop = Map.<String, Object>of("name", "loop", "description", "mine", "body", "MY_CUSTOM_LOOP_BODY");
            String userLoopAgent = defineProfile("hosted-workspace-files/4", "snap-userloop-agent", List.of());
            String userLoopParent = create(request(userLoopAgent, List.of(userLoop)), "snap-userloop-parent", false).get("id").asText();
            assertThat(loopBody(snapshots.snapshot(tenant, userLoopParent))).isEqualTo("MY_CUSTOM_LOOP_BODY");
            String childCwd4 = ".qwen-child-workspaces/dddddddddddddddddddddddddddddddd";
            readySnapshotChildWorkspace(userLoopParent, "run-snap-4", childCwd4);
            var child4 = store.insertChildSessionCommand(tenant, userLoopParent, UUID.randomUUID().toString(),
                    "snap-child-digest-4", "audit", List.of(), null,
                    new com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage(userLoopParent, userLoopParent, "run-snap-4", 1), childCwd4);
            var child4Catalog = snapshots.snapshot(tenant, child4.sessionId());
            assertThat(child4Catalog).extracting(s -> s.get("name")).containsExactly("loop");
            assertThat(loopBody(child4Catalog)).isEqualTo("MY_CUSTOM_LOOP_BODY");
        } finally {
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", previousProfiles);
        }
    }

    @Test
    void serverLoopProvenanceMarkerRoundTripsThroughTheSnapshot() throws Exception {
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
        Object previousProfiles = com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, "definitionToolProfiles");
        com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles",
                List.of("hosted-workspace-files/4"));
        try {
            // R3-1: an injected server variant records the provenance marker in the
            // snapshot; a user-authored caller loop does not. The READ child drops the
            // former by marker (even if its body were superseded) and keeps the latter.
            String agent = defineProfile("hosted-workspace-files/4", "marker-agent", List.of());
            String injectedParent = create(request(agent, List.of()), "marker-injected", false).get("id").asText();
            assertThat(snapshots.serverLoopInjected(tenant, injectedParent)).isTrue();
            var userLoop = Map.<String, Object>of("name", "loop", "description", "mine", "body", "MY_CUSTOM_LOOP_BODY");
            String userAgent = defineProfile("hosted-workspace-files/4", "marker-user-agent", List.of());
            String userParent = create(request(userAgent, List.of(userLoop)), "marker-user", false).get("id").asText();
            assertThat(snapshots.serverLoopInjected(tenant, userParent)).isFalse();
            // READ child of the injected parent: the server loop is dropped by marker.
            String cwdA = ".qwen-child-workspaces/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
            readySnapshotChildWorkspace(injectedParent, "run-marker-a", cwdA);
            var childA = store.insertChildSessionCommand(tenant, injectedParent, UUID.randomUUID().toString(),
                    "marker-child-a", "audit", List.of(), null,
                    new com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage(injectedParent, injectedParent, "run-marker-a", 1), cwdA);
            assertThat(snapshots.snapshot(tenant, childA.sessionId())).isNull();
            // READ child of the user-loop parent: the user loop is kept.
            String cwdB = ".qwen-child-workspaces/ffffffffffffffffffffffffffffffff";
            readySnapshotChildWorkspace(userParent, "run-marker-b", cwdB);
            var childB = store.insertChildSessionCommand(tenant, userParent, UUID.randomUUID().toString(),
                    "marker-child-b", "audit", List.of(), null,
                    new com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage(userParent, userParent, "run-marker-b", 1), cwdB);
            assertThat(loopBody(snapshots.snapshot(tenant, childB.sessionId()))).isEqualTo("MY_CUSTOM_LOOP_BODY");
        } finally {
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "definitionToolProfiles", previousProfiles);
        }
    }

    private void readySnapshotChildWorkspace(String parent, String run, String childCwd) {
        var parentBinding = store.requireSession(tenant, parent).workspace();
        childWorkspaces.admit(tenant, parent, run, parentBinding,
                com.alibaba.qwen.code.managedagent.persistence.JdbcChildWorkspaceStore.SNAPSHOT, System.currentTimeMillis());
        jdbc.update("UPDATE ma_workspace SET child_state = 'ready', child_cwd_relative = ?"
                        + " WHERE tenant_id = ? AND parent_session_id = ? AND child_run_id = ? AND workspace_kind = 'CHILD_GIT'",
                childCwd, tenant, parent, run);
    }

    private String defineProfile(String profile, String key, List<Map<String, Object>> skills) throws Exception {
        var definition = json.createObjectNode();
        definition.putObject("model");
        definition.put("instructions", "");
        definition.putArray("tools").addObject().put("type", "hosted_profile").put("profile", profile);
        definition.putObject("permission_policy").put("approval_mode", "default");
        if (!skills.isEmpty()) {
            definition.set("skills", json.valueToTree(skills));
        }
        var created = mvc.perform(post("/v1/agents").principal(actor("actor"))
                        .header(TenantContextFilter.HEADER, tenant).header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(definition)))
                .andExpect(status().isAccepted()).andReturn();
        return json.readTree(created.getResponse().getContentAsString()).get("id").asText();
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
        previousShellEnabled = (Boolean) com.alibaba.qwen.code.managedagent.VerificationFixtures.agentStoreField(target, "workspaceShellEnabled");
        com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "workspaceShellEnabled", true);
    }

    @AfterEach
    void restoreBuiltinShell() {
        if (previousShellEnabled != null) {
            Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(store);
            com.alibaba.qwen.code.managedagent.VerificationFixtures.setAgentStoreField(target, "workspaceShellEnabled", previousShellEnabled);
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
