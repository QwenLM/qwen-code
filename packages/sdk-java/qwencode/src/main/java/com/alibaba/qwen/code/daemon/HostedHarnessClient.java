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

    private static final int PROTOCOL_VERSION = 1;
    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
                    + "[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern DIGEST_PATTERN = Pattern.compile(
            "^sha256:[0-9a-f]{64}$");
    private static final Pattern CLIENT_ID_PATTERN = Pattern.compile(
            "^[A-Za-z0-9._:-]{1,128}$");
    private static final Pattern EVENT_EPOCH_PATTERN = Pattern.compile(
            "^[A-Za-z0-9_-]{1,64}$");
    private static final AtomicLong CLIENT_SEQUENCE = new AtomicLong();

    private final String baseUrl;
    private final String bearerToken;
    private final Duration requestTimeout;
    private final Duration heartbeatInterval;
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
        this.maximumSseFrameBytes = builder.maximumSseFrameBytes;
        long number = CLIENT_SEQUENCE.incrementAndGet();
        this.httpExecutor = new ThreadPoolExecutor(4, 4, 0L,
                TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(256),
                daemonThreadFactory(
                        "qwencode-hosted-harness-" + number + "-http-"));
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
        validateGeneration(raw.headers(), raw.statusCode());
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
        HttpSupport.Response response = sendMutation(path,
                request.toJson(), null, "POST /session/:id/load");
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
        HttpResponse<HttpSupport.Body> raw;
        try {
            raw = send(sessionPath(session.getHarnessSessionId()) + "/prompt",
                    "POST", request.toJson(), session.getHarnessClientId());
        } catch (IOException | InterruptedException e) {
            restoreInterrupt(e);
            throw new PromptAdmissionUnknownException(e);
        }
        validateGeneration(raw.headers(), raw.statusCode());
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
            if (ownsActivePrompt && response.getStatusCode() != 409) {
                activePrompts.remove(session.getHarnessSessionId(), candidate);
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

    public HarnessEventStream streamEvents(StreamHarnessEvents request) {
        if (request == null) {
            throw new IllegalArgumentException("request must not be null");
        }
        ensureOpen();
        HarnessSessionRef session = requireSessionRef(request.getSession());
        String path = sessionPath(session.getHarnessSessionId()) + "/events"
                + (request.isSnapshot() ? "?snapshot=1" : "");
        HttpRequest.Builder builder = sessionRequestBuilder(path, session)
                .header("Accept", "text/event-stream")
                .header("Accept-Encoding", "identity")
                .header("Cache-Control", "no-cache")
                .header("Last-Event-ID",
                        Long.toString(request.getLastEventId()))
                .timeout(requestTimeout)
                .GET();
        if (request.getEventEpoch() != null) {
            builder.header(EVENT_EPOCH_HEADER, request.getEventEpoch());
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
            if (request.getEventEpoch() != null
                    && !request.getEventEpoch().equals(eventEpoch)) {
                throw new DaemonProtocolException(
                        "Hosted Harness SSE event epoch changed");
            }
            HarnessEventStream stream = new HarnessEventStream(this, session,
                    response.body(), maximumSseFrameBytes,
                    request.getLastEventId(), eventEpoch);
            streams.add(stream);
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
        if (!active) {
            activePrompts.remove(ref.getHarnessSessionId());
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
        HttpSupport.Response response = sendMutation(
                sessionPath(ref.getHarnessSessionId()) + "/detach",
                Collections.emptyMap(), ref.getHarnessClientId(),
                "POST /session/:id/detach");
        requireMutationStatus(response, 204,
                "POST /session/:id/detach");
        removeAttachment(ref);
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
        closeSession(ref.getHarnessSessionId(), ref.getHarnessClientId());
        removeAttachment(ref);
        activePrompts.remove(ref.getHarnessSessionId());
    }

    public void closeSession(String harnessSessionId) {
        String sessionId = requireUuid(harnessSessionId,
                "harnessSessionId");
        closeSession(sessionId, null);
        AttachmentState state = attachments.remove(sessionId);
        if (state != null) {
            state.cancel();
        }
        activePrompts.remove(sessionId);
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
        validateGeneration(raw.headers(), raw.statusCode());
        HttpSupport.Response response;
        try {
            response = HttpSupport.consume(raw, operation);
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
        if (response.getStatusCode() == 404 && clientId == null) {
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

    void unregisterStream(HarnessEventStream stream) {
        streams.remove(stream);
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
        return new HarnessSessionRef(sessionId, clientId,
                capabilities.getBootId(), JsonSupport.requiredString(json,
                        "workspaceCwd", context));
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
        validateGeneration(raw.headers(), raw.statusCode());
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

    private HttpResponse<HttpSupport.Body> send(String path, String method,
            Map<String, Object> body, String clientId)
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
        try {
            return httpClient.send(builder.build(),
                    HttpSupport.bodyHandler());
        } catch (RejectedExecutionException e) {
            throw new IOException(
                    "Hosted Harness HTTP executor is saturated", e);
        }
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

    private static long saturatedMillis(Duration duration) {
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
        private int maximumSseFrameBytes = 16 * 1024 * 1024;

        private Builder() {
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
