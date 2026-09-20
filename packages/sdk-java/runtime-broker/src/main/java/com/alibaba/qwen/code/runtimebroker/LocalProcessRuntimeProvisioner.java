package com.alibaba.qwen.code.runtimebroker;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.InetAddress;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/** Starts and owns isolated managed-runtime-worker local processes. */
public final class LocalProcessRuntimeProvisioner
        implements RuntimeProvisioner {
    private static final int BOOT_MAXIMUM_BYTES = 32 * 1024;
    private static final int READY_MAXIMUM_BYTES = 8 * 1024;
    private static final int HEALTH_MAXIMUM_BYTES = 8 * 1024;
    private static final int PROCESS_MAXIMUM_BYTES = 8 * 1024;
    private static final Set<String> READY_FIELDS = Set.of("type", "version",
            "runtimeInstanceId", "gatewayIncarnation", "leaseId", "epoch",
            "tenantId", "workspaceId", "workspaceCwd", "url");
    private static final Set<String> PROCESS_FIELDS = Set.of("schemaVersion",
            "kind", "generationDirectory", "pid", "processStartedAt");
    private static final List<String> BLOCKED_ENVIRONMENT_PREFIXES = List.of(
            "OPENAI_", "ANTHROPIC_", "DASHSCOPE_", "GEMINI_",
            "GOOGLE_GENERATIVE_AI_", "AZURE_OPENAI_", "QWEN_MODEL",
            "QWEN_API_KEY", "QWEN_BASE_URL", "QWEN_RUNTIME_BROKER_",
            "QWEN_SERVER_TOKEN", "QWEN_CODE_IDE_");

    private final Path stateDirectory;
    private final List<String> workerCommand;
    private final Path cliEntry;
    private final Map<String, String> environment;
    private final int maximumRuntimes;
    private final Duration startupTimeout;
    private final Duration healthTimeout;
    private final Duration gracefulStopTimeout;
    private final Duration forceStopTimeout;
    private final HttpClient httpClient;
    private final ExecutorService executor;
    private final String placementDomain;
    private final String templateDigest;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Object lock = new Object();
    private final ConcurrentMap<RuntimeProvisionRequest, Generation>
            generations = new ConcurrentHashMap<>();
    private final ConcurrentMap<RuntimeProvisionRequest, AtomicLong>
            directEpochs = new ConcurrentHashMap<>();
    private final AtomicInteger physicalStarts = new AtomicInteger();
    private final AtomicInteger physicalStops = new AtomicInteger();

    public LocalProcessRuntimeProvisioner(Path stateDirectory,
            Path nodeExecutable, Path workerEntry, Path cliEntry,
            Map<String, String> environment) {
        this(stateDirectory, List.of(absolute(nodeExecutable,
                        "nodeExecutable").toString(),
                        absolute(workerEntry, "workerEntry").toString()),
                cliEntry, environment, 4, Duration.ofSeconds(60),
                Duration.ofSeconds(2), Duration.ofSeconds(5),
                Duration.ofSeconds(5), HttpClient.newBuilder()
                        .version(HttpClient.Version.HTTP_1_1)
                        .connectTimeout(Duration.ofSeconds(2))
                        .followRedirects(HttpClient.Redirect.NEVER).build(),
                daemonExecutor());
    }

    LocalProcessRuntimeProvisioner(Path stateDirectory,
            List<String> workerCommand, Path cliEntry,
            Map<String, String> environment, int maximumRuntimes,
            Duration startupTimeout, Duration healthTimeout,
            Duration gracefulStopTimeout, Duration forceStopTimeout,
            HttpClient httpClient, ExecutorService executor) {
        rejectUnsupportedPlatform();
        Path configuredStateDirectory = absolute(stateDirectory,
                "stateDirectory").normalize();
        if (configuredStateDirectory.getParent() == null
                || Files.isSymbolicLink(configuredStateDirectory)) {
            throw new IllegalArgumentException(
                    "stateDirectory must be a private non-root directory");
        }
        if (workerCommand == null || workerCommand.isEmpty()
                || workerCommand.stream().anyMatch(value -> value == null
                        || value.isBlank())) {
            throw new IllegalArgumentException(
                    "workerCommand must not be empty");
        }
        this.workerCommand = List.copyOf(workerCommand);
        this.cliEntry = absolute(cliEntry, "cliEntry").normalize();
        this.environment = validatedEnvironment(environment);
        if (maximumRuntimes <= 0) {
            throw new IllegalArgumentException(
                    "maximumRuntimes must be positive");
        }
        this.maximumRuntimes = maximumRuntimes;
        this.startupTimeout = positive(startupTimeout, "startupTimeout");
        this.healthTimeout = positive(healthTimeout, "healthTimeout");
        this.gracefulStopTimeout = positive(gracefulStopTimeout,
                "gracefulStopTimeout");
        this.forceStopTimeout = positive(forceStopTimeout,
                "forceStopTimeout");
        this.httpClient = required(httpClient, "httpClient");
        this.executor = required(executor, "executor");
        try {
            createOwnerDirectory(configuredStateDirectory);
            this.stateDirectory = configuredStateDirectory.toRealPath();
            this.placementDomain = "local-" + digest(
                    InetAddress.getLocalHost().getHostName(),
                    this.stateDirectory.toString());
        } catch (IOException exception) {
            throw failure("runtime_broker_release_failed",
                    "Managed Runtime state directory is unavailable.", true,
                    exception);
        }
        this.templateDigest = "sha256:" + templateDigest(this.workerCommand,
                this.cliEntry, this.environment);
    }

    @Override
    public String kind() {
        return "local-process";
    }

    @Override
    public String placementDomain() {
        return placementDomain;
    }

    @Override
    public String runtimeTemplateDigest() {
        return templateDigest;
    }

    @Override
    public boolean supportsDurableRecovery() {
        return true;
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        synchronized (lock) {
            Generation existing = generations.get(request);
            if (existing != null) {
                if (existing.isReusable()) {
                    return existing.ready;
                }
                return failed(failure("runtime_broker_capacity_exhausted",
                        "Managed Runtime generation is draining.", true,
                        null));
            }
        }
        long epoch = directEpochs.computeIfAbsent(request,
                ignored -> new AtomicLong()).incrementAndGet();
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create(
                "direct-" + UUID.randomUUID(), epoch);
        return ensureGeneration(request, seed, null, false)
                .thenCompose(handle -> generation(request, seed).ready);
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return ensureGeneration(request, seed, null, true)
                .thenCompose(handle -> generation(request, seed).ready);
    }

    @Override
    public CompletionStage<RuntimeResourceHandle> ensureResource(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle knownHandle) {
        validateDurableRequest(request, seed);
        return ensureGeneration(request, seed, knownHandle, true);
    }

    @Override
    public CompletionStage<RuntimeObservation> reconcile(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lastLease) {
        validateDurableRequest(request, seed);
        if (handle == null) {
            throw new IllegalArgumentException("handle is required");
        }
        return CompletableFuture.supplyAsync(() -> {
            Generation generation;
            try {
                generation = generation(request, seed, handle, true);
            } catch (RuntimeBrokerException exception) {
                return exception.isRetryable()
                        ? RuntimeObservation.unknown(handle)
                        : RuntimeObservation.conflict(handle);
            }
            if (generation.process == null
                    || !generation.process.isAlive()) {
                return RuntimeObservation.notFound();
            }
            if (!Files.exists(generation.readyRecord,
                    LinkOption.NOFOLLOW_LINKS)) {
                return RuntimeObservation.starting(handle);
            }
            RuntimeLease lease;
            try {
                lease = readReady(generation);
            } catch (IOException | RuntimeException exception) {
                return RuntimeObservation.conflict(handle);
            }
            if (!checkHealth(lease)) {
                return RuntimeObservation.unknown(handle);
            }
            if (lastLease != null
                    && (!lastLease.getRuntimeInstanceId().equals(
                            lease.getRuntimeInstanceId())
                            || !lastLease.getLeaseId().equals(
                                    lease.getLeaseId())
                            || lastLease.getEpoch() != lease.getEpoch())) {
                return RuntimeObservation.conflict(handle);
            }
            return RuntimeObservation.ready(handle, lease.getEndpoint(),
                    lease.getRuntimeInstanceId(), lease.getLeaseId(),
                    lease.getEpoch());
        }, executor);
    }

    @Override
    public CompletionStage<Void> drain(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        Generation generation = requireGeneration(request, lease);
        generation.markDraining();
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public CompletionStage<Void> release(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        Generation generation = requireGeneration(request, lease);
        return generation.stop();
    }

    @Override
    public CompletionStage<Void> drain(RuntimeResourceContext resource) {
        Generation generation = generation(resource.getRequest(),
                resource.getSeed(), resource.getHandle(), true);
        generation.markDraining();
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public CompletionStage<Void> release(RuntimeResourceContext resource) {
        Generation generation = generation(resource.getRequest(),
                resource.getSeed(), resource.getHandle(), true);
        return generation.stop();
    }

    @Override
    public CompletionStage<Boolean> health(RuntimeLease lease) {
        if (lease == null) {
            throw new IllegalArgumentException("lease is required");
        }
        return CompletableFuture.supplyAsync(() -> checkHealth(lease),
                executor);
    }

    @Override
    public void close() {
        List<Generation> owned;
        synchronized (lock) {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            owned = List.copyOf(generations.values());
        }
        List<CompletableFuture<Void>> stops = new ArrayList<>();
        for (Generation generation : owned) {
            if (!generation.durable) {
                stops.add(generation.stop().toCompletableFuture());
            }
        }
        try {
            CompletableFuture.allOf(stops.toArray(new CompletableFuture[0]))
                    .get(gracefulStopTimeout.plus(forceStopTimeout).plusSeconds(5)
                            .toMillis(), TimeUnit.MILLISECONDS);
        } catch (Exception exception) {
            throw failure("runtime_broker_release_failed",
                    "Managed Runtime shutdown did not complete.", true,
                    exception);
        } finally {
            if (owned.stream().anyMatch(generation -> generation.durable)) {
                executor.shutdown();
            } else {
                executor.shutdownNow();
            }
        }
    }

    int getPhysicalStartCount() {
        return physicalStarts.get();
    }

    int getPhysicalStopCount() {
        return physicalStops.get();
    }

    Set<Long> getLiveProcessIds() {
        Set<Long> result = ConcurrentHashMap.newKeySet();
        for (Generation generation : generations.values()) {
            generation.addLiveProcessId(result);
        }
        return Set.copyOf(result);
    }

    private CompletionStage<RuntimeResourceHandle> ensureGeneration(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle knownHandle, boolean durable) {
        if (request == null || seed == null) {
            throw new IllegalArgumentException(
                    "request and seed are required");
        }
        synchronized (lock) {
            if (closed.get()) {
                return failed(failure("runtime_broker_closed",
                        "Runtime Broker is closed.", false, null));
            }
            Generation existing = generations.get(request);
            if (existing != null) {
                if (!existing.seed.equals(seed)) {
                    return failed(failure(
                            "runtime_broker_resource_conflict",
                            "Managed Runtime seed identity conflicts.",
                            false, null));
                }
                if (existing.handleReady.isDone()
                        && (existing.process == null
                                || !existing.process.isAlive())) {
                    generations.remove(request, existing);
                    deleteGenerationDirectory(existing.directory);
                    existing = null;
                }
            }
            if (existing != null) {
                if (!existing.isReusable()) {
                    return failed(failure(
                            "runtime_broker_capacity_exhausted",
                            "Managed Runtime generation is draining.",
                            true, null));
                }
                return existing.handleReady;
            }
            if (generations.size() >= maximumRuntimes) {
                return failed(failure("runtime_broker_capacity_exhausted",
                        "Managed Runtime capacity is exhausted.", true, null));
            }
            try {
                RuntimeResourceHandle discovered = knownHandle;
                Path directory = generationDirectory(seed);
                if (discovered == null && Files.exists(directory,
                        LinkOption.NOFOLLOW_LINKS)) {
                    Path metadata = directory.resolve("process.json");
                    if (!Files.exists(metadata, LinkOption.NOFOLLOW_LINKS)) {
                        return failed(failure(
                                "runtime_broker_resource_unknown",
                                "Managed Runtime process identity is ambiguous.",
                                true, null));
                    }
                    discovered = readProcessHandle(metadata);
                }
                if (discovered != null) {
                    Generation adopted = adopt(request, seed, discovered,
                            durable);
                    if (adopted.process != null
                            && adopted.process.isAlive()) {
                        generations.put(request, adopted);
                        return adopted.handleReady;
                    }
                    deleteGenerationDirectory(adopted.directory);
                }
                Generation generation = new Generation(request, seed,
                        durable);
                generations.put(request, generation);
                try {
                    executor.execute(() -> start(generation));
                } catch (RuntimeException exception) {
                    generations.remove(request, generation);
                    generation.handleReady.completeExceptionally(failure(
                            "runtime_broker_process_exited",
                            "Managed Runtime failed to start.", true,
                            exception));
                    generation.ready.completeExceptionally(exception);
                }
                return generation.handleReady;
            } catch (RuntimeException exception) {
                return failed(exception);
            }
        }
    }

    private Generation generation(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed) {
        synchronized (lock) {
            Generation generation = generations.get(request);
            if (generation == null || !generation.seed.equals(seed)) {
                throw failure("runtime_broker_resource_unknown",
                        "Managed Runtime generation is unavailable.", true,
                        null);
            }
            return generation;
        }
    }

    private Generation generation(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
            boolean durable) {
        synchronized (lock) {
            Generation generation = generations.get(request);
            if (generation != null) {
                if (!generation.seed.equals(seed)
                        || !matchesHandle(generation, handle)) {
                    throw failure("runtime_broker_resource_conflict",
                            "Managed Runtime resource identity conflicts.",
                            false, null);
                }
                return generation;
            }
            Generation adopted = adopt(request, seed, handle, durable);
            generations.put(request, adopted);
            return adopted;
        }
    }

    private Generation adopt(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
            boolean durable) {
        if (!kind().equals(handle.getKind()) || handle.getVersion() != 1) {
            throw failure("runtime_broker_resource_conflict",
                    "Managed Runtime resource handle is unsupported.", false,
                    null);
        }
        Map<String, Object> value = handle.getValue();
        if (!value.keySet().equals(PROCESS_FIELDS)
                || number(value.get("schemaVersion")) != 1
                || !kind().equals(value.get("kind"))) {
            throw failure("runtime_broker_resource_conflict",
                    "Managed Runtime resource handle is invalid.", false,
                    null);
        }
        Object rawDirectory = value.get("generationDirectory");
        Object rawStartedAt = value.get("processStartedAt");
        long pid = number(value.get("pid"));
        if (!(rawDirectory instanceof String)
                || !(rawStartedAt instanceof String) || pid <= 0) {
            throw failure("runtime_broker_resource_conflict",
                    "Managed Runtime resource handle is invalid.", false,
                    null);
        }
        Path expected = generationDirectory(seed);
        Path directory = Path.of((String) rawDirectory).toAbsolutePath()
                .normalize();
        if (!directory.equals(expected)
                || !directory.startsWith(stateDirectory)
                || Files.isSymbolicLink(directory)) {
            throw failure("runtime_broker_resource_conflict",
                    "Managed Runtime generation directory conflicts.", false,
                    null);
        }
        Instant startedAt;
        try {
            startedAt = Instant.parse((String) rawStartedAt);
        } catch (RuntimeException exception) {
            throw failure("runtime_broker_resource_conflict",
                    "Managed Runtime process fingerprint is invalid.", false,
                    exception);
        }
        Generation generation = new Generation(request, seed, durable);
        ProcessHandle process = ProcessHandle.of(pid).orElse(null);
        if (process != null) {
            Instant actual = process.info().startInstant().orElse(null);
            if (actual == null || !actual.equals(startedAt)) {
                throw failure("runtime_broker_resource_conflict",
                        "Managed Runtime process fingerprint conflicts.",
                        false, null);
            }
            generation.process = new OwnedRuntimeProcess(process);
        }
        generation.processStartedAt = startedAt;
        generation.handleReady.complete(generation.process == null
                ? handle : generation.handle());
        return generation;
    }

    private boolean matchesHandle(Generation generation,
            RuntimeResourceHandle handle) {
        if (handle == null || !kind().equals(handle.getKind())
                || handle.getVersion() != 1
                || !handle.getValue().keySet().equals(PROCESS_FIELDS)) {
            return false;
        }
        Map<String, Object> value = handle.getValue();
        return number(value.get("schemaVersion")) == 1
                && kind().equals(value.get("kind"))
                && generation.directory.toString().equals(
                        value.get("generationDirectory"))
                && generation.process != null
                && number(value.get("pid")) == generation.process.pid()
                && generation.processStartedAt != null
                && generation.processStartedAt.toString().equals(
                        value.get("processStartedAt"));
    }

    private RuntimeResourceHandle readProcessHandle(Path metadata) {
        try {
            BasicFileAttributes attributes = Files.readAttributes(metadata,
                    BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile()
                    || attributes.size() > PROCESS_MAXIMUM_BYTES) {
                throw new IOException("process metadata is invalid");
            }
            byte[] bytes;
            try (InputStream input = Files.newInputStream(metadata)) {
                bytes = input.readNBytes(PROCESS_MAXIMUM_BYTES + 1);
            }
            if (bytes.length > PROCESS_MAXIMUM_BYTES) {
                throw new IOException("process metadata is too large");
            }
            return new RuntimeResourceHandle(kind(), 1,
                    JsonCodec.parseObject(bytes,
                            "Runtime process metadata"));
        } catch (IOException | RuntimeException exception) {
            throw failure("runtime_broker_resource_unknown",
                    "Managed Runtime process identity is unavailable.", true,
                    exception);
        }
    }

    private void validateDurableRequest(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed) {
        if (request == null || seed == null) {
            throw new IllegalArgumentException(
                    "request and seed are required");
        }
        if (!kind().equals(request.getProvisionerKind())
                || !placementDomain.equals(request.getPlacementDomain())
                || !templateDigest.equals(
                        request.getRuntimeTemplateDigest())) {
            throw failure("runtime_broker_resource_conflict",
                    "Managed Runtime placement identity conflicts.", false,
                    null);
        }
    }

    private Path generationDirectory(RuntimeProvisionSeed seed) {
        return stateDirectory.resolve("generation-" + digest(
                seed.getProvisionRequestId()).substring(0, 32)).normalize();
    }

    private void start(Generation generation) {
        try {
            Path workspace = Path.of(generation.request.getScope()
                    .getCanonicalCwd()).toRealPath();
            if (!workspace.equals(Path.of(generation.request.getScope()
                    .getCanonicalCwd()).toAbsolutePath().normalize())) {
                throw new IOException("workspace is not canonical");
            }
            createOwnerDirectory(generation.directory);
            createOwnerDirectory(generation.outputRoot);
            writeBoot(generation, workspace);
            ProcessBuilder builder = new ProcessBuilder(command(generation));
            builder.directory(workspace.toFile());
            builder.environment().clear();
            builder.environment().putAll(environment);
            builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            builder.redirectError(ProcessBuilder.Redirect.DISCARD);
            Process process;
            synchronized (generation) {
                if (generation.stopping) {
                    throw failure("runtime_broker_closed",
                            "Runtime Broker is closed.", false, null);
                }
                process = builder.start();
                generation.process = new OwnedRuntimeProcess(process);
                generation.processStartedAt = process.toHandle().info()
                        .startInstant().orElseThrow(() -> new IOException(
                                "process start fingerprint is unavailable"));
            }
            writeProcessMetadata(generation);
            process.getOutputStream().close();
            physicalStarts.incrementAndGet();
            generation.handleReady.complete(generation.handle());
            long startupDeadline = System.nanoTime()
                    + startupTimeout.toNanos();
            RuntimeLease lease = waitForReady(generation, startupDeadline);
            waitForHealthy(generation, lease, startupDeadline);
            Files.deleteIfExists(generation.bootConfig);
            generation.ready.complete(lease);
        } catch (Throwable error) {
            Throwable failure = error instanceof RuntimeBrokerException
                    ? error : failure("runtime_broker_process_exited",
                            "Managed Runtime failed to start.", true, error);
            generation.handleReady.completeExceptionally(failure);
            generation.stop().whenComplete((ignored, stopError) -> {
                if (stopError != null) {
                    failure.addSuppressed(stopError);
                }
                generation.ready.completeExceptionally(failure);
            });
        }
    }

    private RuntimeLease waitForReady(Generation generation, long deadline)
            throws IOException, InterruptedException {
        while (System.nanoTime() < deadline) {
            if (generation.isStopping()) {
                throw failure("runtime_broker_closed",
                        "Runtime Broker is closed.", false, null);
            }
            if (Files.exists(generation.readyRecord,
                    LinkOption.NOFOLLOW_LINKS)) {
                return readReady(generation);
            }
            if (!generation.process.isAlive()) {
                throw failure("runtime_broker_process_exited",
                        "Managed Runtime exited during startup.", true, null);
            }
            Thread.sleep(25);
        }
        throw failure("runtime_broker_start_timeout",
                "Managed Runtime startup timed out.", true, null);
    }

    private void waitForHealthy(Generation generation, RuntimeLease lease,
            long deadline) throws InterruptedException {
        Throwable lastFailure = null;
        while (System.nanoTime() < deadline) {
            if (generation.isStopping()) {
                throw failure("runtime_broker_closed",
                        "Runtime Broker is closed.", false, null);
            }
            if (!generation.process.isAlive()) {
                throw failure("runtime_broker_process_exited",
                        "Managed Runtime exited during startup.", true,
                        lastFailure);
            }
            try {
                verifyHealth(lease, remainingTimeout(deadline));
                return;
            } catch (IOException | RuntimeException exception) {
                lastFailure = exception;
            }
            long remainingNanos = deadline - System.nanoTime();
            if (remainingNanos > 0) {
                TimeUnit.NANOSECONDS.sleep(Math.min(
                        TimeUnit.MILLISECONDS.toNanos(25), remainingNanos));
            }
        }
        throw failure("runtime_broker_health_failed",
                "Managed Runtime health check failed.", true, lastFailure);
    }

    private RuntimeLease readReady(Generation generation) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(
                generation.readyRecord, BasicFileAttributes.class,
                LinkOption.NOFOLLOW_LINKS);
        if (!attributes.isRegularFile()
                || attributes.size() > READY_MAXIMUM_BYTES) {
            throw invalidReady(null);
        }
        byte[] bytes;
        try (InputStream input = Files.newInputStream(
                generation.readyRecord)) {
            bytes = input.readNBytes(READY_MAXIMUM_BYTES + 1);
        }
        if (bytes.length > READY_MAXIMUM_BYTES) {
            throw invalidReady(null);
        }
        Map<String, Object> ready;
        try {
            ready = JsonCodec.parseObject(bytes, "Runtime ready record");
        } catch (RuntimeException exception) {
            throw invalidReady(exception);
        }
        if (!ready.keySet().equals(READY_FIELDS)
                || !"ready".equals(ready.get("type"))
                || number(ready.get("version")) != 1
                || number(ready.get("epoch")) != generation.epoch
                || !generation.runtimeInstanceId.equals(
                        ready.get("runtimeInstanceId"))
                || !generation.seed.getGatewayIncarnation().equals(
                        ready.get("gatewayIncarnation"))
                || !generation.leaseId.equals(ready.get("leaseId"))
                || !generation.request.getScope().getTenantId().equals(
                        ready.get("tenantId"))
                || !generation.request.getScope().getWorkspaceId().equals(
                        ready.get("workspaceId"))
                || !generation.request.getScope().getCanonicalCwd().equals(
                        ready.get("workspaceCwd"))) {
            throw invalidReady(null);
        }
        Object rawUrl = ready.get("url");
        if (!(rawUrl instanceof String)) {
            throw invalidReady(null);
        }
        URI endpoint;
        try {
            endpoint = URI.create((String) rawUrl);
        } catch (IllegalArgumentException exception) {
            throw invalidReady(exception);
        }
        String expected = "http://127.0.0.1:" + endpoint.getPort();
        if (!"http".equals(endpoint.getScheme())
                || !"127.0.0.1".equals(endpoint.getHost())
                || endpoint.getPort() <= 0 || endpoint.getPort() > 65535
                || endpoint.getUserInfo() != null
                || endpoint.getQuery() != null || endpoint.getFragment() != null
                || !(endpoint.getPath().isEmpty()
                        || "/".equals(endpoint.getPath()))
                || !expected.equals(rawUrl)) {
            throw invalidReady(null);
        }
        return new RuntimeLease(generation.runtimeInstanceId, endpoint,
                generation.token, generation.leaseId, generation.epoch);
    }

    private boolean checkHealth(RuntimeLease lease) {
        try {
            verifyHealth(lease, healthTimeout);
            return true;
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return false;
        } catch (IOException | RuntimeException exception) {
            return false;
        }
    }

    private void verifyHealth(RuntimeLease lease, Duration timeout)
            throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(
                lease.getEndpoint().resolve("/health"))
                .timeout(timeout)
                .header("Authorization", "Bearer " + lease.getToken())
                .header("X-Qwen-Managed-Lease-Id", lease.getLeaseId())
                .header("X-Qwen-Managed-Lease-Epoch",
                        Long.toString(lease.getEpoch()))
                .GET().build();
        HttpResponse<InputStream> response = httpClient.send(request,
                HttpResponse.BodyHandlers.ofInputStream());
        byte[] bytes;
        try (InputStream body = response.body()) {
            bytes = body.readNBytes(HEALTH_MAXIMUM_BYTES + 1);
        }
        if (response.statusCode() != 200) {
            throw new IOException("health returned HTTP "
                    + response.statusCode());
        }
        if (bytes.length > HEALTH_MAXIMUM_BYTES) {
            throw new IOException("health response exceeds its limit");
        }
        Map<String, Object> body;
        try {
            body = JsonCodec.parseObject(bytes, "Runtime health response");
        } catch (RuntimeException exception) {
            throw new IOException("health response is invalid", exception);
        }
        if (body.size() != 1 || !"ok".equals(body.get("status"))) {
            throw new IOException("health response is not ok");
        }
    }

    private Duration remainingTimeout(long deadline) {
        long remainingNanos = Math.max(1, deadline - System.nanoTime());
        return Duration.ofNanos(Math.min(healthTimeout.toNanos(),
                remainingNanos));
    }

    private void writeBoot(Generation generation, Path workspace)
            throws IOException {
        Map<String, Object> boot = new LinkedHashMap<>();
        boot.put("type", "boot");
        boot.put("version", 1);
        boot.put("runtimeInstanceId", generation.runtimeInstanceId);
        boot.put("provisionRequestId",
                generation.seed.getProvisionRequestId());
        boot.put("gatewayIncarnation",
                generation.seed.getGatewayIncarnation());
        boot.put("leaseId", generation.leaseId);
        boot.put("epoch", generation.epoch);
        boot.put("tenantId", generation.request.getScope().getTenantId());
        boot.put("workspaceId", generation.request.getScope().getWorkspaceId());
        boot.put("workspaceGeneration",
                generation.request.getScope().getWorkspaceGeneration());
        boot.put("workspaceCwd", workspace.toString());
        boot.put("capabilityDigest",
                generation.request.getScope().getCapabilityDigest());
        boot.put("isolationClass",
                generation.request.getScope().getIsolationClass());
        boot.put("token", generation.token);
        boot.put("outputRoot", generation.outputRoot.toString());
        boot.put("cliEntry", cliEntry.toString());
        byte[] bytes = JsonCodec.encode(boot);
        if (bytes.length > BOOT_MAXIMUM_BYTES) {
            throw new IOException("boot config exceeds its limit");
        }
        Path temporary = generation.directory.resolve(".boot-"
                + UUID.randomUUID() + ".tmp");
        Files.write(temporary, bytes, StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE);
        setOwnerPermissions(temporary, false);
        try {
            try {
                Files.move(temporary, generation.bootConfig,
                        StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException exception) {
                Files.move(temporary, generation.bootConfig);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private void writeProcessMetadata(Generation generation)
            throws IOException {
        byte[] bytes = JsonCodec.encode(generation.handle().getValue());
        if (bytes.length > PROCESS_MAXIMUM_BYTES) {
            throw new IOException("process metadata exceeds its limit");
        }
        Path temporary = generation.directory.resolve(".process-"
                + UUID.randomUUID() + ".tmp");
        Files.write(temporary, bytes, StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE);
        setOwnerPermissions(temporary, false);
        try {
            try {
                Files.move(temporary, generation.processMetadata,
                        StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException exception) {
                Files.move(temporary, generation.processMetadata);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private List<String> command(Generation generation) {
        List<String> command = new ArrayList<>(workerCommand);
        command.add("--boot-config");
        command.add(generation.bootConfig.toString());
        command.add("--ready-record");
        command.add(generation.readyRecord.toString());
        return command;
    }

    private Generation requireGeneration(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        if (request == null || lease == null) {
            throw new IllegalArgumentException(
                    "request and lease are required");
        }
        Generation generation = generations.get(request);
        if (generation == null || !generation.matches(lease)) {
            throw failure("runtime_broker_release_failed",
                    "Managed Runtime generation is unavailable.", true, null);
        }
        return generation;
    }

    private void stopNow(Generation generation) {
        synchronized (generation) {
            generation.stopping = true;
        }
        OwnedRuntimeProcess process = generation.process;
        if (process != null) {
            process.stop(gracefulStopTimeout, forceStopTimeout);
            physicalStops.incrementAndGet();
        }
        deleteGenerationDirectory(generation.directory);
        generations.remove(generation.request, generation);
    }

    private void deleteGenerationDirectory(Path directory) {
        if (!directory.normalize().startsWith(stateDirectory)
                || directory.equals(stateDirectory)) {
            throw failure("runtime_broker_release_failed",
                    "Managed Runtime generation path is invalid.", true, null);
        }
        if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        try (java.util.stream.Stream<Path> paths = Files.walk(directory)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException exception) {
                    throw new DeleteFailure(exception);
                }
            });
        } catch (IOException | DeleteFailure exception) {
            Throwable cause = exception instanceof DeleteFailure
                    ? exception.getCause() : exception;
            throw failure("runtime_broker_release_failed",
                    "Managed Runtime generation cleanup failed.", true,
                    cause);
        }
    }

    private static long number(Object value) {
        if (!(value instanceof Number)) {
            return Long.MIN_VALUE;
        }
        Number number = (Number) value;
        long result = number.longValue();
        return number.doubleValue() == result ? result : Long.MIN_VALUE;
    }

    private static RuntimeBrokerException invalidReady(Throwable cause) {
        return failure("runtime_broker_invalid_ready",
                "Managed Runtime ready record is invalid.", false, cause);
    }

    private static RuntimeBrokerException failure(String code, String message,
            boolean retryable, Throwable cause) {
        RuntimeBrokerException failure = new RuntimeBrokerException(503,
                code, message, retryable);
        if (cause != null) {
            failure.initCause(cause);
        }
        return failure;
    }

    private static <T> CompletionStage<T> failed(Throwable error) {
        CompletableFuture<T> failed = new CompletableFuture<>();
        failed.completeExceptionally(error);
        return failed;
    }

    private static Path absolute(Path value, String name) {
        if (value == null || !value.isAbsolute()) {
            throw new IllegalArgumentException(name + " must be absolute");
        }
        return value;
    }

    private static Duration positive(Duration value, String name) {
        if (value == null || value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return value;
    }

    private static <T> T required(T value, String name) {
        if (value == null) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }

    private static Map<String, String> validatedEnvironment(
            Map<String, String> source) {
        if (source == null) {
            throw new IllegalArgumentException("environment is required");
        }
        Map<String, String> result = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : source.entrySet()) {
            String key = entry.getKey();
            String value = entry.getValue();
            if (key == null || key.isBlank() || value == null
                    || blockedEnvironment(key)) {
                throw new IllegalArgumentException(
                        "environment contains a blocked entry");
            }
            result.put(key, value);
        }
        return Map.copyOf(result);
    }

    private static boolean blockedEnvironment(String key) {
        String normalized = key.toUpperCase(Locale.ROOT);
        return BLOCKED_ENVIRONMENT_PREFIXES.stream().anyMatch(
                normalized::startsWith);
    }

    private static void rejectUnsupportedPlatform() {
        if (System.getProperty("os.name", "").toLowerCase()
                .contains("windows")) {
            throw failure("runtime_broker_platform_unsupported",
                    "Local Managed Runtime is unsupported on this platform.",
                    false, null);
        }
    }

    private static void createOwnerDirectory(Path directory)
            throws IOException {
        Files.createDirectories(directory);
        setOwnerPermissions(directory, true);
    }

    private static void setOwnerPermissions(Path path, boolean directory)
            throws IOException {
        if (Files.getFileAttributeView(path, PosixFileAttributeView.class,
                LinkOption.NOFOLLOW_LINKS) == null) {
            throw new IOException("POSIX permissions are unavailable");
        }
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(
                directory ? "rwx------" : "rw-------"));
    }

    private static ExecutorService daemonExecutor() {
        return Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable,
                    "qwen-local-runtime-provisioner");
            thread.setDaemon(true);
            return thread;
        });
    }

    private static String templateDigest(List<String> workerCommand,
            Path cliEntry, Map<String, String> environment) {
        List<String> values = new ArrayList<>();
        values.addAll(workerCommand);
        values.add(cliEntry.toString());
        environment.entrySet().stream().sorted(Map.Entry.comparingByKey())
                .forEach(entry -> {
                    values.add(entry.getKey());
                    values.add(entry.getValue());
                });
        return digest(values.toArray(String[]::new));
    }

    private static String digest(String... values) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String value : values) {
                byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
                digest.update((byte) (bytes.length >>> 24));
                digest.update((byte) (bytes.length >>> 16));
                digest.update((byte) (bytes.length >>> 8));
                digest.update((byte) bytes.length);
                digest.update(bytes);
            }
            StringBuilder result = new StringBuilder(64);
            for (byte value : digest.digest()) {
                result.append(String.format(Locale.ROOT, "%02x",
                        value & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable",
                    exception);
        }
    }

    private final class Generation {
        private final RuntimeProvisionRequest request;
        private final RuntimeProvisionSeed seed;
        private final boolean durable;
        private final long epoch;
        private final String runtimeInstanceId;
        private final String leaseId;
        private final String token;
        private final Path directory;
        private final Path outputRoot;
        private final Path bootConfig;
        private final Path readyRecord;
        private final Path processMetadata;
        private final CompletableFuture<RuntimeResourceHandle> handleReady =
                new CompletableFuture<>();
        private final CompletableFuture<RuntimeLease> ready =
                new CompletableFuture<>();
        private CompletableFuture<Void> stop;
        private OwnedRuntimeProcess process;
        private Instant processStartedAt;
        private boolean draining;
        private boolean stopping;

        Generation(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                boolean durable) {
            this.request = request;
            this.seed = seed;
            this.durable = durable;
            this.epoch = seed.getEpoch();
            this.runtimeInstanceId = seed.getProvisionalRuntimeId();
            this.leaseId = seed.getLeaseId();
            this.token = seed.getToken();
            this.directory = generationDirectory(seed);
            this.outputRoot = directory.resolve("output");
            this.bootConfig = directory.resolve("boot.json");
            this.readyRecord = directory.resolve("ready.json");
            this.processMetadata = directory.resolve("process.json");
        }

        RuntimeResourceHandle handle() {
            if (process == null || processStartedAt == null) {
                throw failure("runtime_broker_resource_unknown",
                        "Managed Runtime process identity is unavailable.",
                        true, null);
            }
            long pid = process.pid();
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("schemaVersion", 1);
            value.put("kind", kind());
            value.put("generationDirectory", directory.toString());
            value.put("pid", pid);
            value.put("processStartedAt", processStartedAt.toString());
            return new RuntimeResourceHandle(kind(), 1, value);
        }

        synchronized void markDraining() {
            draining = true;
        }

        synchronized boolean isReusable() {
            return !draining && !stopping;
        }

        synchronized boolean isStopping() {
            return stopping;
        }

        synchronized CompletionStage<Void> stop() {
            if (stop == null) {
                stopping = true;
                stop = new CompletableFuture<>();
                Runnable operation = () -> {
                    try {
                        stopNow(this);
                        stop.complete(null);
                    } catch (Throwable error) {
                        stop.completeExceptionally(error);
                    }
                };
                try {
                    executor.execute(operation);
                } catch (RejectedExecutionException rejected) {
                    operation.run();
                }
            }
            return stop;
        }

        synchronized boolean matches(RuntimeLease lease) {
            return runtimeInstanceId.equals(lease.getRuntimeInstanceId())
                    && leaseId.equals(lease.getLeaseId())
                    && epoch == lease.getEpoch();
        }

        synchronized void addLiveProcessId(Set<Long> result) {
            if (process != null) {
                result.addAll(process.liveProcessIds());
            }
        }
    }

    private static final class DeleteFailure extends RuntimeException {
        DeleteFailure(IOException cause) {
            super(cause);
        }
    }
}
