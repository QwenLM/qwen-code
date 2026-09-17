package com.alibaba.qwen.code.runtimebroker;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
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
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
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
    private static final Set<String> READY_FIELDS = Set.of("type", "version",
            "runtimeInstanceId", "gatewayIncarnation", "leaseId", "epoch",
            "tenantId", "workspaceId", "workspaceCwd", "url");
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
    private final SecureRandom random = new SecureRandom();
    private final String brokerIncarnation = UUID.randomUUID().toString();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Object lock = new Object();
    private final ConcurrentMap<RuntimeProvisionRequest, Generation>
            generations = new ConcurrentHashMap<>();
    private final ConcurrentMap<RuntimeProvisionRequest, AtomicLong> epochs =
            new ConcurrentHashMap<>();
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
        this.stateDirectory = absolute(stateDirectory, "stateDirectory")
                .normalize();
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
            createOwnerDirectory(this.stateDirectory);
        } catch (IOException exception) {
            throw failure("runtime_broker_release_failed",
                    "Managed Runtime state directory is unavailable.", true,
                    exception);
        }
    }

    @Override
    public CompletionStage<RuntimeLease> provision(
            RuntimeProvisionRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        synchronized (lock) {
            if (closed.get()) {
                return failed(failure("runtime_broker_closed",
                        "Runtime Broker is closed.", false, null));
            }
            Generation existing = generations.get(request);
            if (existing != null) {
                if (existing.isReusable()) {
                    return existing.ready;
                }
                return failed(failure("runtime_broker_capacity_exhausted",
                        "Managed Runtime generation is draining.", true,
                        null));
            }
            if (generations.size() >= maximumRuntimes) {
                return failed(failure("runtime_broker_capacity_exhausted",
                        "Managed Runtime capacity is exhausted.", true, null));
            }
            long epoch = epochs.computeIfAbsent(request,
                    ignored -> new AtomicLong()).incrementAndGet();
            Generation generation = new Generation(request, epoch);
            generations.put(request, generation);
            try {
                executor.execute(() -> start(generation));
            } catch (RuntimeException exception) {
                generations.remove(request, generation);
                generation.ready.completeExceptionally(failure(
                        "runtime_broker_process_exited",
                        "Managed Runtime failed to start.", true,
                        exception));
            }
            return generation.ready;
        }
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
            stops.add(generation.stop().toCompletableFuture());
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
            executor.shutdownNow();
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
            Process process;
            synchronized (generation) {
                if (generation.stopping) {
                    throw failure("runtime_broker_closed",
                            "Runtime Broker is closed.", false, null);
                }
                process = builder.start();
                generation.process = new OwnedRuntimeProcess(process);
            }
            process.getOutputStream().close();
            executor.execute(new StreamTail(process.getInputStream()));
            executor.execute(new StreamTail(process.getErrorStream()));
            physicalStarts.incrementAndGet();
            RuntimeLease lease = waitForReady(generation);
            if (!checkHealth(lease)) {
                throw failure("runtime_broker_health_failed",
                        "Managed Runtime health check failed.", true, null);
            }
            Files.deleteIfExists(generation.bootConfig);
            generation.ready.complete(lease);
        } catch (Throwable error) {
            Throwable failure = error instanceof RuntimeBrokerException
                    ? error : failure("runtime_broker_process_exited",
                            "Managed Runtime failed to start.", true, error);
            generation.stop().whenComplete((ignored, stopError) -> {
                if (stopError != null) {
                    failure.addSuppressed(stopError);
                }
                generation.ready.completeExceptionally(failure);
            });
        }
    }

    private RuntimeLease waitForReady(Generation generation)
            throws IOException, InterruptedException {
        long deadline = System.nanoTime() + startupTimeout.toNanos();
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
                || !brokerIncarnation.equals(ready.get("gatewayIncarnation"))
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
        HttpRequest request = HttpRequest.newBuilder(
                lease.getEndpoint().resolve("/health"))
                .timeout(healthTimeout)
                .header("Authorization", "Bearer " + lease.getToken())
                .header("X-Qwen-Managed-Lease-Id", lease.getLeaseId())
                .header("X-Qwen-Managed-Lease-Epoch",
                        Long.toString(lease.getEpoch()))
                .GET().build();
        try {
            HttpResponse<InputStream> response = httpClient.send(request,
                    HttpResponse.BodyHandlers.ofInputStream());
            byte[] bytes;
            try (InputStream body = response.body()) {
                bytes = body.readNBytes(HEALTH_MAXIMUM_BYTES + 1);
            }
            if (response.statusCode() != 200
                    || bytes.length > HEALTH_MAXIMUM_BYTES) {
                return false;
            }
            Map<String, Object> body = JsonCodec.parseObject(bytes,
                    "Runtime health response");
            return body.size() == 1 && "ok".equals(body.get("status"));
        } catch (IOException exception) {
            return false;
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return false;
        } catch (RuntimeException exception) {
            return false;
        }
    }

    private void writeBoot(Generation generation, Path workspace)
            throws IOException {
        Map<String, Object> boot = new LinkedHashMap<>();
        boot.put("type", "boot");
        boot.put("version", 1);
        boot.put("runtimeInstanceId", generation.runtimeInstanceId);
        boot.put("gatewayIncarnation", brokerIncarnation);
        boot.put("leaseId", generation.leaseId);
        boot.put("epoch", generation.epoch);
        boot.put("tenantId", generation.request.getScope().getTenantId());
        boot.put("workspaceId", generation.request.getScope().getWorkspaceId());
        boot.put("workspaceCwd", workspace.toString());
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

    private final class Generation {
        private final RuntimeProvisionRequest request;
        private final long epoch;
        private final String runtimeInstanceId = UUID.randomUUID().toString();
        private final String leaseId = UUID.randomUUID().toString();
        private final String token = token();
        private final Path directory;
        private final Path outputRoot;
        private final Path bootConfig;
        private final Path readyRecord;
        private final CompletableFuture<RuntimeLease> ready =
                new CompletableFuture<>();
        private CompletableFuture<Void> stop;
        private OwnedRuntimeProcess process;
        private boolean draining;
        private boolean stopping;

        Generation(RuntimeProvisionRequest request, long epoch) {
            this.request = request;
            this.epoch = epoch;
            this.directory = stateDirectory.resolve("generation-"
                    + runtimeInstanceId);
            this.outputRoot = directory.resolve("output");
            this.bootConfig = directory.resolve("boot.json");
            this.readyRecord = directory.resolve("ready.json");
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
                stop = CompletableFuture.runAsync(() -> stopNow(this),
                        executor);
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

    private String token() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static final class StreamTail implements Runnable {
        private static final int MAXIMUM_CHARACTERS = 16 * 1024;
        private final InputStream input;
        private final StringBuilder tail = new StringBuilder();

        StreamTail(InputStream input) {
            this.input = input;
        }

        @Override
        public void run() {
            byte[] buffer = new byte[1024];
            try (InputStream stream = input) {
                int read;
                while ((read = stream.read(buffer)) >= 0) {
                    append(new String(buffer, 0, read,
                            java.nio.charset.StandardCharsets.UTF_8));
                }
            } catch (IOException ignored) {
            }
        }

        private synchronized void append(String value) {
            tail.append(value);
            if (tail.length() > MAXIMUM_CHARACTERS) {
                tail.delete(0, tail.length() - MAXIMUM_CHARACTERS);
            }
        }
    }

    private static final class DeleteFailure extends RuntimeException {
        DeleteFailure(IOException cause) {
            super(cause);
        }
    }
}
