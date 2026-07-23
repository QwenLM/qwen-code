package com.alibaba.qwen.code.daemon;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/** Java 11 client for the {@code qwen serve} REST and SSE transport. */
public final class DaemonClient implements AutoCloseable {
    static final String EVENT_EPOCH_HEADER = "X-Qwen-Event-Epoch";

    private static final AtomicLong CLIENT_SEQUENCE = new AtomicLong();

    private final String baseUrl;
    private final String bearerToken;
    private final Duration requestTimeout;
    private final Duration promptObservationTimeout;
    private final Duration sseIdleTimeout;
    private final int maximumReconnectAttempts;
    private final int maximumSseFrameBytes;
    private final Duration heartbeatInterval;
    private final ExecutorService executor;
    private final ExecutorService maintenanceExecutor;
    private final ExecutorService futureExecutor;
    private final ExecutorService httpExecutor;
    private final ExecutorService streamCloseExecutor;
    private final ScheduledThreadPoolExecutor scheduler;
    private final HttpClient httpClient;
    private final Set<DaemonSessionClient> sessions = ConcurrentHashMap.newKeySet();
    private final Semaphore promptSlots;
    private final Semaphore streamLifecycleSlots;
    private final Semaphore futurePublicationSlots;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final AtomicInteger activePromptTasks = new AtomicInteger();
    private final AtomicInteger activeStreamLifecycles = new AtomicInteger();
    private final ThreadLocal<Boolean> futurePublicationThread = new ThreadLocal<>();
    private final Object lifecycleLock = new Object();
    private int activeSessionCreations;

    private DaemonClient(Builder builder) {
        this.baseUrl = normalizeBaseUri(builder.baseUri);
        this.bearerToken = builder.bearerToken;
        this.requestTimeout = builder.requestTimeout;
        this.promptObservationTimeout = builder.promptObservationTimeout;
        this.sseIdleTimeout = builder.sseIdleTimeout;
        this.maximumReconnectAttempts = builder.maximumReconnectAttempts;
        this.maximumSseFrameBytes = builder.maximumSseFrameBytes;
        this.heartbeatInterval = builder.heartbeatInterval;
        long clientNumber = CLIENT_SEQUENCE.incrementAndGet();
        this.promptSlots = new Semaphore(builder.maximumConcurrentPrompts);
        int streamLifecycleCapacity = builder.maximumConcurrentPrompts;
        this.streamLifecycleSlots = new Semaphore(streamLifecycleCapacity);
        this.executor = new ThreadPoolExecutor(builder.maximumConcurrentPrompts,
                builder.maximumConcurrentPrompts, 0L, TimeUnit.MILLISECONDS,
                new LinkedBlockingQueue<>(builder.maximumConcurrentPrompts),
                daemonThreadFactory(
                        "qwencode-daemon-" + clientNumber + "-worker-"));
        this.maintenanceExecutor = new ThreadPoolExecutor(4, 4, 0L,
                TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(256),
                daemonThreadFactory("qwencode-daemon-" + clientNumber
                        + "-maintenance-"));
        int futureThreads = (int) Math.min(Integer.MAX_VALUE,
                Math.max(2L, builder.maximumConcurrentPrompts * 2L));
        int futurePublicationCapacity = (int) Math.min(Integer.MAX_VALUE,
                futureThreads * 2L);
        this.futurePublicationSlots = new Semaphore(futurePublicationCapacity);
        this.futureExecutor = new ThreadPoolExecutor(futureThreads,
                futureThreads, 0L, TimeUnit.MILLISECONDS,
                new LinkedBlockingQueue<>(futurePublicationCapacity),
                daemonThreadFactory(
                        "qwencode-daemon-" + clientNumber + "-future-"));
        int httpThreads = Math.min(16,
                Math.max(4, builder.maximumConcurrentPrompts));
        this.httpExecutor = new ThreadPoolExecutor(httpThreads, httpThreads,
                0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(256),
                daemonThreadFactory("qwencode-daemon-" + clientNumber + "-http-"));
        this.streamCloseExecutor = new ThreadPoolExecutor(
                builder.maximumConcurrentPrompts,
                builder.maximumConcurrentPrompts, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(streamLifecycleCapacity),
                daemonThreadFactory("qwencode-daemon-" + clientNumber
                        + "-stream-close-"));
        this.scheduler = new ScheduledThreadPoolExecutor(1,
                daemonThreadFactory("qwencode-daemon-" + clientNumber + "-timer-"));
        this.scheduler.setRemoveOnCancelPolicy(true);
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(builder.connectTimeout)
                .executor(httpExecutor)
                .followRedirects(HttpClient.Redirect.NEVER)
                .version(HttpClient.Version.HTTP_1_1)
                .build();
    }

    public static Builder builder() {
        return new Builder();
    }

    public DaemonCapabilities capabilities() {
        ensureOpen();
        HttpSupport.Response response = sendRead("/capabilities", "GET /capabilities");
        requireStatus(response, 200, "GET /capabilities");
        Map<String, Object> json = JsonSupport.parseObject(response.getBody(),
                "GET /capabilities response");
        int version = JsonSupport.requiredInt(json, "v", "capabilities");
        if (version != 1) {
            throw new DaemonProtocolException("Unsupported capabilities version: " + version);
        }
        String mode = JsonSupport.requiredString(json, "mode", "capabilities");
        java.util.List<String> transports = JsonSupport.stringList(json,
                "transports");
        return new DaemonCapabilities(version, mode,
                JsonSupport.stringList(json, "features"), transports,
                JsonSupport.optionalString(json, "workspaceCwd"),
                JsonSupport.optionalString(json, "qwenCodeVersion"), json);
    }

    public DaemonSessionClient createSession() {
        return createSession(CreateSessionRequest.defaults());
    }

    public DaemonSessionClient createSession(CreateSessionRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request must not be null");
        }
        synchronized (lifecycleLock) {
            ensureOpen();
            activeSessionCreations += 1;
        }
        try {
            DaemonCapabilities capabilities = capabilities();
            if (!capabilities.getTransports().contains("rest")) {
                throw new DaemonProtocolException(
                        "The daemon does not advertise the REST transport");
            }
            if (!capabilities.supports("session_scope_override")) {
                throw new DaemonProtocolException(
                        "The daemon does not advertise session_scope_override; "
                                + "the SDK cannot guarantee the requested session scope");
            }
            synchronized (lifecycleLock) {
                ensureOpen();
            }
            HttpSupport.Response response;
            try {
                response = send("/session", "POST", request.toJson(), null,
                        requestTimeout);
            } catch (IOException | InterruptedException e) {
                restoreInterrupt(e);
                throw new SessionCreationOutcomeUnknownException(e);
            } catch (DaemonTransportException | DaemonProtocolException e) {
                throw new SessionCreationOutcomeUnknownException(e);
            }
            try {
                if (isAmbiguousMutationStatus(response.getStatusCode())) {
                    throw new SessionCreationOutcomeUnknownException(
                            new DaemonHttpException("POST /session",
                                    response.getStatusCode(), response.getBody()));
                }
                requireStatus(response, 200, "POST /session");
                Map<String, Object> json = JsonSupport.parseObject(response.getBody(),
                        "POST /session response");
                String clientId = JsonSupport.requiredString(json, "clientId",
                        "session");
                validateClientId(clientId);
                DaemonSession session = new DaemonSession(
                        JsonSupport.requiredString(json, "sessionId", "session"),
                        JsonSupport.requiredString(json, "workspaceCwd", "session"),
                        JsonSupport.requiredBoolean(json, "attached", "session"),
                        clientId,
                        JsonSupport.optionalString(json, "createdAt"));
                DaemonSessionClient result = new DaemonSessionClient(this, session,
                        capabilities.supports("client_heartbeat"),
                        capabilities.supports("prompt_absolute_deadline"));
                synchronized (lifecycleLock) {
                    if (!closed.get()) {
                        sessions.add(result);
                        result.startAutomaticHeartbeat();
                        return result;
                    }
                }
                IllegalStateException failure = new IllegalStateException(
                        "DaemonClient is closed");
                try {
                    result.close();
                } catch (RuntimeException cleanupFailure) {
                    failure.addSuppressed(cleanupFailure);
                }
                throw failure;
            } catch (DaemonProtocolException e) {
                throw new SessionCreationOutcomeUnknownException(e);
            }
        } finally {
            boolean shutdownHttpExecutor = false;
            synchronized (lifecycleLock) {
                activeSessionCreations -= 1;
                if (closed.get() && activeSessionCreations == 0) {
                    shutdownHttpExecutor = true;
                }
            }
            if (shutdownHttpExecutor) {
                httpExecutor.shutdownNow();
            }
        }
    }

    @Override
    public void close() {
        List<DaemonSessionClient> sessionsToClose;
        boolean shutdownHttpExecutor;
        synchronized (lifecycleLock) {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            sessionsToClose = new ArrayList<>(sessions);
            shutdownHttpExecutor = activeSessionCreations == 0;
        }
        RuntimeException firstFailure = null;
        try {
            for (DaemonSessionClient session : sessionsToClose) {
                try {
                    session.close();
                } catch (RuntimeException e) {
                    if (firstFailure == null) {
                        firstFailure = e;
                    } else {
                        firstFailure.addSuppressed(e);
                    }
                }
            }
        } finally {
            executor.shutdown();
            maintenanceExecutor.shutdownNow();
            if (shutdownHttpExecutor) {
                httpExecutor.shutdownNow();
            }
            awaitTermination(executor);
            awaitTermination(maintenanceExecutor);
            if (shutdownHttpExecutor) {
                awaitTermination(httpExecutor);
            }
            shutdownPromptSupportIfIdle();
            if (scheduler.isShutdown()) {
                awaitTermination(scheduler);
            }
            if (streamCloseExecutor.isShutdown()) {
                awaitTermination(streamCloseExecutor);
            }
            if (futureExecutor.isShutdown()
                    && futurePublicationThread.get() == null) {
                awaitTermination(futureExecutor);
            }
        }
        if (firstFailure != null) {
            throw firstFailure;
        }
    }

    HttpSupport.Response sendMutation(String path, Map<String, Object> body,
            String clientId) throws IOException,
            InterruptedException {
        return send(path, "POST", body, clientId, requestTimeout);
    }

    HttpSupport.Response sendSessionMutation(String path, Map<String, Object> body,
            String clientId) throws IOException, InterruptedException {
        synchronized (lifecycleLock) {
            ensureOpen();
        }
        return send(path, "POST", body, clientId, requestTimeout);
    }

    HttpSupport.Response sendDelete(String path, String clientId)
            throws IOException, InterruptedException {
        return send(path, "DELETE", null, clientId, requestTimeout);
    }

    HttpResponse<InputStream> openSse(String path, String clientId, long lastEventId,
            String eventEpoch, Duration observationRemaining)
            throws IOException, InterruptedException {
        HttpRequest.Builder request = requestBuilder(path, clientId)
                .header("Accept", "text/event-stream")
                .header("Accept-Encoding", "identity")
                .header("Cache-Control", "no-cache")
                .header("Last-Event-ID", Long.toString(lastEventId));
        if (eventEpoch != null) {
            request.header(EVENT_EPOCH_HEADER, eventEpoch);
        }
        HttpRequest builtRequest = request
                .timeout(shorter(requestTimeout, observationRemaining))
                .GET()
                .build();
        try {
            return httpClient.send(builtRequest,
                    HttpResponse.BodyHandlers.ofInputStream());
        } catch (RejectedExecutionException e) {
            throw new IOException("HTTP executor is saturated", e);
        }
    }

    void submit(Runnable task, Runnable afterCompletion,
            Runnable afterCapacityRelease,
            Supplier<CompletableFuture<Void>> streamCleanup) {
        synchronized (lifecycleLock) {
            ensureOpen();
            if (!promptSlots.tryAcquire()) {
                throw new DaemonClientCapacityException(
                        new RejectedExecutionException(
                                "Prompt capacity is exhausted"));
            }
            if (!streamLifecycleSlots.tryAcquire()) {
                promptSlots.release();
                throw new DaemonClientCapacityException(
                        new RejectedExecutionException(
                                "Stream cleanup capacity is exhausted"));
            }
            activePromptTasks.incrementAndGet();
            activeStreamLifecycles.incrementAndGet();
            FutureTask<Void> submitted = new FutureTask<Void>(() -> {
                task.run();
                return null;
            }) {
                @Override
                protected void done() {
                    try {
                        afterCompletion.run();
                    } finally {
                        try {
                            registerStreamCleanup(streamCleanup);
                        } finally {
                            promptSlots.release();
                            try {
                                afterCapacityRelease.run();
                            } finally {
                                activePromptTasks.decrementAndGet();
                                shutdownPromptSupportIfIdle();
                            }
                        }
                    }
                }
            };
            try {
                executor.execute(submitted);
            } catch (RejectedExecutionException e) {
                promptSlots.release();
                activePromptTasks.decrementAndGet();
                releaseStreamLifecycle();
                shutdownPromptSupportIfIdle();
                throw new DaemonClientCapacityException(e);
            }
        }
    }

    Future<?> submitMaintenance(Runnable task) {
        try {
            return maintenanceExecutor.submit(task);
        } catch (RejectedExecutionException ignored) {
            return null;
        }
    }

    CompletableFuture<Void> closeStreamAsync(InputStream stream) {
        CompletableFuture<Void> completion = new CompletableFuture<>();
        try {
            streamCloseExecutor.execute(() -> {
                try {
                    stream.close();
                    completion.complete(null);
                } catch (IOException | RuntimeException e) {
                    completion.completeExceptionally(e);
                } catch (Error e) {
                    completion.completeExceptionally(e);
                    throw e;
                }
            });
        } catch (RejectedExecutionException e) {
            completion.completeExceptionally(e);
        }
        return completion;
    }

    Executor reserveFuturePublications() {
        if (!futurePublicationSlots.tryAcquire(2)) {
            throw new DaemonClientCapacityException(
                    new RejectedExecutionException(
                            "Future publication capacity is exhausted"));
        }
        AtomicInteger remaining = new AtomicInteger(2);
        return command -> {
            if (remaining.getAndDecrement() <= 0) {
                throw new IllegalStateException(
                        "Prompt future publication reservation is exhausted");
            }
            Runnable publication = () -> {
                futurePublicationSlots.release();
                futurePublicationThread.set(Boolean.TRUE);
                try {
                    command.run();
                } finally {
                    futurePublicationThread.remove();
                }
            };
            try {
                futureExecutor.execute(publication);
            } catch (RejectedExecutionException e) {
                publication.run();
            }
        };
    }

    void unregister(DaemonSessionClient session) {
        sessions.remove(session);
    }

    ScheduledExecutorService scheduler() {
        return scheduler;
    }

    Duration promptObservationTimeout() {
        return promptObservationTimeout;
    }

    Duration sseIdleTimeout() {
        return sseIdleTimeout;
    }

    Duration requestTimeout() {
        return requestTimeout;
    }

    Duration heartbeatInterval() {
        return heartbeatInterval;
    }

    int maximumReconnectAttempts() {
        return maximumReconnectAttempts;
    }

    int maximumSseFrameBytes() {
        return maximumSseFrameBytes;
    }

    static void requireStatus(HttpSupport.Response response, int expected,
            String operation) {
        if (response.getStatusCode() != expected) {
            if (response.isSuccess()) {
                throw new DaemonProtocolException(operation
                        + " returned unexpected successful HTTP "
                        + response.getStatusCode());
            }
            throw new DaemonHttpException(operation, response.getStatusCode(),
                    response.getBody());
        }
    }

    static boolean isAmbiguousMutationStatus(int statusCode) {
        return statusCode == 408 || statusCode >= 500;
    }

    static String encodePathSegment(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8)
                .replace("+", "%20");
    }

    private HttpSupport.Response sendRead(String path, String operation) {
        try {
            return send(path, "GET", null, null, requestTimeout);
        } catch (IOException e) {
            throw new DaemonTransportException(operation + " transport failed", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DaemonTransportException(operation + " was interrupted", e);
        }
    }

    private HttpSupport.Response send(String path, String method,
            Map<String, Object> body, String clientId, Duration timeout)
            throws IOException, InterruptedException {
        HttpRequest.Builder builder = requestBuilder(path, clientId)
                .header("Accept", "application/json")
                .header("Accept-Encoding", "identity")
                .timeout(timeout);
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.header("Content-Type", "application/json; charset=utf-8")
                    .method(method, HttpRequest.BodyPublishers.ofString(
                            JsonSupport.encode(body), StandardCharsets.UTF_8));
        }
        java.util.concurrent.CompletableFuture<HttpResponse<HttpSupport.Body>> future;
        try {
            future = httpClient.sendAsync(builder.build(), HttpSupport.bodyHandler());
        } catch (RejectedExecutionException e) {
            throw new IOException("HTTP executor is saturated", e);
        }
        HttpResponse<HttpSupport.Body> response;
        try {
            response = future.get(timeoutNanos(timeout), TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            future.cancel(true);
            throw e;
        } catch (TimeoutException e) {
            future.cancel(true);
            throw new java.net.http.HttpTimeoutException(
                    method + " " + path + " response timed out");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof IOException) {
                throw (IOException) cause;
            }
            if (cause instanceof RejectedExecutionException) {
                throw new IOException("HTTP executor is saturated", cause);
            }
            if (cause instanceof RuntimeException) {
                throw (RuntimeException) cause;
            }
            throw new IOException(method + " " + path + " failed", cause);
        }
        return HttpSupport.consume(response, method + " " + path);
    }

    private HttpRequest.Builder requestBuilder(String path, String clientId) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + path));
        if (bearerToken != null) {
            builder.header("Authorization", "Bearer " + bearerToken);
        }
        if (clientId != null) {
            builder.header("X-Qwen-Client-Id", clientId);
        }
        return builder;
    }

    private void ensureOpen() {
        if (closed.get()) {
            throw new IllegalStateException("DaemonClient is closed");
        }
    }

    private static String normalizeBaseUri(URI baseUri) {
        String scheme = baseUri.getScheme();
        if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
            throw new IllegalArgumentException("baseUri must use http or https");
        }
        if (baseUri.getHost() == null || baseUri.getUserInfo() != null
                || baseUri.getQuery() != null
                || baseUri.getFragment() != null) {
            throw new IllegalArgumentException(
                    "baseUri must be an absolute HTTP origin or path without credentials");
        }
        String value = baseUri.toString();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private static void validateClientId(String clientId) {
        if (clientId.length() > 128
                || !clientId.matches("[A-Za-z0-9._:-]+")) {
            throw new DaemonProtocolException(
                    "session.clientId is not a valid daemon client identifier");
        }
    }

    private static ThreadFactory daemonThreadFactory(String prefix) {
        AtomicLong sequence = new AtomicLong();
        return runnable -> {
            Thread thread = new Thread(runnable, prefix + sequence.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }

    private static void restoreInterrupt(Exception exception) {
        if (exception instanceof InterruptedException) {
            Thread.currentThread().interrupt();
        }
    }

    private static void awaitTermination(ExecutorService service) {
        try {
            service.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void shutdownPromptSupportIfIdle() {
        if (closed.get() && activePromptTasks.get() == 0) {
            futureExecutor.shutdown();
            scheduler.shutdownNow();
        }
        if (closed.get() && activeStreamLifecycles.get() == 0) {
            streamCloseExecutor.shutdown();
        }
    }

    private void releaseStreamLifecycle() {
        streamLifecycleSlots.release();
        activeStreamLifecycles.decrementAndGet();
        shutdownPromptSupportIfIdle();
    }

    private void registerStreamCleanup(
            Supplier<CompletableFuture<Void>> streamCleanup) {
        try {
            CompletableFuture<Void> cleanup = streamCleanup.get();
            if (cleanup == null) {
                throw new IllegalStateException(
                        "Prompt stream cleanup future is null");
            }
            cleanup.whenComplete((ignored, failure) ->
                    releaseStreamLifecycle());
        } catch (RuntimeException e) {
            releaseStreamLifecycle();
            throw e;
        }
    }

    private static Duration shorter(Duration first, Duration second) {
        return first.compareTo(second) <= 0 ? first : second;
    }

    private static long timeoutNanos(Duration timeout) {
        try {
            return timeout.toNanos();
        } catch (ArithmeticException e) {
            return Long.MAX_VALUE;
        }
    }

    public static final class Builder {
        private URI baseUri = URI.create("http://127.0.0.1:4170");
        private String bearerToken;
        private Duration connectTimeout = Duration.ofSeconds(10);
        private Duration requestTimeout = Duration.ofSeconds(30);
        private Duration promptObservationTimeout = Duration.ofMinutes(30);
        private Duration sseIdleTimeout = Duration.ofSeconds(45);
        private Duration heartbeatInterval = Duration.ofMinutes(1);
        private int maximumReconnectAttempts = 8;
        private int maximumSseFrameBytes = 16 * 1024 * 1024;
        private int maximumConcurrentPrompts = 32;

        private Builder() {
        }

        public Builder baseUri(URI baseUri) {
            if (baseUri == null) {
                throw new IllegalArgumentException("baseUri must not be null");
            }
            this.baseUri = baseUri;
            return this;
        }

        public Builder bearerToken(String bearerToken) {
            if (bearerToken == null || bearerToken.trim().isEmpty()) {
                throw new IllegalArgumentException("bearerToken must not be blank");
            }
            this.bearerToken = bearerToken;
            return this;
        }

        public Builder connectTimeout(Duration connectTimeout) {
            this.connectTimeout = positive(connectTimeout, "connectTimeout");
            return this;
        }

        public Builder requestTimeout(Duration requestTimeout) {
            this.requestTimeout = positive(requestTimeout, "requestTimeout");
            return this;
        }

        public Builder promptObservationTimeout(Duration timeout) {
            this.promptObservationTimeout = positive(timeout,
                    "promptObservationTimeout");
            return this;
        }

        public Builder sseIdleTimeout(Duration sseIdleTimeout) {
            this.sseIdleTimeout = positive(sseIdleTimeout, "sseIdleTimeout");
            return this;
        }

        public Builder heartbeatInterval(Duration heartbeatInterval) {
            if (heartbeatInterval == null || heartbeatInterval.isNegative()) {
                throw new IllegalArgumentException(
                        "heartbeatInterval must be non-negative");
            }
            this.heartbeatInterval = heartbeatInterval;
            return this;
        }

        public Builder maximumReconnectAttempts(int attempts) {
            if (attempts < 0) {
                throw new IllegalArgumentException(
                        "maximumReconnectAttempts must be non-negative");
            }
            this.maximumReconnectAttempts = attempts;
            return this;
        }

        public Builder maximumSseFrameBytes(int bytes) {
            if (bytes < 1024) {
                throw new IllegalArgumentException(
                        "maximumSseFrameBytes must be at least 1024");
            }
            this.maximumSseFrameBytes = bytes;
            return this;
        }

        public Builder maximumConcurrentPrompts(int prompts) {
            if (prompts <= 0) {
                throw new IllegalArgumentException(
                        "maximumConcurrentPrompts must be positive");
            }
            this.maximumConcurrentPrompts = prompts;
            return this;
        }

        public DaemonClient build() {
            return new DaemonClient(this);
        }

        private static Duration positive(Duration duration, String name) {
            if (duration == null || duration.isZero() || duration.isNegative()) {
                throw new IllegalArgumentException(name + " must be positive");
            }
            return duration;
        }
    }
}
