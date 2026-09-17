package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
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

    @Test
    void retriesTransientHealthFailureWithinStartupDeadline()
            throws Exception {
        provisioner = provisioner(1, List.of("--close-first-health"));

        RuntimeLease lease = provisioner.provision(
                workspaceRequest("workspace")).toCompletableFuture()
                .get(10, TimeUnit.SECONDS);

        assertEquals(1, lease.getEpoch());
        assertEquals(1, provisioner.getPhysicalStartCount());
        assertTrue(provisioner.health(lease).toCompletableFuture()
                .get(2, TimeUnit.SECONDS));
    }

    @Test
    void timesOutReapsWorkerAndAdvancesEpochOnRetry() throws Exception {
        RuntimeProvisionRequest request = workspaceRequest("workspace");
        provisioner = provisioner(1, List.of("--never-ready-once"),
                Duration.ofSeconds(2));

        Exception failure = assertThrows(Exception.class,
                () -> provisioner.provision(request)
                        .toCompletableFuture().get(5, TimeUnit.SECONDS));

        assertEquals("runtime_broker_start_timeout",
                brokerFailure(failure).getCode());
        assertEquals(1, provisioner.getPhysicalStartCount());
        assertEquals(1, provisioner.getPhysicalStopCount());
        assertTrue(provisioner.getLiveProcessIds().isEmpty());
        assertNoGenerationDirectories();

        RuntimeLease retry = provisioner.provision(request)
                .toCompletableFuture().get(5, TimeUnit.SECONDS);
        assertEquals(2, retry.getEpoch());
        assertEquals(2, provisioner.getPhysicalStartCount());
    }

    @Test
    void rejectsInvalidReadyAndReapsWorker() throws Exception {
        provisioner = provisioner(1, List.of("--invalid-ready"));

        Exception failure = assertThrows(Exception.class,
                () -> provisioner.provision(workspaceRequest("workspace"))
                        .toCompletableFuture().get(5, TimeUnit.SECONDS));

        assertEquals("runtime_broker_invalid_ready",
                brokerFailure(failure).getCode());
        assertEquals(1, provisioner.getPhysicalStartCount());
        assertEquals(1, provisioner.getPhysicalStopCount());
        assertTrue(provisioner.getLiveProcessIds().isEmpty());
        assertNoGenerationDirectories();
    }

    @Test
    void detectsCrashAfterReadyAndAllowsFreshGeneration() throws Exception {
        RuntimeProvisionRequest request = workspaceRequest("workspace");
        provisioner = provisioner(1, List.of("--exit-after-ready"));
        RuntimeLease first = provisioner.provision(request)
                .toCompletableFuture().get(5, TimeUnit.SECONDS);

        await(() -> !provisioner.health(first).toCompletableFuture()
                .get(2, TimeUnit.SECONDS), Duration.ofSeconds(5));
        assertFalse(provisioner.health(first).toCompletableFuture()
                .get(2, TimeUnit.SECONDS));
        provisioner.release(request, first).toCompletableFuture()
                .get(5, TimeUnit.SECONDS);
        RuntimeLease second = provisioner.provision(request)
                .toCompletableFuture().get(5, TimeUnit.SECONDS);

        assertEquals(2, second.getEpoch());
        assertNotEquals(first.getRuntimeInstanceId(),
                second.getRuntimeInstanceId());
    }

    @Test
    void closeReapsWorkerProcessTree() throws Exception {
        provisioner = provisioner(1, List.of("--spawn-child"));
        provisioner.provision(workspaceRequest("workspace"))
                .toCompletableFuture().get(5, TimeUnit.SECONDS);
        await(() -> provisioner.getLiveProcessIds().size() >= 2,
                Duration.ofSeconds(5));
        Set<Long> processIds = provisioner.getLiveProcessIds();

        provisioner.close();
        provisioner = null;

        await(() -> processIds.stream().noneMatch(id -> ProcessHandle.of(id)
                .map(ProcessHandle::isAlive).orElse(false)),
                Duration.ofSeconds(5));
    }

    private LocalProcessRuntimeProvisioner provisioner(int maximumRuntimes)
            throws Exception {
        return provisioner(maximumRuntimes, List.of());
    }

    private LocalProcessRuntimeProvisioner provisioner(int maximumRuntimes,
            List<String> workerArguments) throws Exception {
        return provisioner(maximumRuntimes, workerArguments,
                Duration.ofSeconds(5));
    }

    private LocalProcessRuntimeProvisioner provisioner(int maximumRuntimes,
            List<String> workerArguments, Duration startupTimeout)
            throws Exception {
        Path cliEntry = temporary.resolve("cli.js");
        Files.writeString(cliEntry, "fixture");
        ExecutorService executor = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "local-runtime-test");
            thread.setDaemon(true);
            return thread;
        });
        List<String> command = new java.util.ArrayList<>(List.of(
                javaExecutable().toString(), "-cp",
                System.getProperty("java.class.path"),
                FakeRuntimeWorkerMain.class.getName()));
        command.addAll(workerArguments);
        return new LocalProcessRuntimeProvisioner(
                temporary.resolve("state").toAbsolutePath(), command,
                cliEntry.toAbsolutePath(), Map.of(), maximumRuntimes,
                startupTimeout, Duration.ofSeconds(1),
                Duration.ofSeconds(1), Duration.ofSeconds(1),
                HttpClient.newBuilder()
                        .version(HttpClient.Version.HTTP_1_1)
                        .connectTimeout(Duration.ofSeconds(1))
                        .followRedirects(HttpClient.Redirect.NEVER).build(),
                executor);
    }

    private static void await(CheckedCondition condition, Duration timeout)
            throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (condition.evaluate()) {
                return;
            }
            Thread.sleep(25);
        }
        assertTrue(condition.evaluate(), "condition did not become true");
    }

    private void assertNoGenerationDirectories() throws Exception {
        try (Stream<Path> paths = Files.list(temporary.resolve("state"))) {
            assertEquals(0, paths.filter(path -> path.getFileName().toString()
                    .startsWith("generation-")).count());
        }
    }

    @FunctionalInterface
    private interface CheckedCondition {
        boolean evaluate() throws Exception;
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
