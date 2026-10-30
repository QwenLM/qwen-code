package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.ExternalStorageRegistrationController;
import com.alibaba.qwen.code.managedagent.api.RequestIdFilter;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.api.WorkspaceDiscoveryController;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceDiscoveryService;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.web.ServerProperties;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.net.InetAddress;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ExternalWorkspaceMaterializationTest {
    private static final String ROUTE = "/internal/managed-workspaces/v1/workspace:materialize-external";
    private final ObjectMapper json = new ObjectMapper();
    private ManagedSchemaJdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private ExternalStorageRegistrationStore registrations;
    private ExternalWorkspaceMaterializationStore store;
    private ManagedWorkspaceRegistry registry;
    private ManagedAgentProperties properties;
    private ServerProperties server;
    private MockMvc mvc;

    DataSource source() {
        return new DriverManagerDataSource("jdbc:h2:mem:external-workspace-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @BeforeEach
    void setUp() throws Exception {
        var source = source();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        registrations = new ExternalStorageRegistrationStore(jdbc, manager);
        store = new ExternalWorkspaceMaterializationStore(jdbc, manager);
        registry = new ManagedWorkspaceRegistry(jdbc);
        properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setToken("operator-secret");
        server = new ServerProperties();
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        mvc = MockMvcBuilders.standaloneSetup(new ExternalStorageRegistrationController(
                registrations, store, properties, server)).setControllerAdvice(new ApiExceptionHandler())
                .addFilters(new RequestIdFilter(), new TenantContextFilter(json)).build();
        register("tenant", "workspace");
    }

    @Test
    void materializesOnlyMetadataAndReplaysOriginalReceiptWithoutRestoringRevokedState() throws Exception {
        var storage = jdbc.queryForMap("SELECT * FROM ma_storage");
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        String first = mvc.perform(operator().content(body("workspace", "Name", "owner", "key", "first")))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(header().string("X-Request-Id", "first"))
                .andExpect(jsonPath("$.workspaceId").value("workspace"))
                .andExpect(jsonPath("$.ownerActorId").value("owner"))
                .andReturn().getResponse().getContentAsString();
        assertThat(jdbc.queryForMap("SELECT workspace_generation, state, workspace_kind FROM ma_workspace"))
                .containsEntry("workspace_generation", 1L).containsEntry("state", "ACTIVE")
                .containsEntry("workspace_kind", "ROOT");
        assertThat(jdbc.queryForObject("SELECT is_default FROM ma_workspace", Boolean.class)).isFalse();
        assertThat(jdbc.queryForObject("SELECT config_ref FROM ma_workspace", String.class))
                .isEqualTo(WorkspaceExecutionProfile.CONFIG_REF);
        assertThat(jdbc.queryForObject("SELECT policy_ref FROM ma_workspace", String.class))
                .isEqualTo(WorkspaceExecutionProfile.POLICY_REF);
        assertThat(registry.accessOf("tenant", "owner", "workspace").name()).isEqualTo("OWNER");
        assertThat(registry.canRead("tenant", "not-owner", "workspace")).isFalse();
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage")).isEqualTo(storage);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        assertThat(owner.get("mount_state")).isEqualTo("UNVERIFIED");
        jdbc.update("DELETE FROM ma_workspace_access");
        jdbc.update("UPDATE ma_workspace SET display_name = 'Renamed', state = 'REMOVED'");
        ManagedSchema.initialize(jdbc.getDataSource());
        var replay = new ExternalWorkspaceMaterializationStore(jdbc, manager)
                .materialize("tenant", "workspace", "Name", "owner", "key");
        assertThat(json.writeValueAsString(replay)).isEqualTo(first);
        mvc.perform(operator().content(body("workspace", "Name", "owner", "key", "second")))
                .andExpect(status().isOk()).andExpect(header().string("X-Request-Id", "second"))
                .andExpect(jsonPath("$.state").value("ACTIVE"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access", Integer.class)).isZero();
        assertThat(jdbc.queryForMap("SELECT display_name, state FROM ma_workspace"))
                .containsEntry("display_name", "Renamed").containsEntry("state", "REMOVED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'EXTERNAL_WORKSPACE'", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT result_json FROM ma_request_receipt WHERE namespace = 'EXTERNAL_WORKSPACE'", String.class))
                .doesNotContain("operator-secret", "first", "second");
        assertNoExecution();
    }

    @Test
    void receiptInsertFailureRollsBackWorkspaceAndGrant() {
        var storage = jdbc.queryForMap("SELECT * FROM ma_storage");
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        jdbc.execute("ALTER TABLE ma_request_receipt ADD CONSTRAINT reject_test_materialization"
                + " CHECK(namespace <> 'EXTERNAL_WORKSPACE')");
        assertThatThrownBy(() -> store.materialize("tenant", "workspace", "Name", "owner", "key"))
                .isInstanceOfSatisfying(org.springframework.dao.DataAccessException.class, error -> {
                    assertThat(error.getMostSpecificCause()).isInstanceOf(java.sql.SQLException.class);
                    assertThat(error.getMostSpecificCause().getMessage()).containsIgnoringCase("reject_test_materialization");
                });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'EXTERNAL_WORKSPACE'", Integer.class)).isZero();
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage")).isEqualTo(storage);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'EXTERNAL_STORAGE'", Integer.class)).isEqualTo(1);
    }

    @Test
    void ownerCanDiscoverInertWorkspaceButNeitherEmptyNorPromptSessionCanStart() {
        store.materialize("tenant", "workspace", "Name", "owner", "key");
        var summary = registry.findReadable("tenant", "owner", "workspace");
        assertThat(summary.canCreateSession()).isFalse();
        assertThat(summary.canSelectDirectory()).isFalse();
        assertThat(registry.findReadable("tenant", "owner", List.of("workspace")).get("workspace").canCreateSession()).isFalse();
        var discovery = new WorkspaceDiscoveryController(new WorkspaceDiscoveryService(registry, json), mock(WorkspaceCreationStore.class));
        var tenant = new TenantContext("tenant", "owner");
        assertThat(discovery.publicList(tenant, null, null).getBody().data()).singleElement()
                .satisfies(item -> assertThat(item.canCreateSession()).isFalse());
        assertThat(discovery.webShellList(tenant, new WorkspaceDiscoveryController.QueryRequest(null, null)).getBody().data())
                .singleElement().satisfies(item -> {
                    assertThat(item.canCreateSession()).isFalse();
                    assertThat(item.canSelectDirectory()).isFalse();
                });
        assertThat(registry.readableDefault("tenant", "owner")).isNull();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var sessions = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {}, registry, properties);
        var harness = mock(HarnessConnector.class);
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        var coordinator = mock(HarnessCoordinator.class);
        var service = new ManagedAgentService(sessions, new RequestDigests(), coordinator, harness, registry);
        for (List<InputBlock> input : List.of(List.<InputBlock>of(), List.of(new InputBlock("input_text", "Read a file")))) {
            assertThatThrownBy(() -> new TransactionTemplate(manager).execute(status -> service.createWorkspaceSession(
                    "tenant", "owner", "session-" + input.size(), "qwen-code", null, null, null,
                    input, new WorkspaceSelection("workspace", "."))))
                    .isInstanceOfSatisfying(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        }
        verifyNoInteractions(coordinator);
        assertThatThrownBy(() -> WorkspaceStorageKindGuard.requireLocalAlias(jdbc, "tenant", "workspace"))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, "tenant", "workspace"))
                .isInstanceOf(RuntimeBrokerException.class);
        assertNoExecution();
    }

    @Test
    void productionWiringNegotiatesBeforeRegisteredRootCreationAndPersistsExactProfile() {
        store.materialize("tenant", "workspace", "Name", "owner", "key");
        properties.getHarness().setEnabled(true);
        properties.getSessionStore().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setEnabled(true);
        properties.getRuntimeBroker().setProvisioner("external-workspace");
        properties.getRuntimeBroker().setTrustedLocalRebootRecovery(false);
        properties.getRuntimeBroker().setExternalProviderUrl("http://provider.invalid");
        properties.getRuntimeBroker().setExternalProviderToken("provider-token-for-tests");
        properties.getRuntimeBroker().setExternalProviderId("provider");
        properties.getRuntimeBroker().setWorkspaceCwd("/worker/workspace");
        properties.getRuntimeBroker().setWorkspaceId("workspace");
        var harness = mock(HarnessConnector.class);
        var warmer = mock(com.alibaba.qwen.code.managedagent.workspace.runtime.RuntimeWarmer.class);
        String profile = "hosted-workspace-external-files/1";
        when(warmer.supportsWorkspaceClose(profile)).thenReturn(true);
        try (var context = new org.springframework.context.annotation.AnnotationConfigApplicationContext()) {
            context.registerBean(ManagedAgentProperties.class, () -> properties);
            context.registerBean(ExternalStorageRegistrationStore.class, () -> registrations);
            context.registerBean(HarnessConnector.class, () -> harness);
            context.registerBean(com.alibaba.qwen.code.managedagent.workspace.runtime.RuntimeWarmer.class, () -> warmer);
            context.registerBean(ManagedWorkspaceRegistry.class, () -> registry);
            context.registerBean(WorkspaceExecutionStore.class, () -> new WorkspaceExecutionStore(jdbc, manager));
            context.refresh();
            var execution = context.getBean(WorkspaceExecutionStore.class);
            assertThat(registry.findReadable("tenant", "owner", "workspace").canCreateSession()).isFalse();
            when(harness.supportsLifecycle(profile)).thenReturn(true);
            assertThat(registry.findReadable("tenant", "owner", "workspace").canCreateSession()).isTrue();
            assertThat(registry.listReadable("tenant", "owner", null, 10)).singleElement()
                    .satisfies(row -> {
                        assertThat(row.canCreateSession()).isTrue();
                        assertThat(row.canSelectDirectory()).isFalse();
                    });
            assertThat(registry.findReadable("tenant", "owner", List.of("workspace")).get("workspace").canCreateSession()).isTrue();
            properties.getRuntimeBroker().setExternalProviderId("other-provider");
            assertThat(registry.findReadable("tenant", "owner", "workspace").canCreateSession()).isFalse();
            assertThat(registry.findReadable("tenant", "owner", List.of("workspace")).get("workspace").canCreateSession()).isFalse();
            assertThat(store.materialize("tenant", "workspace", "Name", "owner", "key").workspaceId()).isEqualTo("workspace");
            properties.getRuntimeBroker().setExternalProviderId("provider");
            assertThat(registry.findReadable("tenant", "owner", "workspace").canCreateSession()).isTrue();
            var sessions = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {}, registry, properties);
            var transaction = new TransactionTemplate(manager);
            transaction.executeWithoutResult(status -> WorkspaceMigrationAdmission.requireOpen(jdbc, "tenant", "workspace"));
            jdbc.update("UPDATE ma_storage SET fence_operation_id='migration-fence'");
            assertThatThrownBy(() -> transaction.executeWithoutResult(status -> WorkspaceMigrationAdmission.requireOpen(jdbc, "tenant", "workspace")))
                    .isInstanceOf(RuntimeBrokerException.class);
            jdbc.update("UPDATE ma_storage SET fence_operation_id=NULL");
            jdbc.update("UPDATE ma_storage_owner SET maintenance_id='maintenance', maintenance_generation=1");
            assertThatThrownBy(() -> transaction.executeWithoutResult(status -> WorkspaceMigrationAdmission.requireOpen(jdbc, "tenant", "workspace")))
                    .isInstanceOf(RuntimeBrokerException.class);
            jdbc.update("UPDATE ma_storage_owner SET maintenance_id=NULL, maintenance_generation=NULL");
            for (var input : List.of(List.<java.util.Map<String, Object>>of(),
                    List.of(java.util.Map.<String, Object>of("type", "input_text", "text", "Read README")))) {
                var admitted = transaction.execute(status -> sessions.insertWorkspaceSessionCommand("tenant", "owner",
                        "create-" + input.size(), "digest-" + input.size(), "qwen-code", null, "Files", input,
                        input.isEmpty() ? null : "input-digest", new WorkspaceSelection("workspace", ".")));
                var saved = sessions.requireSession("tenant", admitted.sessionId());
                assertThat(saved.toolProfile()).isEqualTo(profile);
                var privateStore = new ManagedSessionStore(jdbc);
                String writerToken = "external-approval-writer-token-0123456789";
                var writer = transaction.execute(status -> privateStore.acquireWriter("tenant", admitted.sessionId(), writerToken,
                        new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 60_000L)));
                var query = new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "writer", writer.writerGeneration());
                var liveApproval = transaction.execute(status -> privateStore.approvalSelection("tenant", admitted.sessionId(), writerToken, query));
                assertThat(liveApproval).containsExactlyInAnyOrderEntriesOf(java.util.Map.of("mode", "yolo", "revision", 0L));
                assertThatThrownBy(() -> transaction.execute(status -> privateStore.approvalSelection("tenant", admitted.sessionId(), writerToken,
                        new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "writer", writer.writerGeneration() + 1))))
                        .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
                assertThatThrownBy(() -> transaction.execute(status -> privateStore.approvalSelection("tenant", admitted.sessionId(), writerToken,
                        new ManagedSessionStoreModels.AuthorizeLifecycleRequest("foreign", "writer", writer.writerGeneration()))))
                        .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
                execution.authorize(saved);
                when(harness.supportsLifecycle(profile)).thenReturn(false);
                assertThatThrownBy(() -> execution.authorize(saved)).isInstanceOf(RuntimeBrokerException.class);
                when(harness.supportsLifecycle(profile)).thenReturn(true);
                if (!input.isEmpty()) {
                    var turn = sessions.findTurn("tenant", admitted.sessionId(), admitted.turnId()).orElseThrow();
                    assertThat(sessions.findTurnApprovalSelection("tenant", admitted.sessionId(), turn.promptId()))
                            .isEqualTo(new com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellApprovalSelection("yolo", 0));
                    assertThat(jdbc.queryForObject("SELECT approval_mode FROM ma_turn WHERE session_id=?", String.class, admitted.sessionId()))
                            .isEqualTo("yolo");
                    assertThat(jdbc.queryForObject("SELECT plan_enabled FROM ma_turn WHERE session_id=?", Boolean.class, admitted.sessionId())).isFalse();
                }
            }
            when(harness.supportsLifecycle(profile)).thenReturn(false);
            assertThatThrownBy(() -> transaction.execute(status -> sessions.insertWorkspaceSessionCommand("tenant", "owner",
                    "old-harness", "digest", "qwen-code", null, "Files", List.of(), null, new WorkspaceSelection("workspace", "."))))
                    .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
            when(harness.supportsLifecycle(profile)).thenReturn(true);
            when(warmer.supportsWorkspaceClose(profile)).thenReturn(false);
            assertThat(registry.findReadable("tenant", "owner", "workspace").canCreateSession()).isFalse();
            when(warmer.supportsWorkspaceClose(profile)).thenReturn(true);
            properties.getHarness().setWorkspaceFilesEnabled(false);
            assertThatThrownBy(() -> transaction.execute(status -> sessions.insertWorkspaceSessionCommand("tenant", "owner",
                    "disabled", "digest", "qwen-code", null, "Files", List.of(), null, new WorkspaceSelection("workspace", "."))))
                    .isInstanceOf(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
            properties.getHarness().setWorkspaceFilesEnabled(true);
            jdbc.update("UPDATE ma_workspace_access SET role='READER'");
            assertThat(registry.findReadable("tenant", "owner", "workspace").canCreateSession()).isFalse();
            jdbc.update("UPDATE ma_workspace_access SET role='OWNER'");
            jdbc.update("UPDATE ma_storage SET registration_revision=2");
            assertThat(registry.findReadable("tenant", "owner", "workspace").canCreateSession()).isFalse();
            assertThat(registry.listReadable("tenant", "owner", null, 10)).singleElement()
                    .satisfies(row -> assertThat(row.canCreateSession()).isFalse());
            assertThat(registry.findReadable("tenant", "owner", List.of("workspace")).get("workspace").canCreateSession()).isFalse();
            var binding = new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(
                    "tenant", "workspace", 1, "workspace", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
            assertThatThrownBy(() -> registry.externalFilesAllowed(binding))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class,
                            error -> assertThat(error.getCode()).isEqualTo("external_storage_registration_mismatch"));
            assertThatThrownBy(() -> execution.requireExternalExecution(binding))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class,
                            error -> assertThat(error.getCode()).isEqualTo("external_storage_registration_mismatch"));
            jdbc.update("UPDATE ma_storage SET registration_revision=1");
            assertThat(registry.findReadable("tenant", "owner", "workspace").canCreateSession()).isTrue();
            jdbc.update("UPDATE ma_storage SET registration_state='RETIRED'");
            assertThat(registry.findReadable("tenant", "owner", "workspace").canCreateSession()).isFalse();
        }
    }

    @Test
    void exactOperatorBoundaryAndTenantAreRequiredWithoutActorAuthentication() throws Exception {
        String body = body("workspace", "Name", "owner", "key", null);
        mvc.perform(post(ROUTE).header("X-Qwen-Tenant-Id", "tenant").contentType("application/json").content(body))
                .andExpect(status().isForbidden());
        mvc.perform(operator().content(body).with(request -> {
            request.setRemoteAddr("192.0.2.1");
            return request;
        }).header("X-Forwarded-For", "127.0.0.1")).andExpect(status().isForbidden());
        mvc.perform(operator().content(body).with(request -> {
            request.setLocalAddr("192.0.2.1");
            return request;
        })).andExpect(status().isForbidden());
        properties.getInternalServer().setPort(9091);
        mvc.perform(operator().content(body)).andExpect(status().isForbidden());
        properties.getInternalServer().setPort(0);
        server.setAddress(InetAddress.getByName("0.0.0.0"));
        mvc.perform(operator().content(body)).andExpect(status().isForbidden());
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        properties.getRuntimeBroker().setToken("different-secret");
        mvc.perform(operator().content(body)).andExpect(status().isForbidden());
        properties.getRuntimeBroker().setToken("");
        mvc.perform(operator().content(body)).andExpect(status().isForbidden());
        properties.getRuntimeBroker().setToken("operator-secret");
        mvc.perform(operator().content(body).with(request -> {
            request.removeHeader("X-Qwen-Tenant-Id");
            return request;
        })).andExpect(status().isBadRequest());
        mvc.perform(operator().content(body).with(request -> {
            request.removeHeader("X-Qwen-Tenant-Id");
            request.addHeader("X-Qwen-Tenant-Id", "bad/tenant");
            return request;
        })).andExpect(status().isBadRequest());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isZero();
        mvc.perform(operator().content(body)).andExpect(status().isOk());
        assertThat(registry.canRead("tenant", "owner", "workspace")).isTrue();
    }

    @Test
    void closedBoundedRequestRejectsUnknownDuplicateTrailingAndInvalidOwner() throws Exception {
        String valid = body("workspace", "Name", "owner", "key", null);
        for (String invalid : List.of(valid.replace("\"owner\"", "\"\""),
                valid.replace("\"owner\"", "null"), valid.replace("\"owner\"", "\"a\\nb\""),
                valid.replace("\"owner\"", "\"" + "a".repeat(513) + "\""),
                valid.replace("\"ownerActorId\":", "\"ownerActorId\":\"other\",\"ownerActorId\":"),
                valid.replace("\"registeredAliasId\":", "\"identity\":{},\"registeredAliasId\":"), valid + "{}")) {
            mvc.perform(operator().content(invalid)).andExpect(status().isBadRequest())
                    .andExpect(header().string("Cache-Control", "no-store"));
        }
        mvc.perform(operator().content(" ".repeat(16385))).andExpect(status().isPayloadTooLarge());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isZero();
    }

    @Test
    void receiptIdentityIsTenantScopedAndChangedContentConflicts() {
        store.materialize("tenant", "workspace", "Name", "owner", "key");
        for (var changed : List.of(List.of("workspace", "Other", "owner"), List.of("workspace", "Name", "other"),
                List.of("other", "Name", "owner"))) {
            conflict(() -> store.materialize("tenant", changed.get(0), changed.get(1), changed.get(2), "key"), "idempotency_conflict");
        }
        conflict(() -> store.materialize("other-tenant", "workspace", "Name", "owner", "key"), "external_workspace_conflict");
        register("other-tenant", "workspace");
        store.materialize("other-tenant", "workspace", "Other", "other-owner", "key");
        assertThat(registry.canRead("other-tenant", "owner", "workspace")).isFalse();
        assertThat(registry.canRead("other-tenant", "other-owner", "workspace")).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'EXTERNAL_WORKSPACE'", Integer.class)).isEqualTo(2);
    }

    @Test
    void rejectsPersistedTupleDriftAndBusyOwnersWithoutPartialMaterialization() {
        String physical = jdbc.queryForObject("SELECT physical_key FROM ma_storage", String.class);
        for (String mutation : List.of("storage_kind = 'LOCAL'", "registration_state = 'RETIRING'",
                "registration_revision = 2", "physical_key = 'wrong'")) {
            jdbc.update("UPDATE ma_storage SET " + mutation);
            conflict(() -> store.materialize("tenant", "workspace", "Name", "owner", "key"), "external_workspace_conflict");
            jdbc.update("UPDATE ma_storage SET storage_kind = 'EXTERNAL', registration_state = 'REGISTERED',"
                    + " registration_revision = 1, physical_key = ?", physical);
        }
        String registration = jdbc.queryForObject("SELECT registration_json FROM ma_storage", String.class);
        jdbc.update("UPDATE ma_storage SET registration_json = ?", registration.replace("\"tenantWorkspaceId\":\"workspace\"",
                "\"tenantWorkspaceId\":\"other\""));
        conflict(() -> store.materialize("tenant", "workspace", "Name", "owner", "key"), "external_workspace_conflict");
        jdbc.update("UPDATE ma_storage SET registration_json = ?", registration);
        new TransactionTemplate(manager).executeWithoutResult(status ->
                conflict(() -> store.materialize("tenant", "workspace", "Name", "owner", "key"), "workspace_unavailable"));
        for (String mutation : List.of("mount_root = '/other'", "mount_revision = 2", "holder_key = 'held'", "maintenance_id = 'maintenance'")) {
            jdbc.update("UPDATE ma_storage_owner SET " + mutation);
            conflict(() -> store.materialize("tenant", "workspace", "Name", "owner", "key"), "external_workspace_conflict");
            jdbc.update("UPDATE ma_storage_owner SET mount_root = '/worker/workspace', mount_revision = 1, holder_key = NULL, maintenance_id = NULL");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'EXTERNAL_WORKSPACE'", Integer.class)).isZero();
    }

    @Test
    void refusesExistingWorkspaceAndRuntimeWithoutAdoptingThem() {
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES ('tenant', 'existing', 2, 'workspace',"
                + " 'Existing', ?, ?, 'REMOVED')", WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        conflict(() -> store.materialize("tenant", "workspace", "Name", "owner", "key"), "external_workspace_conflict");
        register("tenant", "second");
        jdbc.update("INSERT INTO ma_runtime_binding (binding_id, request_key, scope_key, tenant_id, workspace_id,"
                + " workspace_generation, canonical_cwd, capability_digest, isolation_class, provisioner_kind,"
                + " storage_id, runtime_generation, binding_state, attestation_generation, drain_requested,"
                + " operation_generation, record_version, last_active_at)"
                + " VALUES ('binding', ?, ?, 'tenant', 'second', '1', '/workspace', 'digest', 'session',"
                + " 'external', 'second', 1, 'READY', 1, FALSE, 0, 1, 0)", "a".repeat(64), "b".repeat(64));
        conflict(() -> store.materialize("tenant", "second", "Name", "owner", "other-key"), "external_workspace_conflict");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'EXTERNAL_WORKSPACE'", Integer.class)).isZero();
    }

    @Test
    void concurrentSameKeyReplaysAndDifferentKeysHaveOnlyOneWinner() throws Exception {
        var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var attempts = List.of(1, 2).stream().map(index -> pool.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return store.materialize("tenant", "workspace", "Name", "owner", "key");
            })).toList();
            start.countDown();
            assertThat(attempts.get(0).get(15, TimeUnit.SECONDS)).isEqualTo(attempts.get(1).get(15, TimeUnit.SECONDS));
        }
        register("tenant", "second");
        var secondStart = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var attempts = List.of("one", "two").stream().map(key -> pool.submit(() -> {
                secondStart.await(5, TimeUnit.SECONDS);
                try {
                    store.materialize("tenant", "second", "Name", "owner", key);
                    return "created";
                } catch (RuntimeBrokerException error) {
                    return error.getCode();
                }
            })).toList();
            secondStart.countDown();
            assertThat(List.of(attempts.get(0).get(15, TimeUnit.SECONDS), attempts.get(1).get(15, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder("created", "external_workspace_conflict");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace = 'EXTERNAL_WORKSPACE'", Integer.class)).isEqualTo(2);
    }

    private void register(String tenant, String workspace) {
        registrations.registerExternalStorage(tenant, "registration-" + workspace,
                new ExternalStorageRegistration(new ExternalStorageRegistration.ExternalStorageIdentity("provider", tenant + "-" + workspace, 1),
                        new ExternalStorageRegistration.StorageAlias(workspace, "/aliases/" + tenant + "/" + workspace, "/worker/workspace")));
    }

    private MockHttpServletRequestBuilder operator() {
        return post(ROUTE).contentType("application/json").header("X-Qwen-Tenant-Id", "tenant")
                .header("Authorization", "Bearer operator-secret").with(request -> {
                    request.setLocalAddr("127.0.0.1");
                    request.setRemoteAddr("127.0.0.1");
                    return request;
                });
    }

    private String body(String alias, String name, String owner, String key, String requestId) throws Exception {
        return json.writeValueAsString(new ExternalStorageRegistrationController.MaterializeRequest(alias, name, owner, key, requestId));
    }

    private void assertNoExecution() {
        for (String table : List.of("ma_session", "ma_turn", "ma_runtime_binding")) {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Integer.class)).isZero();
        }
    }

    private static void conflict(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }
}
