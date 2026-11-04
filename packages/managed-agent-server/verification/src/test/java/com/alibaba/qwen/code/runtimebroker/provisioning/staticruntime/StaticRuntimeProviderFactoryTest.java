package com.alibaba.qwen.code.runtimebroker.provisioning.staticruntime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.URI;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class StaticRuntimeProviderFactoryTest {
    @TempDir
    Path temporary;

    @Test
    void returnsTheConfiguredLeaseWithoutAccessingOtherProviderPorts() {
        var settings = settings();
        var factory = new StaticRuntimeProviderFactory();
        try (var provider = factory.create(settings, null, RuntimeProviderDependencies.NONE)) {
            var scope = new RuntimeScope("tenant", "workspace", "1", "/workspace", "sha256:"
                    + "0".repeat(64), "workspace");
            var request = provider.createRequest(scope, null);
            var lease = provider.provision(request).toCompletableFuture().join();
            assertThat(provider.kind()).isEqualTo("static");
            assertThat(request.requiresDurableIdentity()).isFalse();
            assertThat(provider.supportsDrainedStop()).isFalse();
            assertThat(lease.getEndpoint()).isEqualTo(URI.create("http://127.0.0.1:41270/"));
            assertThat(lease.getToken()).isEqualTo("static-token");
            assertThat(lease.getRuntimeInstanceId()).isEqualTo("original-runtime");
            assertThat(lease.getLeaseId()).isEqualTo("original-lease");
            assertThat(lease.getEpoch()).isEqualTo(7);
        }
    }

    @Test
    void keepsStateAndWorkspaceDirectoryPreflightRequirements() {
        var settings = settings();
        var factory = new StaticRuntimeProviderFactory();
        assertThat(factory.usesLocalWorkspace()).isTrue();
        assertThat(factory.preflight(settings)).singleElement()
                .satisfies(check -> assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL));
        settings.getRuntimeBroker().setStateDirectory(temporary.toString());
        assertThat(factory.preflight(settings)).singleElement().satisfies(check -> {
            assertThat(check.name()).isEqualTo("broker-state");
            assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.PASS);
        });
    }

    @Test
    void refusesSessionIsolationMissingCredentialsAndLocalRecovery() {
        var settings = settings();
        var broker = settings.getRuntimeBroker();
        var factory = new StaticRuntimeProviderFactory();
        broker.setIsolationClass("session");
        assertThatThrownBy(() -> factory.validate(settings)).hasMessageContaining("workspace isolation");
        broker.setIsolationClass("workspace");
        broker.setStaticToken("");
        assertThatThrownBy(() -> factory.validate(settings)).hasMessageContaining("token is required");
        broker.setStaticToken("static-token");
        broker.setTrustedLocalRebootRecovery(true);
        assertThatThrownBy(() -> factory.validate(settings)).hasMessageContaining("trusted-local-reboot-recovery=false");
    }

    private static ManagedAgentProperties settings() {
        var settings = new ManagedAgentProperties();
        var broker = settings.getRuntimeBroker();
        broker.setProvisioner("static");
        broker.setIsolationClass("workspace");
        broker.setTrustedLocalRebootRecovery(false);
        broker.setStaticEndpoint("http://127.0.0.1:41270");
        broker.setStaticToken("static-token");
        broker.setStaticRuntimeInstanceId("original-runtime");
        broker.setStaticLeaseId("original-lease");
        broker.setStaticEpoch(7);
        return settings;
    }
}
