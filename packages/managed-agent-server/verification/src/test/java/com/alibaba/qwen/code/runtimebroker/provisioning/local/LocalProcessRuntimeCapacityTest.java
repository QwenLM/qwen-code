package com.alibaba.qwen.code.runtimebroker.provisioning.local;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LocalProcessRuntimeCapacityTest {
    @TempDir
    Path directory;

    @Test
    void refusesExcessStartupWithoutSpawningAndKeepsCancelledStartupCounted() throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        Path script = directory.resolve("waiting-worker.mjs");
        Files.writeString(script, """
                import { renameSync, writeFileSync } from 'node:fs';
                import { join } from 'node:path';
                let input = '';
                process.stdin.setEncoding('utf8');
                process.stdin.on('data', chunk => input += chunk);
                process.stdin.on('end', () => {
                  const boot = JSON.parse(input);
                  const marker = join(process.argv[2], boot.leaseId + '.pid');
                  writeFileSync(marker + '.tmp', String(process.pid));
                  renameSync(marker + '.tmp', marker);
                  setInterval(() => {}, 1000);
                });
                """);
        RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
                "sha256:" + "a".repeat(64), "workspace");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope, null, "local-process");
        List<RuntimeProvisionSeed> seeds = new ArrayList<>();
        List<CompletableFuture<RuntimeLease>> starts = new ArrayList<>();
        try (var provisioner = new LocalProcessRuntimeProvisioner(
                List.of("node", script.toString(), directory.toString()), directory, new HttpRuntimeTransport())) {
            for (int index = 0; index < 16; index++) {
                RuntimeProvisionSeed seed = RuntimeProvisionSeed.create("binding-" + index, 1);
                seeds.add(seed);
                starts.add(provisioner.provision(request, seed).toCompletableFuture());
            }
            await().atMost(Duration.ofSeconds(15)).until(() -> workerCount() == 16);
            RuntimeProvisionSeed overflow = RuntimeProvisionSeed.create("overflow", 1);
            assertCapacity(provisioner.provision(request, overflow));
            assertFalse(Files.exists(marker(overflow)), "capacity refusal must precede process creation");

            assertTrue(starts.getFirst().cancel(true));
            assertTrue(worker(seeds.getFirst()).isAlive());
            assertCapacity(provisioner.provision(request, overflow));
            assertEquals(16, workerCount(), "cancelling the stage must not free a running startup slot");

            ProcessHandle failedWorker = worker(seeds.get(1));
            failedWorker.destroyForcibly();
            failedWorker.onExit().get(5, TimeUnit.SECONDS);
            assertNotEquals("runtime_local_capacity", failure(starts.get(1)).getCode());
            var retry = new AtomicReference<CompletableFuture<RuntimeLease>>();
            await().atMost(Duration.ofSeconds(5)).until(() -> {
                CompletableFuture<RuntimeLease> candidate = provisioner.provision(request, overflow).toCompletableFuture();
                if (candidate.isCompletedExceptionally()) {
                    assertCapacity(candidate);
                    return false;
                }
                retry.set(candidate);
                return true;
            });
            await().atMost(Duration.ofSeconds(5)).until(() -> Files.exists(marker(overflow)));
            assertFalse(retry.get().isDone(), "a released slot must admit the next worker handshake");
            ProcessHandle retryWorker = worker(overflow);
            retryWorker.destroyForcibly();
            retryWorker.onExit().get(5, TimeUnit.SECONDS);
            assertNotEquals("runtime_local_capacity", failure(retry.get()).getCode());
        }
        try (var markers = Files.list(directory)) {
            for (Path marker : markers.filter(path -> path.toString().endsWith(".pid")).toList()) {
                long pid = Long.parseLong(Files.readString(marker));
                await().atMost(Duration.ofSeconds(5)).until(() -> ProcessHandle.of(pid)
                        .map(process -> !process.isAlive()).orElse(true));
            }
        }
    }

    private long workerCount() throws Exception {
        try (var files = Files.list(directory)) {
            return files.filter(path -> path.toString().endsWith(".pid")).count();
        }
    }

    private Path marker(RuntimeProvisionSeed seed) {
        return directory.resolve(seed.getLeaseId() + ".pid");
    }

    private ProcessHandle worker(RuntimeProvisionSeed seed) throws Exception {
        return ProcessHandle.of(Long.parseLong(Files.readString(marker(seed)))).orElseThrow();
    }

    private static void assertCapacity(CompletionStage<?> stage) {
        RuntimeBrokerException failure = failure(stage);
        assertEquals(503, failure.getStatusCode());
        assertEquals("runtime_local_capacity", failure.getCode());
        assertTrue(failure.isRetryable());
    }

    private static RuntimeBrokerException failure(CompletionStage<?> stage) {
        ExecutionException failure = assertThrows(ExecutionException.class,
                () -> stage.toCompletableFuture().get(2, TimeUnit.SECONDS));
        return assertInstanceOf(RuntimeBrokerException.class, failure.getCause());
    }
}
