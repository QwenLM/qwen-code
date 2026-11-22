package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.fastjson2.JSON;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LocalProcessExecutorTest {
    @TempDir
    Path directory;

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void rejectedOperationsFailAsynchronouslyAndAdmissionRecovers() throws Exception {
        var store = new LocalRuntimeStore(directory.toRealPath(), DurableLocalProcessRuntimeProvisionerTest.HOST);
        var request = request();
        var seed = RuntimeProvisionSeed.create("binding", 1);
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:1"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var binding = new RuntimeBindingRecord("binding", request, seed, 1, RuntimeBindingRecord.State.DRAINING,
                null, null, 0, true, null, null, 0, 0, null, Instant.now(), Instant.now());
        try (var provider = new LocalProcessRuntimeProvisioner(List.of("must-not-run"), directory,
                new HttpRuntimeTransport(), null, store)) {
            try (var blocked = new Saturation(pool(provider, "executor"), 16)) {
                assertOperationsRejected(provider, request, seed, lease, binding);
            }
            var handle = provider.ensureResource(request, seed, null).toCompletableFuture().get(5, TimeUnit.SECONDS);
            assertEquals("local-process", handle.getKind());
            provider.close();
            assertOperationsRejected(provider, request, seed, lease, binding);
        }
    }

    private static void assertOperationsRejected(LocalProcessRuntimeProvisioner provider,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed, RuntimeLease lease,
            RuntimeBindingRecord binding) throws Exception {
        for (var stage : List.of(provider.provision(request), provider.provision(request, seed),
                provider.ensureResource(request, seed, null), provider.reconcile(request, seed, null, lease),
                provider.confirm(request, lease), provider.stopDrained(binding))) {
            assertCapacityFailure(stage);
        }
    }

    @Test
    void readerRejectionSpawnsNothingAndCapacityRecovers() throws Exception {
        Path marker = directory.resolve("spawned");
        Path script = directory.resolve("worker.mjs");
        Files.writeString(script, "import {writeFileSync} from 'node:fs';writeFileSync("
                + JSON.toJSONString(marker.toString()) + ", 'spawned');await import("
                + JSON.toJSONString(workerScript().toUri().toString()) + ");");
        try (var provider = new LocalProcessRuntimeProvisioner(List.of("node", script.toString()), directory,
                new HttpRuntimeTransport())) {
            try (var blocked = new Saturation(pool(provider, "readers"), 64)) {
                assertCapacityFailure(provider.provision(request()));
                assertFalse(Files.exists(marker));
            }
            var lease = provider.provision(request()).toCompletableFuture().get(10, TimeUnit.SECONDS);
            assertTrue(Files.exists(marker));
            assertTrue(provider.isUsable(lease));
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    @DisabledOnOs(OS.WINDOWS)
    void stdoutAndReleaseRemainLiveWhenOperationsAreSaturated(boolean saturateStops) throws Exception {
        Path trigger = directory.resolve("flood");
        Path drained = directory.resolve("drained");
        Path script = directory.resolve("worker.mjs");
        Files.writeString(script, Files.readString(workerScript()) + "\n"
                + "const {existsSync, writeFileSync} = await import('node:fs');\n"
                + "while (!existsSync(" + JSON.toJSONString(trigger.toString())
                + ")) await new Promise(r => setTimeout(r, 10));\n"
                + "await new Promise((resolve, reject) => process.stdout.write('x'.repeat(4 * 1024 * 1024),"
                + " error => error ? reject(error) : resolve()));\n"
                + "writeFileSync(" + JSON.toJSONString(drained.toString()) + ", 'done');\n");
        try (var provider = new LocalProcessRuntimeProvisioner(
                List.of("node", script.toString(), "--ignore-term"), directory, new HttpRuntimeTransport())) {
            var lease = provider.provision(request()).toCompletableFuture().get(10, TimeUnit.SECONDS);
            try (var operations = new Saturation(pool(provider, "executor"), 16);
                    var stops = saturateStops ? new Saturation(pool(provider, "stops"), 4) : null) {
                Files.writeString(trigger, "go");
                await().atMost(5, TimeUnit.SECONDS).until(() -> Files.exists(drained));
                assertTrue(provider.isUsable(lease));
                provider.release(request(), lease).toCompletableFuture().get(1, TimeUnit.SECONDS);
                await().atMost(saturateStops ? 3 : 8, TimeUnit.SECONDS)
                        .until(() -> pool(provider, "readers").getActiveCount() == 0);
                assertFalse(provider.isUsable(lease));
            }
        }
    }

    @Test
    void closeSettlesAnInFlightHandshakeAndTerminatesItsReader() throws Exception {
        Path marker = directory.resolve("pid");
        Path script = directory.resolve("waiting.mjs");
        Files.writeString(script, "import {writeFileSync} from 'node:fs';writeFileSync("
                + JSON.toJSONString(marker.toString()) + ", String(process.pid));"
                + "process.stdin.resume();setInterval(() => {}, 1000);");
        try (var provider = new LocalProcessRuntimeProvisioner(List.of("node", script.toString()), directory,
                new HttpRuntimeTransport())) {
            var pending = provider.provision(request()).toCompletableFuture();
            await().atMost(5, TimeUnit.SECONDS).until(() -> Files.exists(marker));
            long pid = Long.parseLong(Files.readString(marker));
            provider.close();
            assertThrows(ExecutionException.class, () -> pending.get(5, TimeUnit.SECONDS));
            for (String name : List.of("executor", "readers", "stops")) {
                assertTrue(pool(provider, name).awaitTermination(5, TimeUnit.SECONDS));
            }
            assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
        }
    }

    private RuntimeProvisionRequest request() {
        var scope = new RuntimeScope("tenant", "workspace", "1", directory.toAbsolutePath().toString(),
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        return new RuntimeProvisionRequest(scope, "harness", "local-process", "storage:a");
    }

    private static Path workerScript() {
        return Path.of("src/test/resources/fake-attestation-worker.mjs").toAbsolutePath();
    }

    static ThreadPoolExecutor pool(LocalProcessRuntimeProvisioner provider, String name) throws Exception {
        var field = LocalProcessRuntimeProvisioner.class.getDeclaredField(name);
        field.setAccessible(true);
        return (ThreadPoolExecutor) field.get(provider);
    }

    private static void assertCapacityFailure(CompletionStage<?> stage) {
        var error = assertThrows(ExecutionException.class, () -> stage.toCompletableFuture().get(1, TimeUnit.SECONDS));
        var failure = assertInstanceOf(RuntimeBrokerException.class, error.getCause());
        assertEquals(503, failure.getStatusCode());
        assertEquals("runtime_local_capacity", failure.getCode());
        assertTrue(failure.isRetryable());
        assertTrue(failure.getMessage().contains("capacity or closed"));
    }

    static final class Saturation implements AutoCloseable {
        private final ThreadPoolExecutor executor;
        private final CountDownLatch release = new CountDownLatch(1);
        private final CountDownLatch finished;

        Saturation(ThreadPoolExecutor executor, int maximum) throws Exception {
            this.executor = executor;
            this.finished = new CountDownLatch(maximum);
            assertEquals(maximum, executor.getMaximumPoolSize());
            CountDownLatch entered = new CountDownLatch(maximum);
            for (int index = 0; index < maximum; index++) {
                executor.execute(() -> {
                    entered.countDown();
                    try {
                        release.await();
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    } finally {
                        finished.countDown();
                    }
                });
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS));
        }

        @Override
        public void close() throws Exception {
            release.countDown();
            assertTrue(finished.await(5, TimeUnit.SECONDS));
            await().atMost(5, TimeUnit.SECONDS).until(() -> executor.getActiveCount() == 0);
        }
    }
}
