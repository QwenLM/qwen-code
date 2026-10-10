package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.InMemoryToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class EmbeddedRuntimeBrokerTest {
    @Test
    void stepCallBackstopExceedsEveryShippedCalleeWait() {
        // The never-answering step backstop is twice the operation lease; it
        // must stay above the provisioner and transport declared waits, or a
        // slow-but-healthy runtime is cut mid-wait and never converges.
        long stepCallTimeoutMillis = EmbeddedRuntimeBroker.LEASE.toMillis() * 2;
        assertThat(stepCallTimeoutMillis)
                .isGreaterThan(com.alibaba.qwen.code.runtimebroker.LocalProcessRuntimeProvisioner.READY_TIMEOUT.toMillis());
        assertThat(stepCallTimeoutMillis)
                .isGreaterThan(com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport.REQUEST_TIMEOUT.toMillis());
    }


    private static final String SESSION_ID =
            "550e8400-e29b-41d4-a716-446655440000";

    @Test
    void usesFetchCompatibleDefaultBrokerPort() {
        assertThat(new ManagedAgentProperties().getRuntimeBroker().getPort())
                .isEqualTo(4182);
        assertThat(new ManagedAgentProperties().getRuntimeBroker().isDurableLocalProcess()).isTrue();
        assertThat(new ManagedAgentProperties().getRuntimeBroker().isTrustedLocalRebootRecovery()).isTrue();
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {false, true})
    void rebootRecoveryRequiresDurableLocalProvisioning(boolean local) throws Exception {
        var properties = properties();
        properties.getRuntimeBroker().setTrustedLocalRebootRecovery(true);
        properties.getRuntimeBroker().setDurableLocalProcess(!local);
        if (local) {
            properties.getRuntimeBroker().setProvisioner("local-process");
            properties.getRuntimeBroker().setWorkspaceId("");
        }
        assertThatThrownBy(() -> broker(mock(ManagedAgentStore.class), properties))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("requires durable local-process")
                .hasMessageContaining("QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY")
                .hasMessageContaining(local ? "enable durable local-process" : "configured: static");
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {false, true})
    void recoveryDirectoryCannotBeInsideLegacyOrManagedWorkspace(boolean managed,
            @org.junit.jupiter.api.io.TempDir Path root) throws Exception {
        ManagedAgentProperties properties = properties();
        var config = properties.getRuntimeBroker();
        config.setProvisioner("local-process");
        config.setWorkspaceId("");
        Path workspace = java.nio.file.Files.createDirectory(root.resolve("workspace")).toRealPath();
        config.setWorkspaceCwd(workspace.toString());
        config.setDurableLocalProcess(true);
        config.setNodeExecutable("node");
        config.setWorkerEntry("worker.js");
        config.setCliEntry("cli.js");
        Path storage = managed ? java.nio.file.Files.createDirectory(root.resolve("storage")).toRealPath() : workspace;
        if (managed) {
            config.setWorkspaceMounts(java.util.List.of(new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                    "tenant", "storage", storage.toString())));
        }
        config.setStateDirectory(storage.resolve("recovery").toString());
        assertThatThrownBy(() -> broker(mock(ManagedAgentStore.class), properties))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("outside Workspace roots")
                .hasMessageContaining("QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY");
    }

    @Test
    void startsPrivateListenerAndResolvesTenantFromTheSessionStore()
            throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        when(store.findSessionById(SESSION_ID)).thenReturn(
                Optional.of(new SessionRecord("tenant-a", SESSION_ID,
                        "qwen-code", null, "ACTIVE",
                        null, null, 0, 0, 1, 1, null, 0)));
        ManagedAgentProperties properties = properties();

        try (EmbeddedRuntimeBroker broker = broker(store, properties)) {
            broker.warm(SESSION_ID).toCompletableFuture().join();
            verify(store).findSessionById(SESSION_ID);

            URI endpoint = broker.getBaseUri().resolve(
                    "/internal/runtime-broker/v1/tool-sessions:acquire");
            HttpURLConnection connection = (HttpURLConnection) endpoint
                    .toURL().openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer wrong");
            connection.setDoOutput(true);
            connection.getOutputStream().write("{}".getBytes());
            assertThat(connection.getResponseCode()).isEqualTo(401);
        }
    }

    @Test
    void boundSessionCannotResolveTheGlobalRuntimeWorkspace()
            throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        ContextBinding binding = new ContextBinding("tenant-a", "ws-a", 1,
                "storage-a", ".", "config-a", 1);
        when(store.findSessionById(SESSION_ID)).thenReturn(Optional.of(
                new SessionRecord("tenant-a", SESSION_ID, "qwen-code",
                        null, null, "ACTIVE", null, null, 0, 0, 0, 1, 1, null,
                        0, binding, "yolo", "hosted-workspace-files/1")));
        try (EmbeddedRuntimeBroker broker = broker(store, properties())) {
            assertThatThrownBy(() -> broker.warm(SESSION_ID)
                    .toCompletableFuture().join())
                    .hasCauseInstanceOf(RuntimeBrokerException.class)
                    .satisfies(error -> assertThat(
                            ((RuntimeBrokerException) error.getCause())
                                    .getCode())
                            .isEqualTo("workspace_unavailable"));
        }
    }

    @Test
    void rejectsUnsupportedOrMalformedBrokerRoutesBeforeAnySideEffects()
            throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        try (EmbeddedRuntimeBroker broker = broker(store, properties())) {
            for (String route : java.util.List.of("executions:prepare",
                    "executions/execution-1:start",
                    "executions/execution-1:resolve")) {
                HttpURLConnection connection = (HttpURLConnection) broker
                        .getBaseUri().resolve("/internal/runtime-broker/v1/"
                                + route).toURL().openConnection();
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Authorization",
                        "Bearer broker-token");
                connection.setDoOutput(true);
                connection.getOutputStream().write("{}".getBytes());
                boolean unsupported = route.endsWith(":resolve");
                assertThat(connection.getResponseCode()).isEqualTo(unsupported ? 501 : 409);
                assertThat(new String(connection.getErrorStream()
                        .readAllBytes(), java.nio.charset.StandardCharsets.UTF_8))
                        .contains(unsupported ? "runtime_broker_operation_unsupported"
                                : "runtime_broker_protocol_conflict");
                connection.disconnect();
            }
            org.mockito.Mockito.verifyNoInteractions(store);
        }
    }

    @Test
    void derivesWorkspaceIdWhenItIsNotConfigured() throws Exception {
        ManagedAgentProperties properties = properties();
        properties.getRuntimeBroker().setProvisioner("local-process");
        properties.getRuntimeBroker().setWorkspaceId("");

        assertThatThrownBy(() -> broker(mock(ManagedAgentStore.class),
                properties))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("state directory");
    }

    @Test
    void rejectsMismatchedLocalProcessWorkspaceId() throws Exception {
        ManagedAgentProperties properties = properties();
        properties.getRuntimeBroker().setProvisioner("local-process");
        properties.getRuntimeBroker().setWorkspaceId("wrong-workspace");

        assertThatThrownBy(() -> broker(mock(ManagedAgentStore.class),
                properties))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("canonical workspace path hash");
    }

    @Test
    void closingTheListenerAlsoClosesTheBrokerService() throws Exception {
        EmbeddedRuntimeBroker broker = broker(mock(ManagedAgentStore.class),
                properties());

        broker.close();

        assertThatThrownBy(() -> broker.warm(SESSION_ID))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("closed");
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"CLOSING",
            "CLOSED", "ARCHIVING", "ARCHIVED", "DELETING", "DELETED"})
    void unboundLifecycleClosedSessionsAreFencedByTheDurableRow(String status)
            throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        // No in-process drain entry: the resolver must reject every
        // closed-or-closing row durably, so the retired set no longer grows
        // on the lifecycle path and the fence survives restarts.
        when(store.findSessionById(SESSION_ID)).thenReturn(
                Optional.of(new SessionRecord("tenant-a", SESSION_ID,
                        "qwen-code", null, status, null, null, 0, 0, 1,
                        1, null, 0)));
        try (EmbeddedRuntimeBroker broker = broker(store, properties())) {
            assertThatThrownBy(() -> broker.warm(SESSION_ID)
                    .toCompletableFuture().join())
                    .hasCauseInstanceOf(RuntimeBrokerException.class)
                    .satisfies(error -> assertThat(
                            ((RuntimeBrokerException) error.getCause())
                                    .getCode())
                            .isEqualTo("runtime_broker_session_closed"));
        }
    }

    @Test
    void drainDuringSettleStillFencesTheWarm() throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        // deliver() settles before completing the operation, so drain() reads
        // the row while it is still CLOSING and must not count on the
        // in-process set: the durable fence has to refuse the warm.
        when(store.findSessionById(SESSION_ID)).thenReturn(
                Optional.of(new SessionRecord("tenant-a", SESSION_ID,
                        "qwen-code", null, "CLOSING", null, null, 0, 0, 1,
                        1, null, 0)));
        try (EmbeddedRuntimeBroker broker = broker(store, properties())) {
            broker.drain(SESSION_ID).toCompletableFuture().join();
            assertThatThrownBy(() -> broker.warm(SESSION_ID)
                    .toCompletableFuture().join())
                    .hasCauseInstanceOf(RuntimeBrokerException.class)
                    .satisfies(error -> assertThat(
                            ((RuntimeBrokerException) error.getCause())
                                    .getCode())
                            .isEqualTo("runtime_broker_session_closed"));
        }
    }

    @Test
    void drainRetiresASessionWhoseRowIsGone() throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        // A vanished row is the one state the durable fence cannot cover;
        // the in-process entry keeps the closed refusal instead of the
        // not-owned one.
        when(store.findSessionById(SESSION_ID)).thenReturn(Optional.empty());
        try (EmbeddedRuntimeBroker broker = broker(store, properties())) {
            broker.drain(SESSION_ID).toCompletableFuture().join();
            assertThatThrownBy(() -> broker.warm(SESSION_ID)
                    .toCompletableFuture().join())
                    .hasCauseInstanceOf(RuntimeBrokerException.class)
                    .satisfies(error -> assertThat(
                            ((RuntimeBrokerException) error.getCause())
                                    .getCode())
                            .isEqualTo("runtime_broker_session_closed"));
        }
    }

    @Test
    void drainLeavesAnActiveSessionWarmable() throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        when(store.findSessionById(SESSION_ID)).thenReturn(
                Optional.of(new SessionRecord("tenant-a", SESSION_ID,
                        "qwen-code", null, "ACTIVE", null, null, 0, 0, 1,
                        1, null, 0)));
        try (EmbeddedRuntimeBroker broker = broker(store, properties())) {
            broker.drain(SESSION_ID).toCompletableFuture().join();
            broker.warm(SESSION_ID).toCompletableFuture().join();
        }
    }

    @Test
    void drainStillRetiresAClosedSessionInProcess() throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        when(store.findSessionById(SESSION_ID)).thenReturn(
                Optional.of(new SessionRecord("tenant-a", SESSION_ID,
                        "qwen-code", null, "CLOSED", null, null, 0, 0, 1,
                        1, null, 0)));
        try (EmbeddedRuntimeBroker broker = broker(store, properties())) {
            // The durable row fences CLOSED, so drain() adds no in-process
            // entry for it; the re-warm still refuses.
            broker.drain(SESSION_ID).toCompletableFuture().join();
            assertThatThrownBy(() -> broker.warm(SESSION_ID)
                    .toCompletableFuture().join())
                    .hasCauseInstanceOf(RuntimeBrokerException.class)
                    .satisfies(error -> assertThat(
                            ((RuntimeBrokerException) error.getCause())
                                    .getCode())
                            .isEqualTo("runtime_broker_session_closed"));
        }
    }

    @Test
    void releaseStillSettlesAnUnboundClosedSession() throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        when(store.findSessionById(SESSION_ID)).thenReturn(
                Optional.of(new SessionRecord("tenant-a", SESSION_ID,
                        "qwen-code", null, "CLOSED", null, null, 0, 0, 1,
                        1, null, 0)));
        ManagedAgentProperties properties = properties();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        seedReleasedSession(sessions, bindings, properties);
        try (EmbeddedRuntimeBroker broker = new EmbeddedRuntimeBroker(store,
                properties, bindings, sessions,
                new InMemoryToolExecutionRepository())) {
            // The admission fence refuses new work on a closed Session, but
            // release is a teardown route: it must still resolve the
            // Session's scope so an already-released Runtime Session
            // answers idempotently.
            HttpURLConnection connection = (HttpURLConnection) broker
                    .getBaseUri().resolve("/internal/runtime-broker/v1/"
                            + "tool-sessions/" + RUNTIME_ID + ":release")
                    .toURL().openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization",
                    "Bearer broker-token");
            connection.setDoOutput(true);
            connection.getOutputStream().write(("{\"protocolVersion\":1,"
                    + "\"requestId\":\"req-release\","
                    + "\"harnessSessionId\":\"" + SESSION_ID + "\"}")
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertThat(connection.getResponseCode()).isEqualTo(200);
            assertThat(new String(connection.getInputStream().readAllBytes(),
                    java.nio.charset.StandardCharsets.UTF_8))
                    .contains("\"released\":true");
            connection.disconnect();
        }
    }

    @Test
    void reconcileStillAnswersAnUnknownExecutionOfAClosedSession()
            throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        when(store.findSessionById(SESSION_ID)).thenReturn(
                Optional.of(new SessionRecord("tenant-a", SESSION_ID,
                        "qwen-code", null, "CLOSED", null, null, 0, 0, 1,
                        1, null, 0)));
        ManagedAgentProperties properties = properties();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        seedReleasedSession(sessions, bindings, properties);
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository();
        String digest = "sha256:" + "b".repeat(64);
        ToolExecutionRecord prepared = ToolExecutionRecord.prepared("call-1",
                "idem-1", "binding-1", 1, SESSION_ID, RUNTIME_ID, "turn-1",
                "tool-call-1", digest,
                Map.of("sessionId", RUNTIME_ID, "promptId", "turn-1",
                        "callId", "tool-call-1", "argsDigest", digest));
        executions.findOrCreate(prepared);
        ToolExecutionRecord claimed = executions.claimDispatch("call-1",
                "owner-1", Duration.ofMinutes(5));
        assertThat(executions.compareAndSet(claimed, claimed.withUnknown(),
                "owner-1", claimed.getDispatchGeneration())).isNotNull();
        try (EmbeddedRuntimeBroker broker = new EmbeddedRuntimeBroker(store,
                properties, bindings, sessions, executions)) {
            // The reconcile of an UNKNOWN outcome is evidence work after
            // the close: the fence must not answer it, so the path still
            // resolves the Session's scope, and the binding check reports
            // the execution's recorded generation as unanswerable — the
            // binding it was dispatched to is gone from this Broker.
            RuntimeBrokerService service = serviceOf(broker);
            assertThatThrownBy(() -> service.reconcileExecution(SESSION_ID,
                    RUNTIME_ID, "call-1").toCompletableFuture().join())
                    .hasCauseInstanceOf(RuntimeBrokerException.class)
                    .satisfies(error -> assertThat(
                            ((RuntimeBrokerException) error.getCause())
                                    .getCode())
                            .isEqualTo(
                                    "runtime_execution_evidence_unavailable"));
        }
    }

    @Test
    void namesTheSupportedProvisionersInTheKubernetesRejection()
            throws Exception {
        ManagedAgentProperties properties = properties();
        properties.getRuntimeBroker().setProvisioner("kubernetes");
        // Blank derives the canonical workspace ID for the k8s/local path.
        properties.getRuntimeBroker().setWorkspaceId("");

        assertThatThrownBy(() -> broker(mock(ManagedAgentStore.class),
                properties))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("not supported")
                .hasMessageContaining("local-process, static");
    }

    @Test
    void refusesANonLoopbackListenAddressWithoutTheOptIn() throws Exception {
        ManagedAgentProperties properties = properties();
        properties.getRuntimeBroker().setHost("0.0.0.0");

        assertThatThrownBy(() -> broker(mock(ManagedAgentStore.class),
                properties))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("could not start")
                .cause()
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("non-loopback");
    }

    @Test
    void refusesAV3ResultWindowBelowThePollFloor() throws Exception {
        // An absent value binds as null and a suffix-less one as
        // milliseconds; every shape below the floor must be refused here
        // rather than degrade each v3 execution later.
        for (java.time.Duration window : new java.time.Duration[] {
                null, java.time.Duration.ZERO, java.time.Duration.ofMillis(-1),
                java.time.Duration.ofMillis(999)}) {
            ManagedAgentProperties properties = properties();
            properties.getRuntimeBroker().setV3ResultWindow(window);

            assertThatThrownBy(() -> broker(mock(ManagedAgentStore.class),
                    properties))
                    .as("window %s", window)
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("v3 result window");
        }
    }

    @Test
    void allowNonLoopbackLetsTheBrokerBindAWildcardAddress()
            throws Exception {
        ManagedAgentProperties properties = properties();
        properties.getRuntimeBroker().setHost("0.0.0.0");
        properties.getRuntimeBroker().setAllowNonLoopback(true);

        try (EmbeddedRuntimeBroker broker = broker(
                mock(ManagedAgentStore.class), properties)) {
            assertThat(broker.getBaseUri()).isNotNull();
            assertThat(broker.getBaseUri().getScheme()).isEqualTo("http");
        }
    }

    private static final String RUNTIME_ID =
            "550e8400-e29b-41d4-a716-446655440001";

    private static void seedReleasedSession(
            InMemoryRuntimeSessionRepository sessions,
            InMemoryRuntimeBindingRepository bindings,
            ManagedAgentProperties properties) {
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        RuntimeScope scope = new RuntimeScope("tenant-a",
                broker.getWorkspaceId(), broker.getWorkspaceGeneration(),
                broker.getWorkspaceCwd(),
                properties.getHarness().getCapabilityDigest(),
                broker.getIsolationClass());
        // persistedSession confirms the historical record's parent binding
        // before it settles anything.
        RuntimeBindingRecord binding = bindings.findOrCreate(
                new RuntimeProvisionRequest(scope, null));
        RuntimeSessionRecord acquiring = new RuntimeSessionRecord(
                new RuntimeSession(SESSION_ID, RUNTIME_ID, "bootstrap",
                        scope),
                binding.getBindingId(), binding.getGeneration(),
                RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
        sessions.findOrCreate(acquiring);
        sessions.compareAndSet(acquiring, acquiring.withState(
                RuntimeSessionRecord.State.RELEASED, Instant.now()));
    }

    private static RuntimeBrokerService serviceOf(EmbeddedRuntimeBroker broker)
            throws Exception {
        java.lang.reflect.Field field = EmbeddedRuntimeBroker.class
                .getDeclaredField("service");
        field.setAccessible(true);
        return (RuntimeBrokerService) field.get(broker);
    }

    @Test
    void childWorkspacesAreOffByDefaultAndNeedWorkspaceMounts() throws Exception {
        try (EmbeddedRuntimeBroker broker = broker(mock(ManagedAgentStore.class), properties())) {
            assertThat(broker.childWorkspaces()).isNull();
        }
        ManagedAgentProperties enabled = properties();
        enabled.getRuntimeBroker().setChildWorkspacesEnabled(true);
        assertThatThrownBy(() -> broker(mock(ManagedAgentStore.class), enabled))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Child Workspaces require Workspace mounts");
    }

    @Test
    @org.junit.jupiter.api.condition.DisabledOnOs(org.junit.jupiter.api.condition.OS.WINDOWS)
    void childWorkspaceProviderAnswersTheVerifiedMountAndRefusesAMissingGit(
            @org.junit.jupiter.api.io.TempDir Path temp) throws Exception {
        Path storage = java.nio.file.Files.createDirectory(temp.toRealPath().resolve("storage"));
        ManagedAgentProperties properties = mountedProperties(storage);
        properties.getRuntimeBroker().setStateDirectory(temp.toRealPath().resolve("state").toString());
        properties.getRuntimeBroker().setChildWorkspaceGit("qwen-no-such-git");
        assertThatThrownBy(() -> mountedBroker(properties))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("need Git");
        properties.getRuntimeBroker().setChildWorkspaceGit("git");
        var probe = new com.alibaba.qwen.code.managedagent.service.ChildWorktreeGit("git",
                java.time.Duration.ofSeconds(30));
        try {
            probe.requireSupportedVersion();
        } catch (IllegalStateException error) {
            org.junit.jupiter.api.Assumptions.assumeTrue(false, error.getMessage());
        } finally {
            probe.close();
        }
        try (EmbeddedRuntimeBroker broker = mountedBroker(properties)) {
            var provider = broker.childWorkspaces();
            assertThat(provider).isNotNull();
            ContextBinding binding = new ContextBinding("tenant", "workspace", 1, "storage", ".", "config", 1);
            assertThat(provider.storageRoot(binding)).isEqualTo(storage);
            assertThatThrownBy(() -> provider.storageRoot(new ContextBinding("tenant", "workspace", 1,
                    "other", ".", "config", 1)))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class,
                            error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
            // A mount replaced after boot is not the administrator's mount.
            Path elsewhere = java.nio.file.Files.createDirectory(temp.toRealPath().resolve("elsewhere"));
            java.nio.file.Files.delete(storage);
            java.nio.file.Files.createSymbolicLink(storage, elsewhere);
            assertThatThrownBy(() -> provider.storageRoot(binding))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class,
                            error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        }
    }

    private static ManagedAgentProperties mountedProperties(Path storage) throws Exception {
        ManagedAgentProperties properties = properties();
        var config = properties.getRuntimeBroker();
        config.setProvisioner("local-process");
        config.setIsolationClass("session");
        config.setWorkspaceId("");
        config.setDurableLocalProcess(false);
        config.setNodeExecutable("node");
        config.setWorkerEntry("worker.js");
        config.setCliEntry("cli.js");
        config.setWorkspaceMounts(java.util.List.of(new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                "tenant", "storage", storage.toString())));
        config.setChildWorkspacesEnabled(true);
        return properties;
    }

    private static EmbeddedRuntimeBroker mountedBroker(ManagedAgentProperties properties) {
        return new EmbeddedRuntimeBroker(mock(ManagedAgentStore.class), properties,
                new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(),
                mock(com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore.class));
    }

    private static ManagedAgentProperties properties() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setCapabilityDigest("sha256:"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        broker.setHost("127.0.0.1");
        broker.setPort(0);
        broker.setToken("broker-token");
        broker.setProvisioner("static");
        broker.setTrustedLocalRebootRecovery(false);
        broker.setWorkspaceId("workspace");
        broker.setWorkspaceGeneration("generation");
        broker.setWorkspaceCwd(Path.of(".").toRealPath().toString());
        broker.setIsolationClass("workspace");
        broker.setStaticEndpoint("http://127.0.0.1:9");
        broker.setStaticToken("runtime-token");
        return properties;
    }

    private static EmbeddedRuntimeBroker broker(ManagedAgentStore store,
            ManagedAgentProperties properties) {
        return new EmbeddedRuntimeBroker(store, properties,
                new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository());
    }
}
