package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

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
            "spring_worker_env_probe");
    private static final String KEPT = "WORKER_ENV_PASSTHROUGH_PROBE";

    @TempDir
    Path directory;

    @Test
    void nonDurableWorkersStartWithoutControlPlaneSettings() throws Exception {
        assumeProbes();
        Path names = directory.resolve("names");
        try (var provisioner = new LocalProcessRuntimeProvisioner(worker(names), directory,
                new HttpRuntimeTransport(), ignored -> "storage:a")) {
            awaitFailure(provisioner.provision(request(), RuntimeProvisionSeed.create("binding", 1)));
        }
        assertFiltered(names);
    }

    @Test
    void durableWorkersStartWithoutControlPlaneSettings() throws Exception {
        assumeProbes();
        Path names = directory.resolve("names");
        var store = new LocalRuntimeStore(directory.toRealPath(), DurableLocalProcessRuntimeProvisionerTest.HOST);
        try (var provisioner = new LocalProcessRuntimeProvisioner(worker(names), directory,
                new HttpRuntimeTransport(), ignored -> "storage:a", store)) {
            // Without a seed the store records the launch intent the durable path requires.
            awaitFailure(provisioner.provision(request()));
        }
        assertFiltered(names);
    }

    private static void assumeProbes() {
        assumeTrue(System.getenv(KEPT) != null && REMOVED.stream().allMatch(name -> System.getenv(name) != null),
                "the surefire configuration sets the worker environment probes");
    }

    private List<String> worker(Path names) throws Exception {
        Path script = Files.writeString(directory.resolve("env-worker.mjs"), "import {writeFileSync} from 'node:fs';"
                + "writeFileSync(process.argv[2], Object.keys(process.env).join('\\n'));process.exit(1);");
        return List.of("node", script.toString(), names.toString());
    }

    private RuntimeProvisionRequest request() {
        return new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1",
                directory.toAbsolutePath().toString(), WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session"),
                "harness", LocalProcessRuntimeProvisioner.KIND, "storage:a");
    }

    private static void awaitFailure(java.util.concurrent.CompletionStage<?> launch) {
        try {
            launch.toCompletableFuture().get(30, TimeUnit.SECONDS);
        } catch (Exception expected) {
            // The worker exits after recording its environment, so the launch fails.
        }
    }

    private static void assertFiltered(Path names) throws Exception {
        assertTrue(Files.isRegularFile(names), "the worker was spawned");
        List<String> inherited = Files.readAllLines(names);
        for (String name : REMOVED) {
            assertFalse(inherited.contains(name), name + " reached the worker");
        }
        assertTrue(inherited.contains(KEPT), "an unrelated variable must still reach the worker");
    }
}
