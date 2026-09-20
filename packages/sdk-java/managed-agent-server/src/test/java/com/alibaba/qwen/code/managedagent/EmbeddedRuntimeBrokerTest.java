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
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Path;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class EmbeddedRuntimeBrokerTest {
    @Test
    void usesFetchCompatibleDefaultBrokerPort() {
        assertThat(new ManagedAgentProperties().getRuntimeBroker().getPort())
                .isEqualTo(4182);
    }

    @Test
    void startsPrivateListenerAndResolvesTenantFromTheSessionStore()
            throws Exception {
        ManagedAgentStore store = mock(ManagedAgentStore.class);
        when(store.findSessionByHarnessId("harness-session")).thenReturn(
                Optional.of(new SessionRecord("tenant-a", "session-a",
                        "harness-session", "qwen-code", null, "ACTIVE",
                        null, null, 0, 0, 1, 1, 0)));
        ManagedAgentProperties properties = properties();

        try (EmbeddedRuntimeBroker broker = new EmbeddedRuntimeBroker(store,
                properties)) {
            broker.warm("harness-session").toCompletableFuture().join();
            verify(store).findSessionByHarnessId("harness-session");

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
    void derivesWorkspaceIdWhenItIsNotConfigured() throws Exception {
        ManagedAgentProperties properties = properties();
        properties.getRuntimeBroker().setProvisioner("local-process");
        properties.getRuntimeBroker().setWorkspaceId("");

        assertThatThrownBy(() -> new EmbeddedRuntimeBroker(
                mock(ManagedAgentStore.class), properties))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("state directory");
    }

    @Test
    void rejectsMismatchedLocalProcessWorkspaceId() throws Exception {
        ManagedAgentProperties properties = properties();
        properties.getRuntimeBroker().setProvisioner("local-process");
        properties.getRuntimeBroker().setWorkspaceId("wrong-workspace");

        assertThatThrownBy(() -> new EmbeddedRuntimeBroker(
                mock(ManagedAgentStore.class), properties))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("canonical workspace path hash");
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
        broker.setWorkspaceId("workspace");
        broker.setWorkspaceGeneration("generation");
        broker.setWorkspaceCwd(Path.of(".").toRealPath().toString());
        broker.setIsolationClass("workspace");
        broker.setStaticEndpoint("http://127.0.0.1:9");
        broker.setStaticToken("runtime-token");
        return properties;
    }
}
