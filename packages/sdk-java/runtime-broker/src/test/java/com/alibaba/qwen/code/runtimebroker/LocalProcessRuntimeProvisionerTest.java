package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
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
    void rejectsTheFilesystemRootAsStateDirectory() throws Exception {
        Path cliEntry = temporary.resolve("cli.js").toAbsolutePath();
        Files.writeString(cliEntry, "fixture");

        assertThrows(IllegalArgumentException.class, () ->
                new LocalProcessRuntimeProvisioner(
                        Path.of("/").toAbsolutePath(), javaExecutable(),
                        javaExecutable(), cliEntry, Map.of()));
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

    @Test
    void adoptsTheSameDurableProcessAfterProviderRestart()
            throws Exception {
        LocalProcessRuntimeProvisioner first = provisioner(1);
        provisioner = first;
        RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                "generation", workspace().toString(), "capability",
                "workspace");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope,
                null, first.kind(), first.placementDomain(),
                first.runtimeTemplateDigest());
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create("binding", 1);
        RuntimeResourceHandle handle = first.ensureResource(request, seed,
                null).toCompletableFuture().get(5, TimeUnit.SECONDS);
        RuntimeObservation initial = readyObservation(first, request, seed,
                handle);
        long processId = ((Number) handle.getValue().get("pid")).longValue();

        first.close();
        provisioner = null;
        assertTrue(ProcessHandle.of(processId).map(ProcessHandle::isAlive)
                .orElse(false));

        LocalProcessRuntimeProvisioner restored = provisioner(1);
        provisioner = restored;
        RuntimeResourceHandle adopted = restored.ensureResource(request, seed,
                handle).toCompletableFuture().get(5, TimeUnit.SECONDS);
        RuntimeObservation recovered = readyObservation(restored, request,
                seed, adopted);

        assertEquals(handle, adopted);
        assertEquals(initial.getEndpoint(), recovered.getEndpoint());
        assertEquals(0, restored.getPhysicalStartCount());

        RuntimeLease lease = new RuntimeLease(recovered.getRuntimeInstanceId(),
                recovered.getEndpoint(), seed.getToken(),
                recovered.getLeaseId(), recovered.getEpoch());
        restored.release(new RuntimeResourceContext(request, seed, adopted,
                lease)).toCompletableFuture().get(5, TimeUnit.SECONDS);
        await(() -> ProcessHandle.of(processId)
                .map(process -> !process.isAlive()).orElse(true),
                Duration.ofSeconds(5));
    }

    @Test
    void adoptsTheSameDurableProcessAfterTheOwnerJvmExits()
            throws Exception {
        Path workspace = workspace();
        Path cliEntry = temporary.resolve("cli.js");
        Files.writeString(cliEntry, "fixture");
        Path state = temporary.resolve("state").toAbsolutePath();
        String classpath = System.getProperty("java.class.path");
        Process child = new ProcessBuilder(javaExecutable().toString(), "-cp",
                classpath, LocalProcessProvisionerFixtureMain.class.getName(),
                state.toString(), workspace.toString(),
                cliEntry.toAbsolutePath().toString()).redirectErrorStream(true)
                        .start();
        assertTrue(child.waitFor(15, TimeUnit.SECONDS));
        String output = new String(child.getInputStream().readAllBytes(),
                StandardCharsets.UTF_8);
        assertEquals(0, child.exitValue(), output);
        String marker = "P3_LOCAL_RUNTIME_PID=";
        int markerIndex = output.indexOf(marker);
        assertTrue(markerIndex >= 0, output);
        long processId = Long.parseLong(output.substring(
                markerIndex + marker.length()).trim());
        try {
            provisioner = provisioner(1);
            RuntimeProvisionRequest request =
                    LocalProcessProvisionerFixtureMain.request(provisioner,
                            workspace);
            RuntimeProvisionSeed seed =
                    LocalProcessProvisionerFixtureMain.seed();
            RuntimeResourceHandle adopted = provisioner.ensureResource(request,
                    seed, null).toCompletableFuture()
                    .get(5, TimeUnit.SECONDS);
            RuntimeObservation observation = readyObservation(provisioner,
                    request, seed, adopted);

            assertEquals(processId,
                    ((Number) adopted.getValue().get("pid")).longValue());
            assertEquals(RuntimeObservation.Outcome.READY,
                    observation.getOutcome());
            assertEquals(0, provisioner.getPhysicalStartCount());

            RuntimeLease lease = new RuntimeLease(
                    observation.getRuntimeInstanceId(),
                    observation.getEndpoint(), seed.getToken(),
                    observation.getLeaseId(), observation.getEpoch());
            provisioner.release(new RuntimeResourceContext(request, seed,
                    adopted, lease)).toCompletableFuture()
                    .get(5, TimeUnit.SECONDS);
        } finally {
            ProcessHandle.of(processId).filter(ProcessHandle::isAlive)
                    .ifPresent(ProcessHandle::destroyForcibly);
        }
    }

    @Test
    void templateDigestIncludesEnvironmentIndependentOfMapOrder()
            throws Exception {
        LocalProcessRuntimeProvisioner first = provisioner(1,
                Map.of("ALPHA", "one", "BETA", "two"));
        LocalProcessRuntimeProvisioner reordered = provisioner(1,
                new java.util.LinkedHashMap<>(Map.of("BETA", "two",
                        "ALPHA", "one")));
        LocalProcessRuntimeProvisioner changed = provisioner(1,
                Map.of("ALPHA", "one", "BETA", "changed"));
        try {
            assertEquals(first.runtimeTemplateDigest(),
                    reordered.runtimeTemplateDigest());
            assertNotEquals(first.runtimeTemplateDigest(),
                    changed.runtimeTemplateDigest());
        } finally {
            first.close();
            reordered.close();
            changed.close();
        }
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
        return provisioner(maximumRuntimes, workerArguments, startupTimeout,
                Map.of());
    }

    private LocalProcessRuntimeProvisioner provisioner(int maximumRuntimes,
            Map<String, String> environment) throws Exception {
        return provisioner(maximumRuntimes, List.of(), Duration.ofSeconds(5),
                environment);
    }

    private LocalProcessRuntimeProvisioner provisioner(int maximumRuntimes,
            List<String> workerArguments, Duration startupTimeout,
            Map<String, String> environment) throws Exception {
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
                cliEntry.toAbsolutePath(), environment, maximumRuntimes,
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

    private static RuntimeObservation readyObservation(
            LocalProcessRuntimeProvisioner target,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        RuntimeObservation observation;
        do {
            observation = target.reconcile(request, seed, handle, null)
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
            if (observation.getOutcome()
                    == RuntimeObservation.Outcome.READY) {
                return observation;
            }
            Thread.sleep(25);
        } while (System.nanoTime() < deadline);
        throw new AssertionError("Runtime did not become ready: "
                + observation.getOutcome());
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
