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
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Path;
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
                        0, binding, "hosted-workspace-files/1")));
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
