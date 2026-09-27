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
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Starts the merged attestation worker over stdin and returns a lease only
 * after that process attests as the same identity.
 */
public final class LocalProcessRuntimeProvisioner
        implements RuntimeProvisioner {
    static final String KIND = "local-process";
    private static final Duration READY_TIMEOUT = Duration.ofSeconds(30);
    private static final int READY_RECORD_LIMIT = 32 * 1024;
    private static final Pattern CAPABILITY_DIGEST =
            Pattern.compile("sha256:[0-9a-f]{64}");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final List<String> command;
    private final Path workingDirectory;
    private final HttpRuntimeTransport transport;
    private final Function<RuntimeScope, String> storageResolver;
    private final ExecutorService executor = Executors.newCachedThreadPool(
            task -> {
                Thread thread = new Thread(task, "runtime-provisioner");
                thread.setDaemon(true);
                return thread;
            });
    private final ConcurrentMap<List<Object>, OwnedProcess> owned =
            new ConcurrentHashMap<>();
    private final Set<List<Object>> issued = ConcurrentHashMap.newKeySet();

    public LocalProcessRuntimeProvisioner(List<String> command,
            Path workingDirectory, HttpRuntimeTransport transport) {
        this(command, workingDirectory, transport, null);
    }

    /** The optional resolver must come from trusted storage configuration. */
    public LocalProcessRuntimeProvisioner(List<String> command,
            Path workingDirectory, HttpRuntimeTransport transport,
            Function<RuntimeScope, String> storageResolver) {
        if (command == null || command.isEmpty() || workingDirectory == null
                || transport == null) {
            throw new IllegalArgumentException(
                    "worker command, directory, and transport are required");
        }
        this.command = List.copyOf(command);
        this.workingDirectory = workingDirectory;
        this.transport = transport;
        this.storageResolver = storageResolver;
    }

    @Override
    public RuntimeProvisionRequest createRequest(RuntimeScope scope,
            String isolationKey) {
        return storageResolver == null
                ? RuntimeProvisioner.super.createRequest(scope, isolationKey)
                : new RuntimeProvisionRequest(scope, isolationKey, kind(),
                        ManagedContextProtocol.storageId(storageResolver.apply(scope)));
    }

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request) {
        return CompletableFuture.supplyAsync(() -> start(request, null),
                executor);
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        if (seed == null) {
            throw new IllegalArgumentException("seed is required");
        }
        return CompletableFuture.supplyAsync(() -> start(request, seed),
                executor);
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle knownHandle) {
        if (knownHandle != null) {
            if (!KIND.equals(knownHandle.getKind())
                    || knownHandle.getVersion() != 1) {
                CompletableFuture<RuntimeResourceHandle> failed =
                        new CompletableFuture<>();
                failed.completeExceptionally(new RuntimeBrokerException(409,
                        "runtime_broker_resource_conflict",
                        "Managed Runtime resource identity conflicts.",
                        false));
                return failed;
            }
            return CompletableFuture.completedFuture(knownHandle);
        }
        return CompletableFuture.completedFuture(new RuntimeResourceHandle(
                KIND, 1, Map.of("provider", KIND)));
    }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
        return CompletableFuture.supplyAsync(
                () -> observe(request, seed, handle, lastLease), executor);
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
        OwnedProcess process = owned.get(ownershipKey(lease));
        return process != null && process.process.isAlive();
    }

    void stop(RuntimeLease lease) {
        OwnedProcess process = owned.remove(ownershipKey(lease));
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

    private RuntimeLease start(RuntimeProvisionRequest request,
            RuntimeProvisionSeed provided) {
        OwnedProcess ownedProcess = null;
        boolean adopted = false;
        try {
            RuntimeProvisionSeed seed = provided != null
                    ? provided : newSeed();
            String runtimeInstanceId = seed.getProvisionalRuntimeId();
            String runtimeIncarnation = seed.getGatewayIncarnation();
            String leaseId = seed.getLeaseId();
            String provisionRequestId = seed.getProvisionRequestId();
            String token = seed.getToken();
            long epoch = seed.getEpoch();
            RuntimeScope scope = request.getScope();
            if (!CAPABILITY_DIGEST.matcher(scope.getCapabilityDigest())
                    .matches()) {
                throw new RuntimeBrokerException(400,
                        "runtime_provision_failed",
                        "capabilityDigest is not a sha256 digest.", false);
            }
            JSONObject boot = new JSONObject();
            boot.put("capabilityDigest", scope.getCapabilityDigest());
            boot.put("epoch", epoch);
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
            Map<String, Object> document = request.isManagedContext()
                    ? ManagedContextProtocol.boot(request, seed) : boot;
            byte[] encoded = JsonCodec.encode(document);
            if (encoded.length > READY_RECORD_LIMIT) {
                throw new IllegalArgumentException("Managed Runtime boot exceeds 32 KiB.");
            }
            Process process = new ProcessBuilder(command)
                    .directory(workingDirectory.toFile())
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
            ownedProcess = new OwnedProcess(process, seed);
            process.getOutputStream().write(encoded);
            process.getOutputStream().close();
            String readyLine = readReadyLine(process);
            byte[] readyBytes = readyLine.getBytes(StandardCharsets.UTF_8);
            if (readyBytes.length > READY_RECORD_LIMIT) {
                throw failed("Managed Runtime ready record exceeds 32 KiB.");
            }
            Map<String, Object> ready = request.isManagedContext()
                    ? ManagedContextProtocol.parse(readyBytes)
                    : JsonCodec.parseObject(readyBytes,
                            "Managed Runtime ready record");
            URI endpoint;
            if (request.isManagedContext()) {
                endpoint = ManagedContextProtocol.ready(ready, document);
            } else {
                if (!"ready".equals(ready.get("type"))
                        || !Long.valueOf(1L).equals(number(ready.get("version")))
                        || !runtimeInstanceId.equals(
                                ready.get("runtimeInstanceId"))
                        || !runtimeIncarnation.equals(
                                ready.get("runtimeIncarnation"))
                        || !leaseId.equals(ready.get("leaseId"))
                        || !Long.valueOf(epoch).equals(number(ready.get("epoch")))) {
                    throw failed("Managed Runtime ready record is invalid.");
                }
                endpoint = URI.create(String.valueOf(ready.get("url")));
                if (!"http".equals(endpoint.getScheme())
                        || !"127.0.0.1".equals(endpoint.getHost())) {
                    throw failed("Managed Runtime ready record is invalid.");
                }
            }
            RuntimeLease lease = new RuntimeLease(runtimeInstanceId,
                    endpoint, token, leaseId, epoch);
            attest(request, ownedProcess.seed, lease);
            List<Object> key = ownershipKey(lease);
            // A dead worker's port can be reused, but its old lease may still
            // arrive for release. Never issue that identity again.
            if (!issued.add(key)) {
                throw new RuntimeBrokerException(409,
                        "runtime_broker_resource_conflict",
                        "Managed Runtime lease identity was already issued.",
                        false);
            }
            owned.put(key, ownedProcess);
            adopted = true;
            return lease;
        } catch (IOException | RuntimeException exception) {
            if (request.isManagedContext()) {
                throw new RuntimeBrokerException(503, "runtime_provision_failed",
                        "Managed context startup failed; recovery is blocked.",
                        false, exception);
            }
            if (exception instanceof RuntimeException failure) {
                throw failure;
            }
            throw failed("Managed Runtime worker failed to start.", exception);
        } finally {
            if (!adopted && ownedProcess != null) {
                ownedProcess.process.destroyForcibly();
            }
        }
    }

    private RuntimeObservation observe(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
            RuntimeLease lastLease) {
        if (handle != null && !KIND.equals(handle.getKind())) {
            return RuntimeObservation.conflict(handle);
        }
        if (lastLease == null || seed == null) {
            return RuntimeObservation.unknown(handle);
        }
        OwnedProcess process = owned.get(ownershipKey(lastLease));
        if (process == null) {
            return RuntimeObservation.unknown(handle);
        }
        if (!process.process.isAlive()) {
            return RuntimeObservation.notFound();
        }
        try {
            attest(request, seed, lastLease);
        } catch (RuntimeBrokerException failure) {
            if ("managed_runtime_identity_conflict".equals(failure.getCode())
                    || "managed_runtime_unauthorized".equals(
                            failure.getCode())) {
                return RuntimeObservation.conflict(handle);
            }
            return RuntimeObservation.unknown(handle);
        }
        RuntimeResourceHandle readyHandle = handle != null ? handle
                : new RuntimeResourceHandle(KIND, 1, Map.of("provider", KIND));
        return RuntimeObservation.ready(readyHandle, lastLease.getEndpoint(),
                lastLease.getRuntimeInstanceId(), lastLease.getLeaseId(),
                lastLease.getEpoch());
    }

    private static RuntimeProvisionSeed newSeed() {
        String runtimeInstanceId = UUID.randomUUID().toString();
        String runtimeIncarnation = UUID.randomUUID().toString();
        String leaseId = UUID.randomUUID().toString();
        String provisionRequestId = UUID.randomUUID().toString();
        byte[] tokenBytes = new byte[32];
        RANDOM.nextBytes(tokenBytes);
        String token = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(tokenBytes);
        return new RuntimeProvisionSeed(provisionRequestId, runtimeInstanceId,
                runtimeIncarnation, leaseId, 1, token);
    }

    private void attestOwned(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        OwnedProcess process = owned.get(ownershipKey(lease));
        if (process == null || !process.process.isAlive()) {
            throw failed("Managed Runtime process is not alive.");
        }
        attest(request, process.seed, lease);
    }

    private static List<Object> ownershipKey(RuntimeLease lease) {
        // A binding id survives generations; even the same seed can start
        // distinct workers. The attested endpoint distinguishes those attempts.
        return List.of(lease.getRuntimeInstanceId(), lease.getEndpoint(),
                lease.getLeaseId(), lease.getEpoch(), lease.getToken());
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
                    process.getInputStream(), StandardCharsets.UTF_8.newDecoder()));
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
