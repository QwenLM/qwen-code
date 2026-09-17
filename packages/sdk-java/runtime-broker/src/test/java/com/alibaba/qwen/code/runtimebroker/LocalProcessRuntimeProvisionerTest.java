package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LocalProcessRuntimeProvisionerTest {
    @TempDir
    Path temporary;

    private LocalProcessRuntimeProvisioner provisioner;

    @AfterEach
    void closeProvisioner() {
        if (provisioner != null) {
            provisioner.close();
        }
    }

    @Test
    void reusesOneProcessAndIncrementsEpochAfterRelease() throws Exception {
        RuntimeProvisionRequest request = workspaceRequest("workspace");
        provisioner = provisioner(4);

        var firstProvision = provisioner.provision(request);
        var duplicateProvision = provisioner.provision(request);
        RuntimeLease first = firstProvision.toCompletableFuture()
                .get(10, TimeUnit.SECONDS);
        RuntimeLease duplicate = duplicateProvision.toCompletableFuture()
                .get(10, TimeUnit.SECONDS);

        assertEquals(first.getRuntimeInstanceId(),
                duplicate.getRuntimeInstanceId());
        assertEquals(1, first.getEpoch());
        assertEquals(1, provisioner.getPhysicalStartCount());
        assertTrue(provisioner.health(first).toCompletableFuture()
                .get(2, TimeUnit.SECONDS));
        try (Stream<Path> paths = Files.walk(temporary.resolve("state"))) {
            assertEquals(0, paths.filter(path -> "boot.json".equals(
                    path.getFileName().toString())).count());
        }

        provisioner.drain(request, first).toCompletableFuture()
                .get(2, TimeUnit.SECONDS);
        provisioner.release(request, first).toCompletableFuture()
                .get(5, TimeUnit.SECONDS);
        RuntimeLease second = provisioner.provision(request)
                .toCompletableFuture().get(10, TimeUnit.SECONDS);

        assertEquals(2, second.getEpoch());
        assertNotEquals(first.getRuntimeInstanceId(),
                second.getRuntimeInstanceId());
        assertEquals(2, provisioner.getPhysicalStartCount());
        assertEquals(1, provisioner.getPhysicalStopCount());
    }

    @Test
    void keepsSessionIsolationKeysOnSeparateProcesses() throws Exception {
        provisioner = provisioner(4);
        RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                "generation", workspace().toString(), "capability",
                "session");
        RuntimeProvisionRequest alpha = new RuntimeProvisionRequest(scope,
                "harness-alpha");
        RuntimeProvisionRequest beta = new RuntimeProvisionRequest(scope,
                "harness-beta");

        RuntimeLease alphaLease = provisioner.provision(alpha)
                .toCompletableFuture().get(10, TimeUnit.SECONDS);
        RuntimeLease betaLease = provisioner.provision(beta)
                .toCompletableFuture().get(10, TimeUnit.SECONDS);

        assertNotEquals(alphaLease.getRuntimeInstanceId(),
                betaLease.getRuntimeInstanceId());
        assertEquals(2, provisioner.getPhysicalStartCount());
    }

    @Test
    void rejectsProvisioningBeyondConfiguredCapacity() throws Exception {
        provisioner = provisioner(1);
        RuntimeLease first = provisioner.provision(workspaceRequest("alpha"))
                .toCompletableFuture().get(10, TimeUnit.SECONDS);

        Exception failure = org.junit.jupiter.api.Assertions.assertThrows(
                Exception.class,
                () -> provisioner.provision(workspaceRequest("beta"))
                        .toCompletableFuture().get(2, TimeUnit.SECONDS));

        assertEquals("runtime_broker_capacity_exhausted",
                brokerFailure(failure).getCode());
        assertEquals(1, provisioner.getPhysicalStartCount());
        assertTrue(provisioner.health(first).toCompletableFuture()
                .get(2, TimeUnit.SECONDS));
    }

    private LocalProcessRuntimeProvisioner provisioner(int maximumRuntimes)
            throws Exception {
        Path cliEntry = temporary.resolve("cli.js");
        Files.writeString(cliEntry, "fixture");
        ExecutorService executor = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "local-runtime-test");
            thread.setDaemon(true);
            return thread;
        });
        return new LocalProcessRuntimeProvisioner(
                temporary.resolve("state").toAbsolutePath(),
                List.of(javaExecutable().toString(), "-cp",
                        System.getProperty("java.class.path"),
                        FakeRuntimeWorkerMain.class.getName()),
                cliEntry.toAbsolutePath(), Map.of(), maximumRuntimes,
                Duration.ofSeconds(5), Duration.ofSeconds(1),
                Duration.ofSeconds(1), Duration.ofSeconds(1),
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1))
                        .followRedirects(HttpClient.Redirect.NEVER).build(),
                executor);
    }

    private RuntimeProvisionRequest workspaceRequest(String workspaceId)
            throws Exception {
        return new RuntimeProvisionRequest(new RuntimeScope("tenant",
                workspaceId, "generation", workspace().toString(),
                "capability", "workspace"), null);
    }

    private Path workspace() throws Exception {
        Path workspace = temporary.resolve("workspace");
        Files.createDirectories(workspace);
        return workspace.toRealPath();
    }

    private static Path javaExecutable() {
        return Path.of(System.getProperty("java.home"), "bin", "java")
                .toAbsolutePath();
    }

    private static RuntimeBrokerException brokerFailure(Throwable failure) {
        Throwable current = failure;
        while (current.getCause() != null
                && !(current instanceof RuntimeBrokerException)) {
            current = current.getCause();
        }
        return (RuntimeBrokerException) current;
    }
}
