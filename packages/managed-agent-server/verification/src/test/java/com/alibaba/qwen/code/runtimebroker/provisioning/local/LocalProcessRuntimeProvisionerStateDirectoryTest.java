package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.protocol.ManagedContextProtocolTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The ephemeral provisioner creates its state directory at spawn, not at
 * construction: a deployment that never pre-created the directory can still
 * start a Runtime, while create() itself stays side-effect-free.
 */
class LocalProcessRuntimeProvisionerStateDirectoryTest {
    @TempDir
    Path directory;

    @Test
    void ephemeralSpawnCreatesTheStateDirectoryLazily() throws Exception {
        Path state = directory.resolve("lazy-state");
        try (var provisioner = new LocalProcessRuntimeProvisioner(
                List.of("/nonexistent-node-for-lazy-state-test", "unused-worker"),
                state, new HttpRuntimeTransport())) {
            assertThat(state).doesNotExist();
            // The spawn fails at ProcessBuilder.start (no such executable),
            // which is after the directory ensure: existence proves the
            // ensure ran before start, not after a successful spawn.
            assertThatThrownBy(() -> provisioner.provision(ManagedContextProtocolTest.request())
                    .toCompletableFuture().get(10, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class);
            assertThat(state).exists();
        }
    }
}