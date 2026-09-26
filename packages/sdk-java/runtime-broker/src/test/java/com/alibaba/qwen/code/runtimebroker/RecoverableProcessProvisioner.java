package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * The production {@link LocalProcessRuntimeProvisioner} plus the one thing
 * it lacks for a Broker restart: a record of each worker's pid and endpoint
 * that a later Broker process can observe. The production provisioner still
 * starts, attests and owns every worker. For a lease this process does not
 * own, a recorded process that is alive and re-attests is READY, a recorded
 * process that is gone is NOT_FOUND, and a missing record proves nothing.
 * Durable local adoption is follow-up work in production; this stands in for
 * it so the gates can drive the service's adoption and takeover paths
 * against real workers.
 */
final class RecoverableProcessProvisioner implements RuntimeProvisioner {
    private static final Duration TIMEOUT = Duration.ofSeconds(60);
    private static final Set<String> IDENTITY_FAILURES = Set.of(
            "managed_runtime_identity_conflict",
            "managed_runtime_unauthorized");

    private final LocalProcessRuntimeProvisioner local;
    private final HttpRuntimeTransport transport;
    private final Path records;
    private final ConcurrentMap<Path, RuntimeProvisionSeed> adopted =
            new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool(
            task -> {
                Thread thread = new Thread(task, "recoverable-provisioner");
                thread.setDaemon(true);
                return thread;
            });

    RecoverableProcessProvisioner(LocalProcessRuntimeProvisioner local,
            HttpRuntimeTransport transport, Path records) {
        this.local = local;
        this.transport = transport;
        this.records = records;
    }

    @Override
    public String kind() {
        return local.kind();
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request) {
        return CompletableFuture.failedFuture(new UnsupportedOperationException(
                "only durable placements are recoverable"));
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return CompletableFuture.supplyAsync(() -> start(request, seed),
                executor);
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle knownHandle) {
        return local.ensureResource(request, seed, knownHandle);
    }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
        return local.reconcile(request, seed, handle, lastLease)
                .thenApplyAsync(observed -> observed.getOutcome()
                        != RuntimeObservation.Outcome.UNKNOWN
                        || seed == null || lastLease == null ? observed
                                : observeRecord(request, seed, handle,
                                        lastLease, observed), executor);
    }

    @Override
    public CompletionStage<Void> confirm(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        if (local.isUsable(lease)) {
            return local.confirm(request, lease);
        }
        return CompletableFuture.runAsync(() -> {
            RuntimeProvisionSeed seed = adopted.get(file(lease));
            if (seed == null || alive(lease) == null) {
                throw new RuntimeBrokerException(503,
                        "runtime_provision_failed",
                        "Managed Runtime process is not alive.", true);
            }
            attest(request, seed, lease);
        }, executor);
    }

    @Override
    public CompletionStage<Void> release(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        local.release(request, lease);
        ProcessHandle process = alive(lease);
        if (process != null) {
            ProcessTrees.kill(process, TIMEOUT);
        }
        adopted.remove(file(lease));
        try {
            Files.deleteIfExists(file(lease));
        } catch (IOException ignored) {
            // A stale record only ever observes a dead process.
        }
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public boolean isUsable(RuntimeLease lease) {
        return local.isUsable(lease) || alive(lease) != null;
    }

    @Override
    public void close() {
        local.close();
        executor.shutdownNow();
    }

    private synchronized RuntimeLease start(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed) {
        Set<Long> before = ProcessTrees.childPids();
        RuntimeLease lease = await(local.provision(request, seed));
        // This lock is the only way this JVM starts a child, so the one new
        // child is the worker the production provisioner just adopted.
        List<ProcessHandle> started = ProcessHandle.current().children()
                .filter(process -> !before.contains(process.pid())
                        && ProcessTrees.running(process))
                .toList();
        if (started.size() != 1) {
            local.release(request, lease);
            throw new RuntimeBrokerException(503, "runtime_provision_failed",
                    "Managed Runtime worker process is ambiguous.", true);
        }
        ProcessHandle worker = started.get(0);
        JSONObject record = new JSONObject();
        record.put("pid", worker.pid());
        record.put("start", startMillis(worker));
        try {
            Files.writeString(file(lease), record.toJSONString());
        } catch (IOException exception) {
            local.release(request, lease);
            throw new RuntimeBrokerException(503, "runtime_provision_failed",
                    "Managed Runtime worker record was not written.", true,
                    exception);
        }
        return lease;
    }

    private RuntimeObservation observeRecord(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
            RuntimeLease lastLease, RuntimeObservation unknown) {
        if (!Files.exists(file(lastLease))) {
            return unknown;
        }
        if (alive(lastLease) == null) {
            return RuntimeObservation.notFound();
        }
        try {
            attest(request, seed, lastLease);
        } catch (RuntimeBrokerException failure) {
            return IDENTITY_FAILURES.contains(failure.getCode())
                    ? RuntimeObservation.conflict(handle) : unknown;
        }
        adopted.put(file(lastLease), seed);
        RuntimeResourceHandle readyHandle = handle != null ? handle
                : new RuntimeResourceHandle(kind(), 1,
                        Map.of("provider", kind()));
        return RuntimeObservation.ready(readyHandle, lastLease.getEndpoint(),
                lastLease.getRuntimeInstanceId(), lastLease.getLeaseId(),
                lastLease.getEpoch());
    }

    private ProcessHandle alive(RuntimeLease lease) {
        JSONObject record;
        try {
            record = JSON.parseObject(Files.readString(file(lease)));
        } catch (NoSuchFileException missing) {
            return null;
        } catch (IOException exception) {
            throw new IllegalStateException(exception);
        }
        long start = record.getLongValue("start");
        return ProcessHandle.of(record.getLongValue("pid"))
                .filter(ProcessTrees::running)
                .filter(process -> startMillis(process) == start)
                .orElse(null);
    }

    private void attest(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeLease lease) {
        await(transport.attest(lease, request, seed));
    }

    private Path file(RuntimeLease lease) {
        String identity = lease.getRuntimeInstanceId() + "\n"
                + lease.getEndpoint() + "\n" + lease.getLeaseId() + "\n"
                + lease.getEpoch();
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                    identity.getBytes(StandardCharsets.UTF_8));
            return records.resolve(HexFormat.of().formatHex(digest)
                    + ".json");
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        }
    }

    private static long startMillis(ProcessHandle process) {
        return process.info().startInstant().map(Instant::toEpochMilli)
                .orElse(-1L);
    }

    private static <T> T await(CompletionStage<T> stage) {
        try {
            return stage.toCompletableFuture().get(TIMEOUT.toMillis(),
                    TimeUnit.MILLISECONDS);
        } catch (ExecutionException exception) {
            if (exception.getCause() instanceof RuntimeException failure) {
                throw failure;
            }
            throw new IllegalStateException(exception.getCause());
        } catch (Exception exception) {
            throw new IllegalStateException(exception);
        }
    }
}
