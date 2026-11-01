package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Both worker launch paths must inherit the server environment through the
 * filter. The surefire configuration sets the probe variables; a worker that
 * records its own environment proves what actually reached it.
 */
class WorkerEnvironmentRoutingTest {
    private static final List<String> REMOVED = List.of("QWEN_MANAGED_AGENT_WORKER_ENV_PROBE",
            "spring_worker_env_probe", "QWEN_MANAGEDAGENT_WORKER_ENV_PROBE", "OSS_WORKER_ENV_PROBE");
    private static final List<String> KEPT = List.of("WORKER_ENV_PASSTHROUGH_PROBE",
            "ALIBABA_CLOUD_WORKER_ENV_PROBE");

    @TempDir
    Path directory;

    @Test
    void nonDurableWorkersStartWithoutControlPlaneSettings() throws Exception {
        assumeProbes();
        Path names = directory.resolve("names");
        Throwable launchFailure;
        try (var provisioner = new LocalProcessRuntimeProvisioner(worker(names), directory,
                new HttpRuntimeTransport(), ignored -> "storage:a")) {
            launchFailure = awaitFailure(provisioner.provision(request(), RuntimeProvisionSeed.create("binding", 1)));
        }
        assertFiltered(names, launchFailure);
    }

    @DisabledOnOs(OS.WINDOWS)
    @Test
    void durableWorkersStartWithoutControlPlaneSettings() throws Exception {
        assumeProbes();
        Path names = directory.resolve("names");
        var store = new LocalRuntimeStore(directory.toRealPath(), DurableLocalProcessRuntimeProvisionerTest.HOST);
        Throwable launchFailure;
        try (var provisioner = new LocalProcessRuntimeProvisioner(worker(names), directory,
                new HttpRuntimeTransport(), ignored -> "storage:a", store)) {
            // Without a seed the store records the launch intent the durable path requires.
            launchFailure = awaitFailure(provisioner.provision(request()));
        }
        assertTrue(recordedLaunch(directory), "the durable path records its launch in the store");
        assertFiltered(names, launchFailure);
    }

    private static boolean recordedLaunch(Path directory) throws Exception {
        try (var entries = Files.list(directory)) {
            return entries.anyMatch(entry -> entry.getFileName().toString().endsWith(".json"));
        }
    }

    private static void assumeProbes() {
        LocalProcessRuntimeProvisionerTest.requireNode();
        boolean present = KEPT.stream().allMatch(name -> System.getenv(name) != null)
                && REMOVED.stream().allMatch(name -> System.getenv(name) != null);
        // The surefire block is the only writer of these names. An IDE run should
        // skip, but a CI run without them means the pin was dropped, so it fails.
        if (!present && "true".equals(System.getenv("GITHUB_ACTIONS"))) {
            throw new AssertionError("the surefire configuration sets the worker environment probes");
        }
        assumeTrue(present, "the surefire configuration sets the worker environment probes");
    }

    private List<String> worker(Path names) throws Exception {
        Path script = Files.writeString(directory.resolve("env-worker.mjs"), "import {writeFileSync} from 'node:fs';"
                + "writeFileSync(process.argv[2], Object.keys(process.env).join('\\n'));process.exit(1);");
        return List.of("node", script.toString(), names.toString());
    }

    private RuntimeProvisionRequest request() {
        return new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1",
                directory.toAbsolutePath().toString(), WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session"),
                "harness", com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS, "storage:a");
    }

    private static Throwable awaitFailure(CompletionStage<?> launch) {
        try {
            launch.toCompletableFuture().get(
                    LocalProcessRuntimeProvisioner.READY_TIMEOUT.plusSeconds(10).toMillis(),
                    TimeUnit.MILLISECONDS);
        } catch (InterruptedException expected) {
            Thread.currentThread().interrupt();
            return expected;
        } catch (ExecutionException | TimeoutException expected) {
            // The worker records its environment and exits non-zero, so the launch fails.
            return expected;
        }
        return null;
    }

    private static void assertFiltered(Path names, Throwable launchFailure) throws Exception {
        assertTrue(Files.isRegularFile(names), () -> "the worker was spawned and recorded its environment;"
                + " the launch failed with " + launchFailure);
        List<String> inherited = Files.readAllLines(names);
        for (String name : REMOVED) {
            assertFalse(inherited.contains(name), name + " reached the worker");
        }
        for (String name : KEPT) {
            assertTrue(inherited.contains(name), name + " must still reach the worker");
        }
    }
}
