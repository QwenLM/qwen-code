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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
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
            Set.of("await_runtime", "await_agent", "await_command",
                    "results_ready");
    private static final Set<String> RUNTIME_EXECUTION_STATES =
            Set.of("prepared", "executing", "cancel_requested", "settled",
                    "abandoned");
    private static final AtomicLong CLIENT_SEQUENCE = new AtomicLong();
    // The Harness writes keepalive comments on its events route while no
    // event is committed; only then can silence bound a stream (#14135).
    static final String EVENT_KEEPALIVE_FEATURE = "event-keepalive/1";
    // Sessions whose terminal-event record is kept (see terminalPromptIds).
    private static final int TERMINAL_RECORD_LIMIT = 4096;

    private final String baseUrl;
    private final String bearerToken;
    private final Duration requestTimeout;
    private final Duration loadTimeout;
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
    // The promptId of each session's last observed terminal event: a
    // replay 202 answered from the route's journal for such a promptId owes
    // no future terminal event, so an owning retry must not keep the marker
    // it just planted for it. No teardown resets the durable journal those
    // replays are answered from — a detach, a DELETE and a Harness restart
    // all leave it for the next load — so none retires the record. The map
    // is bounded instead: past TERMINAL_RECORD_LIMIT sessions the least
    // recently used record is evicted, and an evicted session's journal
    // replay plants a marker the busy-turn status probe clears on the next
    // different prompt.
    private final Map<String, String> terminalPromptIds =
            Collections.synchronizedMap(new TerminalRecords());
    // Test seam: parks a getStatus snapshot between its two reads,
    // modelling an OS preemption at that point.
    volatile Runnable statusSnapshotProbe = () -> {};
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
        this.loadTimeout = builder.loadTimeout != null
                ? builder.loadTimeout : builder.requestTimeout;
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
            // outcome-unknown, and so is an unfenced 2xx or 3xx — an
            // intermediary that stripped the boot header proves nothing
            // about whether the mutation ran. A genuine unfenced 4xx
            // refused the request before it reached the route, but it is
            // not the Harness's own answer: surface the protocol failure,
            // never a DaemonHttpException consumers key terminal verdicts
            // on.
            if (DaemonClient.isAmbiguousMutationStatus(raw.statusCode())
                    || raw.statusCode() < 400) {
                throw new SessionCreationOutcomeUnknownException(e);
            }
            throw e;
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
        // Only a takeover load may settle parked executions and need the
        // longer ceiling; a plain attach stays on the steady-state one
        // (it also runs under ConcurrentHashMap bin locks in the connector).
        Duration timeout = request.isRuntimeRecoveryLoad()
                ? loadTimeout : requestTimeout;
        HttpSupport.Response response;
        try {
            response = sendMutation(path, request.toJson(),
                    request.getHarnessSessionId(), null,
                    "POST /session/:id/load", timeout);
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
                        ref.getHarnessSessionId(),
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
        if (request.getModelSelection() != null
                && !capabilities().getFeatures().contains("model-selection/1")) {
            throw new DaemonException("Hosted model selection is unavailable");
        }
        if (request.getApprovalSelection() != null
                && !capabilities().getFeatures().contains("approval-selection/1")) {
            throw new DaemonException("Hosted approval selection is unavailable");
        }
        if (request.getApprovalSelection() != null && Boolean.TRUE.equals(request.getApprovalSelection().get("planMode"))
                && !capabilities().getFeatures().contains("plan-mode/1")) {
            throw new DaemonException("Hosted Plan mode is unavailable");
        }
        if (request.getPromptContent().stream().anyMatch(block -> List.of("image", "resource").contains(block.get("type")))
                && !capabilities().getFeatures().contains("input-attachments/1")) {
            throw new DaemonException("Hosted input attachments are unavailable");
        }
        ActivePrompt candidate = new ActivePrompt(request.getPromptId(),
                request.getPayloadDigest(), session.getHarnessClientId(),
                request.getModelSelection(), request.getApprovalSelection());
        // Publish (or join) the admission marker and open this call's send
        // attempt under the same bin lock: a status read may clear the
        // marker only while no send attempt is in flight, so the attempt
        // window must open atomically with the registration it belongs to.
        // A same-identity retry joins the earlier registration; the server
        // deduplicates its replay against it.
        ActivePrompt admitted = registerAdmission(
                session.getHarnessSessionId(), candidate);
        if (!admitted.matches(candidate)) {
            // A prompt whose admission outcome was never learned (an
            // ambiguous answer, then a terminal coordinator failure) must
            // not pin the Session for every later Turn: ask the Harness,
            // which drops the entry when nothing is running there. The
            // probe is fail-closed — only a successful idle read clears the
            // entry, and only while no send attempt is open on it — and its
            // own failure must not leak the probe's exception types: the
            // dispatcher maps DaemonHttpException and
            // DaemonProtocolException to a terminal Turn failure, while the
            // plain busy-turn refusal below retries. A generation change
            // still propagates, so the dispatcher adopts the new
            // generation instead of flattening it into a busy retry.
            try {
                getStatus(session);
            } catch (HostedHarnessGenerationException generationChange) {
                throw generationChange;
            } catch (DaemonException probeFailure) {
                throw new DaemonException(
                        "Hosted Harness session already has a running turn");
            }
            admitted = registerAdmission(session.getHarnessSessionId(),
                    candidate);
            if (!admitted.matches(candidate)) {
                throw new DaemonException(
                        "Hosted Harness session already has a running turn");
            }
        }
        ActivePrompt registered = admitted;
        boolean ownsActivePrompt = registered == candidate;
        AtomicBoolean dispatched = new AtomicBoolean();
        // Set by a non-owning attempt whose conclusion was a definitive
        // refusal: an owed release is discharged on it once this attempt's
        // own send window closes in the finally below.
        boolean definitiveRefusal = false;
        // Set when this attempt's 202 was answered from the journal
        // after the promptId's terminal event was already observed:
        // the replay owes no future terminal event, so an owed release
        // on the joined entry is discharged once this attempt's send
        // window closes in the finally below.
        AtomicBoolean terminalReplay = new AtomicBoolean();
        try {
            HttpResponse<HttpSupport.Body> raw;
            try {
                raw = send(sessionPath(session.getHarnessSessionId()) + "/prompt",
                        "POST", request.toJson(), session.getHarnessClientId(),
                        requestTimeout, dispatched);
            } catch (DaemonTransportException e) {
                // A locally rejected send proves this submission never reached
                // the server, so a marker owned by it cannot be a running turn;
                // a same-identity retry keeps the original entry instead.
                if (ownsActivePrompt) {
                    registered.endSend();
                    releaseOwnedMarker(session.getHarnessSessionId(),
                            registered);
                } else {
                    definitiveRefusal = true;
                }
                throw e;
            } catch (IOException | InterruptedException e) {
                // A dropped send may still land server-side, but its admission
                // window closes with the attempt — the same rule as the owning
                // call's concluded send. A non-owning retry's dropped send must
                // not un-settle the owner's entry past every later status read:
                // no path would ever re-settle it.
                if (!ownsActivePrompt) {
                    registered.blockRelease();
                } else {
                    registered.endSend();
                }
                restoreInterrupt(e);
                throw new PromptAdmissionUnknownException(e);
            } catch (RuntimeException | Error e) {
                // An unchecked escape before dispatch (a header value the
                // request builder rejects, a failing executor state probe)
                // proves this submission never reached the server, so a marker
                // this call owns is released like a locally rejected send; a
                // same-identity retry keeps the original entry.
                if (ownsActivePrompt) {
                    registered.endSend();
                    if (!dispatched.get()) {
                        releaseOwnedMarker(session.getHarnessSessionId(),
                                registered);
                    }
                } else if (dispatched.get()) {
                    registered.blockRelease();
                } else {
                    definitiveRefusal = true;
                }
                throw e;
            }
            // An owning call's send attempt concluded here, so a status answer
            // received from here on no longer predates this submission's
            // admission window. A non-owning retry's window stays open until
            // its ledger decision lands — the 202 republish below or a
            // concluded refusal in the finally — so an owning release can
            // never strand the republish.
            if (ownsActivePrompt) {
                registered.endSend();
            }
            try {
                validateGeneration(raw.headers(), raw.statusCode());
            } catch (DaemonTransportException e) {
                // A boot-headerless 404 is answered by the serve delegating
                // app while the runtime is still starting, so this submission
                // provably never reached the Harness: release a marker this
                // call owns, the same rule as a locally rejected send.
                if (ownsActivePrompt) {
                    releaseOwnedMarker(session.getHarnessSessionId(),
                            registered);
                } else {
                    definitiveRefusal = true;
                }
                throw e;
            } catch (DaemonProtocolException | HostedHarnessGenerationException e) {
                // A proven generation change means every local record for that
                // peer is dead, the admission ledger included: retire it
                // instead of leaving a veto no live turn can ever clear.
                if (e instanceof HostedHarnessGenerationException) {
                    activePrompts.remove(session.getHarnessSessionId());
                    throw e;
                }
                // An unfenced 408/5xx (for example a gateway error page) cannot
                // prove the prompt was not admitted, and neither can an
                // unfenced 2xx or 3xx — the header-stripping intermediary may
                // have forwarded a real admission — so both are
                // outcome-unknown. A definitive unfenced 4xx was produced
                // before the route's promptId lookup: it refuses this
                // submission, so a marker this call owns is released, while an
                // earlier same-identity entry stays — the refusal says nothing
                // about it. The exception carries the peer's buffered body, so
                // a refusal code in it stays readable. submitTurn is the one
                // path whose unfenced 4xx still surfaces as DaemonHttpException:
                // the marker release keys on the refusal's definitiveness, and
                // the turn consumer's terminal classification of a refused
                // submission is bounded (hosted_harness_rejected). A 409 is the
                // exception: the consumer waits coded ones out as
                // duplicate-admission signals, so a code-less one is
                // outcome-unknown below, never this surface.
                if (DaemonClient.isAmbiguousMutationStatus(raw.statusCode())
                        || raw.statusCode() < 400) {
                    if (!ownsActivePrompt) {
                        registered.blockRelease();
                    }
                    throw new PromptAdmissionUnknownException(e);
                }
                // The body may be consumed only once, so the refusal-code
                // check below reuses this same consumed body.
                String refusalBody = HttpSupport.consume(raw,
                        "POST /session/:id/prompt").getBody();
                if (raw.statusCode() == 409) {
                    // An unfenced 409 carries the same refusal vocabulary as
                    // the fenced arm below, so it is narrowed by code exactly
                    // the same way: a boot-header-stripped
                    // hosted_prompt_recovery_required retains the marker and
                    // surfaces with its code intact instead of reading as a
                    // plain definitive refusal.
                    String code = refusalCode(refusalBody);
                    if ("hosted_prompt_recovery_required".equals(code)) {
                        registered.blockRelease();
                        throw new PromptAlreadyActiveException(
                                "POST /session/:id/prompt", raw.statusCode(),
                                refusalBody, code);
                    }
                    if (code == null) {
                        // A boot-headerless 409 whose body carries no
                        // refusal-vocabulary code is not the route's answer
                        // (an intermediary's error page, a body truncated
                        // past the buffered bound): like the unfenced
                        // 408/5xx arm above it cannot prove this submission
                        // was refused, so it is outcome-unknown and the
                        // marker stays.
                        if (!ownsActivePrompt) {
                            registered.blockRelease();
                        }
                        throw new PromptAdmissionUnknownException(e);
                    }
                }
                if (ownsActivePrompt) {
                    releaseOwnedMarker(session.getHarnessSessionId(),
                            candidate);
                } else {
                    definitiveRefusal = true;
                }
                throw new DaemonHttpException("POST /session/:id/prompt",
                        raw.statusCode(), refusalBody);
            }
            HttpSupport.Response response;
            try {
                response = HttpSupport.consume(raw,
                        "POST /session/:id/prompt");
            } catch (DaemonProtocolException e) {
                if (!ownsActivePrompt) {
                    registered.blockRelease();
                }
                throw new PromptAdmissionUnknownException(e);
            }
            if (response.getStatusCode() != 202) {
                if (DaemonClient.isAmbiguousMutationStatus(
                        response.getStatusCode())) {
                    if (!ownsActivePrompt) {
                        registered.blockRelease();
                    }
                    throw new PromptAdmissionUnknownException(
                            new DaemonHttpException(
                                    "POST /session/:id/prompt",
                                    response.getStatusCode(), response.getBody()));
                }
                if (response.isSuccess()) {
                    if (!ownsActivePrompt) {
                        registered.blockRelease();
                    }
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
                    if ("hosted_prompt_recovery_required".equals(code)) {
                        if (!ownsActivePrompt) {
                            registered.blockRelease();
                        }
                    } else if (ownsActivePrompt) {
                        releaseOwnedMarker(session.getHarnessSessionId(),
                                candidate);
                    } else {
                        definitiveRefusal = true;
                    }
                    throw new PromptAlreadyActiveException(
                            "POST /session/:id/prompt", response.getStatusCode(),
                            response.getBody(), code);
                }
                // A definitive non-409 refusal releases only the marker this
                // call owns: refusals produced before the route's promptId
                // lookup (auth, rate limiting, body parsing) say nothing about
                // an earlier same-identity submission, whose entry stays.
                if (ownsActivePrompt) {
                    releaseOwnedMarker(session.getHarnessSessionId(),
                            candidate);
                } else {
                    definitiveRefusal = true;
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
                // One bin-locked decision for both arms: the
                // terminal-record check gates the republish too, and the
                // record is read under the same bin lock observeEvent
                // writes it, so the check and the ledger update cannot
                // interleave with the terminal clear. A replay answered
                // from the journal after this promptId's terminal event
                // was already observed owes no future terminal event, so
                // no marker may survive it on either arm — retire through
                // the settled-checked path (a third same-identity attempt
                // may hold the entry open) and never republish: a fresh
                // instance would drop an owed release and could never be
                // cleared, vetoing every later identity for this client's
                // lifetime. A fresh admission keeps the marker its turn
                // still owes; a non-owning retry's 202 re-admitted the
                // submission, so it publishes a fresh, settled entry — a
                // status read that snapshotted the earlier instance
                // cannot clear the marker that is live now, its two-arg
                // remove keyed on the observed instance. When the earlier
                // entry is already gone, its turn's terminal event was
                // consumed or a lifecycle teardown retired it, and no
                // marker is replanted for it. The candidate carries no
                // in-flight send: this call's attempt opened against the
                // earlier registration and closes in the finally below.
                activePrompts.compute(session.getHarnessSessionId(),
                        (sessionId, active) -> {
                            if (active != registered) {
                                return active;
                            }
                            if (candidate.promptId.equals(
                                    terminalPromptIds.get(sessionId))) {
                                terminalReplay.set(true);
                                if (active.isSettled()) {
                                    return active.releaseBlocked
                                            ? active : null;
                                }
                                active.releaseOwed = true;
                                return active;
                            }
                            return ownsActivePrompt ? active : candidate;
                        });
                return new PromptReceipt(responsePromptId,
                        JsonSupport.requiredNonNegativeLong(json, "lastEventId",
                                "prompt admission"),
                        requireEventEpoch(
                                JsonSupport.requiredString(json, "eventEpoch",
                                        "prompt admission"), false));
            } catch (PromptAdmissionUnknownException e) {
                if (!ownsActivePrompt) {
                    registered.blockRelease();
                }
                throw e;
            } catch (DaemonProtocolException e) {
                if (!ownsActivePrompt) {
                    registered.blockRelease();
                }
                throw new PromptAdmissionUnknownException(e);
            }
        } finally {
            if (!ownsActivePrompt) {
                // The non-owning attempt's window closes only once its ledger
                // decision has landed — the 202 republish above or a concluded
                // refusal — so an owning release can never drop the joined
                // entry out from under the republish. A definitive refusal
                // then discharges the release an owning arm owed: every
                // concluded attempt proved the prompt was never admitted, so
                // the settled marker must not veto later identities; a
                // journal replay answered after the terminal event
                // discharges it the same way — the turn is over, so
                // nothing later clears the marker.
                registered.endSend();
                if (definitiveRefusal || terminalReplay.get()) {
                    dischargeOwedRelease(session.getHarnessSessionId(),
                            registered);
                }
            }
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
                ref.getHarnessSessionId(), ref.getHarnessClientId(),
                operation);
        return parseManagedRuntimeAdmission(response, stablePromptId,
                operation, "continuation");
    }

    /**
     * H6b/H6c: one automation operation onto the Session's journal (the
     * control plane's verbs). The Hosted side commits through its funnel and
     * answers 202 with the settled result; a non-2xx answer surfaces as a
     * {@link DaemonHttpException} the caller translates, and anything
     * ambiguous is an unknown outcome to retry, never to guess at.
     */
    public Map<String, Object> runAutomationOperation(HarnessSessionRef session,
            Map<String, Object> body) {
        HarnessSessionRef ref = requireSessionRef(session);
        String operation = "POST /session/:id/automations/operations";
        HttpSupport.Response response = sendMutation(
                sessionPath(ref.getHarnessSessionId())
                        + "/automations/operations",
                body, ref.getHarnessSessionId(), ref.getHarnessClientId(),
                operation);
        DaemonClient.requireStatus(response, 202, operation);
        try {
            Map<String, Object> json = JsonSupport.parseObject(
                    response.getBody(), "automation operation response");
            String state = JsonSupport.requiredString(json, "state",
                    "automation operation");
            if (!"settled".equals(state)) {
                throw new DaemonProtocolException(
                        "Hosted Harness did not settle the automation operation");
            }
            String operationId = JsonSupport.requiredString(json,
                    "operationId", "automation operation");
            if (!operationId.equals(body.get("operationId"))) {
                throw new DaemonProtocolException(
                        "Hosted Harness settled a different automation operation");
            }
            return json;
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
    }

    /**
     * H4b: one child operation onto the Session's journal (the control
     * plane's verbs). The Hosted side commits through its funnel and
     * answers 202 once settled; anything ambiguous is an unknown outcome
     * for the caller to retry, never to guess at.
     */
    public void runChildOperation(HarnessSessionRef session,
            Map<String, Object> body) {
        HarnessSessionRef ref = requireSessionRef(session);
        String operation = "POST /session/:id/children/operations";
        HttpSupport.Response response = sendMutation(
                sessionPath(ref.getHarnessSessionId())
                        + "/children/operations",
                body, ref.getHarnessSessionId(), ref.getHarnessClientId(),
                operation);
        try {
            DaemonClient.requireStatus(response, 202, operation);
            Map<String, Object> json = JsonSupport.parseObject(
                    response.getBody(), "child operation response");
            String state = JsonSupport.requiredString(json, "state",
                    "child operation");
            if (!"settled".equals(state)) {
                throw new DaemonProtocolException(
                        "Hosted Harness did not settle the child operation");
            }
            String operationId = JsonSupport.requiredString(json,
                    "operationId", "child operation");
            if (!operationId.equals(body.get("operationId"))) {
                throw new DaemonProtocolException(
                        "Hosted Harness settled a different child operation");
            }
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
    }

    /**
     * H4d-b: one session message operation onto the Session's journal (the
     * message relay's verbs). The Hosted side commits through its funnel
     * and answers 202 once settled, carrying the settled body — H4e-b3's
     * command verbs answer it with the lead's reply document, which the
     * relay copies back to the member. A non-2xx answer surfaces as a
     * {@link DaemonHttpException}, and anything ambiguous is an unknown
     * outcome for the caller to retry, never to guess at.
     */
    public Map<String, Object> runMessageOperation(HarnessSessionRef session,
            Map<String, Object> body) {
        HarnessSessionRef ref = requireSessionRef(session);
        String operation = "POST /session/:id/messages/operations";
        HttpSupport.Response response = sendMutation(
                sessionPath(ref.getHarnessSessionId())
                        + "/messages/operations",
                body, ref.getHarnessSessionId(), ref.getHarnessClientId(),
                operation);
        try {
            DaemonClient.requireStatus(response, 202, operation);
            Map<String, Object> json = JsonSupport.parseObject(
                    response.getBody(), "message operation response");
            String state = JsonSupport.requiredString(json, "state",
                    "message operation");
            if (!"settled".equals(state)) {
                throw new DaemonProtocolException(
                        "Hosted Harness did not settle the message operation");
            }
            String operationId = JsonSupport.requiredString(json,
                    "operationId", "message operation");
            if (!operationId.equals(body.get("operationId"))) {
                throw new DaemonProtocolException(
                        "Hosted Harness settled a different message operation");
            }
            return json;
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
    }

    /**
     * H5b/H5c: one channel operation onto the Session's journal (the control
     * plane's verbs). The Hosted side commits through its funnel and answers
     * 202 with the settled result; a non-2xx answer surfaces as a
     * {@link DaemonHttpException} the caller translates, and anything
     * ambiguous is an unknown outcome to retry, never to guess at.
     */
    public Map<String, Object> runChannelOperation(HarnessSessionRef session,
            Map<String, Object> body) {
        HarnessSessionRef ref = requireSessionRef(session);
        String operation = "POST /session/:id/channels/operations";
        HttpSupport.Response response = sendMutation(
                sessionPath(ref.getHarnessSessionId())
                        + "/channels/operations",
                body, ref.getHarnessSessionId(), ref.getHarnessClientId(),
                operation);
        DaemonClient.requireStatus(response, 202, operation);
        try {
            Map<String, Object> json = JsonSupport.parseObject(
                    response.getBody(), "channel operation response");
            String state = JsonSupport.requiredString(json, "state",
                    "channel operation");
            if (!"settled".equals(state)) {
                throw new DaemonProtocolException(
                        "Hosted Harness did not settle the channel operation");
            }
            String operationId = JsonSupport.requiredString(json,
                    "operationId", "channel operation");
            if (!operationId.equals(body.get("operationId"))) {
                throw new DaemonProtocolException(
                        "Hosted Harness settled a different channel operation");
            }
            return json;
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
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
                request.toJson(), ref.getHarnessSessionId(),
                ref.getHarnessClientId(), operation);
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
        } catch (HostedHarnessGenerationException e) {
            // A proven generation change means every local record for that
            // peer is dead, the admission ledger included — the same rule
            // the shared mutation channel follows.
            closeQuietly(response.body());
            discardLocalSessionState(session.getHarnessSessionId());
            throw e;
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
            // A client.close() that flipped closed before this
            // registration could not see the stream in its snapshot and
            // already drained the scheduler, so its watchdog would never
            // tick: close it here instead of stranding a parked reader.
            if (closed.get()) {
                stream.closeQuietly();
            }
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
                Collections.emptyMap(), ref.getHarnessSessionId(),
                ref.getHarnessClientId(),
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
        } catch (HostedHarnessGenerationException e) {
            // The scheduled heartbeat retires every local record on this
            // proof; a client built with heartbeatInterval(Duration.ZERO)
            // has only this entrance, so it must retire them here or the
            // ledger's veto wedges the session for this client's life.
            discardLocalSessionState(ref.getHarnessSessionId());
            throw e;
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
        // The clock is read before settledness: a beginSend landing between
        // the two snapshot reads then flips the settled read false, and the
        // clear below re-checks settledness inside the bin-locked compute,
        // where the retry's beginSend cannot interleave.
        statusSnapshotProbe.run();
        long observedClock = observed != null ? observed.sendClock() : 0;
        boolean observedSettled = observed != null && observed.isSettled();
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
            // Clear only the exact record the snapshot read, and only while
            // no send attempt has opened or closed since: the answer
            // describes the evaluation instant, so an attempt that
            // concluded during the round trip may postdate it.
            activePrompts.compute(ref.getHarnessSessionId(),
                    (sessionId, current) -> current == observed
                            && current.isSettled()
                            && current.sendClock() == observedClock
                            ? null : current);
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

    public Map<String, Object> settleLifecycle(HarnessSessionRef session, Map<String, Object> request) {
        HarnessSessionRef ref = requireSessionRef(session);
        int version = request.containsKey("protocolVersion") ? JsonSupport.requiredInt(request, "protocolVersion", "lifecycle") : 1;
        if (version != 1 && version != 2) {
            throw new DaemonProtocolException("Unknown Hosted lifecycle protocol");
        }
        boolean v2 = version == 2;
        if (v2 && !("hosted-workspace-shell/1".equals(request.get("toolProfile"))
                || "hosted-workspace-mcp/1".equals(request.get("toolProfile")))) {
            throw new DaemonProtocolException("Unsupported Hosted lifecycle profile");
        }
        if (v2 ? !capabilities.getLifecycleV2Profiles().contains(request.get("toolProfile"))
                : capabilities.getLifecycleProtocolVersion() != 1) {
            throw new DaemonProtocolException("Hosted lifecycle capability is required");
        }
        String operation = "POST /session/:id/lifecycle";
        HttpSupport.Response response = sendMutation(sessionPath(ref.getHarnessSessionId()) + "/lifecycle",
                request, ref.getHarnessSessionId(), ref.getHarnessClientId(),
                operation);
        requireMutationStatus(response, 200, operation);
        // Past this point the Harness has answered 200: a failure to decode
        // or match the receipt is a post-answer failure, which the
        // coordinator must not read as "the settle never happened".
        Map<String, Object> receipt;
        try {
            receipt = JsonSupport.parseObject(response.getBody(), operation);
        } catch (DaemonProtocolException error) {
            throw new HostedHarnessSettleAnsweredException(error.getMessage(), error);
        }
        if (!java.util.Objects.equals(request.get("sessionKey"), receipt.get("sessionKey"))
                || !java.util.Objects.equals(request.get("kind"), receipt.get("kind"))
                || v2 && (!java.util.Objects.equals(request.get("phase"), receipt.get("phase"))
                        || JsonSupport.requiredInt(receipt, "protocolVersion", operation) != 2
                        || !java.util.Objects.equals(request.get("toolProfile"), receipt.get("toolProfile"))
                        || !java.util.Objects.equals(JsonSupport.requiredObject(request, "authority", operation).get("operationId"),
                                receipt.get("operationId")))) {
            throw new HostedHarnessSettleAnsweredException(
                    "Hosted lifecycle receipt identity differs", null);
        }
        return receipt;
    }

    public void detachLifecycle(HarnessSessionRef session, Map<String, Object> authority) {
        HarnessSessionRef ref = requireSessionRef(session);
        AttachmentState state = attachments.get(ref.getHarnessSessionId());
        HttpSupport.Response response = sendMutation(sessionPath(ref.getHarnessSessionId()) + "/detach",
                Map.of("authority", authority), ref.getHarnessSessionId(),
                ref.getHarnessClientId(), "POST /session/:id/detach");
        boolean deleted = response.getStatusCode() != 404;
        if (deleted) {
            requireMutationStatus(response, 204, "POST /session/:id/detach");
        }
        if (state != null && state.matches(ref) && attachments.remove(ref.getHarnessSessionId(), state)) {
            state.cancel();
        }
        // The ledger retirement stays out of the attachment gate: a close
        // refused hosted_turn_active already dropped the attachment while
        // keeping the marker, and a detach whose 204 deleted the session
        // is the last retirement chance for that orphan. A tolerated 404
        // collapses an absent session and a client-id mismatch into the
        // same answer, so it stays identity-matched — a stale ref's 404
        // must not wipe the marker the session's current owner planted,
        // and retireLedger's re-read also retires a marker this same
        // identity replanted while the detach was in flight. A 204
        // instead proves the incarnation this ref addressed is gone —
        // the same proof detachSession's 204 rides — so a marker an
        // abandoned identity planted retires with it, while one the
        // current attachment's identity planted stays (see
        // retireStaleLedger).
        if (deleted) {
            retireStaleLedger(ref.getHarnessSessionId());
        } else {
            retireLedger(ref.getHarnessSessionId(),
                    ref.getHarnessClientId());
        }
    }

    public void detachLifecycle(String harnessSessionId, Map<String, Object> authority) {
        ensureOpen();
        String sessionId = requireUuid(harnessSessionId, "harnessSessionId");
        AttachmentState state = attachments.get(sessionId);
        HttpSupport.Response response = sendMutation(sessionPath(sessionId) + "/detach",
                Map.of("authority", authority), sessionId, null,
                "POST /session/:id/detach");
        if (response.getStatusCode() != 404) {
            requireMutationStatus(response, 204, "POST /session/:id/detach");
        }
        // Both definitive answers of this headerless detach prove the
        // incarnation gone — the 204 ran the route's close, and its
        // tolerated 404 carried no client id, so it can only mean absent.
        // Only the attachment observed before the request retires: a
        // re-load that raced the round trip registered a newer one. The
        // ledger retirement follows the ref overload's 204 rule and does
        // not depend on an attachment being present; this overload holds
        // no client id, so a marker retires exactly when no current
        // attachment's identity planted it.
        discardObservedAttachment(sessionId, state);
        retireStaleLedger(sessionId);
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
                    Collections.emptyMap(), ref.getHarnessSessionId(),
                    ref.getHarnessClientId(),
                    "POST /session/:id/detach");
            boolean deleted = response.getStatusCode() != 404;
            if (deleted) {
                requireMutationStatus(response, 204,
                        "POST /session/:id/detach");
            }
            removeAttachment(ref);
            // A 204 proves the incarnation this ref addressed is gone, so
            // a marker planted for it can never be cleared and would veto
            // every later identity after the supported load recovery
            // re-opens this id: it retires regardless of the planting
            // identity, except one the current attachment's identity
            // planted (see retireStaleLedger). A tolerated 404 instead
            // collapses an absent session and a client-id mismatch into
            // the same answer, so it stays identity-matched: a stale ref's
            // tolerated 404 must not wipe the marker the session's current
            // owner planted.
            if (deleted) {
                retireStaleLedger(ref.getHarnessSessionId());
            } else {
                retireLedger(ref.getHarnessSessionId(),
                        ref.getHarnessClientId());
            }
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
        updateSessionTitle(session, title, null);
    }

    public void updateSessionTitle(HarnessSessionRef session, String title, long revision) {
        if (revision < 1) {
            throw new IllegalArgumentException("title revision must be positive");
        }
        if (capabilities().getTitleProtocolVersion() != 1) {
            throw new DaemonProtocolException("Hosted Harness title protocol version 1 is required");
        }
        updateSessionTitle(session, title, Long.valueOf(revision));
    }

    private void updateSessionTitle(HarnessSessionRef session, String title, Long revision) {
        HarnessSessionRef ref = requireSessionRef(session);
        String value = requireNonBlank(title, "title");
        if (value.length() > 256) {
            throw new IllegalArgumentException(
                    "title must not exceed 256 characters");
        }
        String operation = "POST /session/:id/title";
        HttpSupport.Response response = sendMutation(
                sessionPath(ref.getHarnessSessionId()) + "/title",
                revision == null ? Map.of("title", value)
                        : Map.of("title", value, "managedRenameRevision", revision.toString()),
                ref.getHarnessSessionId(),
                ref.getHarnessClientId(), operation);
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
        if (revision != null && !revision.toString().equals(
                JsonSupport.requiredString(json, "managedRenameRevision", "title"))) {
            throw new DaemonProtocolException("Hosted Harness title revision does not match");
        }
        if (!JsonSupport.requiredBoolean(json, "persisted", "title")) {
            throw new DaemonProtocolException(
                    "Hosted Harness did not persist the Session title");
        }
    }

    public void closeSession(HarnessSessionRef session) {
        HarnessSessionRef ref = requireSessionRef(session);
        try {
            boolean deleted = closeSession(ref.getHarnessSessionId(),
                    ref.getHarnessClientId());
            removeAttachment(ref);
            if (deleted) {
                // The 204 deleted the incarnation this ref addressed —
                // identity() answers the route only when the client id
                // matches — so a marker planted for it is stale whichever
                // identity planted it, including one a concurrent
                // submission planted while the DELETE was in flight; only
                // a marker the current attachment's identity planted, for
                // a re-load that raced the DELETE, stays (see
                // retireStaleLedger).
                retireStaleLedger(ref.getHarnessSessionId());
            } else {
                // Identity-matched retirement: a tolerated 404 answers an
                // absent session and a stale ref's client-id mismatch
                // alike, so only a marker this identity planted is
                // provably stale.
                retireLedger(ref.getHarnessSessionId(),
                        ref.getHarnessClientId());
            }
        } catch (DaemonHttpException | HostedHarnessGenerationException e) {
            // A definitive refusal proves the DELETE did not run — the
            // session and any turn on it are still alive — so it retires
            // the attachment but keeps the admission ledger: a refusal
            // speaks only to the DELETE, never to a submission still in
            // flight, and the kept marker is the one record whose veto
            // fails closed. Same rule as detachSession above. A proven
            // generation change instead means every local record for that
            // peer is dead, including a marker published while the DELETE
            // was in flight.
            removeAttachment(ref);
            if (e instanceof HostedHarnessGenerationException) {
                activePrompts.remove(ref.getHarnessSessionId());
            }
            throw e;
        }
    }

    public void closeSession(String harnessSessionId) {
        ensureOpen();
        String sessionId = requireUuid(harnessSessionId,
                "harnessSessionId");
        // Snapshot the attachment before the DELETE: an arm that lands
        // after a concurrent loadSession may retire only what it observed,
        // or it wipes the newer caller's attachment — AttachmentState.matches
        // cannot key this path because it compares client ids and this
        // overload holds none. The 204 answers a DELETE dispatched before
        // any such re-registration, so a survivor may belong to a re-opened
        // incarnation whose heartbeats the peer still accepts; when it does
        // not, its heartbeat's definitive hosted_session_not_found 404
        // retires it (see scheduleHeartbeat), capping a stale task at one
        // heartbeat interval. The headerless DELETE is answered with
        // allowMissingClientId, so its success deleted the incarnation
        // outright: the ledger retires with it regardless of the planting
        // identity, except a marker the current attachment's identity
        // planted for a re-load that raced the DELETE (see
        // retireStaleLedger).
        AttachmentState observedAttachment = attachments.get(sessionId);
        try {
            closeSession(sessionId, null);
            discardObservedAttachment(sessionId, observedAttachment);
            retireStaleLedger(sessionId);
        } catch (DaemonHttpException | HostedHarnessGenerationException e) {
            if (e instanceof HostedHarnessGenerationException) {
                // Same proven-restart rule as the ref overload: retire
                // unconditionally, including a marker or attachment
                // registered while the DELETE was in flight.
                discardLocalSessionState(sessionId);
            } else {
                // Same refusal rule as the ref overload: the refusal proves
                // the DELETE did not run, so only the observed attachment
                // retires; the ledger stays as the record of a turn that
                // may still be live.
                discardObservedAttachment(sessionId, observedAttachment);
            }
            throw e;
        }
    }

    private void discardLocalSessionState(String sessionId) {
        discardObservedAttachment(sessionId, attachments.get(sessionId));
        removeObservedLedger(sessionId, activePrompts.get(sessionId));
    }

    private void discardObservedAttachment(String sessionId,
            AttachmentState observedAttachment) {
        if (observedAttachment != null
                && attachments.remove(sessionId, observedAttachment)) {
            observedAttachment.cancel();
        }
    }

    // Retire the admission ledger entry a tolerated-404 teardown proved
    // stale. Only a marker the asking identity planted, and no other
    // identity's retry joined, retires: the Harness answers an absent
    // session and a client-id mismatch with the same 404, so a stale ref's
    // tolerated 404 must not wipe a marker the session's current owner
    // planted or joined. The decision runs under the marker's bin lock, so
    // a join cannot land between it and the removal.
    private void retireLedger(String sessionId, String clientId) {
        activePrompts.compute(sessionId, (id, marker) ->
                marker != null && clientId.equals(marker.clientId)
                        && marker.joinedClientId == null
                        ? null : marker);
    }

    // Retire the admission marker a deleting teardown — a detach's or a
    // DELETE's 204, or a headerless tolerated 404 — made stale. The
    // answer proves the incarnation it addressed is gone, and every
    // caller has already retired that incarnation's attachment, so a
    // marker no current attachment's identity planted or joined can never
    // be cleared and retires. A marker the current attachment's identity
    // planted, or joined with a same-identity retry, stays: a re-load may
    // have raced the teardown to register that attachment and admit a
    // live turn, and vetoing it fails closed. The decision runs under the
    // marker's bin lock and reads the attachment there: a re-load
    // registers its attachment before it can plant or join, so a plant or
    // join the decision observes is always paired with an attachment read
    // that observes the registration, and neither can land between the
    // decision and the removal. The terminal-event record stays (see
    // terminalPromptIds).
    private void retireStaleLedger(String sessionId) {
        activePrompts.compute(sessionId, (id, marker) -> {
            if (marker == null) {
                return null;
            }
            AttachmentState current = attachments.get(id);
            String owner = current != null
                    ? current.session.getHarnessClientId() : null;
            return owner != null && (owner.equals(marker.clientId)
                    || owner.equals(marker.joinedClientId))
                    ? marker : null;
        });
    }

    private void removeObservedLedger(String sessionId,
            ActivePrompt observedLedger) {
        if (observedLedger != null) {
            activePrompts.remove(sessionId, observedLedger);
        }
    }

    // Publish (or join) the admission marker and open the caller's send
    // attempt on it under one bin lock. A different prompt holding the slot
    // is returned untouched, with no attempt opened on it, so the caller
    // tells a veto (the returned entry does not match its candidate) from
    // a registration.
    private ActivePrompt registerAdmission(String sessionId,
            ActivePrompt candidate) {
        return activePrompts.compute(sessionId, (id, existing) -> {
            if (existing != null && !existing.matches(candidate)) {
                return existing;
            }
            if (existing != null
                    && !existing.clientId.equals(candidate.clientId)) {
                existing.joinedClientId = candidate.clientId;
            }
            ActivePrompt entry = existing != null ? existing : candidate;
            entry.beginSend();
            return entry;
        });
    }

    // Owning release of an admission marker: drop the shared entry only
    // once no send attempt is open on it. A same-identity retry joins the
    // owner's entry and only bumps its in-flight counter, so an owning
    // arm that removed the entry while a retry's send is still open would
    // strand the retry's 202: the republish keys on the joined instance
    // and cannot replant a mapping that is already gone, leaving a live
    // admitted turn with no ledger entry. Every owning-release arm runs
    // after this call's own endSend(), so isSettled() is false exactly
    // while another attempt is open.
    private void releaseOwnedMarker(String sessionId, ActivePrompt marker) {
        activePrompts.compute(sessionId, (id, active) -> {
            if (active != marker) {
                return active;
            }
            if (active.isSettled()) {
                // Honour the same flag dischargeOwedRelease does: a
                // conclusion that was outcome-unknown or durably admitted
                // blocks the release — this promptId may be admitted
                // server-side, so the marker keeps vetoing until a status
                // read (settled and clock-matched) clears it.
                return active.releaseBlocked ? active : null;
            }
            // A sibling attempt still holds the entry open: record the owed
            // release for the last concluded attempt to discharge instead of
            // dropping it — a marker every concluded attempt proved was
            // never admitted must not veto later identities.
            active.releaseOwed = true;
            return active;
        });
    }

    // Discharge the release an owning arm owed, at the conclusion of a
    // non-owning attempt that was itself definitively refused: retire the
    // entry once no send is open on it and no conclusion was
    // outcome-unknown or a durable admission. Runs after this call's own
    // endSend(), so isSettled() is false exactly while another attempt is
    // still open.
    private void dischargeOwedRelease(String sessionId,
            ActivePrompt marker) {
        activePrompts.compute(sessionId,
                (id, active) -> active == marker && active.isSettled()
                        && active.releaseOwed && !active.releaseBlocked
                        ? null : active);
    }

    private boolean closeSession(String sessionId, String clientId) {
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
            // Same classification as the shared mutation channel below:
            // an unfenced 2xx or 3xx proves nothing about whether the
            // mutation ran, so it is outcome-unknown. A genuine unfenced
            // 4xx refused the request before it reached the route, but it
            // is not the Harness's own answer: it surfaces as the protocol
            // failure it is, never as a DaemonHttpException consumers key
            // terminal verdicts on.
            if (DaemonClient.isAmbiguousMutationStatus(raw.statusCode())
                    || raw.statusCode() < 400) {
                throw new MutationOutcomeUnknownException(operation, e);
            }
            throw e;
        }
        HttpSupport.Response response;
        try {
            response = HttpSupport.consume(raw, operation);
        } catch (DaemonProtocolException e) {
            throw new MutationOutcomeUnknownException(operation, e);
        }
        if (response.getStatusCode() == 404) {
            // The headerless DELETE is answered with
            // allowMissingClientId, so its tolerated 404 also means the
            // session is gone outright. An identity-scoped tolerated 404
            // collapses an absent session and a client-id mismatch into
            // the same answer, so it proves no deletion.
            return clientId == null;
        }
        requireMutationStatus(response, 204, operation);
        return true;
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
        if (!"turn_complete".equals(event.getType())
                && !"turn_error".equals(event.getType())) {
            return;
        }
        // Key the terminal clear on the promptId inside the bin lock, not
        // on a snapshotted instance: a same-identity retry's 202 may have
        // republished a fresh entry since any read, and the turn that just
        // ended is the one the ledger tracks regardless of which object
        // currently represents it.
        activePrompts.compute(session.getHarnessSessionId(),
                (sessionId, active) -> {
                    // Written under the same bin lock as the clear: an
                    // owning same-identity replay answered from the journal
                    // after this terminal event owes no future terminal
                    // event, and its 202 arm retires the marker it planted.
                    String terminalPromptId = event.terminalPromptId();
                    if (terminalPromptId != null) {
                        terminalPromptIds.put(sessionId, terminalPromptId);
                    }
                    return active != null && event.belongsTo(active.promptId)
                            ? null : active;
                });
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

    boolean advertisesEventKeepalive() {
        return capabilities.getFeatures().contains(EVENT_KEEPALIVE_FEATURE);
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
        // A build that predates message.delta records cannot open the
        // journals one now writes; refuse it once here instead of failing
        // every Session open.
        if (!features.contains("managed_session_journal_delta_v1")) {
            throw new DaemonProtocolException(
                    "Endpoint does not advertise"
                            + " managed_session_journal_delta_v1");
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
        List<String> hostedFeatures = new ArrayList<>();
        if (hosted.containsKey("features")) {
            if (!(hosted.get("features") instanceof List<?>)) {
                throw new DaemonProtocolException("Hosted Harness features must be an array");
            }
            for (Object value : (List<?>) hosted.get("features")) {
                if (!(value instanceof String) || ((String) value).isBlank() || hostedFeatures.contains(value)) {
                    throw new DaemonProtocolException("Invalid Hosted Harness feature");
                }
                hostedFeatures.add((String) value);
            }
        }
        return new HostedHarnessCapabilities(current, supported, bootId,
                digest, hosted.containsKey("lifecycleProtocolVersion")
                        ? JsonSupport.requiredInt(hosted, "lifecycleProtocolVersion", "capabilities.hostedHarness") : 0,
                hosted.containsKey("titleProtocolVersion")
                        ? JsonSupport.requiredInt(hosted, "titleProtocolVersion", "capabilities.hostedHarness") : 0,
                hostedFeatures, parseLifecycleV2Profiles(hosted));
    }

    private static List<String> parseLifecycleV2Profiles(Map<String, Object> hosted) {
        if (!hosted.containsKey("lifecycleV2Profiles")) {
            return List.of();
        }
        List<Object> values = JsonSupport.optionalList(hosted, "lifecycleV2Profiles");
        if (values == null || values.stream().anyMatch(value -> !(value instanceof String))) {
            throw new DaemonProtocolException("lifecycleV2Profiles must be a string array");
        }
        return values.stream().map(String.class::cast).distinct().collect(java.util.stream.Collectors.toList());
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
        } catch (HostedHarnessGenerationException e) {
            // Same rule as the heartbeat entrances: the peer restarted,
            // so every local record for it is dead, ledger included.
            discardLocalSessionState(session.getHarnessSessionId());
            throw e;
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
            Map<String, Object> body, String sessionId, String clientId,
            String operation) {
        return sendMutation(path, body, sessionId, clientId, operation,
                requestTimeout);
    }

    private HttpSupport.Response sendMutation(String path,
            Map<String, Object> body, String sessionId, String clientId,
            String operation, Duration timeout) {
        HttpResponse<HttpSupport.Body> raw;
        try {
            raw = send(path, "POST", body, clientId, timeout);
        } catch (IOException | InterruptedException e) {
            restoreInterrupt(e);
            throw new MutationOutcomeUnknownException(operation, e);
        }
        try {
            validateGeneration(raw.headers(), raw.statusCode());
        } catch (HostedHarnessGenerationException e) {
            // A proven generation change means every local record for that
            // peer is dead, the admission ledger included: retire it at
            // the channel every mutation shares, or the ledger's veto
            // wedges the session for this client's life. Stays narrower
            // than DaemonException — outcome-unknown surfaces keep both
            // records.
            discardLocalSessionState(sessionId);
            throw e;
        } catch (DaemonProtocolException e) {
            // A response that never passed the fencing middleware cannot
            // prove the mutation did not reach the Harness when its status
            // is ambiguous — and an unfenced 2xx or 3xx proves nothing
            // either, since the intermediary that stripped the boot header
            // may have forwarded a real success. A genuine unfenced 4xx
            // refused the request before it reached the route, but it is
            // not the Harness's own answer: it surfaces as the protocol
            // failure it is, never as a DaemonHttpException — consumers
            // key terminal verdicts (an invalid action response, a
            // rejected turn) on that type's status.
            if (DaemonClient.isAmbiguousMutationStatus(raw.statusCode())
                    || raw.statusCode() < 400) {
                throw new MutationOutcomeUnknownException(operation, e);
            }
            throw e;
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
        return send(path, method, body, clientId, requestTimeout,
                new AtomicBoolean());
    }

    private HttpResponse<HttpSupport.Body> send(String path, String method,
            Map<String, Object> body, String clientId, Duration timeout)
            throws IOException, InterruptedException {
        return send(path, method, body, clientId, timeout,
                new AtomicBoolean());
    }

    private HttpResponse<HttpSupport.Body> send(String path, String method,
            Map<String, Object> body, String clientId, Duration timeout,
            AtomicBoolean dispatched)
            throws IOException, InterruptedException {
        HttpRequest.Builder builder = sessionRequestBuilder(path, clientId)
                .header("Accept", "application/json")
                .header("Accept-Encoding", "identity")
                .timeout(timeout);
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.header("Content-Type", "application/json; charset=utf-8")
                    .method(method, HttpRequest.BodyPublishers.ofString(
                            JsonSupport.encode(body),
                            StandardCharsets.UTF_8));
        }
        HttpRequest request = builder.build();
        CompletableFuture<HttpResponse<HttpSupport.Body>> pending;
        try {
            pending = httpClient.sendAsync(request, HttpSupport.bodyHandler());
        } catch (RejectedExecutionException e) {
            // sendAsync surfaces a submit-time rejection synchronously —
            // for a saturated-but-running pool and a terminated one alike —
            // so the request provably never left the JVM and its outcome is
            // known, not unknown. The caller-supplied executor also runs
            // response delivery, so a rejection reported through the future
            // below proves nothing about dispatch and keeps its
            // outcome-unknown classification.
            throw new DaemonTransportException(
                    "Hosted Harness HTTP executor is saturated", e);
        }
        // The future exists: the request was accepted for dispatch, so any
        // failure from here on is mid-flight.
        dispatched.set(true);
        try {
            return pending.get();
        } catch (InterruptedException e) {
            pending.cancel(true);
            throw e;
        } catch (ExecutionException e) {
            // Mirror HttpClient.send(): an IOException cause surfaces as
            // itself; anything else — including a rejection that lands
            // after dispatch — is an outcome-unknown IOException, never a
            // dispatch refusal.
            Throwable cause = e.getCause();
            if (cause instanceof IOException) {
                throw (IOException) cause;
            }
            throw new IOException(cause);
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
                Collections.emptyMap(), session.getHarnessSessionId(),
                session.getHarnessClientId(), operation);
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
                } catch (DaemonException e) {
                    // A definitive hosted_session_not_found 404 proves the
                    // session record is gone server-side — the same proof a
                    // deleting close or detach rides — so the attachment
                    // retires itself instead of beating against the dead
                    // session for the client's lifetime. Any other refusal
                    // is transient to the keepalive: the next scheduled
                    // heartbeat is a new attempt.
                    if (e instanceof DaemonHttpException
                            && ((DaemonHttpException) e).getStatusCode()
                                    == 404
                            && "hosted_session_not_found".equals(
                                    ((DaemonHttpException) e)
                                            .getErrorCode())
                            && attachments.remove(
                                    state.session.getHarnessSessionId(),
                                    state)) {
                        state.cancel();
                    }
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
            // The serve delegating app answers requests with a bare
            // pre-contract 404 while the runtime is still booting — the
            // generation contract lives only in the runtime app, so this
            // is "not ready yet", never a generation change.
            if (statusCode == 404) {
                throw new DaemonTransportException(
                        "Hosted Harness answered a pre-contract 404"
                                + " (still starting)",
                        null);
            }
            throw new DaemonProtocolException(
                    "Hosted Harness response omitted " + BOOT_ID_HEADER
                            + " (HTTP " + statusCode + ")");
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
        // The identity that planted this marker: lifecycle teardowns retire
        // a marker only for the identity that asked, because the Harness
        // answers an absent session and a client-id mismatch with the same
        // 404.
        private final String clientId;
        private final Map<String, Object> modelSelection;
        private final Map<String, Object> approvalSelection;
        // The identity of the latest same-identity retry that joined this
        // entry from a different client id (a re-load's dispatcher retrying
        // the prompt): the entry then speaks for that identity's attempt
        // too, so a teardown of the planting identity must not retire it.
        // Written under the activePrompts bin lock.
        private volatile String joinedClientId;
        // Per-attempt admission windows: every send attempt opens one and
        // its conclusion closes it, so a marker with no send in flight is
        // settled — a status answer received from then on postdates every
        // admission window this marker tracked. A single shared boolean
        // cannot express two overlapping attempts (an owner's in-flight
        // send and a same-identity retry's), which is why this is a
        // counter. The clock ticks on every open and close, so a status
        // read can prove its snapshot is untouched by any attempt since.
        private final AtomicInteger inFlightSends = new AtomicInteger();
        private final AtomicLong sendClock = new AtomicLong();
        // Owed-release bookkeeping for overlapping same-identity attempts:
        // an owning release refused while a sibling send is open is owed,
        // and the last attempt to conclude discharges it — unless a
        // conclusion was outcome-unknown or a durable admission (a 202, or
        // a hosted_prompt_recovery_required refusal), which blocks it.
        // Written under the activePrompts bin lock or ahead of the
        // attempt's own endSend, and read the same way.
        private volatile boolean releaseOwed;
        private volatile boolean releaseBlocked;

        ActivePrompt(String promptId, String payloadDigest,
                String clientId, Map<String, Object> modelSelection,
                Map<String, Object> approvalSelection) {
            this.promptId = promptId;
            this.payloadDigest = payloadDigest;
            this.clientId = clientId;
            this.modelSelection = modelSelection;
            this.approvalSelection = approvalSelection;
        }

        void beginSend() {
            inFlightSends.incrementAndGet();
            sendClock.incrementAndGet();
        }

        // Mark an outcome-unknown or durably admitted conclusion: it
        // blocks the owed release this entry may carry. Called ahead of the
        // attempt's own endSend so the discharge observes it.
        void blockRelease() {
            releaseBlocked = true;
        }

        void endSend() {
            inFlightSends.decrementAndGet();
            sendClock.incrementAndGet();
        }

        boolean isSettled() {
            return inFlightSends.get() == 0;
        }

        long sendClock() {
            return sendClock.get();
        }

        boolean matches(ActivePrompt other) {
            return promptId.equals(other.promptId)
                    && payloadDigest.equals(other.payloadDigest)
                    && java.util.Objects.equals(modelSelection, other.modelSelection)
                    && java.util.Objects.equals(approvalSelection, other.approvalSelection);
        }
    }

    // The terminal-event records, least recently used first; callers wrap
    // it in Collections.synchronizedMap.
    private static final class TerminalRecords
            extends LinkedHashMap<String, String> {
        private static final long serialVersionUID = 1L;

        TerminalRecords() {
            super(16, 0.75f, true);
        }

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
            return size() > TERMINAL_RECORD_LIMIT;
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
        private Duration loadTimeout;
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

        /** A takeover load can take far longer than a steady-state call
         * (it may settle parked Runtime executions), so it gets its own
         * ceiling; unset falls back to {@link #requestTimeout}. */
        public Builder loadTimeout(Duration loadTimeout) {
            this.loadTimeout = positive(loadTimeout, "loadTimeout");
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
         * and {@code next()} fails with a
         * {@link HostedHarnessStreamIdleException}.
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
         * comfortably above that interval. The client arms the watchdog
         * only against a Harness that advertises those keepalives as the
         * {@code event-keepalive/1} feature: against any other, a read stays
         * unbounded whatever this value says. {@link Duration#ZERO}
         * disables the watchdog for callers that own the deadline
         * themselves.
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
