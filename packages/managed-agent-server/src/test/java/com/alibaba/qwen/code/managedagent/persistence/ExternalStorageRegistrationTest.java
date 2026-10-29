package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.ExternalStorageRegistrationController;
import com.alibaba.qwen.code.managedagent.api.RequestIdFilter;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistration.ExternalStorageIdentity;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistration.StorageAlias;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
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

import javax.sql.DataSource;

import java.net.InetAddress;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ExternalStorageRegistrationTest {
    private static final String ROUTE = "/internal/managed-workspaces/v1/storage:register-external";
    private final ObjectMapper json = new ObjectMapper();
    private ManagedSchemaJdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private ExternalStorageRegistrationStore store;
    private ManagedAgentProperties properties;
    private ServerProperties server;
    private MockMvc mvc;

    DataSource source() {
        return new DriverManagerDataSource("jdbc:h2:mem:external-storage-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @BeforeEach
    void setUp() throws Exception {
        var source = source();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        store = new ExternalStorageRegistrationStore(jdbc, manager);
        properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setToken("operator-secret");
        server = new ServerProperties();
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        mvc = MockMvcBuilders.standaloneSetup(new ExternalStorageRegistrationController(store, properties, server))
                .setControllerAdvice(new ApiExceptionHandler())
                .addFilters(new RequestIdFilter(), new TenantContextFilter(json)).build();
    }

    @Test
    void registrationSurvivesRestartAndCorrelationChangesWithoutMutatingOwnership() throws Exception {
        var registration = registration("provider", "volume", "workspace", "/aliases/one");
        String body = body(registration, "key", "request-one");
        var first = mvc.perform(operator().content(body)).andExpect(status().isOk())
                .andExpect(header().string("X-Request-Id", "request-one"))
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.storageKind").value("EXTERNAL"))
                .andReturn().getResponse().getContentAsString();
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        assertThat(owner.get("mount_state")).isEqualTo("UNVERIFIED");
        assertThat(owner.get("holder_key")).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_binding", Integer.class)).isZero();
        ManagedSchema.initialize(jdbc.getDataSource());
        var replay = new ExternalStorageRegistrationStore(jdbc, manager)
                .registerExternalStorage("tenant", "key", registration);
        assertThat(replay.registrationId()).isEqualTo(json.readTree(first).path("registrationId").asText());
        assertThat(replay.registeredAt()).isEqualTo(json.readTree(first).path("registeredAt").asLong()).isPositive();
        mvc.perform(operator().content(body(registration, "key", "request-two")))
                .andExpect(status().isOk()).andExpect(header().string("X-Request-Id", "request-two"))
                .andExpect(jsonPath("$.registrationId").value(replay.registrationId()));
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT result_json FROM ma_request_receipt", String.class))
                .doesNotContain("request-one", "request-two", "operator-secret");
    }

    @Test
    void conflictsNeverRebindAliasesPhysicalOwnersOrIdempotencyKeys() {
        var original = registration("provider", "volume", "workspace", "/aliases/one");
        store.registerExternalStorage("tenant", "key", original);
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        var alias = jdbc.queryForMap("SELECT * FROM ma_storage");
        for (var changed : List.of(
                registration("provider", "other-volume", "workspace", "/aliases/one"),
                registration("other-provider", "volume", "workspace", "/aliases/one"),
                new ExternalStorageRegistration(new ExternalStorageIdentity("provider", "volume", 2), original.alias()),
                registration("provider", "volume", "other-workspace", "/aliases/two"))) {
            assertConflict(() -> store.registerExternalStorage("tenant", "key", changed), "idempotency_conflict");
            assertConflict(() -> store.registerExternalStorage("tenant", "other-key", changed), "alias_conflict");
        }
        assertConflict(() -> store.registerExternalStorage("other-tenant", "key",
                registration("provider", "volume", "other-workspace", "/aliases/two")), "alias_conflict");
        assertConflict(() -> store.registerExternalStorage("other-tenant", "key",
                registration("other-provider", "other-volume", "other-workspace", "/aliases/one")), "alias_conflict");
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage")).isEqualTo(alias);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt", Integer.class)).isEqualTo(1);
        store.registerExternalStorage("other-tenant", "key",
                registration("other-provider", "volume", "other-workspace", "/aliases/two"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(2);
    }

    @Test
    void concurrentCrossTenantAliasRegistrationHasExactlyOneWinner() throws Exception {
        var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var attempts = List.of("one", "two").stream().map(tenant -> pool.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                try {
                    store.registerExternalStorage(tenant, "key", registration("provider", tenant, "workspace", "/shared"));
                    return "registered";
                } catch (RuntimeBrokerException error) {
                    return error.getCode();
                }
            })).toList();
            start.countDown();
            assertThat(List.of(attempts.get(0).get(10, TimeUnit.SECONDS), attempts.get(1).get(10, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder("registered", "alias_conflict");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt", Integer.class)).isEqualTo(1);
    }

    @Test
    void externalRegistrationCannotEnterLocalExecutionAndCannotAdoptLegacyAliases() {
        for (String kind : List.of("LOCAL", "UNREGISTERED")) {
            String alias = JdbcRuntimeBindingRepository.storageAliasKey("tenant", kind);
            jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, storage_kind) VALUES (?, ?, ?, ?, ?, ?)",
                    alias, JdbcRuntimeBindingRepository.storageFenceKey("tenant"), JdbcRuntimeBindingRepository.storageFenceKey(kind), "tenant", kind, kind);
            assertThat(LocalStorageOwners.alias(jdbc, "tenant", kind, false).get("storage_kind")).isEqualTo(kind);
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, "tenant", kind);
            WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, "tenant", kind);
            assertConflict(() -> store.registerExternalStorage("tenant", kind,
                    registration("provider", kind, kind, "/aliases/" + kind)), "alias_conflict");
        }
        store.registerExternalStorage("tenant", "key", registration("provider", "volume", "workspace", "/aliases/one"));
        assertThatThrownBy(() -> WorkspaceStorageKindGuard.requireLocalAlias(jdbc, "tenant", "workspace"))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, "tenant", "workspace"))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> LocalStorageOwners.key(jdbc, "tenant", "workspace"))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
    }

    @Test
    void onlyLoopbackOperatorCanRegisterAndForwardedHeadersGrantNoAccess() throws Exception {
        String body = body(registration("provider", "volume", "workspace", "/aliases/one"), "key", "request");
        mvc.perform(post(ROUTE).header("X-Qwen-Tenant-Id", "tenant").contentType("application/json").content(body))
                .andExpect(status().isForbidden()).andExpect(header().string("Cache-Control", "no-store"));
        mvc.perform(operator().content(body).with(request -> {
            request.setRemoteAddr("192.0.2.1");
            return request;
        }).header("X-Forwarded-For", "127.0.0.1")).andExpect(status().isForbidden());
        properties.getInternalServer().setPort(9091);
        properties.getInternalServer().setAddress("127.0.0.1");
        mvc.perform(operator().content(body)).andExpect(status().isForbidden());
        properties.getInternalServer().setPort(0);
        server.setAddress(InetAddress.getByName("0.0.0.0"));
        mvc.perform(operator().content(body)).andExpect(status().isForbidden());
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        properties.getRuntimeBroker().setToken("");
        mvc.perform(operator().content(body)).andExpect(status().isForbidden());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt", Integer.class)).isZero();
    }

    @Test
    void unsafePathsAndNonStorageIdentitiesAreRejectedWithoutLeakingInput() throws Exception {
        String valid = body(registration("provider", "volume", "workspace", "/aliases/one"), "key", "request");
        for (String invalid : List.of("/", "/a/../b", "/a//b", "/a/", "relative", "C:\\private")) {
            var document = json.readTree(valid);
            ((com.fasterxml.jackson.databind.node.ObjectNode) document.path("alias")).put("mountRoot", invalid);
            mvc.perform(operator().content(document.toString())).andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("invalid_external_storage_registration"))
                    .andExpect(jsonPath("$.error.message").value("Invalid external storage registration."));
        }
        mvc.perform(operator().content(valid.replace("\"registrationRevision\":1", "\"registrationRevision\":1.5")))
                .andExpect(status().isBadRequest());
        mvc.perform(operator().content(valid.replace("\"volume\"", "\"sandbox/id\"")))
                .andExpect(status().isBadRequest());
        mvc.perform(operator().content(valid.replace("\"identity\":", "\"identity\":{},\"identity\":")))
                .andExpect(status().isBadRequest());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class)).isZero();
    }

    @Test
    void theProvisionerReadPathResolvesOnlyTheTenantBoundAlias() {
        var registration = registration("provider", "volume", "workspace", "/aliases/one");
        store.registerExternalStorage("tenant", "key", registration);
        int storage = jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class);
        int owners = jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class);
        int receipts = jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt", Integer.class);

        var found = store.find("tenant", "workspace");
        assertThat(found).isPresent();
        assertThat(found.get().providerId()).isEqualTo("provider");
        assertThat(found.get().physicalKey()).isEqualTo("volume");
        assertThat(found.get().registrationRevision()).isEqualTo(1);
        assertThat(found.get().tenantWorkspaceId()).isEqualTo("workspace");
        assertThat(found.get().aliasPath()).isEqualTo("/aliases/one");
        assertThat(found.get().mountRoot()).isEqualTo("/worker/workspace");
        assertThat(found.get().toString()).isEqualTo("RegisteredExternalStorage[redacted]");

        // The read path resolves no other tenant and no other alias, and writes nothing.
        assertThat(store.find("tenant-other", "workspace")).isEmpty();
        assertThat(store.find("tenant", "workspace-other")).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class)).isEqualTo(storage);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(owners);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt", Integer.class)).isEqualTo(receipts);
        assertThatThrownBy(() -> store.find(null, "workspace"))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getStatusCode()).isEqualTo(400);
                    assertThat(error.getCode()).isEqualTo("invalid_external_storage_registration");
                });
    }

    @Test
    void theProvisionerReadPathRefusesADurableRowThatDisagreesWithItself() {
        store.registerExternalStorage("tenant", "key",
                registration("provider", "volume", "workspace", "/aliases/one"));
        // A revision or mount root that drifted away from the persisted JSON is
        // never reconciled by picking one side.
        jdbc.update("UPDATE ma_storage SET registration_revision = 2");
        assertReadPathMismatch();
        jdbc.update("UPDATE ma_storage SET registration_revision = 1");
        jdbc.update("UPDATE ma_storage_owner SET mount_root = '/worker/other'");
        assertReadPathMismatch();
    }

    @Test
    void aRetiredOrRetiringRegistrationResolvesEmpty() {
        store.registerExternalStorage("tenant", "key",
                registration("provider", "volume", "workspace", "/aliases/one"));
        assertThat(store.find("tenant", "workspace")).isPresent();
        for (String state : List.of("RETIRING", "RETIRED")) {
            jdbc.update("UPDATE ma_storage SET registration_state = ?", state);
            assertThat(store.find("tenant", "workspace"))
                    .as("a %s row is not a registration", state).isEmpty();
        }
        jdbc.update("UPDATE ma_storage SET registration_state = 'REGISTERED'");
        assertThat(store.find("tenant", "workspace")).isPresent();
    }

    @Test
    void aRegistrationRevisionMustStayInsideTheExactJsonRange() {
        long max = ExternalStorageRegistration.ExternalStorageIdentity
                .MAX_REGISTRATION_REVISION;
        assertThat(max).isEqualTo(9_007_199_254_740_991L);
        assertThat(new ExternalStorageRegistration.ExternalStorageIdentity(
                "provider", "volume", max).registrationRevision()).isEqualTo(max);
        assertThatThrownBy(() -> new ExternalStorageRegistration.ExternalStorageIdentity(
                "provider", "volume", max + 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Invalid external storage registration.");
        // The registry record mirrors the same bound without importing the DTO.
        assertThat(com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry
                .RegisteredExternalStorage.MAX_REGISTRATION_REVISION).isEqualTo(max);
        assertThatThrownBy(() -> new com.alibaba.qwen.code.runtimebroker.provisioning
                .ExternalStorageRegistry.RegisteredExternalStorage("provider", "volume",
                        max + 1, "workspace", "/aliases/one", "/worker/workspace"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void anUnreadableRegistrationIsRetryableInsteadOfPermanent() {
        store.registerExternalStorage("tenant", "key",
                registration("provider", "volume", "workspace", "/aliases/one"));
        jdbc.update("UPDATE ma_storage SET registration_json = 'not-json'");
        assertThatThrownBy(() -> store.find("tenant", "workspace"))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getStatusCode()).isEqualTo(503);
                    assertThat(error.getCode()).isEqualTo("runtime_external_unavailable");
                    assertThat(error.isRetryable()).isTrue();
                });
    }

    @Test
    void publishesAnExistingRegistrationWithAnOwnerGrantAndDurableReplay() throws Exception {
        store.registerExternalStorage("tenant", "register", registration("provider", "volume", "workspace", "/aliases/one"));
        String route = "/internal/managed-workspaces/v1/workspaces:publish-external";
        String input = json.writeValueAsString(new ExternalStorageRegistrationController.PublishRequest(
                "workspace", "provider", 1, "actor", "E2B Workspace", "publish", "publish-request"));
        mvc.perform(operator(route).content(input)).andExpect(status().isOk())
                .andExpect(jsonPath("$.workspaceId").value("workspace"))
                .andExpect(jsonPath("$.workspaceGeneration").value(1));
        assertThat(new ExternalStorageRegistrationStore(jdbc, manager).publishWorkspace(
                "tenant", "publish", "workspace", "provider", 1, "actor", "E2B Workspace").workspaceId()).isEqualTo("workspace");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT role FROM ma_workspace_access WHERE tenant_id = ? AND workspace_id = ? AND actor_id = ?",
                String.class, "tenant", "workspace", ManagedWorkspaceRegistry.actorKey("tenant", "actor"))).isEqualTo("OWNER");
        assertConflict(() -> store.publishWorkspace("tenant", "publish", "workspace", "provider", 1, "other-actor", "E2B Workspace"), "idempotency_conflict");
        assertThatThrownBy(() -> store.publishWorkspace("foreign", "publish", "workspace", "provider", 1, "actor", "E2B Workspace"))
                .isInstanceOf(RuntimeBrokerException.class);
        mvc.perform(operator(route).content(input).with(request -> { request.setRemoteAddr("192.0.2.1"); return request; }))
                .andExpect(status().isForbidden());
        mvc.perform(operator(route).content(input.replace("\"providerId\":", "\"providerId\":\"other\",\"providerId\":")))
                .andExpect(status().isBadRequest());
    }

    @Test
    void filesExecutionRequiresTheExactRegisteredOwnerWithoutCreatingALocalOwner() {
        store.registerExternalStorage("tenant", "key", registration("provider", "volume", "workspace", "/aliases/one"));
        WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, "tenant", "workspace", true);
        jdbc.update("UPDATE ma_storage_owner SET tenant_id = 'foreign'");
        assertThatThrownBy(() -> WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, "tenant", "workspace", true))
                .isInstanceOf(RuntimeBrokerException.class);
        jdbc.update("UPDATE ma_storage_owner SET tenant_id = 'tenant', mount_revision = 2");
        assertThatThrownBy(() -> WorkspaceStorageKindGuard.requireExecutionAlias(jdbc, "tenant", "workspace", true))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE storage_kind = 'LOCAL'", Integer.class)).isZero();
    }

    @Test
    void filesWorkspaceAdmitsAnOwnerSessionAndKeepsItsOriginalExecutionClaim() {
        store.registerExternalStorage("tenant", "register", registration("provider", "volume", "workspace", "/aliases/one"));
        store.publishWorkspace("tenant", "publish", "workspace", "provider", 1, "actor", "E2B Workspace");
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setProvisioner(com.alibaba.qwen.code.runtimebroker.provisioning.ExternalWorkspaceProvisioner.FILES_KIND);
        properties.getRuntimeBroker().setExternalProviderId("provider");
        var transactions = new org.springframework.transaction.support.TransactionTemplate(manager);
        var sessions = new ManagedAgentStore(jdbc, json, java.time.Clock.systemUTC(), ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
        var selection = new com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection("workspace", ".");
        String id = transactions.execute(ignored -> sessions.insertWorkspaceSessionCommand("tenant", "actor", "create", "digest", "qwen-code",
                null, null, List.of(), null, selection).sessionId());
        assertThatThrownBy(() -> transactions.execute(ignored -> sessions.insertWorkspaceSessionCommand("tenant", "foreign", "foreign-create", "digest", "qwen-code",
                null, null, List.of(), null, selection))).isInstanceOf(RuntimeException.class);
        var saved = sessions.requireSession("tenant", id);
        assertThat(saved.toolProfile()).isEqualTo(com.alibaba.qwen.code.managedagent.workspace.WorkspaceToolProfiles.FILES);
        var scope = new com.alibaba.qwen.code.runtimebroker.RuntimeScope("tenant", "workspace", "1", "/worker/workspace",
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        var bindings = new JdbcRuntimeBindingRepository(jdbc.getDataSource(), new com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector("test", new byte[32]));
        var request = new com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest(scope, id,
                com.alibaba.qwen.code.runtimebroker.provisioning.ExternalWorkspaceProvisioner.FILES_KIND, "workspace");
        var initial = bindings.findOrCreate(request);
        var seed = initial.getProvisionSeed();
        var lease = new com.alibaba.qwen.code.runtimebroker.RuntimeLease(seed.getProvisionalRuntimeId(), java.net.URI.create("http://127.0.0.1:1"), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var ready = bindings.compareAndSet(initial, initial.withAttestation(lease, new com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle(request.getProvisionerKind(), 1, java.util.Map.of("fixture", true)), java.time.Instant.now(), java.time.Instant.now()));
        var runtimeSessions = new com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository(jdbc.getDataSource());
        var session = new com.alibaba.qwen.code.runtimebroker.RuntimeSession(id, UUID.randomUUID().toString(), "bootstrap", scope);
        var record = runtimeSessions.findOrCreate(new com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord(session, ready.getBindingId(), ready.getGeneration(),
                com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord.State.READY, 1, java.time.Instant.now()));
        var authority = new WorkspaceExecutionStore(jdbc, manager, null, properties);
        authority.claim(saved.workspace(), record);
        assertThat(authority.isHeld(saved.workspace(), record)).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE storage_kind = 'LOCAL'", Integer.class)).isZero();
        jdbc.update("UPDATE ma_runtime_binding SET runtime_generation = runtime_generation + 1 WHERE binding_id = ?", ready.getBindingId());
        assertThatThrownBy(() -> authority.release(saved.workspace(), record)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT execution_storage_key FROM ma_runtime_session WHERE runtime_session_id = ?", String.class, session.getRuntimeSessionId())).isNotNull();
        jdbc.update("UPDATE ma_runtime_binding SET runtime_generation = runtime_generation - 1 WHERE binding_id = ?", ready.getBindingId());
        authority.release(saved.workspace(), record);
        assertThat(authority.isHeld(saved.workspace(), record)).isFalse();
    }

    private void assertReadPathMismatch() {
        assertThatThrownBy(() -> store.find("tenant", "workspace"))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getStatusCode()).isEqualTo(409);
                    assertThat(error.getCode())
                            .isEqualTo("external_storage_registration_mismatch");
                });
    }

    private MockHttpServletRequestBuilder operator() {
        return operator(ROUTE);
    }

    private MockHttpServletRequestBuilder operator(String route) {
        return post(route).contentType("application/json").header("X-Qwen-Tenant-Id", "tenant")
                .header("Authorization", "Bearer operator-secret").with(request -> {
                    request.setLocalAddr("127.0.0.1");
                    request.setRemoteAddr("127.0.0.1");
                    return request;
                });
    }

    private String body(ExternalStorageRegistration registration, String key, String requestId) throws Exception {
        return json.writeValueAsString(new ExternalStorageRegistrationController.Request(
                registration.identity(), registration.alias(), key, requestId));
    }

    private static ExternalStorageRegistration registration(String provider, String physical, String workspace, String path) {
        return new ExternalStorageRegistration(new ExternalStorageIdentity(provider, physical, 1),
                new StorageAlias(workspace, path, "/worker/workspace"));
    }

    private static void assertConflict(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
            assertThat(error.getStatusCode()).isEqualTo(409);
            assertThat(error.getCode()).isEqualTo(code);
            assertThat(error.getMessage()).isEqualTo("External storage registration conflicts with existing ownership.");
        });
    }
}
