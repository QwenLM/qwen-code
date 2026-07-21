package com.alibaba.qwen.code.daemon;

import java.io.IOException;
import java.io.InputStream;
import java.net.http.HttpHeaders;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Collections;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/** One independently attached daemon session. */
public final class DaemonSessionClient implements AutoCloseable {
    public static final long DEFAULT_MAXIMUM_TEXT_BYTES = 4L * 1024L * 1024L;

    private static final Set<String> SESSION_FAILURE_EVENTS = Set.of(
            "client_evicted", "session_closed", "session_died",
            "state_resync_required", "stream_error");
    private static final Set<String> IDLESS_SYNTHETIC_EVENTS = Set.of(
            "client_evicted", "slow_client_warning", "stream_error",
            "state_resync_required", "replay_complete");
    private static final Set<String> OBSERVABLE_STREAM_EVENTS = Set.of(
            "slow_client_warning", "replay_complete");
    private static final Set<Integer> RETRYABLE_SSE_STATUS = Set.of(
            408, 429, 500, 502, 503, 504);

    private final DaemonClient client;
    private final DaemonSession session;
    private final boolean automaticHeartbeatSupported;
    private final boolean promptDeadlineSupported;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final AtomicBoolean detachAttempted = new AtomicBoolean();
    private final AtomicBoolean destroySucceeded = new AtomicBoolean();
    private final AtomicReference<PromptExecution> activePrompt = new AtomicReference<>();
    private final AtomicBoolean heartbeatUnsupported = new AtomicBoolean();
    private final AtomicBoolean heartbeatInFlight = new AtomicBoolean();
    private final Object lifecycleLock = new Object();
    private ScheduledFuture<?> heartbeatTask;
    private boolean automaticHeartbeatRunning;

    DaemonSessionClient(DaemonClient client, DaemonSession session,
            boolean automaticHeartbeatSupported, boolean promptDeadlineSupported) {
        this.client = client;
        this.session = session;
        this.automaticHeartbeatSupported = automaticHeartbeatSupported;
        this.promptDeadlineSupported = promptDeadlineSupported;
    }

    public DaemonSession getSession() {
        return session;
    }

    public String getSessionId() {
        return session.getSessionId();
    }

    public String getClientId() {
        return session.getClientId();
    }

    public PromptCall startPrompt(PromptRequest request, PromptObserver observer) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(observer, "observer");
        synchronized (lifecycleLock) {
            ensureOpen();
            if (request.getDeadlineMillis() != null && !promptDeadlineSupported) {
                throw new DaemonProtocolException(
                        "The daemon does not advertise prompt_absolute_deadline; "
                                + "the SDK cannot guarantee the requested deadline");
            }
            if (activePrompt.get() != null) {
                throw new PromptAlreadyActiveException();
            }
            PromptExecution execution = new PromptExecution(request, observer);
            activePrompt.set(execution);
            try {
                client.submit(execution::run,
                        execution::publishCompletion,
                        execution::releaseTerminalPublication,
                        execution::streamCleanupCompletion);
            } catch (RuntimeException e) {
                activePrompt.compareAndSet(execution, null);
                execution.failBeforeStart(e);
            }
            return execution.call;
        }
    }

    public PromptTextResult promptText(String text) {
        return promptText(PromptRequest.text(text), DEFAULT_MAXIMUM_TEXT_BYTES);
    }

    public PromptTextResult promptText(PromptRequest request) {
        return promptText(request, DEFAULT_MAXIMUM_TEXT_BYTES);
    }

    public PromptTextResult promptText(PromptRequest request, long maximumBytes) {
        if (maximumBytes <= 0) {
            throw new IllegalArgumentException("maximumBytes must be positive");
        }
        TextCollector collector = new TextCollector(maximumBytes);
        PromptTerminal terminal;
        try {
            terminal = startPrompt(request, collector).completionFuture().join();
        } catch (CompletionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof PromptContentLimitException) {
                throw (PromptContentLimitException) cause;
            }
            collector.finish();
            if (cause instanceof PromptOutcomeIndeterminateException) {
                PromptOutcomeIndeterminateException indeterminate =
                        (PromptOutcomeIndeterminateException) cause;
                throw new PromptOutcomeIndeterminateException(
                        indeterminate.getMessage(), indeterminate,
                        collector.getText());
            }
            if (cause instanceof RuntimeException) {
                throw (RuntimeException) cause;
            }
            throw e;
        }
        collector.finish();
        if (terminal.getKind() == PromptTerminal.Kind.ERROR) {
            throw new PromptTurnException(terminal, collector.getText());
        }
        return new PromptTextResult(collector.getText(), terminal);
    }

    public boolean respondToPermission(String requestId, PermissionResponse response) {
        if (requestId == null || requestId.isEmpty()) {
            throw new IllegalArgumentException("requestId must not be empty");
        }
        Objects.requireNonNull(response, "response");
        synchronized (lifecycleLock) {
            ensureOpen();
            String path = sessionPath() + "/permission/"
                    + DaemonClient.encodePathSegment(requestId);
            HttpSupport.Response httpResponse = sendMutation(path,
                    "POST /session/:id/permission/:requestId", response.toJson());
            if (httpResponse.getStatusCode() == 404) {
                if (isCurrentPermissionNotFound(httpResponse, requestId)) {
                    return false;
                }
                throw new DaemonHttpException(
                        "POST /session/:id/permission/:requestId",
                        httpResponse.getStatusCode(), httpResponse.getBody());
            }
            requireMutationStatus(httpResponse, 200,
                    "POST /session/:id/permission/:requestId");
            return true;
        }
    }

    public void cancelActivePrompt() {
        synchronized (lifecycleLock) {
            ensureOpen();
            HttpSupport.Response response = sendMutation(sessionPath() + "/cancel",
                    "POST /session/:id/cancel", Collections.emptyMap());
            requireMutationStatus(response, 204, "POST /session/:id/cancel");
        }
    }

    public HeartbeatResult heartbeat() {
        synchronized (lifecycleLock) {
            ensureOpen();
            return sendHeartbeat();
        }
    }

    public void detach() {
        close();
    }

    public void destroySession() {
        synchronized (lifecycleLock) {
            if (destroySucceeded.get()) {
                return;
            }
            closed.set(true);
            cancelAutomaticHeartbeat();
            awaitAutomaticHeartbeat();
            stopActivePrompt("Session was destroyed locally");
            try {
                HttpSupport.Response response;
                try {
                    response = client.sendDelete(sessionPath(),
                            detachAttempted.get() ? null : session.getClientId());
                } catch (IOException | InterruptedException e) {
                    restoreInterrupt(e);
                    throw new MutationOutcomeUnknownException(
                            "DELETE /session/:id", e);
                } catch (DaemonTransportException | DaemonProtocolException e) {
                    throw new MutationOutcomeUnknownException(
                            "DELETE /session/:id", e);
                }
                if (response.getStatusCode() == 404) {
                    if (!isCurrentSessionNotFound(response)) {
                        throw new DaemonHttpException("DELETE /session/:id",
                                response.getStatusCode(), response.getBody());
                    }
                } else {
                    requireMutationStatus(response, 204, "DELETE /session/:id");
                }
                destroySucceeded.set(true);
            } finally {
                client.unregister(this);
            }
        }
    }

    @Override
    public void close() {
        synchronized (lifecycleLock) {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            cancelAutomaticHeartbeat();
            awaitAutomaticHeartbeat();
            stopActivePrompt("Session was detached locally");
            try {
                if (!destroySucceeded.get()
                        && detachAttempted.compareAndSet(false, true)) {
                    HttpSupport.Response response;
                    try {
                        response = client.sendMutation(sessionPath() + "/detach",
                                Collections.emptyMap(),
                                session.getClientId());
                    } catch (IOException | InterruptedException e) {
                        restoreInterrupt(e);
                        throw new DetachOutcomeUnknownException(e);
                    } catch (DaemonTransportException | DaemonProtocolException e) {
                        throw new DetachOutcomeUnknownException(e);
                    }
                    if (DaemonClient.isAmbiguousMutationStatus(
                            response.getStatusCode())) {
                        throw new DetachOutcomeUnknownException(
                                new DaemonHttpException(
                                        "POST /session/:id/detach",
                                        response.getStatusCode(),
                                        response.getBody()));
                    }
                    try {
                        DaemonClient.requireStatus(response, 204,
                                "POST /session/:id/detach");
                    } catch (DaemonProtocolException e) {
                        throw new DetachOutcomeUnknownException(e);
                    }
                }
            } finally {
                client.unregister(this);
            }
        }
    }

    private HttpSupport.Response sendMutation(String path, String operation,
            Map<String, Object> body) {
        try {
            return client.sendSessionMutation(path, body, session.getClientId());
        } catch (IOException | InterruptedException e) {
            restoreInterrupt(e);
            throw new MutationOutcomeUnknownException(operation, e);
        } catch (DaemonTransportException | DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
    }

    private static void requireMutationStatus(HttpSupport.Response response,
            int expected, String operation) {
        if (DaemonClient.isAmbiguousMutationStatus(response.getStatusCode())) {
            throw new MutationOutcomeUnknownException(operation,
                    new DaemonHttpException(operation,
                            response.getStatusCode(), response.getBody()));
        }
        try {
            DaemonClient.requireStatus(response, expected, operation);
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
    }

    void startAutomaticHeartbeat() {
        Duration interval = client.heartbeatInterval();
        if (interval.isZero() || !automaticHeartbeatSupported) {
            return;
        }
        synchronized (lifecycleLock) {
            if (closed.get() || heartbeatTask != null) {
                return;
            }
            long delayMillis = saturatedMillis(interval);
            heartbeatTask = client.scheduler().scheduleWithFixedDelay(
                    this::submitAutomaticHeartbeat,
                    delayMillis, delayMillis, TimeUnit.MILLISECONDS);
        }
    }

    private void submitAutomaticHeartbeat() {
        if (closed.get()
                || !heartbeatInFlight.compareAndSet(false, true)) {
            return;
        }
        Future<?> submitted = client.submitMaintenance(this::runAutomaticHeartbeat);
        if (submitted == null) {
            heartbeatInFlight.set(false);
        }
    }

    private void runAutomaticHeartbeat() {
        synchronized (lifecycleLock) {
            if (closed.get()) {
                heartbeatInFlight.set(false);
                return;
            }
            automaticHeartbeatRunning = true;
        }
        try {
            automaticHeartbeat();
        } finally {
            finishAutomaticHeartbeat();
        }
    }

    private void automaticHeartbeat() {
        if (closed.get() || heartbeatUnsupported.get()) {
            return;
        }
        try {
            sendHeartbeat();
        } catch (DaemonHttpException e) {
            if (e.getStatusCode() == 404 || e.getStatusCode() == 405) {
                heartbeatUnsupported.set(true);
            }
        } catch (DaemonException ignored) {
            // A later scheduled heartbeat is a new keepalive, not a request retry.
        }
    }

    private HeartbeatResult sendHeartbeat() {
        HttpSupport.Response response = sendMutation(
                sessionPath() + "/heartbeat",
                "POST /session/:id/heartbeat", Collections.emptyMap());
        try {
            requireMutationStatus(response, 200,
                    "POST /session/:id/heartbeat");
            Map<String, Object> json = JsonSupport.parseObject(response.getBody(),
                    "heartbeat response");
            String responseSessionId = JsonSupport.requiredString(json,
                    "sessionId", "heartbeat");
            if (!session.getSessionId().equals(responseSessionId)) {
                throw new DaemonProtocolException(
                        "Heartbeat response sessionId does not match the session");
            }
            String responseClientId = JsonSupport.requiredString(json,
                    "clientId", "heartbeat");
            if (!session.getClientId().equals(responseClientId)) {
                throw new DaemonProtocolException(
                        "Heartbeat response clientId does not match the client");
            }
            return new HeartbeatResult(responseSessionId,
                    responseClientId,
                    JsonSupport.requiredNonNegativeLong(json, "lastSeenAt",
                            "heartbeat"));
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(
                    "POST /session/:id/heartbeat", e);
        }
    }

    private void finishAutomaticHeartbeat() {
        synchronized (lifecycleLock) {
            automaticHeartbeatRunning = false;
            heartbeatInFlight.set(false);
            lifecycleLock.notifyAll();
        }
    }

    private void awaitAutomaticHeartbeat() {
        boolean interrupted = false;
        while (automaticHeartbeatRunning) {
            try {
                lifecycleLock.wait();
            } catch (InterruptedException e) {
                interrupted = true;
            }
        }
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private void cancelAutomaticHeartbeat() {
        ScheduledFuture<?> task = heartbeatTask;
        if (task != null) {
            task.cancel(false);
            heartbeatTask = null;
        }
    }

    private String sessionPath() {
        return "/session/" + DaemonClient.encodePathSegment(session.getSessionId());
    }

    private boolean isCurrentSessionNotFound(HttpSupport.Response response) {
        try {
            Map<String, Object> body = JsonSupport.parseObject(response.getBody(),
                    "DELETE /session/:id error response");
            String responseSessionId = JsonSupport.optionalString(body, "sessionId");
            String code = JsonSupport.optionalString(body, "code");
            return session.getSessionId().equals(responseSessionId)
                    && (code == null || "session_not_found".equals(code));
        } catch (DaemonProtocolException e) {
            return false;
        }
    }

    private boolean isCurrentPermissionNotFound(HttpSupport.Response response,
            String requestId) {
        try {
            Map<String, Object> body = JsonSupport.parseObject(response.getBody(),
                    "permission response error");
            String responseSessionId = JsonSupport.optionalString(body, "sessionId");
            String responseRequestId = JsonSupport.optionalString(body, "requestId");
            String code = JsonSupport.optionalString(body, "code");
            return session.getSessionId().equals(responseSessionId)
                    && (responseRequestId == null
                            || requestId.equals(responseRequestId))
                    && (code == null || "session_not_found".equals(code));
        } catch (DaemonProtocolException e) {
            return false;
        }
    }

    private void ensureOpen() {
        if (closed.get()) {
            throw new IllegalStateException("DaemonSessionClient is closed");
        }
    }

    private void stopActivePrompt(String message) {
        PromptExecution execution = activePrompt.get();
        if (execution != null) {
            execution.stop(new PromptOutcomeIndeterminateException(message, ""));
        }
    }

    private static void restoreInterrupt(Exception exception) {
        if (exception instanceof InterruptedException) {
            Thread.currentThread().interrupt();
        }
    }

    private final class PromptExecution {
        private final PromptRequest request;
        private final PromptObserver observer;
        private final CompletableFuture<PromptAcceptance> acceptance =
                new CompletableFuture<>();
        private final CompletableFuture<PromptTerminal> completion =
                new CompletableFuture<>();
        private final CountDownLatch terminalPublicationGate =
                new CountDownLatch(1);
        private final PromptCall call = new PromptCall(acceptance, completion,
                client.reserveFuturePublications(), terminalPublicationGate);
        private final AtomicReference<InputStream> activeStream = new AtomicReference<>();
        private final Object streamLifecycleLock = new Object();
        private final Object observerLifecycleLock = new Object();
        private final Object outcomeLock = new Object();
        private final AtomicReference<PromptOutcomeIndeterminateException> stopFailure =
                new AtomicReference<>();
        private volatile CompletableFuture<Void> streamClose =
                CompletableFuture.completedFuture(null);
        private volatile boolean admissionStarted;
        private volatile PromptTerminal terminalResult;
        private volatile Throwable terminalFailure;
        private volatile Thread runner;
        private boolean observerInProgress;
        private boolean outcomeClaimed;

        PromptExecution(PromptRequest request, PromptObserver observer) {
            this.request = request;
            this.observer = observer;
        }

        void failBeforeStart(RuntimeException failure) {
            terminalPublicationGate.countDown();
            acceptance.completeExceptionally(failure);
            completion.completeExceptionally(failure);
        }

        void releaseTerminalPublication() {
            terminalPublicationGate.countDown();
        }

        CompletableFuture<Void> streamCleanupCompletion() {
            synchronized (streamLifecycleLock) {
                return streamClose;
            }
        }

        void stop(PromptOutcomeIndeterminateException failure) {
            synchronized (outcomeLock) {
                if (outcomeClaimed) {
                    return;
                }
                outcomeClaimed = true;
                stopFailure.set(failure);
            }
            synchronized (observerLifecycleLock) {
                if (!observerInProgress && acceptance.isDone()) {
                    completion.completeExceptionally(failure);
                    terminalPublicationGate.countDown();
                }
            }
            InputStream stream = activeStream.get();
            if (stream != null) {
                requestStreamClose(stream);
            }
            Thread currentRunner = runner;
            if (currentRunner != null
                    && currentRunner != Thread.currentThread()) {
                currentRunner.interrupt();
            }
        }

        void run() {
            runner = Thread.currentThread();
            try {
                PromptAcceptance admitted;
                synchronized (lifecycleLock) {
                    ensureOpen();
                    admissionStarted = true;
                    admitted = admit();
                }
                acceptance.complete(admitted);
                try {
                    PromptTerminal terminal = observe(admitted);
                    activePrompt.compareAndSet(this, null);
                    terminalResult = terminal;
                } catch (PromptOutcomeIndeterminateException e) {
                    throw e;
                } catch (Throwable e) {
                    throw new PromptOutcomeIndeterminateException(
                            "Prompt observation failed", e, "");
                }
            } catch (Throwable failure) {
                if (!acceptance.isDone()
                        && failure instanceof DaemonHttpException) {
                    activePrompt.compareAndSet(this, null);
                }
                if (!acceptance.isDone()) {
                    PromptOutcomeIndeterminateException stopped = stopFailure.get();
                    acceptance.completeExceptionally(stopped != null
                            && !admissionStarted
                                    ? new DaemonException(
                                            "Prompt stopped before admission was dispatched")
                                    : failure);
                }
                PromptOutcomeIndeterminateException stopped = stopFailure.get();
                terminalFailure = stopped == null ? failure : stopped;
            } finally {
                runner = null;
            }
        }

        void publishCompletion() {
            PromptTerminal terminal = terminalResult;
            Throwable failure = terminalFailure;
            PromptOutcomeIndeterminateException stopped = stopFailure.get();
            if (!acceptance.isDone()) {
                acceptance.completeExceptionally(stopped != null
                        && !admissionStarted
                                ? new DaemonException(
                                        "Prompt stopped before admission was dispatched")
                                : failure == null ? new PromptOutcomeIndeterminateException(
                                        "Prompt ended without an admission outcome", "")
                                        : failure);
            }
            if (terminal != null) {
                completion.complete(terminal);
            } else {
                completion.completeExceptionally(stopped != null
                        ? stopped
                        : failure == null ? new PromptOutcomeIndeterminateException(
                                "Prompt ended without a terminal outcome", "")
                                : failure);
            }
        }

        private PromptAcceptance admit() {
            HttpSupport.Response response;
            try {
                response = client.sendMutation(sessionPath() + "/prompt",
                        request.toJson(),
                        session.getClientId());
            } catch (IOException | InterruptedException e) {
                restoreInterrupt(e);
                throw new PromptAdmissionUnknownException(e);
            } catch (DaemonTransportException | DaemonProtocolException e) {
                throw new PromptAdmissionUnknownException(e);
            }
            if (response.getStatusCode() != 202) {
                if (DaemonClient.isAmbiguousMutationStatus(
                        response.getStatusCode())) {
                    throw new PromptAdmissionUnknownException(
                            new DaemonHttpException("POST /session/:id/prompt",
                                    response.getStatusCode(), response.getBody()));
                }
                if (!response.isSuccess()) {
                    throw new DaemonHttpException("POST /session/:id/prompt",
                            response.getStatusCode(), response.getBody());
                }
                throw new PromptAdmissionUnknownException(
                        "Expected 202 admission watermark but received HTTP "
                                + response.getStatusCode());
            }
            try {
                Map<String, Object> json = JsonSupport.parseObject(response.getBody(),
                        "prompt admission response");
                return new PromptAcceptance(
                        JsonSupport.requiredString(json, "promptId", "prompt admission"),
                        JsonSupport.requiredNonNegativeLong(json, "lastEventId",
                                "prompt admission"));
            } catch (DaemonProtocolException e) {
                throw new PromptAdmissionUnknownException(e);
            }
        }

        private PromptTerminal observe(PromptAcceptance admitted) {
            Duration timeout = request.observationTimeoutOr(
                    client.promptObservationTimeout());
            long deadline = deadlineAfter(timeout);
            long cursor = admitted.getLastEventId();
            int consecutiveFailures = 0;
            Duration serverRetry = null;
            while (true) {
                checkStoppedOrExpired(deadline);
                awaitPriorStreamClose(deadline);
                checkStoppedOrExpired(deadline);
                HttpResponse<InputStream> response;
                try {
                    response = client.openSse(sessionPath() + "/events",
                            session.getClientId(), cursor,
                            Duration.ofMillis(remainingMillis(deadline)));
                } catch (IOException e) {
                    reconnectOrThrow(++consecutiveFailures,
                            serverRetry, deadline, e);
                    continue;
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw stoppedOrIndeterminate("SSE connection was interrupted", e);
                }
                if (response.statusCode() != 200) {
                    int statusCode = response.statusCode();
                    Duration retryAfter = retryAfter(response.headers());
                    Duration retryDelay = retryAfter == null
                            ? serverRetry : retryAfter;
                    String body;
                    try {
                        body = readSseError(response, deadline);
                    } catch (DaemonProtocolException e) {
                        throw indeterminate("SSE error response was malformed", e);
                    } catch (DaemonTransportException e) {
                        if (!RETRYABLE_SSE_STATUS.contains(statusCode)) {
                            throw indeterminate("SSE failed with HTTP "
                                    + statusCode, e);
                        }
                        reconnectOrThrow(++consecutiveFailures,
                                retryDelay, deadline, e);
                        continue;
                    }
                    if (!RETRYABLE_SSE_STATUS.contains(statusCode)) {
                        Throwable responseFailure = statusCode >= 200
                                && statusCode < 300
                                        ? new DaemonProtocolException(
                                                "GET /session/:id/events returned "
                                                        + "unexpected successful HTTP "
                                                        + statusCode)
                                        : new DaemonHttpException(
                                                "GET /session/:id/events",
                                                statusCode, body);
                        throw indeterminate("SSE failed with HTTP "
                                + statusCode, responseFailure);
                    }
                    reconnectOrThrow(++consecutiveFailures,
                            retryDelay, deadline,
                            new DaemonHttpException("GET /session/:id/events",
                                    statusCode, body));
                    continue;
                }
                InputStream stream = response.body();
                activeStream.set(stream);
                AtomicLong lastActivity = new AtomicLong(System.nanoTime());
                AtomicBoolean idleClosed = new AtomicBoolean();
                ScheduledFuture<?> watchdog = null;
                ScheduledFuture<?> deadlineWatchdog = null;
                SseReader reader = null;
                try {
                    checkStoppedOrExpired(deadline);
                    validateSseHeaders(response.headers());
                    watchdog = scheduleIdleWatchdog(stream,
                            lastActivity, idleClosed);
                    deadlineWatchdog = scheduleDeadlineWatchdog(deadline);
                    reader = new SseReader(stream,
                            client.maximumSseFrameBytes(),
                            () -> lastActivity.set(System.nanoTime()));
                    while (true) {
                        checkStoppedOrExpired(deadline);
                        SseReader.Frame frame = reader.next();
                        if (frame == null) {
                            throw new IOException("SSE stream ended before terminal");
                        }
                        DaemonEvent event = parseEvent(frame);
                        Long eventId = event.getId();
                        if (eventId != null && eventId <= cursor) {
                            continue;
                        }
                        if (eventId != null && eventId != cursor + 1) {
                            throw new DaemonProtocolException("SSE event ID gap: expected "
                                    + (cursor + 1) + " but received " + eventId);
                        }
                        PromptTerminal terminal = processEvent(event, admitted.getPromptId());
                        if (terminal == null) {
                            checkStoppedOrExpired(deadline);
                        }
                        if (eventId != null) {
                            cursor = eventId;
                            consecutiveFailures = 0;
                        }
                        if (terminal != null) {
                            if (!claimTerminal(terminal, deadline)) {
                                PromptOutcomeIndeterminateException stopped =
                                        stopFailure.get();
                                if (stopped == null) {
                                    stop(indeterminate(
                                            "Prompt observation timed out", null));
                                    stopped = stopFailure.get();
                                }
                                throw stopped == null
                                        ? indeterminate(
                                                "Prompt outcome was already settled",
                                                null)
                                        : stopped;
                            }
                            return terminal;
                        }
                    }
                } catch (IOException e) {
                    requestStreamClose(stream);
                    checkStoppedOrExpired(deadline);
                    String reason = idleClosed.get()
                            ? "SSE idle timeout" : "SSE stream failed";
                    if (reader != null && reader.getRetryMillis() != null) {
                        serverRetry = Duration.ofMillis(reader.getRetryMillis());
                    }
                    reconnectOrThrow(++consecutiveFailures,
                            serverRetry, deadline,
                            new IOException(reason, e));
                } catch (DaemonProtocolException e) {
                    throw indeterminate(e.getMessage(), e);
                } catch (RuntimeException e) {
                    if (e instanceof PromptOutcomeIndeterminateException) {
                        throw e;
                    }
                    throw indeterminate("Prompt observer failed", e);
                } finally {
                    if (watchdog != null) {
                        watchdog.cancel(false);
                    }
                    if (deadlineWatchdog != null) {
                        deadlineWatchdog.cancel(false);
                    }
                    requestStreamClose(stream);
                }
            }
        }

        private PromptTerminal processEvent(DaemonEvent event, String promptId) {
            if (SESSION_FAILURE_EVENTS.contains(event.getType())) {
                throw indeterminate("Daemon session stream reported "
                        + event.getType(), null);
            }
            if (OBSERVABLE_STREAM_EVENTS.contains(event.getType())) {
                notifyObserver(() -> observer.onEvent(event));
                return null;
            }
            if (!event.belongsTo(promptId)) {
                return null;
            }
            if ("turn_complete".equals(event.getType())
                    || "turn_error".equals(event.getType())) {
                PromptTerminal terminal = PromptTerminal.from(event, promptId,
                        session.getSessionId());
                dispatch(event);
                return terminal;
            }
            dispatch(event);
            return null;
        }

        private void dispatch(DaemonEvent event) {
            notifyObserver(() -> dispatchToObserver(event));
        }

        private void dispatchToObserver(DaemonEvent event) {
            if ("permission_request".equals(event.getType())) {
                event.requireSessionId(session.getSessionId(), "permission_request");
                observer.onPermission(PermissionRequest.from(event), event);
            }
            if ("session_update".equals(event.getType())) {
                event.requireSessionId(session.getSessionId(), "session_update");
                Map<String, Object> update = event.update();
                String kind = event.updateKind();
                if ("agent_message_chunk".equals(kind)) {
                    String text = event.textChunk();
                    if (text != null) {
                        observer.onText(text, event);
                    }
                    Map<String, Object> metadata = JsonSupport.extensionObject(
                            update.get("_meta"));
                    Map<String, Object> usage = metadata == null ? null
                            : JsonSupport.extensionObject(metadata.get("usage"));
                    if (usage != null) {
                        observer.onUsage(usage, event);
                    }
                } else if ("agent_thought_chunk".equals(kind)) {
                    String text = event.textChunk();
                    if (text != null) {
                        observer.onThought(text, event);
                    }
                } else if ("tool_call".equals(kind)
                        || "tool_call_update".equals(kind)) {
                    observer.onTool(update, event);
                } else if ("usage_update".equals(kind)) {
                    JsonSupport.requiredNonNegativeLong(update, "used",
                            "session_update.data.update");
                    JsonSupport.requiredNonNegativeLong(update, "size",
                            "session_update.data.update");
                    observer.onUsage(update, event);
                }
            }
            observer.onEvent(event);
        }

        private void notifyObserver(Runnable callback) {
            synchronized (observerLifecycleLock) {
                PromptOutcomeIndeterminateException stopped = stopFailure.get();
                if (stopped != null) {
                    throw stopped;
                }
                observerInProgress = true;
            }
            try {
                callback.run();
            } finally {
                synchronized (observerLifecycleLock) {
                    observerInProgress = false;
                }
            }
        }

        private void reconnectOrThrow(int failures,
                Duration retryAfter, long deadline, Throwable cause) {
            checkStoppedOrExpired(deadline);
            if (failures > client.maximumReconnectAttempts()) {
                throw indeterminate("SSE reconnect attempts exhausted", cause);
            }
            long maximumDelayMillis = Math.min(5000L,
                    250L << Math.min(failures - 1, 4));
            long delayMillis = retryAfter == null
                    ? ThreadLocalRandom.current().nextLong(maximumDelayMillis + 1)
                    : Math.min(5000L, retryAfter.toMillis());
            long remainingMillis = remainingMillis(deadline);
            if (remainingMillis <= 0) {
                throw indeterminate("Prompt observation timed out", cause);
            }
            delayMillis = Math.min(delayMillis, remainingMillis);
            try {
                Thread.sleep(delayMillis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw stoppedOrIndeterminate("SSE reconnect was interrupted", e);
            }
        }

        private ScheduledFuture<?> scheduleIdleWatchdog(InputStream stream,
                AtomicLong lastActivity, AtomicBoolean idleClosed) {
            long idleNanos = saturatedNanos(client.sseIdleTimeout());
            long intervalMillis = Math.max(100L,
                    saturatedMillis(client.sseIdleTimeout()) / 2L);
            return client.scheduler().scheduleAtFixedRate(() -> {
                if (System.nanoTime() - lastActivity.get() >= idleNanos
                        && idleClosed.compareAndSet(false, true)) {
                    requestStreamClose(stream);
                }
            }, intervalMillis, intervalMillis, TimeUnit.MILLISECONDS);
        }

        private String readSseError(HttpResponse<InputStream> response,
                long deadline) {
            InputStream stream = response.body();
            activeStream.set(stream);
            ScheduledFuture<?> watchdog = null;
            ScheduledFuture<?> deadlineWatchdog = null;
            try {
                checkStoppedOrExpired(deadline);
                long remaining = remainingMillis(deadline);
                long requestLimit = saturatedMillis(client.requestTimeout());
                watchdog = client.scheduler().schedule(
                        () -> requestStreamClose(stream),
                        Math.min(remaining, requestLimit), TimeUnit.MILLISECONDS);
                deadlineWatchdog = scheduleDeadlineWatchdog(deadline);
                return HttpSupport.readError(stream,
                        "GET /session/:id/events");
            } finally {
                if (watchdog != null) {
                    watchdog.cancel(false);
                }
                if (deadlineWatchdog != null) {
                    deadlineWatchdog.cancel(false);
                }
                requestStreamClose(stream);
            }
        }

        private ScheduledFuture<?> scheduleDeadlineWatchdog(long deadline) {
            return client.scheduler().schedule(
                    () -> stop(indeterminate(
                            "Prompt observation timed out", null)),
                    remainingNanos(deadline), TimeUnit.NANOSECONDS);
        }

        private boolean claimTerminal(PromptTerminal terminal, long deadline) {
            synchronized (outcomeLock) {
                if (outcomeClaimed || System.nanoTime() >= deadline) {
                    return false;
                }
                outcomeClaimed = true;
                terminalResult = terminal;
                return true;
            }
        }

        private void requestStreamClose(InputStream stream) {
            synchronized (streamLifecycleLock) {
                if (activeStream.compareAndSet(stream, null)) {
                    streamClose = client.closeStreamAsync(stream);
                }
            }
        }

        private void awaitPriorStreamClose(long deadline) {
            CompletableFuture<Void> cleanup;
            synchronized (streamLifecycleLock) {
                cleanup = streamClose;
            }
            try {
                cleanup.get(remainingMillis(deadline), TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw stoppedOrIndeterminate(
                        "SSE stream closure was interrupted", e);
            } catch (ExecutionException e) {
                throw indeterminate("SSE stream closure failed", e.getCause());
            } catch (TimeoutException e) {
                throw indeterminate(
                        "SSE stream closure exceeded the observation timeout", e);
            }
        }

        private void checkStoppedOrExpired(long deadline) {
            PromptOutcomeIndeterminateException stopped = stopFailure.get();
            if (stopped != null) {
                throw stopped;
            }
            if (System.nanoTime() >= deadline) {
                throw indeterminate("Prompt observation timed out", null);
            }
        }

        private PromptOutcomeIndeterminateException stoppedOrIndeterminate(
                String message, Throwable cause) {
            PromptOutcomeIndeterminateException stopped = stopFailure.get();
            return stopped == null ? indeterminate(message, cause) : stopped;
        }

        private PromptOutcomeIndeterminateException indeterminate(
                String message, Throwable cause) {
            return cause == null
                    ? new PromptOutcomeIndeterminateException(message, "")
                    : new PromptOutcomeIndeterminateException(message, cause, "");
        }
    }

    private static DaemonEvent parseEvent(SseReader.Frame frame) {
        Map<String, Object> envelope = JsonSupport.parseObject(frame.getData(),
                "SSE data");
        int version = JsonSupport.requiredInt(envelope, "v", "SSE envelope");
        if (version != 1) {
            throw new DaemonProtocolException("Unsupported SSE event version: " + version);
        }
        String type = JsonSupport.requiredString(envelope, "type", "SSE envelope");
        if (frame.getEvent() != null && !frame.getEvent().equals(type)) {
            throw new DaemonProtocolException("SSE event field does not match envelope type");
        }
        Long envelopeId = JsonSupport.optionalPositiveLong(envelope, "id",
                "SSE envelope");
        if (!Objects.equals(frame.getId(), envelopeId)) {
            throw new DaemonProtocolException("SSE id field does not match envelope id");
        }
        if (envelopeId == null && !IDLESS_SYNTHETIC_EVENTS.contains(type)) {
            throw new DaemonProtocolException(
                    "SSE event " + type + " must have a replayable event ID");
        }
        if (!envelope.containsKey("data")) {
            throw new DaemonProtocolException("SSE envelope.data is required");
        }
        Object data = envelope.get("data");
        Map<String, Object> metadata = JsonSupport.optionalObject(envelope, "_meta");
        return new DaemonEvent(envelopeId, version, type, data,
                JsonSupport.optionalString(envelope, "promptId"),
                JsonSupport.optionalString(envelope, "originatorClientId"),
                metadata == null ? Collections.emptyMap() : metadata);
    }

    private static void validateSseHeaders(HttpHeaders headers) {
        String contentType = headers.firstValue("Content-Type").orElse("");
        String mediaType = contentType.split(";", 2)[0].trim();
        if (!"text/event-stream".equalsIgnoreCase(mediaType)) {
            throw new DaemonProtocolException(
                    "SSE response Content-Type is not text/event-stream");
        }
        String contentEncoding = headers.firstValue("Content-Encoding")
                .orElse("identity");
        if (!"identity".equalsIgnoreCase(contentEncoding)) {
            throw new DaemonProtocolException("SSE response used unsupported Content-Encoding: "
                    + contentEncoding);
        }
    }

    private static Duration retryAfter(HttpHeaders headers) {
        String value = headers.firstValue("Retry-After").orElse(null);
        if (value == null) {
            return null;
        }
        try {
            long seconds = Long.parseLong(value.trim());
            return Duration.ofSeconds(Math.min(5, Math.max(0, seconds)));
        } catch (NumberFormatException ignored) {
            try {
                ZonedDateTime time = ZonedDateTime.parse(value,
                        DateTimeFormatter.RFC_1123_DATE_TIME);
                Duration result = Duration.between(ZonedDateTime.now(time.getZone()), time);
                return result.isNegative() ? Duration.ZERO : result;
            } catch (DateTimeParseException invalidDate) {
                return null;
            }
        }
    }

    private static long deadlineAfter(Duration timeout) {
        long now = System.nanoTime();
        long nanos;
        try {
            nanos = timeout.toNanos();
            return Math.addExact(now, nanos);
        } catch (ArithmeticException e) {
            return Long.MAX_VALUE;
        }
    }

    private static long remainingMillis(long deadline) {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) {
            return 0;
        }
        return Math.max(1L, TimeUnit.NANOSECONDS.toMillis(remaining));
    }

    private static long remainingNanos(long deadline) {
        return Math.max(0L, deadline - System.nanoTime());
    }

    private static long saturatedMillis(Duration duration) {
        try {
            return Math.max(1L, duration.toMillis());
        } catch (ArithmeticException e) {
            return Long.MAX_VALUE;
        }
    }

    private static long saturatedNanos(Duration duration) {
        try {
            return duration.toNanos();
        } catch (ArithmeticException e) {
            return Long.MAX_VALUE;
        }
    }

    private static final class TextCollector implements PromptObserver {
        private final long maximumBytes;
        private final StringBuilder text = new StringBuilder();
        private long bytes;
        private boolean pendingHighSurrogate;

        TextCollector(long maximumBytes) {
            this.maximumBytes = maximumBytes;
        }

        @Override
        public void onText(String chunk, DaemonEvent event) {
            boolean resolvesPendingSurrogate = pendingHighSurrogate
                    && !chunk.isEmpty();
            long chunkBytes = utf8Bytes(chunk);
            if (chunkBytes > maximumBytes - bytes) {
                String partialText = resolvesPendingSurrogate
                        ? text.substring(0, text.length() - 1)
                        : text.toString();
                throw new PromptContentLimitException(maximumBytes, partialText);
            }
            text.append(chunk);
            bytes += chunkBytes;
        }

        void finish() {
            if (!pendingHighSurrogate) {
                return;
            }
            if (bytes == maximumBytes) {
                throw new PromptContentLimitException(maximumBytes,
                        text.substring(0, text.length() - 1));
            }
            bytes++;
            pendingHighSurrogate = false;
        }

        private long utf8Bytes(String chunk) {
            long result = 0;
            int index = 0;
            if (pendingHighSurrogate && !chunk.isEmpty()) {
                if (Character.isLowSurrogate(chunk.charAt(0))) {
                    result += 4;
                    index = 1;
                } else {
                    result++;
                }
                pendingHighSurrogate = false;
            }
            while (index < chunk.length()) {
                char current = chunk.charAt(index++);
                if (Character.isHighSurrogate(current)) {
                    if (index == chunk.length()) {
                        pendingHighSurrogate = true;
                    } else if (Character.isLowSurrogate(chunk.charAt(index))) {
                        result += 4;
                        index++;
                    } else {
                        result++;
                    }
                } else if (Character.isLowSurrogate(current)) {
                    result++;
                } else if (current <= 0x7f) {
                    result++;
                } else if (current <= 0x7ff) {
                    result += 2;
                } else {
                    result += 3;
                }
            }
            return result;
        }

        String getText() {
            return text.toString();
        }
    }
}
