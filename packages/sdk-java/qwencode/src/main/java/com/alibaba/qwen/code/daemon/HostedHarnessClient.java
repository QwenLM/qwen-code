package com.alibaba.qwen.code.daemon;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

/** Java 11 transport dedicated to the private Hosted Harness profile. */
public final class HostedHarnessClient implements AutoCloseable {
    static final String BOOT_ID_HEADER = "X-Qwen-Harness-Boot-Id";
    static final String PROTOCOL_HEADER = "X-Qwen-Harness-Protocol-Version";
    static final String CLIENT_ID_HEADER = "X-Qwen-Client-Id";
    static final String EVENT_EPOCH_HEADER = "X-Qwen-Event-Epoch";
    static final String MANAGED_RUNTIME_RECOVERY_META_KEY =
            "qwen.daemon.managedRuntimeRecovery";

    private static final int PROTOCOL_VERSION = 1;
    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
                    + "[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern DIGEST_PATTERN = Pattern.compile(
            "^sha256:[0-9a-f]{64}$");
    private static final Pattern CLIENT_ID_PATTERN = Pattern.compile(
            "^[A-Za-z0-9._:-]{1,128}$");
    // The refusal-code vocabulary the Harness writes (snake_case, bounded by
    // the consumers' persistence column) — anything else on the wire is not
    // a named refusal.
    private static final Pattern REFUSAL_CODE_PATTERN = Pattern.compile(
            "[a-z0-9_]{1,128}");
    private static final Pattern EVENT_EPOCH_PATTERN = Pattern.compile(
            "^[A-Za-z0-9_-]{1,64}$");
    private static final Set<String> RUNTIME_RECOVERY_OUTCOMES =
            Set.of("known", "unknown");
    private static final Set<String> RUNTIME_RECOVERY_PHASES =
            Set.of("await_runtime", "results_ready");
    private static final Set<String> RUNTIME_EXECUTION_STATES =
            Set.of("prepared", "executing", "cancel_requested", "settled");
    private static final AtomicLong CLIENT_SEQUENCE = new AtomicLong();

    private final String baseUrl;
    private final String bearerToken;
    private final Duration requestTimeout;
    private final Duration heartbeatInterval;
    private final Duration sseIdleTimeout;
    private final int maximumSseFrameBytes;
    private final ExecutorService httpExecutor;
    private final ExecutorService heartbeatExecutor;
    private final ScheduledThreadPoolExecutor scheduler;
    private final HttpClient httpClient;
    private final HostedHarnessCapabilities capabilities;
    private final Map<String, AttachmentState> attachments =
            new ConcurrentHashMap<>();
    private final Map<String, ActivePrompt> activePrompts =
            new ConcurrentHashMap<>();
    private final Set<HarnessEventStream> streams =
            ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean();

    private HostedHarnessClient(Builder builder) {
        this.baseUrl = normalizeBaseUri(builder.baseUri);
        this.bearerToken = requireNonBlank(
                builder.bearerToken, "bearerToken");
        String expectedDigest = requireDigest(
                builder.capabilityDigest, "capabilityDigest");
        this.requestTimeout = builder.requestTimeout;
        this.heartbeatInterval = builder.heartbeatInterval;
        this.sseIdleTimeout = builder.sseIdleTimeout;
        this.maximumSseFrameBytes = builder.maximumSseFrameBytes;
        long number = CLIENT_SEQUENCE.incrementAndGet();
        this.httpExecutor = builder.httpExecutorOverride != null
                ? builder.httpExecutorOverride
                : new ThreadPoolExecutor(4, 4, 0L,
                        TimeUnit.MILLISECONDS,
                        new ArrayBlockingQueue<>(256),
                        daemonThreadFactory(
                                "qwencode-hosted-harness-" + number
                                        + "-http-"));
        this.heartbeatExecutor = new ThreadPoolExecutor(4, 4, 0L,
                TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(256),
                daemonThreadFactory(
                        "qwencode-hosted-harness-" + number + "-heartbeat-"));
        this.scheduler = new ScheduledThreadPoolExecutor(1,
                daemonThreadFactory(
                        "qwencode-hosted-harness-" + number + "-timer-"));
        this.scheduler.setRemoveOnCancelPolicy(true);
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(builder.connectTimeout)
                .executor(httpExecutor)
                .followRedirects(HttpClient.Redirect.NEVER)
                .version(HttpClient.Version.HTTP_1_1)
                .build();
        try {
            this.capabilities = negotiateCapabilities(expectedDigest);
        } catch (RuntimeException e) {
            scheduler.shutdownNow();
            heartbeatExecutor.shutdownNow();
            httpExecutor.shutdownNow();
            throw e;
        }
    }

    public static Builder builder() {
        return new Builder();
    }

    public HostedHarnessCapabilities capabilities() {
        ensureOpen();
        return capabilities;
    }

    public HarnessSessionRef createSession(CreateHarnessSession request) {
        if (request == null) {
            throw new IllegalArgumentException("request must not be null");
        }
        ensureOpen();
        HttpResponse<HttpSupport.Body> raw;
        try {
            raw = send("/session", "POST", request.toJson(), null);
        } catch (IOException | InterruptedException e) {
            restoreInterrupt(e);
            throw new SessionCreationOutcomeUnknownException(e);
        }
        try {
            validateGeneration(raw.headers(), raw.statusCode());
        } catch (DaemonProtocolException e) {
            // Same rule as the other mutation paths: ambiguous is
            // outcome-unknown, a definitive unfenced refusal keeps its
            // status.
            if (DaemonClient.isAmbiguousMutationStatus(raw.statusCode())) {
                throw new SessionCreationOutcomeUnknownException(e);
            }
            throw new DaemonHttpException("POST /session",
                    raw.statusCode(), e.getMessage());
        }
        HttpSupport.Response response;
        try {
            response = HttpSupport.consume(raw, "POST /session");
        } catch (DaemonProtocolException e) {
            throw new SessionCreationOutcomeUnknownException(e);
        }
        if (DaemonClient.isAmbiguousMutationStatus(
                response.getStatusCode())) {
            throw new SessionCreationOutcomeUnknownException(
                    new DaemonHttpException("POST /session",
                            response.getStatusCode(), response.getBody()));
        }
        try {
            DaemonClient.requireStatus(response, 200, "POST /session");
            HarnessSessionRef session = parseSession(response.getBody(),
                    request.getHarnessSessionId(), "POST /session response");
            registerAttachment(session);
            return session;
        } catch (DaemonProtocolException e) {
            throw new SessionCreationOutcomeUnknownException(e);
        }
    }

    public HarnessSessionRef loadSession(LoadHarnessSession request) {
        if (request == null) {
            throw new IllegalArgumentException("request must not be null");
        }
        ensureOpen();
        String path = sessionPath(request.getHarnessSessionId()) + "/load";
        HttpSupport.Response response;
        try {
            response = sendMutation(path, request.toJson(), null,
                    "POST /session/:id/load");
        } catch (MutationOutcomeUnknownException error) {
            throw namedLoadRefusal(error);
        }
        try {
            DaemonClient.requireStatus(response, 200,
                    "POST /session/:id/load");
            HarnessSessionRef session = parseSession(response.getBody(),
                    request.getHarnessSessionId(),
                    "POST /session/:id/load response");
            registerAttachment(session);
            return session;
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(
                    "POST /session/:id/load", e);
        }
    }

    public void resolveAction(
            HarnessSessionRef session,
            String actionId,
            String optionId,
            long inputRevision,
            String policyRevision) {
        HarnessSessionRef ref = requireSessionRef(session);
        if (actionId == null || !actionId.matches("tool_approval_[0-9a-f]{32}")) {
            throw new IllegalArgumentException("Invalid actionId");
        }
        HttpSupport.Response response =
                sendMutation(
                        sessionPath(ref.getHarnessSessionId())
                                + "/actions/"
                                + actionId
                                + "/resolve",
                        Map.of(
                                "optionId",
                                optionId,
                                "inputRevision",
                                inputRevision,
                                "policyRevision",
                                policyRevision),
                        ref.getHarnessClientId(),
                        "POST /session/:id/actions/:id/resolve");
        DaemonClient.requireStatus(response, 200, "POST /session/:id/actions/:id/resolve");
    }

    public PromptReceipt submitTurn(SubmitHarnessTurn request) {
        if (request == null) {
            throw new IllegalArgumentException("request must not be null");
        }
        ensureOpen();
        HarnessSessionRef session = requireSessionRef(request.getSession());
        ActivePrompt candidate = new ActivePrompt(request.getPromptId(),
                request.getPayloadDigest());
        ActivePrompt existing = activePrompts.putIfAbsent(
                session.getHarnessSessionId(), candidate);
        if (existing != null
                && (!existing.promptId.equals(candidate.promptId)
                        || !existing.payloadDigest.equals(
                                candidate.payloadDigest))) {
            throw new DaemonException(
                    "Hosted Harness session already has a running turn");
        }
        boolean ownsActivePrompt = existing == null;
        // Every settle flip below must write the entry the map holds: on a
        // same-identity retry that is the earlier registration, not this
        // call's candidate.
        ActivePrompt registered = ownsActivePrompt ? candidate : existing;
        // The latch is per-attempt: this call's send has not concluded, so
        // the registered entry is unsettled again even when an earlier
        // attempt's latch survived.
        registered.admissionSettled = false;
        AtomicBoolean dispatched = new AtomicBoolean();
        HttpResponse<HttpSupport.Body> raw;
        try {
            raw = send(sessionPath(session.getHarnessSessionId()) + "/prompt",
                    "POST", request.toJson(), session.getHarnessClientId(),
                    dispatched);
        } catch (DaemonTransportException e) {
            // A locally rejected send proves this submission never reached
            // the server, so a marker owned by it cannot be a running turn;
            // a same-identity retry keeps the original entry instead.
            if (ownsActivePrompt) {
                activePrompts.remove(session.getHarnessSessionId(),
                        registered);
            }
            throw e;
        } catch (IOException | InterruptedException e) {
            if (ownsActivePrompt) {
                registered.admissionSettled = true;
            }
            restoreInterrupt(e);
            throw new PromptAdmissionUnknownException(e);
        } catch (RuntimeException | Error e) {
            // An unchecked escape before dispatch (a header value the
            // request builder rejects, a failing executor state probe)
            // proves this submission never reached the server, so a marker
            // this call owns is released like a locally rejected send; a
            // same-identity retry keeps the original entry. An escape past
            // the dispatch boundary can never be matched by a terminal
            // event, so the owning call's marker settles instead: a later
            // status read is the recovery path that can clear it.
            if (ownsActivePrompt && !dispatched.get()) {
                activePrompts.remove(session.getHarnessSessionId(),
                        registered);
            } else if (ownsActivePrompt) {
                registered.admissionSettled = true;
            }
            throw e;
        }
        // The owning call's send attempt concluded, so a status answer
        // received from here on no longer predates this submission's
        // admission window. A non-owning retry settles the entry only by
        // publishing a fresh one on the 202 path below.
        if (ownsActivePrompt) {
            registered.admissionSettled = true;
        }
        try {
            validateGeneration(raw.headers(), raw.statusCode());
        } catch (DaemonProtocolException | HostedHarnessGenerationException e) {
            // A proven generation change means every local record for that
            // peer is dead, the admission ledger included: retire it
            // instead of leaving a veto no live turn can ever clear.
            if (e instanceof HostedHarnessGenerationException) {
                activePrompts.remove(session.getHarnessSessionId());
                throw e;
            }
            // An unfenced 408/5xx (for example a gateway error page) cannot
            // prove the prompt was not admitted, so it is outcome-unknown.
            // A definitive unfenced 4xx was produced before the route's
            // promptId lookup: it refuses this submission, so a marker this
            // call owns is released, while an earlier same-identity entry
            // stays — the refusal says nothing about it.
            if (DaemonClient.isAmbiguousMutationStatus(raw.statusCode())) {
                throw new PromptAdmissionUnknownException(e);
            }
            if (ownsActivePrompt) {
                activePrompts.remove(session.getHarnessSessionId(),
                        candidate);
            }
            throw new DaemonHttpException("POST /session/:id/prompt",
                    raw.statusCode(), e.getMessage());
        }
        HttpSupport.Response response;
        try {
            response = HttpSupport.consume(raw,
                    "POST /session/:id/prompt");
        } catch (DaemonProtocolException e) {
            throw new PromptAdmissionUnknownException(e);
        }
        if (response.getStatusCode() != 202) {
            if (DaemonClient.isAmbiguousMutationStatus(
                    response.getStatusCode())) {
                throw new PromptAdmissionUnknownException(
                        new DaemonHttpException(
                                "POST /session/:id/prompt",
                                response.getStatusCode(), response.getBody()));
            }
            if (response.isSuccess()) {
                throw new PromptAdmissionUnknownException(
                        "Expected 202 admission watermark but received HTTP "
                                + response.getStatusCode());
            }
            if (response.getStatusCode() == 409) {
                // Narrow the release by refusal code, not by status class.
                // hosted_prompt_recovery_required is answered from the
                // route's hasAcceptedInput gate, so this promptId already
                // sits in the durable input log and the expected recovery
                // is its same-identity replay. The retention is a hint,
                // not a lock: the gate cannot distinguish an owed terminal
                // event from an already-settled replay, and a status read
                // answering hasActivePrompt:false still clears the marker.
                // Every other 409 code is
                // produced without admitting this submission
                // (hosted_turn_active only after the same-identity replay
                // branch already returned 202, the busy and closing codes
                // above the route's promptId lookup), so a marker this
                // call owns is released. On a same-identity retry the
                // earlier entry stays either way: several 409 reasons say
                // nothing about whether the original admission reached
                // the server at all.
                String code = refusalCode(response.getBody());
                if (ownsActivePrompt
                        && !"hosted_prompt_recovery_required".equals(code)) {
                    activePrompts.remove(session.getHarnessSessionId(),
                            candidate);
                }
                throw new PromptAlreadyActiveException(
                        "POST /session/:id/prompt", response.getStatusCode(),
                        code);
            }
            // A definitive non-409 refusal releases only the marker this
            // call owns: refusals produced before the route's promptId
            // lookup (auth, rate limiting, body parsing) say nothing about
            // an earlier same-identity submission, whose entry stays.
            if (ownsActivePrompt) {
                activePrompts.remove(session.getHarnessSessionId(),
                        candidate);
            }
            throw new DaemonHttpException("POST /session/:id/prompt",
                    response.getStatusCode(), response.getBody());
        }
        try {
            Map<String, Object> json = JsonSupport.parseObject(
                    response.getBody(), "prompt admission response");
            String responsePromptId = parseWireUuid(
                    JsonSupport.requiredString(json, "promptId",
                            "prompt admission"), "prompt admission.promptId");
            if (!candidate.promptId.equals(responsePromptId)) {
                throw new PromptAdmissionUnknownException(
                        "Hosted Harness returned a different promptId");
            }
            if (!ownsActivePrompt) {
                // A same-identity retry's 202 re-admitted the submission:
                // publish a fresh, settled entry so a status read that
                // snapshotted the earlier instance cannot clear the marker
                // that is live now — its two-arg remove keys on the
                // observed instance.
                candidate.admissionSettled = true;
                if (!activePrompts.replace(session.getHarnessSessionId(),
                        registered, candidate)) {
                    // A terminal event for the earlier registration raced
                    // this flight and cleared the entry; this 202 is a
                    // live admission, so plant the fresh marker for its
                    // own terminal event.
                    activePrompts.putIfAbsent(
                            session.getHarnessSessionId(), candidate);
                }
            }
            return new PromptReceipt(responsePromptId,
                    JsonSupport.requiredNonNegativeLong(json, "lastEventId",
                            "prompt admission"),
                    requireEventEpoch(
                            JsonSupport.requiredString(json, "eventEpoch",
                                    "prompt admission"), false));
        } catch (PromptAdmissionUnknownException e) {
            throw e;
        } catch (DaemonProtocolException e) {
            throw new PromptAdmissionUnknownException(e);
        }
    }

    public PromptReceipt continueManagedRuntime(HarnessSessionRef session,
            String promptId, String checkpointId, String activationId) {
        HarnessSessionRef ref = requireSessionRef(session);
        String stablePromptId = requireUuid(promptId, "promptId");
        String checkpoint = requireBoundedRecoveryText(checkpointId,
                "checkpointId");
        String activation = requireBoundedRecoveryText(activationId,
                "activationId");
        String operation = "POST /session/:id/managed-runtime/continue";
        HttpSupport.Response response = sendMutation(
                sessionPath(ref.getHarnessSessionId())
                        + "/managed-runtime/continue",
                Map.of("promptId", stablePromptId,
                        "checkpointId", checkpoint,
                        "activationId", activation),
                ref.getHarnessClientId(), operation);
        return parseManagedRuntimeAdmission(response, stablePromptId,
                operation, "continuation");
    }

    public PromptReceipt cancelManagedRuntime(CancelManagedRuntime request) {
        if (request == null) {
            throw new IllegalArgumentException("request must not be null");
        }
        HarnessSessionRef ref = requireSessionRef(request.getSession());
        String operation = "POST /session/:id/managed-runtime/cancel";
        HttpSupport.Response response = sendMutation(
                sessionPath(ref.getHarnessSessionId())
                        + "/managed-runtime/cancel",
                request.toJson(), ref.getHarnessClientId(), operation);
        return parseManagedRuntimeAdmission(response, request.getPromptId(),
                operation, "cancellation");
    }

    private PromptReceipt parseManagedRuntimeAdmission(
            HttpSupport.Response response, String promptId, String operation,
            String action) {
        String context = "managed Runtime " + action;
        try {
            DaemonClient.requireStatus(response, 200, operation);
            Map<String, Object> json = JsonSupport.parseObject(
                    response.getBody(), context + " response");
            if (!JsonSupport.requiredBoolean(json, "accepted", context)) {
                throw new DaemonProtocolException(
                        "Hosted Harness did not admit the Runtime " + action);
            }
            String responsePromptId = parseWireUuid(
                    JsonSupport.requiredString(json, "promptId", context),
                    context + ".promptId");
            if (!promptId.equals(responsePromptId)) {
                throw new DaemonProtocolException(
                        "Hosted Harness returned a different " + action
                                + " promptId");
            }
            return new PromptReceipt(responsePromptId,
                    JsonSupport.requiredNonNegativeLong(json, "lastEventId",
                            context),
                    requireEventEpoch(JsonSupport.requiredString(json,
                            "eventEpoch", context), false));
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
    }

    public HarnessEventStream streamEvents(StreamHarnessEvents request) {
        if (request == null) {
            throw new IllegalArgumentException("request must not be null");
        }
        ensureOpen();
        HarnessSessionRef session = requireSessionRef(request.getSession());
        // The ref carries the watermark parseSession already validated, so
        // a caller that omits the resume pair still gets the epoch fence
        // from it rather than silently disabling the check.
        String fenceEpoch = request.getEventEpoch() != null
                ? request.getEventEpoch()
                : session.getHarnessEventEpoch();
        // An explicit cursor always wins, including a deliberate 0 (replay
        // from the beginning); only an omitted cursor falls back to the
        // ref's watermark.
        Long requestedCursor = request.getLastEventId();
        long cursor = requestedCursor != null
                ? requestedCursor
                : (session.getHarnessLastEventId() == null
                        ? 0
                        : session.getHarnessLastEventId());
        String path = sessionPath(session.getHarnessSessionId()) + "/events"
                + (request.isSnapshot() ? "?snapshot=1" : "");
        HttpRequest.Builder builder = sessionRequestBuilder(path, session)
                .header("Accept", "text/event-stream")
                .header("Accept-Encoding", "identity")
                .header("Cache-Control", "no-cache")
                .header("Last-Event-ID", Long.toString(cursor))
                .timeout(requestTimeout)
                .GET();
        if (fenceEpoch != null) {
            builder.header(EVENT_EPOCH_HEADER, fenceEpoch);
        }
        HttpResponse<InputStream> response;
        try {
            response = httpClient.send(builder.build(),
                    HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException e) {
            throw new DaemonTransportException(
                    "GET /session/:id/events transport failed", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DaemonTransportException(
                    "GET /session/:id/events was interrupted", e);
        } catch (RejectedExecutionException e) {
            throw new DaemonTransportException(
                    "Hosted Harness HTTP executor is saturated", e);
        }
        try {
            validateGeneration(response.headers(), response.statusCode());
        } catch (RuntimeException e) {
            closeQuietly(response.body());
            throw e;
        }
        if (response.statusCode() != 200) {
            String body = HttpSupport.readError(response.body(),
                    "GET /session/:id/events");
            closeQuietly(response.body());
            throw new DaemonHttpException("GET /session/:id/events",
                    response.statusCode(), body);
        }
        try {
            DaemonSessionClient.validateSseHeaders(response.headers());
            String eventEpoch = requireEventEpoch(
                    response.headers().firstValue(EVENT_EPOCH_HEADER)
                            .orElse(null), false);
            if (fenceEpoch != null && !fenceEpoch.equals(eventEpoch)) {
                throw new DaemonProtocolException(
                        "Hosted Harness SSE event epoch changed");
            }
            HarnessEventStream stream = new HarnessEventStream(this, session,
                    response.body(), maximumSseFrameBytes, cursor,
                    eventEpoch);
            registerStream(stream);
            stream.startIdleWatchdog();
            return stream;
        } catch (RuntimeException e) {
            closeQuietly(response.body());
            throw e;
        }
    }

    public void cancelTurn(HarnessSessionRef session) {
        HarnessSessionRef ref = requireSessionRef(session);
        HttpSupport.Response response = sendMutation(
                sessionPath(ref.getHarnessSessionId()) + "/cancel",
                Collections.emptyMap(), ref.getHarnessClientId(),
                "POST /session/:id/cancel");
        requireMutationStatus(response, 204,
                "POST /session/:id/cancel");
    }

    public HarnessHeartbeat heartbeat(HarnessSessionRef session) {
        HarnessSessionRef ref = requireSessionRef(session);
        AttachmentState state = attachments.get(ref.getHarnessSessionId());
        if (state != null && state.matches(ref)
                && !state.heartbeatInFlight.compareAndSet(false, true)) {
            throw new DaemonException(
                    "Hosted Harness heartbeat is already in flight");
        }
        try {
            return sendHeartbeat(ref);
        } finally {
            if (state != null && state.matches(ref)) {
                state.heartbeatInFlight.set(false);
            }
        }
    }

    public HarnessSessionStatus getStatus(HarnessSessionRef session) {
        HarnessSessionRef ref = requireSessionRef(session);
        // Snapshot before the remote read: the response describes the point
        // in time when the server evaluated it, so it may only clear the
        // registration that was present when the request was sent. A marker
        // whose submission is still in flight has not settled: the server
        // may admit it after evaluating the status answer, so the snapshot
        // says nothing about it.
        ActivePrompt observed = activePrompts.get(
                ref.getHarnessSessionId());
        boolean observedSettled = observed != null
                && observed.admissionSettled;
        String operation = "GET /session/:id/status";
        HttpSupport.Response response = sendRead(
                sessionPath(ref.getHarnessSessionId()) + "/status", ref,
                operation);
        DaemonClient.requireStatus(response, 200, operation);
        Map<String, Object> json = JsonSupport.parseObject(response.getBody(),
                "Hosted Harness status response");
        String responseSessionId = parseWireUuid(
                JsonSupport.requiredString(json, "sessionId", "status"),
                "status.sessionId");
        if (!ref.getHarnessSessionId().equals(responseSessionId)) {
            throw new DaemonProtocolException(
                    "Hosted Harness status sessionId does not match");
        }
        boolean active = JsonSupport.requiredBoolean(json,
                "hasActivePrompt", "status");
        if (!active && observedSettled) {
            activePrompts.remove(ref.getHarnessSessionId(), observed);
        }
        return new HarnessSessionStatus(responseSessionId, active, json);
    }

    public HarnessTranscriptPage getTranscript(GetHarnessTranscript request) {
        if (request == null) {
            throw new IllegalArgumentException("request must not be null");
        }
        HarnessSessionRef ref = requireSessionRef(request.getSession());
        List<String> query = new ArrayList<>();
        if (request.getLimit() != null) {
            query.add("limit=" + request.getLimit());
        }
        if (request.getCursor() != null) {
            query.add("cursor=" + encodeQuery(request.getCursor()));
        }
        if (request.getDirection() != null) {
            query.add("direction=" + request.getDirection());
        }
        String path = sessionPath(ref.getHarnessSessionId()) + "/transcript"
                + (query.isEmpty() ? "" : "?" + String.join("&", query));
        String operation = "GET /session/:id/transcript";
        HttpSupport.Response response = sendRead(path, ref, operation);
        DaemonClient.requireStatus(response, 200, operation);
        Map<String, Object> json = JsonSupport.parseObject(response.getBody(),
                "Hosted Harness transcript response");
        if (JsonSupport.requiredInt(json, "v", "transcript") != 1) {
            throw new DaemonProtocolException(
                    "Unsupported Hosted Harness transcript version");
        }
        String responseSessionId = parseWireUuid(
                JsonSupport.requiredString(json, "sessionId", "transcript"),
                "transcript.sessionId");
        if (!ref.getHarnessSessionId().equals(responseSessionId)) {
            throw new DaemonProtocolException(
                    "Hosted Harness transcript sessionId does not match");
        }
        List<Object> events = JsonSupport.optionalList(json, "events");
        if (events == null) {
            throw new DaemonProtocolException(
                    "transcript.events must be an array");
        }
        return new HarnessTranscriptPage(responseSessionId, events,
                JsonSupport.optionalString(json, "nextCursor"),
                JsonSupport.requiredBoolean(json, "hasMore", "transcript"),
                json);
    }

    public void detachSession(HarnessSessionRef session) {
        HarnessSessionRef ref = requireSessionRef(session);
        // sendMutation sits inside the try so the definitive arm below
        // also intercepts the DaemonHttpException sendMutation itself
        // raises for an unfenced definitive answer, matching the private
        // closeSession. Everything sendMutation lets through is
        // definitive; on an outcome-unknown surface the attachment stays:
        // it is the client's only liveness probe for this ref and its
        // record that the ref is still attached, while the server may
        // still be deciding the mutation.
        try {
            HttpSupport.Response response = sendMutation(
                    sessionPath(ref.getHarnessSessionId()) + "/detach",
                    Collections.emptyMap(), ref.getHarnessClientId(),
                    "POST /session/:id/detach");
            if (response.getStatusCode() != 404) {
                requireMutationStatus(response, 204,
                        "POST /session/:id/detach");
            }
            removeAttachment(ref);
        } catch (DaemonHttpException | HostedHarnessGenerationException e) {
            // A definitive refusal retires the attachment but says nothing
            // about a turn detach leaves running server-side, so the
            // admission ledger stays. A proven generation change means
            // every local record for that peer is dead, ledger included.
            // An outcome-unknown surface keeps both.
            removeAttachment(ref);
            if (e instanceof HostedHarnessGenerationException) {
                activePrompts.remove(ref.getHarnessSessionId());
            }
            throw e;
        }
    }

    public void updateSessionTitle(HarnessSessionRef session, String title) {
        HarnessSessionRef ref = requireSessionRef(session);
        String value = requireNonBlank(title, "title");
        if (value.length() > 256) {
            throw new IllegalArgumentException(
                    "title must not exceed 256 characters");
        }
        String operation = "POST /session/:id/title";
        HttpSupport.Response response = sendMutation(
                sessionPath(ref.getHarnessSessionId()) + "/title",
                Map.of("title", value), ref.getHarnessClientId(), operation);
        DaemonClient.requireStatus(response, 200, operation);
        Map<String, Object> json = JsonSupport.parseObject(
                response.getBody(), "Hosted Harness title response");
        String responseSessionId = parseWireUuid(
                JsonSupport.requiredString(json, "sessionId", "title"),
                "title.sessionId");
        if (!ref.getHarnessSessionId().equals(responseSessionId)) {
            throw new DaemonProtocolException(
                    "Hosted Harness title response sessionId does not match");
        }
        if (!JsonSupport.requiredBoolean(json, "persisted", "title")) {
            throw new DaemonProtocolException(
                    "Hosted Harness did not persist the Session title");
        }
    }

    public void closeSession(HarnessSessionRef session) {
        HarnessSessionRef ref = requireSessionRef(session);
        try {
            closeSession(ref.getHarnessSessionId(), ref.getHarnessClientId());
            removeAttachment(ref);
            activePrompts.remove(ref.getHarnessSessionId());
        } catch (DaemonHttpException | HostedHarnessGenerationException e) {
            // A definitive refusal still retires the local state; an
            // outcome-unknown surface keeps it, same rule as detach. The
            // ledger is the one exception: a refusal proving the turn is
            // still live (hosted_turn_active) must keep the admission
            // record, or the local one-turn veto fails open against a
            // running turn.
            removeAttachment(ref);
            if (!provesLiveTurn(e)) {
                activePrompts.remove(ref.getHarnessSessionId());
            }
            throw e;
        }
    }

    public void closeSession(String harnessSessionId) {
        ensureOpen();
        String sessionId = requireUuid(harnessSessionId,
                "harnessSessionId");
        try {
            closeSession(sessionId, null);
            discardLocalSessionState(sessionId);
        } catch (DaemonHttpException | HostedHarnessGenerationException e) {
            discardLocalSessionState(sessionId, provesLiveTurn(e));
            throw e;
        }
    }

    private void discardLocalSessionState(String sessionId) {
        discardLocalSessionState(sessionId, false);
    }

    private void discardLocalSessionState(String sessionId,
            boolean keepLedger) {
        AttachmentState state = attachments.remove(sessionId);
        if (state != null) {
            state.cancel();
        }
        if (!keepLedger) {
            activePrompts.remove(sessionId);
        }
    }

    private void closeSession(String sessionId, String clientId) {
        String operation = "DELETE /session/:id";
        HttpResponse<HttpSupport.Body> raw;
        try {
            raw = send(sessionPath(sessionId), "DELETE", null, clientId);
        } catch (IOException | InterruptedException e) {
            restoreInterrupt(e);
            throw new MutationOutcomeUnknownException(operation, e);
        }
        try {
            validateGeneration(raw.headers(), raw.statusCode());
        } catch (DaemonProtocolException e) {
            // Same classification as the shared mutation channel below.
            if (DaemonClient.isAmbiguousMutationStatus(raw.statusCode())) {
                throw new MutationOutcomeUnknownException(operation, e);
            }
            throw new DaemonHttpException(operation, raw.statusCode(),
                    e.getMessage());
        }
        HttpSupport.Response response;
        try {
            response = HttpSupport.consume(raw, operation);
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
        if (response.getStatusCode() == 404) {
            return;
        }
        requireMutationStatus(response, 204, operation);
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        for (HarnessEventStream stream : new ArrayList<>(streams)) {
            stream.closeQuietly();
        }
        for (AttachmentState state : attachments.values()) {
            state.cancel();
        }
        attachments.clear();
        activePrompts.clear();
        scheduler.shutdownNow();
        heartbeatExecutor.shutdownNow();
        httpExecutor.shutdownNow();
        awaitTermination(scheduler);
        awaitTermination(heartbeatExecutor);
        awaitTermination(httpExecutor);
    }

    void observeEvent(HarnessSessionRef session, DaemonEvent event) {
        ActivePrompt active = activePrompts.get(
                session.getHarnessSessionId());
        if (active == null) {
            return;
        }
        if (("turn_complete".equals(event.getType())
                || "turn_error".equals(event.getType()))
                && event.belongsTo(active.promptId)) {
            activePrompts.remove(session.getHarnessSessionId(), active);
        }
    }

    void registerStream(HarnessEventStream stream) {
        streams.add(stream);
    }

    void unregisterStream(HarnessEventStream stream) {
        streams.remove(stream);
    }

    int registeredStreamCount() {
        return streams.size();
    }

    Duration sseIdleTimeout() {
        return sseIdleTimeout;
    }

    ScheduledThreadPoolExecutor scheduler() {
        return scheduler;
    }

    static String requireUuid(String value, String name) {
        String nonBlank = requireNonBlank(value, name);
        if (!UUID_PATTERN.matcher(nonBlank).matches()) {
            throw new IllegalArgumentException(
                    name + " must be an RFC UUID v1-v5");
        }
        return nonBlank.toLowerCase(Locale.ROOT);
    }

    static String requireDigest(String value, String name) {
        String nonBlank = requireNonBlank(value, name);
        if (!DIGEST_PATTERN.matcher(nonBlank).matches()) {
            throw new IllegalArgumentException(
                    name + " must be sha256:<64 lowercase hex characters>");
        }
        return nonBlank;
    }

    static String requireEventEpoch(String value, boolean optional) {
        if (value == null && optional) {
            return null;
        }
        if (value == null || value.isEmpty()) {
            throw new DaemonProtocolException(
                    "eventEpoch must contain 1-64 URL-safe characters");
        }
        String nonBlank = value;
        if (!EVENT_EPOCH_PATTERN.matcher(nonBlank).matches()) {
            throw new DaemonProtocolException(
                    "eventEpoch must contain 1-64 URL-safe characters");
        }
        return nonBlank;
    }

    private HostedHarnessCapabilities negotiateCapabilities(
            String expectedDigest) {
        HttpSupport.Response response;
        try {
            HttpRequest request = baseRequestBuilder("/capabilities")
                    .header("Accept", "application/json")
                    .header("Accept-Encoding", "identity")
                    .timeout(requestTimeout)
                    .GET()
                    .build();
            HttpResponse<HttpSupport.Body> raw = httpClient.send(request,
                    HttpSupport.bodyHandler());
            response = HttpSupport.consume(raw, "GET /capabilities");
        } catch (IOException e) {
            throw new DaemonTransportException(
                    "GET /capabilities transport failed", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DaemonTransportException(
                    "GET /capabilities was interrupted", e);
        } catch (RejectedExecutionException e) {
            throw new DaemonTransportException(
                    "Hosted Harness HTTP executor is saturated", e);
        }
        DaemonClient.requireStatus(response, 200, "GET /capabilities");
        Map<String, Object> json = JsonSupport.parseObject(response.getBody(),
                "GET /capabilities response");
        if (JsonSupport.requiredInt(json, "v", "capabilities") != 1) {
            throw new DaemonProtocolException(
                    "Unsupported capabilities version");
        }
        List<String> features = JsonSupport.stringList(json, "features");
        if (!JsonSupport.stringList(json, "transports").contains("rest")) {
            throw new DaemonProtocolException(
                    "Hosted Harness does not advertise the REST transport");
        }
        if (!features.contains("hosted_harness_private_v1")) {
            throw new DaemonProtocolException(
                    "Endpoint does not advertise hosted_harness_private_v1");
        }
        Map<String, Object> hosted = JsonSupport.requiredObject(json,
                "hostedHarness", "capabilities");
        Map<String, Object> versions = JsonSupport.requiredObject(hosted,
                "protocolVersions", "capabilities.hostedHarness");
        int current = JsonSupport.requiredInt(versions, "current",
                "capabilities.hostedHarness.protocolVersions");
        List<Object> supportedValues = JsonSupport.optionalList(versions,
                "supported");
        if (supportedValues == null) {
            throw new DaemonProtocolException(
                    "capabilities.hostedHarness.protocolVersions.supported "
                            + "must be an array");
        }
        List<Integer> supported = new ArrayList<>();
        for (Object value : supportedValues) {
            if (!(value instanceof Number)
                    || ((Number) value).intValue()
                            != ((Number) value).longValue()) {
                throw new DaemonProtocolException(
                        "Hosted Harness supported protocol versions must be integers");
            }
            supported.add(((Number) value).intValue());
        }
        if (current != PROTOCOL_VERSION
                || !supported.contains(PROTOCOL_VERSION)) {
            throw new DaemonProtocolException(
                    "Hosted Harness protocol version 1 is not supported");
        }
        String bootId = parseWireUuid(JsonSupport.requiredString(hosted,
                "bootId", "capabilities.hostedHarness"),
                "capabilities.hostedHarness.bootId");
        String digest = parseWireDigest(JsonSupport.requiredString(hosted,
                "capabilityDigest", "capabilities.hostedHarness"),
                "capabilities.hostedHarness.capabilityDigest");
        if (!expectedDigest.equals(digest)) {
            throw new HostedHarnessCapabilityMismatchException(
                    expectedDigest, digest);
        }
        return new HostedHarnessCapabilities(current, supported, bootId,
                digest);
    }

    private HarnessSessionRef parseSession(String body,
            String expectedSessionId, String context) {
        Map<String, Object> json = JsonSupport.parseObject(body, context);
        String sessionId = parseWireUuid(JsonSupport.requiredString(json,
                "sessionId", context), context + ".sessionId");
        if (!expectedSessionId.equals(sessionId)) {
            throw new DaemonProtocolException(
                    context + " returned a different sessionId");
        }
        String clientId = JsonSupport.requiredString(json, "clientId",
                context);
        if (!CLIENT_ID_PATTERN.matcher(clientId).matches()) {
            throw new DaemonProtocolException(
                    context + ".clientId is invalid");
        }
        HarnessRuntimeRecovery runtimeRecovery = parseRuntimeRecovery(json,
                context);
        Long lastEventId = json.containsKey("lastEventId")
                ? JsonSupport.requiredNonNegativeLong(json, "lastEventId",
                        context)
                : null;
        String eventEpoch = requireEventEpoch(
                JsonSupport.optionalString(json, "eventEpoch"), true);
        if ((lastEventId == null) != (eventEpoch == null)) {
            throw new DaemonProtocolException(context
                    + " must carry lastEventId and eventEpoch together");
        }
        if (runtimeRecovery != null && eventEpoch == null) {
            throw new DaemonProtocolException(context
                    + " must carry an event watermark for Runtime recovery");
        }
        return new HarnessSessionRef(
                sessionId,
                clientId,
                capabilities.getBootId(),
                JsonSupport.requiredString(json, "workspaceCwd", context),
                runtimeRecovery,
                lastEventId,
                eventEpoch,
                JsonSupport.optionalString(json, "approvalMode"));
    }

    private HarnessRuntimeRecovery parseRuntimeRecovery(
            Map<String, Object> session, String context) {
        Map<String, Object> metadata = JsonSupport.optionalObject(session,
                "_meta");
        if (metadata == null) {
            return null;
        }
        Map<String, Object> recovery = JsonSupport.optionalObject(metadata,
                MANAGED_RUNTIME_RECOVERY_META_KEY);
        if (recovery == null) {
            return null;
        }
        String phase = boundedRecoveryText(recovery, "phase", context);
        if (!RUNTIME_RECOVERY_PHASES.contains(phase)) {
            throw new DaemonProtocolException(context
                    + "._meta managed Runtime recovery phase is invalid");
        }
        String checkpointId = boundedRecoveryText(recovery,
                "checkpointId", context);
        String activationId = boundedRecoveryText(recovery,
                "activationId", context);
        List<Object> rawExecutions = JsonSupport.optionalList(recovery,
                "executions");
        if (rawExecutions == null || rawExecutions.isEmpty()
                || rawExecutions.size() > 1024) {
            throw new DaemonProtocolException(context
                    + "._meta managed Runtime recovery executions"
                    + " must contain 1-1024 items");
        }
        List<HarnessRuntimeExecutionRecovery> executions = new ArrayList<>();
        for (Object raw : rawExecutions) {
            Map<String, Object> execution = JsonSupport.extensionObject(raw);
            if (execution == null) {
                throw new DaemonProtocolException(context
                        + "._meta managed Runtime recovery execution"
                        + " must be an object");
            }
            String outcome = boundedRecoveryText(execution, "outcome",
                    context);
            if (!RUNTIME_RECOVERY_OUTCOMES.contains(outcome)) {
                throw new DaemonProtocolException(context
                        + "._meta managed Runtime recovery outcome is invalid");
            }
            Map<String, Object> status = JsonSupport.optionalObject(execution,
                    "status");
            if ("known".equals(outcome)) {
                if (status == null
                        || !RUNTIME_EXECUTION_STATES.contains(
                                JsonSupport.requiredString(status, "state",
                                        context))) {
                    throw new DaemonProtocolException(context
                            + "._meta managed Runtime recovery status is invalid");
                }
            } else if (status != null) {
                throw new DaemonProtocolException(context
                        + "._meta unknown Runtime recovery cannot carry status");
            }
            String progressCursor = JsonSupport.optionalString(execution,
                    "progressCursor");
            if (progressCursor != null
                    && !isBoundedRecoveryText(progressCursor)) {
                throw new DaemonProtocolException(context
                        + "._meta managed Runtime progress cursor is invalid");
            }
            executions.add(new HarnessRuntimeExecutionRecovery(
                    boundedRecoveryText(execution, "functionCallId", context),
                    boundedRecoveryText(execution, "toolName", context),
                    boundedRecoveryText(execution, "executionCallId", context),
                    boundedRecoveryText(execution, "runtimeSessionId", context),
                    progressCursor, outcome, status));
        }
        return new HarnessRuntimeRecovery(phase, checkpointId, activationId,
                executions);
    }

    private static String boundedRecoveryText(Map<String, Object> value,
            String field, String context) {
        String result = JsonSupport.requiredString(value, field, context);
        if (!isBoundedRecoveryText(result)) {
            throw new DaemonProtocolException(context + "._meta managed Runtime "
                    + field + " is invalid");
        }
        return result;
    }

    static String requireBoundedRecoveryText(String value,
            String field) {
        String result = requireNonBlank(value, field);
        if (!isBoundedRecoveryText(result)) {
            throw new IllegalArgumentException(
                    field + " must not exceed 512 UTF-8 bytes");
        }
        return result;
    }

    private static boolean isBoundedRecoveryText(String value) {
        return value.indexOf('\0') < 0
                && value.getBytes(StandardCharsets.UTF_8).length <= 512;
    }

    private HttpSupport.Response sendRead(String path,
            HarnessSessionRef session, String operation) {
        try {
            HttpResponse<HttpSupport.Body> raw = send(path, "GET", null,
                    session.getHarnessClientId());
            validateGeneration(raw.headers(), raw.statusCode());
            return HttpSupport.consume(raw, operation);
        } catch (IOException e) {
            throw new DaemonTransportException(
                    operation + " transport failed", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DaemonTransportException(
                    operation + " was interrupted", e);
        }
    }

    private HttpSupport.Response sendMutation(String path,
            Map<String, Object> body, String clientId, String operation) {
        HttpResponse<HttpSupport.Body> raw;
        try {
            raw = send(path, "POST", body, clientId);
        } catch (IOException | InterruptedException e) {
            restoreInterrupt(e);
            throw new MutationOutcomeUnknownException(operation, e);
        }
        try {
            validateGeneration(raw.headers(), raw.statusCode());
        } catch (DaemonProtocolException e) {
            // A response that never passed the fencing middleware cannot
            // prove the mutation did not reach the Harness when its status
            // is ambiguous; a definitive unfenced refusal surfaces as-is.
            if (DaemonClient.isAmbiguousMutationStatus(raw.statusCode())) {
                throw new MutationOutcomeUnknownException(operation, e);
            }
            throw new DaemonHttpException(operation, raw.statusCode(),
                    e.getMessage());
        }
        HttpSupport.Response response;
        try {
            response = HttpSupport.consume(raw, operation);
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
        if (DaemonClient.isAmbiguousMutationStatus(
                response.getStatusCode())) {
            throw new MutationOutcomeUnknownException(operation,
                    new DaemonHttpException(operation,
                            response.getStatusCode(), response.getBody()));
        }
        return response;
    }

    // The machine-readable code of a definitive prompt refusal, when the
    // wire answer carries one from the refusal vocabulary.
    private static String refusalCode(String body) {
        String code;
        try {
            code = JsonSupport.optionalString(JsonSupport.parseObject(body,
                    "prompt refusal response"), "code");
        } catch (DaemonProtocolException parseFailure) {
            return null;
        }
        return code != null && REFUSAL_CODE_PATTERN.matcher(code).matches()
                ? code
                : null;
    }

    // A refusal whose code proves the session's turn is still running
    // server-side: the admission ledger must then survive a failed close.
    private static boolean provesLiveTurn(DaemonException e) {
        return e instanceof DaemonHttpException
                && "hosted_turn_active".equals(refusalCode(
                        ((DaemonHttpException) e).getResponseBody()));
    }

    // A load that fails with a refusal code on the wire is fail-closed, not
    // ambiguous: the Harness answers with a code only after the failed open
    // was cleaned up. Transport failures and code-less error bodies keep the
    // outcome-unknown classification.
    private static RuntimeException namedLoadRefusal(
            MutationOutcomeUnknownException error) {
        if (!(error.getCause() instanceof DaemonHttpException)) {
            return error;
        }
        DaemonHttpException http = (DaemonHttpException) error.getCause();
        String code;
        try {
            code = JsonSupport.optionalString(JsonSupport.parseObject(
                    http.getResponseBody(), "load refusal response"),
                    "code");
        } catch (DaemonProtocolException parseFailure) {
            return error;
        }
        if (code == null || !REFUSAL_CODE_PATTERN.matcher(code).matches()) {
            return error;
        }
        return new HarnessSessionRefusedException(error.getOperation(),
                http.getStatusCode(), code, error);
    }

    private HttpResponse<HttpSupport.Body> send(String path, String method,
            Map<String, Object> body, String clientId)
            throws IOException, InterruptedException {
        return send(path, method, body, clientId, new AtomicBoolean());
    }

    private HttpResponse<HttpSupport.Body> send(String path, String method,
            Map<String, Object> body, String clientId,
            AtomicBoolean dispatched)
            throws IOException, InterruptedException {
        HttpRequest.Builder builder = sessionRequestBuilder(path, clientId)
                .header("Accept", "application/json")
                .header("Accept-Encoding", "identity")
                .timeout(requestTimeout);
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.header("Content-Type", "application/json; charset=utf-8")
                    .method(method, HttpRequest.BodyPublishers.ofString(
                            JsonSupport.encode(body),
                            StandardCharsets.UTF_8));
        }
        // Snapshot the executor state ahead of dispatch: a termination
        // already in effect proves the request never left the JVM, while
        // one that lands mid-flight (close() racing an in-flight send)
        // must keep its outcome-unknown classification.
        boolean terminatedBeforeSend = httpExecutor.isShutdown();
        // Everything above is pre-dispatch construction; the flag lets the
        // caller tell an escape from it (provably never on the wire) apart
        // from one out of httpClient.send itself (outcome unknown).
        dispatched.set(true);
        try {
            return httpClient.send(builder.build(),
                    HttpSupport.bodyHandler());
        } catch (RejectedExecutionException e) {
            // A bare rejection surfaces at submit, so the request provably
            // never left the JVM; its outcome is known, not unknown.
            throw new DaemonTransportException(
                    "Hosted Harness HTTP executor is saturated", e);
        } catch (IOException e) {
            // java.net.http wraps a pool rejection into an IOException, and
            // the caller-supplied executor runs response delivery tasks too
            // — so this shape alone cannot tell a rejection at dispatch
            // from one after the request was already on the wire. Only the
            // already-terminated executor case proves non-dispatch;
            // everything else keeps its mid-flight outcome-unknown
            // classification.
            if (terminatedBeforeSend && isExecutorRejection(e)) {
                throw new DaemonTransportException(
                        "Hosted Harness HTTP executor is saturated", e);
            }
            throw e;
        }
    }

    private static boolean isExecutorRejection(Throwable failure) {
        for (Throwable current = failure; current != null;
                current = current.getCause()) {
            if (current instanceof RejectedExecutionException) {
                return true;
            }
        }
        return false;
    }

    private HttpRequest.Builder sessionRequestBuilder(String path,
            HarnessSessionRef session) {
        return sessionRequestBuilder(path, session.getHarnessClientId());
    }

    private HttpRequest.Builder sessionRequestBuilder(String path,
            String clientId) {
        HttpRequest.Builder builder = baseRequestBuilder(path)
                .header(PROTOCOL_HEADER, Integer.toString(PROTOCOL_VERSION))
                .header(BOOT_ID_HEADER, capabilities.getBootId());
        if (clientId != null) {
            builder.header(CLIENT_ID_HEADER, clientId);
        }
        return builder;
    }

    private HttpRequest.Builder baseRequestBuilder(String path) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(
                URI.create(baseUrl + path));
        builder.header("Authorization", "Bearer " + bearerToken);
        return builder;
    }

    private HarnessSessionRef requireSessionRef(HarnessSessionRef session) {
        ensureOpen();
        if (session == null) {
            throw new IllegalArgumentException("session must not be null");
        }
        requireUuid(session.getHarnessSessionId(), "harnessSessionId");
        if (!CLIENT_ID_PATTERN.matcher(
                session.getHarnessClientId()).matches()) {
            throw new IllegalArgumentException("harnessClientId is invalid");
        }
        if (!capabilities.getBootId().equals(
                session.getHarnessBootId())) {
            throw new HostedHarnessGenerationException(
                    session.getHarnessBootId(), capabilities.getBootId());
        }
        return session;
    }

    private HarnessHeartbeat sendHeartbeat(HarnessSessionRef session) {
        String operation = "POST /session/:id/heartbeat";
        HttpSupport.Response response = sendMutation(
                sessionPath(session.getHarnessSessionId()) + "/heartbeat",
                Collections.emptyMap(), session.getHarnessClientId(),
                operation);
        try {
            DaemonClient.requireStatus(response, 200, operation);
            Map<String, Object> json = JsonSupport.parseObject(
                    response.getBody(), "Hosted Harness heartbeat response");
            String sessionId = parseWireUuid(JsonSupport.requiredString(json,
                    "sessionId", "heartbeat"), "heartbeat.sessionId");
            String clientId = JsonSupport.requiredString(json, "clientId",
                    "heartbeat");
            if (!session.getHarnessSessionId().equals(sessionId)
                    || !session.getHarnessClientId().equals(clientId)) {
                throw new DaemonProtocolException(
                        "Hosted Harness heartbeat identity does not match");
            }
            return new HarnessHeartbeat(sessionId, clientId,
                    JsonSupport.requiredNonNegativeLong(json, "lastSeenAt",
                            "heartbeat"));
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
    }

    private void registerAttachment(HarnessSessionRef session) {
        AttachmentState replacement = new AttachmentState(session);
        AttachmentState previous = attachments.put(
                session.getHarnessSessionId(), replacement);
        if (previous != null) {
            previous.cancel();
        }
        if (!heartbeatInterval.isZero()) {
            long delay = saturatedMillis(heartbeatInterval);
            replacement.task = scheduler.scheduleWithFixedDelay(
                    () -> scheduleHeartbeat(replacement), delay, delay,
                    TimeUnit.MILLISECONDS);
        }
    }

    private void scheduleHeartbeat(AttachmentState state) {
        if (closed.get() || state.cancelled.get()
                || !state.heartbeatInFlight.compareAndSet(false, true)) {
            return;
        }
        try {
            heartbeatExecutor.execute(() -> {
                try {
                    if (!closed.get() && !state.cancelled.get()) {
                        sendHeartbeat(state.session);
                    }
                } catch (HostedHarnessGenerationException e) {
                    // A proven generation change means every local record
                    // for that peer is dead: retire the attachment and the
                    // admission ledger, or the ledger's veto wedges the
                    // session for the rest of this client's life.
                    discardLocalSessionState(
                            state.session.getHarnessSessionId());
                } catch (DaemonException ignored) {
                    // The next scheduled heartbeat is a new keepalive.
                } finally {
                    state.heartbeatInFlight.set(false);
                }
            });
        } catch (RejectedExecutionException e) {
            state.heartbeatInFlight.set(false);
        }
    }

    private void removeAttachment(HarnessSessionRef session) {
        AttachmentState state = attachments.get(session.getHarnessSessionId());
        if (state != null && state.matches(session)
                && attachments.remove(session.getHarnessSessionId(), state)) {
            state.cancel();
        }
    }

    private void validateGeneration(HttpHeaders headers, int statusCode) {
        String actual = headers.firstValue(BOOT_ID_HEADER).orElse(null);
        if (actual == null) {
            if (statusCode == 401 || statusCode == 403) {
                return;
            }
            throw new DaemonProtocolException(
                    "Hosted Harness response omitted " + BOOT_ID_HEADER);
        }
        String normalized;
        try {
            normalized = requireUuid(actual, BOOT_ID_HEADER);
        } catch (IllegalArgumentException e) {
            throw new DaemonProtocolException(
                    "Hosted Harness response returned an invalid boot ID", e);
        }
        if (!capabilities.getBootId().equals(normalized)) {
            throw new HostedHarnessGenerationException(
                    capabilities.getBootId(), normalized);
        }
    }

    private static void requireMutationStatus(HttpSupport.Response response,
            int expected, String operation) {
        if (DaemonClient.isAmbiguousMutationStatus(
                response.getStatusCode())) {
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

    private static String sessionPath(String sessionId) {
        return "/session/" + encodeQuery(sessionId);
    }

    private static String encodeQuery(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8)
                .replace("+", "%20");
    }

    private static String requireNonBlank(String value, String name) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }

    private static String parseWireUuid(String value, String name) {
        try {
            return requireUuid(value, name);
        } catch (IllegalArgumentException e) {
            throw new DaemonProtocolException(name + " is invalid", e);
        }
    }

    private static String parseWireDigest(String value, String name) {
        try {
            return requireDigest(value, name);
        } catch (IllegalArgumentException e) {
            throw new DaemonProtocolException(name + " is invalid", e);
        }
    }

    private static String normalizeBaseUri(URI baseUri) {
        if (baseUri == null) {
            throw new IllegalArgumentException("baseUri must not be null");
        }
        String scheme = baseUri.getScheme();
        if (!("http".equalsIgnoreCase(scheme)
                || "https".equalsIgnoreCase(scheme))
                || baseUri.getHost() == null
                || baseUri.getUserInfo() != null
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

    private static void restoreInterrupt(Exception exception) {
        if (exception instanceof InterruptedException) {
            Thread.currentThread().interrupt();
        }
    }

    private static void closeQuietly(InputStream input) {
        try {
            input.close();
        } catch (IOException ignored) {
            // The response is already being discarded.
        }
    }

    static long saturatedMillis(Duration duration) {
        try {
            return Math.max(1L, duration.toMillis());
        } catch (ArithmeticException e) {
            return Long.MAX_VALUE;
        }
    }

    private static ThreadFactory daemonThreadFactory(String prefix) {
        AtomicLong sequence = new AtomicLong();
        return runnable -> {
            Thread thread = new Thread(runnable,
                    prefix + sequence.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }

    private static void awaitTermination(ExecutorService service) {
        try {
            service.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void ensureOpen() {
        if (closed.get()) {
            throw new IllegalStateException(
                    "HostedHarnessClient is closed");
        }
    }

    private static final class ActivePrompt {
        private final String promptId;
        private final String payloadDigest;
        // Flipped when the owning submitTurn call's send attempt concludes
        // (answered or failed); while it is clear, a status answer may
        // predate the admission and must not clear the marker.
        private volatile boolean admissionSettled;

        ActivePrompt(String promptId, String payloadDigest) {
            this.promptId = promptId;
            this.payloadDigest = payloadDigest;
        }
    }

    private static final class AttachmentState {
        private final HarnessSessionRef session;
        private final AtomicBoolean heartbeatInFlight = new AtomicBoolean();
        private final AtomicBoolean cancelled = new AtomicBoolean();
        private volatile ScheduledFuture<?> task;

        AttachmentState(HarnessSessionRef session) {
            this.session = session;
        }

        boolean matches(HarnessSessionRef other) {
            return session.getHarnessClientId().equals(
                    other.getHarnessClientId());
        }

        void cancel() {
            cancelled.set(true);
            ScheduledFuture<?> scheduled = task;
            if (scheduled != null) {
                scheduled.cancel(false);
            }
        }
    }

    public static final class Builder {
        private URI baseUri = URI.create("http://127.0.0.1:4170");
        private String bearerToken;
        private String capabilityDigest;
        private Duration connectTimeout = Duration.ofSeconds(10);
        private Duration requestTimeout = Duration.ofSeconds(30);
        private Duration heartbeatInterval = Duration.ofMinutes(1);
        private Duration sseIdleTimeout = Duration.ofSeconds(45);
        private int maximumSseFrameBytes = 16 * 1024 * 1024;
        private ExecutorService httpExecutorOverride;

        private Builder() {
        }

        // Test seam: lets the suite park the HTTP executor deterministically
        // to stage dispatch- versus delivery-phase rejections.
        Builder httpExecutorOverride(ExecutorService executor) {
            this.httpExecutorOverride = executor;
            return this;
        }

        public Builder baseUri(URI baseUri) {
            this.baseUri = baseUri;
            return this;
        }

        public Builder bearerToken(String bearerToken) {
            this.bearerToken = bearerToken;
            return this;
        }

        public Builder capabilityDigest(String capabilityDigest) {
            this.capabilityDigest = capabilityDigest;
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

        public Builder heartbeatInterval(Duration heartbeatInterval) {
            if (heartbeatInterval == null || heartbeatInterval.isNegative()) {
                throw new IllegalArgumentException(
                        "heartbeatInterval must be non-negative");
            }
            this.heartbeatInterval = heartbeatInterval;
            return this;
        }

        /**
         * Bounds how long a consumer parked in {@code next()} waits without
         * any bytes from the peer before the client force-closes the stream
         * and {@code next()} fails with a {@link DaemonTransportException}.
         * Time between {@code next()} calls is not charged: this watchdog
         * never aborts a caller that pauses consumption (an approval wait
         * handled outside the stream, a slow event handler). The peer does
         * not share that patience — the hosted events route ends the SSE
         * response once its write buffer stays full, which this client can
         * only observe as a clean end of stream, so a consumer that stops
         * reading must bound the pause itself and re-open from {@code
         * getLastEventId()}/{@code getEventEpoch()} if the stream ends
         * early. The bound relies on the peer proving liveness during long
         * silent phases, the way the hosted events route's keepalive
         * comments do every 15 seconds, so a custom bound should stay
         * comfortably above that interval; against a peer that stays quiet
         * while a consumer is waiting, legitimate silence is treated as a
         * dead connection. {@link Duration#ZERO} disables the watchdog for
         * callers that own the deadline themselves.
         */
        public Builder sseIdleTimeout(Duration sseIdleTimeout) {
            if (sseIdleTimeout == null || sseIdleTimeout.isNegative()) {
                throw new IllegalArgumentException(
                        "sseIdleTimeout must be non-negative");
            }
            this.sseIdleTimeout = sseIdleTimeout;
            return this;
        }

        public Builder maximumSseFrameBytes(int maximumSseFrameBytes) {
            if (maximumSseFrameBytes < 1024) {
                throw new IllegalArgumentException(
                        "maximumSseFrameBytes must be at least 1024");
            }
            this.maximumSseFrameBytes = maximumSseFrameBytes;
            return this;
        }

        public HostedHarnessClient build() {
            return new HostedHarnessClient(this);
        }

        private static Duration positive(Duration duration, String name) {
            if (duration == null || duration.isZero()
                    || duration.isNegative()) {
                throw new IllegalArgumentException(name + " must be positive");
            }
            return duration;
        }
    }
}
