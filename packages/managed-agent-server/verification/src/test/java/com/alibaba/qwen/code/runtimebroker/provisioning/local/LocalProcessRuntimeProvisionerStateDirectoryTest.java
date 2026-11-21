package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.protocol.ManagedContextProtocolTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The ephemeral provisioner creates its state directory immediately before
 * spawn, not at construction and not on the failure path: a real child that
 * writes a marker relative to its working directory proves the directory
 * existed before {@code ProcessBuilder.start}. A missing directory is created
 * owner-private (rwx------), matching the durable store's convention; an
 * existing directory is used as-is.
 */
class LocalProcessRuntimeProvisionerStateDirectoryTest {
    @TempDir
    Path directory;

    @Test
    void ephemeralSpawnCreatesTheStateDirectoryBeforeTheChildStarts() throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        Path state = directory.resolve("lazy-state");
        // The child writes the marker relative to its working directory and
        // exits without speaking the boot protocol, so the provision fails
        // after a real start. The marker can only exist if the directory was
        // created before start; an ensure on the failure path leaves no child
        // and no marker.
        try (var provisioner = new LocalProcessRuntimeProvisioner(
                List.of("node", "-e", "require('fs').writeFileSync('spawn-marker.txt','ok')"),
                state, new HttpRuntimeTransport())) {
            assertThat(state).doesNotExist();
            assertThatThrownBy(() -> provisioner.provision(ManagedContextProtocolTest.request())
                    .toCompletableFuture().get(30, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class);
            assertThat(state).isDirectory();
            assertThat(state.resolve("spawn-marker.txt")).hasContent("ok");
        }
    }

    @Test
    void createdStateDirectoryIsOwnerPrivate() throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        assumeTrue(directory.getFileSystem().supportedFileAttributeViews().contains("posix"),
                "POSIX permissions required");
        Path state = directory.resolve("private-state");
        try (var provisioner = new LocalProcessRuntimeProvisioner(
                List.of("node", "-e", "require('fs').writeFileSync('spawn-marker.txt','ok')"),
                state, new HttpRuntimeTransport())) {
            assertThatThrownBy(() -> provisioner.provision(ManagedContextProtocolTest.request())
                    .toCompletableFuture().get(30, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class);
            assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(state)))
                    .isEqualTo("rwx------");
        }
    }

    @Test
    void occupiedStatePathFailsProvisioningWithTheNamedDirectory() throws Exception {
        Path state = directory.resolve("occupied-state");
        Files.writeString(state, "not a directory");
        try (var provisioner = new LocalProcessRuntimeProvisioner(
                List.of("unused-node", "unused-worker"), state, new HttpRuntimeTransport())) {
            ExecutionException failure = assertThrows(ExecutionException.class,
                    () -> provisioner.provision(ManagedContextProtocolTest.request())
                            .toCompletableFuture().get(30, TimeUnit.SECONDS));
            assertThat(failure.getCause()).isInstanceOf(RuntimeBrokerException.class);
            assertThat(failure.getCause().getCause())
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("Runtime Broker state directory is unavailable")
                    .hasMessageContaining(state.toString());
        }
    }
}