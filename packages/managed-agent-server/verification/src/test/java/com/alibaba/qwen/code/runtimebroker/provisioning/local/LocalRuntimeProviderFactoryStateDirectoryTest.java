package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The factory refuses an unusable ephemeral state path at wiring time with
 * the path named, without creating anything; an absent but creatable path
 * passes create() and preflight no longer refuses the deployment, because
 * the provisioner creates the directory at first spawn.
 */
class LocalRuntimeProviderFactoryStateDirectoryTest {
    @TempDir
    Path directory;

    @Test
    void createLeavesAnAbsentCreatableStateDirectoryAbsent() {
        Path state = directory.resolve("absent-state");
        var factory = new LocalRuntimeProviderFactory();
        try (var provider = factory.create(settings(state), new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE)) {
            assertThat(provider).isNotNull();
            assertThat(state).doesNotExist();
        }
    }

    @Test
    void createRefusesAnOccupiedStatePathNamingTheDirectory() throws Exception {
        Path state = directory.resolve("occupied-state");
        Files.writeString(state, "not a directory");
        var factory = new LocalRuntimeProviderFactory();
        assertThatThrownBy(() -> factory.create(settings(state), new HttpRuntimeTransport(),
                RuntimeProviderDependencies.NONE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Runtime Broker state directory is unavailable")
                .hasMessageContaining(state.toString());
        assertThat(Files.readString(state)).isEqualTo("not a directory");
    }

    @Test
    void preflightWarnsForAnAbsentCreatableDirectoryAndFailsForAnOccupiedPath() throws Exception {
        var factory = new LocalRuntimeProviderFactory();
        Path absent = directory.resolve("absent-state");
        assertThat(factory.preflight(settings(absent)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> {
                    assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.WARN);
                    assertThat(check.detail()).contains("created at first Runtime spawn");
                });
        Path occupied = directory.resolve("occupied-state");
        Files.writeString(occupied, "not a directory");
        assertThat(factory.preflight(settings(occupied)))
                .filteredOn(check -> check.name().equals("broker-state"))
                .singleElement()
                .satisfies(check -> assertThat(check.status()).isEqualTo(RuntimeProviderFactory.Status.FAIL));
    }

    private static ManagedAgentProperties settings(Path state) {
        var settings = new ManagedAgentProperties();
        var broker = settings.getRuntimeBroker();
        broker.setProvisioner("local-process");
        broker.setStateDirectory(state.toString());
        broker.setNodeExecutable("/unused-node");
        broker.setWorkerEntry("/unused-worker");
        broker.setDurableLocalProcess(false);
        broker.setIsolationClass("workspace");
        broker.setTrustedLocalRebootRecovery(false);
        return settings;
    }
}