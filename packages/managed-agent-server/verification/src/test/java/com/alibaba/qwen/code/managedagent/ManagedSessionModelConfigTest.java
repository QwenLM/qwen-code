package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ManagedSessionStoreController;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.SessionModelConfig;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionModelConfigs;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.security.SecretProtector;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:session-model-config;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedSessionModelConfigTest {
    @Autowired private @Qualifier("managedJdbcTemplate") JdbcTemplate jdbc;
    @Autowired private ObjectMapper json;
    @Autowired private ManagedWorkspaceRegistry registry;
    @Autowired private PlatformTransactionManager manager;
    private final String token = "synthetic-writer-token-0123456789012345";
    private String tenant;
    private ManagedAgentProperties properties;
    private ManagedSessionModelConfigs configs;
    private ManagedAgentStore store;
    private ManagedAgentService service;
    private HarnessConnector harness;
    private DefaultListableBeanFactory beans;

    @BeforeEach
    void setup() {
        tenant = "model-config-" + UUID.randomUUID();
        jdbc.update("INSERT INTO ma_workspace (tenant_id,workspace_id,workspace_generation,storage_id,"
                + "display_name,config_ref,policy_ref,state) VALUES (?,'ws',1,'storage','Workspace',?,?,'ACTIVE')",
                tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,workspace_id,actor_id,role) VALUES (?,'ws',?,'OWNER')",
                tenant, "actor".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getSessionStore().setEnabled(true);
        properties.setModelConfigBaseUrls(List.of("https://models.example/v1"));
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(tenant, "storage", "/tmp/model-config")));
        beans = new DefaultListableBeanFactory();
        beans.registerSingleton("protector", new AesGcmSecretProtector("test-key", new byte[32]));
        configs = repository();
        store = VerificationFixtures.configure(new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                registry, properties, new SdkHarnessRules()));
        store.setModelConfigs(configs);
        harness = mock(HarnessConnector.class);
        when(harness.supportsModelConfiguration()).thenReturn(true);
        service = new ManagedAgentService(store, new RequestDigests(), mock(HarnessCoordinator.class), harness, registry,
                new SdkHarnessRules());
    }

    @Test
    void freezesEncryptedConfigurationAndReplaysBeforeMutableAdmissionGates() {
        var config = config("synthetic-key-a");
        String session = create("create", config);
        assertThat(store.requireSession(tenant, session).modelConfigDigest()).isEqualTo(config.digest());
        var row = jdbc.queryForMap("SELECT model_config_digest, model_config_key_id, model_config_ciphertext"
                + " FROM ma_session WHERE tenant_id=? AND session_id=?", tenant, session);
        assertThat(row.toString()).doesNotContain("synthetic-key-a", "models.example", "session-model");
        assertThat(repository().read(tenant, session, config.digest()).wireValue()).isEqualTo(config.wireValue());
        when(harness.supportsModelConfiguration()).thenReturn(false);
        properties.setModelConfigBaseUrls(List.of());
        assertThat(create("create", config)).isEqualTo(session);
        assertCode(() -> create("create", config("different-key")), "idempotency_conflict");
        assertCode(() -> create("new", config), "unsupported_feature");
        assertCode(() -> new TransactionTemplate(manager).execute(status ->
                store.changeSessionModel(tenant, "actor", session, "switch", "digest", "catalog", 0, true)),
                "model_config_immutable");
    }

    @Test
    void requiresAdmissionPolicyAndDoesNotLeavePartialSessions() {
        properties.setModelConfigBaseUrls(List.of());
        assertCode(() -> create("denied", config("key")), "model_endpoint_not_allowed");
        properties.setModelConfigBaseUrls(List.of("https://models.example/v1"));
        beans.destroySingleton("protector");
        assertCode(() -> create("missing-key", config("key")), "model_config_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=?", Integer.class, tenant)).isZero();
    }

    @Test
    void reencryptsInheritedConfigurationForTheChildIdentity() {
        var config = config("parent-key");
        String parent = create("parent", config);
        var input = List.<Map<String, Object>>of(Map.of("type", "workflow_launch"));
        String child = new TransactionTemplate(manager).execute(status -> store.insertChildSessionCommand(
                tenant, parent, "child", "child-digest", "Child", input,
                com.alibaba.qwen.code.daemon.SubmitHarnessTurn.computePayloadDigest(input),
                new SessionLineage(parent, parent, "workflow-run", 1))).sessionId();
        assertThat(configs.read(tenant, child, config.digest()).wireValue()).isEqualTo(config.wireValue());
        String parentCiphertext = jdbc.queryForObject("SELECT model_config_ciphertext FROM ma_session WHERE tenant_id=? AND session_id=?",
                String.class, tenant, parent);
        assertThat(jdbc.queryForObject("SELECT model_config_ciphertext FROM ma_session WHERE tenant_id=? AND session_id=?",
                String.class, tenant, child)).isNotEqualTo(parentCiphertext);
        jdbc.update("UPDATE ma_session SET model_config_ciphertext=? WHERE tenant_id=? AND session_id=?", parentCiphertext, tenant, child);
        assertThatThrownBy(() -> configs.read(tenant, child, config.digest())).isInstanceOf(RuntimeException.class);
    }

    @Test
    void privateReadRequiresCurrentTenantWorkspaceWriterGenerationAndDigest() {
        var config = config("private-key");
        String session = create("private", config);
        var sessionStore = VerificationFixtures.configure(new ManagedSessionStore(jdbc));
        new TransactionTemplate(manager).execute(status -> sessionStore.acquireWriter(tenant, session, token,
                new AcquireWriterRequest("ws", "writer", 60_000L)));
        var controller = new ManagedSessionStoreController(sessionStore, null, null);
        ReflectionTestUtils.setField(controller, "modelConfigs", configs);
        var request = new ManagedSessionStoreController.ModelConfigQuery("ws", "writer", 1, config.digest(), null);
        var result = new TransactionTemplate(manager).execute(status -> controller.modelConfig(new TenantContext(tenant, null), session,
                token, request, new HttpHeaders()));
        assertThat(result.getHeaders().getCacheControl()).isEqualTo("no-store");
        assertThat(result.getBody()).isEqualTo(Map.of("digest", config.digest(), "config", config.wireValue()));
        for (var invalid : List.of(
                new ManagedSessionStoreController.ModelConfigQuery("other", "writer", 1, config.digest(), null),
                new ManagedSessionStoreController.ModelConfigQuery("ws", "other", 1, config.digest(), null),
                new ManagedSessionStoreController.ModelConfigQuery("ws", "writer", 2, config.digest(), null),
                new ManagedSessionStoreController.ModelConfigQuery("ws", "writer", 1, config.digest(), "unknown"),
                new ManagedSessionStoreController.ModelConfigQuery("ws", "writer", 1, "sha256:" + "0".repeat(64), null))) {
            assertThatThrownBy(() -> new TransactionTemplate(manager).execute(status -> controller.modelConfig(
                    new TenantContext(tenant, null), session, token, invalid, new HttpHeaders()))).isInstanceOf(ManagedAgentException.class);
        }
        assertThatThrownBy(() -> new TransactionTemplate(manager).execute(status -> controller.modelConfig(
                new TenantContext("other", null), session, token, request, new HttpHeaders()))).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> new TransactionTemplate(manager).execute(status -> controller.modelConfig(
                new TenantContext(tenant, null), session, "wrong-token", request, new HttpHeaders()))).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void secretReadsPreserveLegacyCloseAndLifecycleAuthority() {
        var config = config("hook-key");
        String session = create("hooks", config);
        var authority = mock(ManagedSessionStore.class);
        var controller = new ManagedSessionStoreController(authority, null, null);
        ReflectionTestUtils.setField(controller, "modelConfigs", configs);
        controller.modelConfig(new TenantContext(tenant, null), session, token,
                new ManagedSessionStoreController.ModelConfigQuery("ws", "writer", 1, config.digest(), "legacy-close"), new HttpHeaders());
        verify(authority).authorizeOrdinary(tenant, session, token,
                new com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AuthorizeLifecycleRequest(
                        "ws", "writer", 1, "legacy-close"));
        var headers = new HttpHeaders();
        var lifecycle = new com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority(UUID.randomUUID().toString(), 1);
        headers.set(com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority.OPERATION_HEADER, lifecycle.operationId());
        headers.set(com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority.GENERATION_HEADER, "1");
        controller.modelConfig(new TenantContext(tenant, null), session, token,
                new ManagedSessionStoreController.ModelConfigQuery("ws", "writer", 1, config.digest(), null), headers);
        verify(authority).authorizeLifecycle(tenant, session, token,
                new com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AuthorizeLifecycleRequest(
                        "ws", "writer", 1, null), lifecycle);
    }

    @Test
    void validatesConnectionAndGenerationFieldsWithoutLeakingSecrets() {
        for (var override : List.of(Map.of("protocol", "qwen-oauth"), Map.of("base_url", "file:///tmp/model"),
                Map.of("base_url", "https://user:password@models.example/v1"), Map.of("api_key", "bad\nkey"),
                Map.of("generation_config", Map.of("temperature", 3)), Map.of("generation_config", Map.of("max_tokens", 0.5)),
                Map.of("unknown", "private-secret"))) {
            var value = json.valueToTree(config("private-secret").wireValue()).deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) value).setAll((com.fasterxml.jackson.databind.node.ObjectNode) json.valueToTree(override));
            assertCode(() -> SessionModelConfig.parse(value), "invalid_model_config");
        }
        assertThat(config("private-secret").toString()).doesNotContain("private-secret");
    }

    private ManagedSessionModelConfigs repository() {
        return new ManagedSessionModelConfigs(jdbc, json, beans.getBeanProvider(SecretProtector.class), properties);
    }

    private SessionModelConfig config(String key) {
        return SessionModelConfig.parse(json.valueToTree(Map.of("protocol", "openai", "model", "session-model",
                "base_url", "https://models.example/v1", "api_key", key, "generation_config", Map.of("temperature", 0.4))));
    }

    private String create(String key, SessionModelConfig config) {
        return new TransactionTemplate(manager).execute(status -> service.createWorkspaceSession(tenant, "actor", key,
                "qwen-code", null, null, null, List.of(), new WorkspaceSelection("ws", "."), null, null, null,
                null, null, null, config)).sessionId();
    }

    private static void assertCode(Runnable work, String code) {
        assertThatThrownBy(work::run).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }
}
