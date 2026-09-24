package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSONObject;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Starts the merged attestation worker over stdin and returns a lease only
 * after that process attests as the same identity.
 */
public final class LocalProcessRuntimeProvisioner
        implements RuntimeProvisioner {
    private static final Duration READY_TIMEOUT = Duration.ofSeconds(30);
    private static final int READY_RECORD_LIMIT = 32 * 1024;
    private static final Pattern CAPABILITY_DIGEST =
            Pattern.compile("sha256:[0-9a-f]{64}");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final List<String> command;
    private final Path workingDirectory;
    private final HttpRuntimeTransport transport;
    private final ExecutorService executor = Executors.newCachedThreadPool(
            task -> {
                Thread thread = new Thread(task, "runtime-provisioner");
                thread.setDaemon(true);
                return thread;
            });
    private final ConcurrentMap<String, OwnedProcess> owned =
            new ConcurrentHashMap<>();

    public LocalProcessRuntimeProvisioner(List<String> command,
            Path workingDirectory, HttpRuntimeTransport transport) {
        if (command == null || command.isEmpty() || workingDirectory == null
                || transport == null) {
            throw new IllegalArgumentException(
                    "worker command, directory, and transport are required");
        }
        this.command = List.copyOf(command);
        this.workingDirectory = workingDirectory;
        this.transport = transport;
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request) {
        return CompletableFuture.supplyAsync(() -> start(request), executor);
    }

    @Override
    public CompletionStage<Void> confirm(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        return CompletableFuture.runAsync(() -> attestOwned(request, lease),
                executor);
    }

    @Override
    public CompletionStage<Void> release(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        stop(lease);
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public boolean isUsable(RuntimeLease lease) {
        OwnedProcess process = owned.get(lease.getRuntimeInstanceId());
        return process != null && process.process.isAlive();
    }

    void stop(RuntimeLease lease) {
        OwnedProcess process = owned.remove(lease.getRuntimeInstanceId());
        if (process != null) {
            process.process.destroy();
        }
    }

    @Override
    public void close() {
        for (OwnedProcess process : owned.values()) {
            process.process.destroy();
        }
        owned.clear();
        executor.shutdownNow();
    }

    private RuntimeLease start(RuntimeProvisionRequest request) {
        OwnedProcess ownedProcess = null;
        boolean adopted = false;
        try {
            String runtimeInstanceId = UUID.randomUUID().toString();
            String runtimeIncarnation = UUID.randomUUID().toString();
            String leaseId = UUID.randomUUID().toString();
            String provisionRequestId = UUID.randomUUID().toString();
            byte[] tokenBytes = new byte[32];
            RANDOM.nextBytes(tokenBytes);
            String token = Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(tokenBytes);
            RuntimeScope scope = request.getScope();
            if (!CAPABILITY_DIGEST.matcher(scope.getCapabilityDigest())
                    .matches()) {
                throw new RuntimeBrokerException(400,
                        "runtime_provision_failed",
                        "capabilityDigest is not a sha256 digest.", false);
            }
            JSONObject boot = new JSONObject();
            boot.put("capabilityDigest", scope.getCapabilityDigest());
            boot.put("epoch", 1);
            boot.put("isolationClass", scope.getIsolationClass());
            boot.put("leaseId", leaseId);
            boot.put("provisionRequestId", provisionRequestId);
            boot.put("runtimeIncarnation", runtimeIncarnation);
            boot.put("runtimeInstanceId", runtimeInstanceId);
            boot.put("tenantId", scope.getTenantId());
            boot.put("token", token);
            boot.put("type", "boot");
            boot.put("version", 1);
            boot.put("workspaceCwd", scope.getCanonicalCwd());
            boot.put("workspaceGeneration", scope.getWorkspaceGeneration());
            boot.put("workspaceId", scope.getWorkspaceId());
            Process process = new ProcessBuilder(command)
                    .directory(workingDirectory.toFile())
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
            ownedProcess = new OwnedProcess(process,
                    new RuntimeProvisionSeed(provisionRequestId,
                            runtimeInstanceId, runtimeIncarnation, leaseId,
                            1, token));
            process.getOutputStream().write(boot.toJSONString()
                    .getBytes(StandardCharsets.UTF_8));
            process.getOutputStream().close();
            String readyLine = readReadyLine(process);
            Map<String, Object> ready = JsonCodec.parseObject(
                    readyLine.getBytes(StandardCharsets.UTF_8),
                    "Managed Runtime ready record");
            if (!"ready".equals(ready.get("type"))
                    || !Long.valueOf(1L).equals(number(ready.get("version")))
                    || !runtimeInstanceId.equals(
                            ready.get("runtimeInstanceId"))
                    || !runtimeIncarnation.equals(
                            ready.get("runtimeIncarnation"))
                    || !leaseId.equals(ready.get("leaseId"))
                    || !Long.valueOf(1L).equals(number(ready.get("epoch")))) {
                throw failed("Managed Runtime ready record is invalid.");
            }
            RuntimeLease lease = new RuntimeLease(runtimeInstanceId,
                    URI.create(String.valueOf(ready.get("url"))), token,
                    leaseId, 1);
            attest(request, ownedProcess.seed, lease);
            owned.put(runtimeInstanceId, ownedProcess);
            adopted = true;
            return lease;
        } catch (IOException exception) {
            throw failed("Managed Runtime worker failed to start.",
                    exception);
        } finally {
            if (!adopted && ownedProcess != null) {
                ownedProcess.process.destroyForcibly();
            }
        }
    }

    private void attestOwned(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        OwnedProcess process = owned.get(lease.getRuntimeInstanceId());
        if (process == null || !process.process.isAlive()) {
            throw failed("Managed Runtime process is not alive.");
        }
        attest(request, process.seed, lease);
    }

    private void attest(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeLease lease) {
        try {
            transport.attest(lease, request, seed).toCompletableFuture()
                    .get(READY_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        } catch (ExecutionException exception) {
            if (exception
                    .getCause() instanceof RuntimeBrokerException failure) {
                throw failure;
            }
            throw failed("Managed Runtime attestation failed.", exception);
        } catch (Exception exception) {
            throw failed("Managed Runtime attestation failed.", exception);
        }
    }

    private static String readReadyLine(Process process) throws IOException {
        CompletableFuture<String> line = new CompletableFuture<>();
        Thread reader = new Thread(() -> {
            BufferedReader input = new BufferedReader(new InputStreamReader(
                    process.getInputStream(), StandardCharsets.UTF_8));
            try {
                line.complete(readLine(input, true));
            } catch (Throwable throwable) {
                line.completeExceptionally(throwable);
            }
            // The worker treats a closed stdout pipe as fatal, so keep the
            // pipe open and drained for the worker's lifetime.
            try {
                while (readLine(input, false) != null) {
                    // Discard everything the worker prints after ready.
                }
            } catch (Throwable ignored) {
                // The worker is gone; nothing left to drain.
            }
        }, "runtime-ready");
        reader.setDaemon(true);
        reader.start();
        String ready;
        try {
            ready = line.get(READY_TIMEOUT.toMillis(),
                    TimeUnit.MILLISECONDS);
        } catch (Exception exception) {
            process.destroyForcibly();
            if (exception instanceof ExecutionException
                    && exception
                            .getCause() instanceof RuntimeBrokerException failure) {
                throw failure;
            }
            throw failed("Managed Runtime worker did not become ready.",
                    exception);
        }
        if (ready == null) {
            process.destroyForcibly();
            throw failed("Managed Runtime worker closed before ready.");
        }
        return ready;
    }

    private static String readLine(BufferedReader input, boolean bounded)
            throws IOException {
        StringBuilder builder = new StringBuilder();
        boolean any = false;
        while (true) {
            int value = input.read();
            if (value == -1) {
                return any ? builder.toString() : null;
            }
            any = true;
            if (value == '\n') {
                return builder.toString();
            }
            if (value == '\r') {
                continue;
            }
            if (builder.length() >= READY_RECORD_LIMIT) {
                if (bounded) {
                    throw failed("Managed Runtime ready record exceeds the "
                            + "32 KiB limit.");
                }
                continue;
            }
            builder.append((char) value);
        }
    }

    private static Long number(Object value) {
        return value instanceof Number number ? number.longValue() : null;
    }

    private static RuntimeBrokerException failed(String message) {
        return failed(message, null);
    }

    private static RuntimeBrokerException failed(String message,
            Throwable cause) {
        return new RuntimeBrokerException(503, "runtime_provision_failed",
                message, true, cause);
    }

    private record OwnedProcess(Process process, RuntimeProvisionSeed seed) {
    }
}
