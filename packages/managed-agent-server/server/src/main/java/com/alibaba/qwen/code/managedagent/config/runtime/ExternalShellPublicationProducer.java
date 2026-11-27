package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistrationStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalShellPublication;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;

/**
 * The Broker as the control plane's producer for an external worker's
 * foreground Shell capture (#15512 slice C).
 *
 * <p>The external worker holds no control-plane credential: it keeps its own
 * capture store and exposes it read-only. This class opens that worker channel,
 * moves the bytes into the original publication as the producer, rebuilds the
 * result manifest and pages over the published segments, finishes the
 * publication, and only then acknowledges the worker's sequences — including
 * each stream's empty EOF sequence, without which the worker reports
 * {@code undrained} and the guarded stop refuses.
 *
 * <p>Every step runs before the execution settles, because the producer lane
 * requires a live, non-draining binding and an unsettled execution. A failure
 * anywhere leaves the worker channel unacknowledged, so the close keeps
 * refusing rather than releasing storage whose bytes never arrived.
 */
public final class ExternalShellPublicationProducer
        implements ExternalShellPublication, AutoCloseable {
    /**
     * One control-plane segment per worker read block. The result contract
     * bounds a page at 1024 segments and a stream at 64 pages. Those are
     * structural ceilings, not the budget: the publication binding reserves
     * {@code captureBytes} for the whole execution, and the store refuses the
     * first segment beyond it. A capture too large for either bound refuses
     * the drain rather than losing bytes, and the close then keeps refusing.
     */
    private static final int SEGMENTS_PER_PAGE = 1024;
    private static final int MAX_PAGES_PER_STREAM = 64;
    private static final int MAX_MANIFEST = 64 * 1024;
    private static final int MAX_PAGE = 256 * 1024;
    private static final List<String> STREAMS = List.of("stdout", "stderr");
    private static final Set<String> RESUMABLE = Set.of(
            "managed_tool_publication_operation_expired",
            "managed_tool_publication_claim_expired",
            "managed_tool_publication_claim_lost",
            "managed_tool_publication_busy");
    /**
     * Answers a resubmission can never change, and that are raised before any
     * operation row is written: capacity in the publish and finish claims,
     * storage denial while verifying an accepted operation. Without this the
     * drain would spin against them until its deadline.
     */
    private static final Set<String> PERMANENT = Set.of(
            "managed_tool_publication_storage_denied",
            "managed_tool_publication_quota_exhausted");
    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpRuntimeTransport transport;
    private final ToolPublicationDataStore publications;
    private final ExternalStorageRegistrationStore registrations;
    // Same virtual-thread rule as the other guarded repository lanes: a JDBC
    // call must not pin the carrier of the stage that scheduled it.
    private final ExecutorService worker =
            Executors.newThreadPerTaskExecutor(
                    Thread.ofVirtual().name("external-shell-publication-", 0).factory());

    public ExternalShellPublicationProducer(HttpRuntimeTransport transport,
            ToolPublicationDataStore publications,
            ExternalStorageRegistrationStore registrations) {
        this.transport = Objects.requireNonNull(transport, "transport");
        this.publications = Objects.requireNonNull(publications, "publications");
        this.registrations = Objects.requireNonNull(registrations, "registrations");
    }

    @Override
    public CompletionStage<String> begin(RuntimeLease lease, RuntimeBindingRecord binding,
            ToolExecutionRecord execution, RuntimePublicationGrant grant) {
        try {
            long revision = revision(binding);
            Map<String, Object> reference = reference(binding, execution, grant);
            Map<String, Object> capture = capture(execution, grant);
            // The worker refuses a channel whose lifetime has passed, so the
            // grant's own horizon is the only honest expiry to offer it. The
            // dispatch renewal pushes each renewed horizon on `renew`, because
            // a foreground Shell may outlive one writer lease.
            long expiresAt = expiry(grant);
            // The reserved binding fixed this token before dispatch, and the
            // control plane compares every finished manifest against it, so
            // the worker adopts it rather than minting its own.
            String captureId = requireCaptureId(grant.binding().get("captureId"));
            return transport.externalPublicationBegin(lease, binding.getRequest(),
                    binding.getProvisionSeed(), revision, reference, capture, expiresAt, captureId);
        } catch (RuntimeException invalid) {
            return CompletableFuture.failedFuture(invalid);
        }
    }

    @Override
    public CompletionStage<Void> renew(RuntimeLease lease, RuntimeBindingRecord binding,
            RuntimePublicationGrant grant, String channelId) {
        try {
            return transport.externalPublicationRenew(lease, binding.getRequest(),
                    binding.getProvisionSeed(), revision(binding), channelId, expiry(grant));
        } catch (RuntimeException invalid) {
            return CompletableFuture.failedFuture(invalid);
        }
    }

    @Override
    public CompletionStage<Void> drain(RuntimeLease lease, RuntimeBindingRecord binding,
            ToolExecutionRecord execution, RuntimePublicationGrant grant, String channelId,
            Map<String, Object> result) {
        try {
            JsonNode envelope = JSON.valueToTree(result);
            // The envelope alone decides whether this capture can ever finish,
            // so a doomed drain refuses before any block is moved or published.
            requireCompleteCapture(envelope);
            long revision = revision(binding);
            JsonNode key = key(grant);
            String publicationId = grant.publicationId();
            String token = grant.token();
            JsonNode identity = manifestIdentity(key, grant.binding());
            CompletionStage<Map<String, Long>> moved =
                    CompletableFuture.completedFuture(new LinkedHashMap<>());
            // Both streams report the same process outcome, and the copy chain
            // visits them one at a time.
            Map<String, JsonNode> facts = new LinkedHashMap<>();
            for (String stream : STREAMS) {
                moved = moved.thenCompose(counts -> move(lease, binding, revision, key,
                        publicationId, token, channelId, stream, facts)
                        .thenApply(segments -> {
                            counts.put(stream, segments);
                            return counts;
                        }));
            }
            return moved
                    .thenCompose(counts -> CompletableFuture.supplyAsync(() -> {
                        publishResult(key, publicationId, token, identity, envelope, facts, counts);
                        return counts;
                    }, worker))
                    .thenCompose(counts -> acknowledge(lease, binding, revision, channelId, counts));
        } catch (RuntimeException invalid) {
            return CompletableFuture.failedFuture(invalid);
        }
    }

    private static void requireCompleteCapture(JsonNode envelope) {
        JsonNode capture = envelope.path("capture");
        require(capture.isObject() && "complete".equals(capture.path("captureStatus").asText())
                && !"not_started".equals(envelope.path("executionStatus").asText()),
                "External Shell capture is not complete");
    }

    /**
     * Copies one stream block by block, sealing it once the worker's EOF
     * arrives. The empty EOF block is not published as a segment; it only
     * bounds the stream, exactly as the worker's own capture does.
     */
    private CompletionStage<Long> move(RuntimeLease lease, RuntimeBindingRecord binding,
            long revision, JsonNode key, String publicationId, String token,
            String channelId, String stream, Map<String, JsonNode> facts) {
        CompletableFuture<Long> done = new CompletableFuture<>();
        copy(lease, binding, revision, key, publicationId, token, channelId, stream,
                0, -1, facts, done);
        return done;
    }

    private void copy(RuntimeLease lease, RuntimeBindingRecord binding, long revision,
            JsonNode key, String publicationId, String token, String channelId, String stream,
            long sequence, long acknowledged, Map<String, JsonNode> facts,
            CompletableFuture<Long> done) {
        if (done.isDone()) {
            return;
        }
        if (sequence > (long) SEGMENTS_PER_PAGE * MAX_PAGES_PER_STREAM) {
            done.completeExceptionally(new RuntimeBrokerException(409,
                    "external_shell_publication_capacity",
                    "External Shell capture exceeds its retained segment bound.", false));
            return;
        }
        transport.externalPublicationRead(lease, binding.getRequest(), binding.getProvisionSeed(),
                revision, channelId, stream, sequence, acknowledged)
                .whenCompleteAsync((answer, error) -> {
                    if (done.isDone()) {
                        return;
                    }
                    if (error != null) {
                        done.completeExceptionally(error);
                        return;
                    }
                    try {
                        if ("pending".equals(answer.get("state"))) {
                            // The worker settles its capture only after the
                            // process ends; until then the stream has no final
                            // manifest to read against. Yield the carrier so a
                            // long-running process cannot spin this executor.
                            pause();
                            copy(lease, binding, revision, key, publicationId, token,
                                    channelId, stream, sequence, acknowledged, facts, done);
                            return;
                        }
                        facts.put("exitCode", fact(answer.get("exitCode")));
                        facts.put("signal", fact(answer.get("signal")));
                        byte[] block = (byte[]) answer.get("bytes");
                        if (block.length > 0) {
                            String digest = ToolPublicationContract.sha256(block);
                            operation(key, publicationId, token,
                                    "seg-" + stream + "-" + sequence,
                                    () -> publications.publishSegment(key, publicationId, token,
                                            "seg-" + stream + "-" + sequence, stream,
                                            Math.toIntExact(sequence), block, digest));
                        }
                        if (Boolean.TRUE.equals(answer.get("eof"))) {
                            require(block.length == 0, "External Shell EOF carried bytes");
                            seal(key, publicationId, token, stream, sequence);
                            done.complete(sequence);
                            return;
                        }
                        require(block.length > 0, "External Shell block was empty before its EOF");
                        copy(lease, binding, revision, key, publicationId, token, channelId,
                                stream, sequence + 1, sequence, facts, done);
                    } catch (RuntimeException failure) {
                        done.completeExceptionally(failure);
                    }
                }, worker);
    }

    /**
     * Seals a stream over exactly the segments its blocks produced. A stream
     * whose blocks did not divide evenly into whole segments has a short tail
     * block, so the segment count is the number of published blocks and the
     * byte length and digest come from those same bytes.
     */
    private void seal(JsonNode key, String publicationId, String token, String stream,
            long endSequence) {
        // The store re-reads every segment during the seal, so the aggregate
        // digest and length must come from the same published bytes, not from
        // the worker's own stream, whose block boundaries need not match.
        MessageDigest aggregate = DigestUtils.getSha256Digest();
        long total = 0;
        for (long sequence = 0; sequence < endSequence; sequence++) {
            byte[] block = publications.readSegment(key, publicationId, stream,
                    Math.toIntExact(sequence));
            aggregate.update(block);
            total += block.length;
        }
        final long length = total;
        String hex = HexFormat.of().formatHex(aggregate.digest());
        ObjectNode body = JSON.createObjectNode().put("segmentCount", endSequence)
                .put("byteLength", length).put("digest", hex);
        String operationId = "seal-" + stream + "-" + ToolPublicationContract.sha256(
                body.toString().getBytes(StandardCharsets.UTF_8)).substring(0, 32);
        JsonNode receipt = operation(key, publicationId, token, operationId,
                () -> publications.seal(key, publicationId, token, operationId, stream,
                        Math.toIntExact(endSequence), length, hex));
        require(receipt.path("segmentCount").asLong(-1) == endSequence
                && receipt.path("byteLength").asLong(-1) == length
                && hex.equals(receipt.path("digest").asText()),
                "Original seal receipt conflicts");
    }

    /**
     * Rebuilds the result manifest and its pages over the published segments,
     * then finishes the publication with the worker's own terminal envelope.
     * The manifest identity is the publication binding's, so the control
     * plane's own {@code validateFinished} is the check that this rebuild is
     * faithful — a mismatch refuses instead of finishing.
     */
    private void publishResult(JsonNode key, String publicationId, String token,
            JsonNode identity, JsonNode envelope, Map<String, JsonNode> facts,
            Map<String, Long> segments) {
        requireCompleteCapture(envelope);
        ArrayNode contents = JSON.createArrayNode();
        for (String stream : STREAMS) {
            Long count = segments.get(stream);
            require(count != null, "External Shell stream was not moved");
            contents.add(content(key, publicationId, token, identity, stream, count));
        }
        ObjectNode manifest = JSON.createObjectNode();
        manifest.put("toolResult", "managed-tool-result/1").put("type", "manifest");
        manifest.setAll((ObjectNode) identity);
        manifest.put("executionStatus", envelope.path("executionStatus").asText());
        manifest.set("exitCode", facts.get("exitCode"));
        manifest.set("signal", facts.get("signal"));
        manifest.put("captureScope", "process_pipes").put("capturePolicy", "complete_required");
        manifest.put("captureStatus", "complete").putNull("captureReason");
        manifest.put("upstreamTruncated", false);
        manifest.set("contents", contents);
        JsonNode manifestRef = resource(key, publicationId, token,
                "managed-tool-result-manifest", "manifest:1", manifest);
        ObjectNode finished = envelope.deepCopy();
        ObjectNode finishedCapture = (ObjectNode) finished.path("capture");
        finishedCapture.set("manifest", manifestRef);
        finishedCapture.putNull("captureReason");
        finishedCapture.put("deliveryStatus", "pending");
        byte[] bytes = finished.toString().getBytes(StandardCharsets.UTF_8);
        JsonNode receipt = operation(key, publicationId, token, "finish",
                () -> publications.finish(key, publicationId, token, "finish", bytes));
        require("FINISHED".equals(receipt.path("producerPhase").asText())
                && receipt.path("terminal").path("byteLength").asLong(-1) == bytes.length
                && ToolPublicationContract.sha256(bytes).equals(receipt.path("terminal").path("digest").asText()),
                "Publication finish was not confirmed");
    }

    private ObjectNode content(JsonNode key, String publicationId, String token,
            JsonNode identity, String stream, long segments) {
        ArrayNode pages = JSON.createArrayNode();
        ArrayNode pending = JSON.createArrayNode();
        long pageOffset = 0;
        long firstOrdinal = 0;
        long byteLength = 0;
        MessageDigest aggregate = DigestUtils.getSha256Digest();
        // The count is the one the copy loop published and sealed, so a missing
        // or extra segment is a conflict here, never a silent short stream.
        for (long ordinal = 0; ordinal < segments; ordinal++) {
            byte[] bytes = publications.readSegment(key, publicationId, stream,
                    Math.toIntExact(ordinal));
            aggregate.update(bytes);
            byteLength += bytes.length;
            pending.add(JSON.createObjectNode().put("byteLength", bytes.length)
                    .put("digest", ToolPublicationContract.sha256(bytes)));
            if (pending.size() == SEGMENTS_PER_PAGE) {
                pages.add(page(key, publicationId, token, identity, stream,
                        firstOrdinal, pageOffset, pending));
                firstOrdinal = ordinal + 1;
                pageOffset = byteLength;
                pending = JSON.createArrayNode();
            }
        }
        if (!pending.isEmpty()) {
            pages.add(page(key, publicationId, token, identity, stream,
                    firstOrdinal, pageOffset, pending));
        }
        ObjectNode body = JSON.createObjectNode();
        body.set("pages", pages);
        ObjectNode content = JSON.createObjectNode();
        content.put("streamId", stream).put("role", stream)
                .put("mimeType", "application/octet-stream").put("state", "sealed")
                .put("byteLength", byteLength)
                .put("digest", HexFormat.of().formatHex(aggregate.digest()));
        content.set("missingRanges", JSON.createArrayNode());
        content.set("body", body);
        return content;
    }

    private ObjectNode page(JsonNode key, String publicationId, String token, JsonNode identity,
            String stream, long firstOrdinal, long offset, ArrayNode segments) {
        long byteLength = 0;
        for (JsonNode segment : segments) {
            byteLength += segment.path("byteLength").asLong();
        }
        ObjectNode page = JSON.createObjectNode();
        page.put("toolResult", "managed-tool-result/1").put("type", "page")
                .put("captureId", identity.path("captureId").asText())
                .put("streamId", stream).put("firstOrdinal", firstOrdinal).put("offset", offset);
        page.set("segments", segments);
        JsonNode ref = resource(key, publicationId, token, "managed-tool-result-page",
                "page:" + stream + ":" + firstOrdinal, page);
        ObjectNode reference = JSON.createObjectNode();
        reference.set("ref", ref);
        reference.put("segmentCount", segments.size()).put("byteLength", byteLength);
        return reference;
    }

    private JsonNode resource(JsonNode key, String publicationId, String token, String kind,
            String slot, JsonNode value) {
        byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        ToolPublicationContract.parseToolResult(
                "managed-tool-result-manifest".equals(kind) ? "manifest" : "page", bytes,
                "managed-tool-result-manifest".equals(kind) ? MAX_MANIFEST : MAX_PAGE);
        String operationId = "res-" + slot.replace(':', '-');
        JsonNode ref = operation(key, publicationId, token, operationId,
                () -> publications.publishResource(key, publicationId, token, operationId,
                        slot, kind, bytes));
        require(kind.equals(ref.path("kind").asText())
                && ref.path("schemaVersion").asInt(-1) == 1
                && ref.path("byteLength").asLong(-1) == bytes.length
                && ToolPublicationContract.sha256(bytes).equals(ref.path("digest").asText()),
                "Original resource receipt conflicts");
        return ref;
    }

    /**
     * Acknowledges every delivered sequence, the empty EOF included. Only after
     * this does the worker consider the channel drained, which is the evidence
     * the guarded stop requires.
     */
    private CompletionStage<Void> acknowledge(RuntimeLease lease, RuntimeBindingRecord binding,
            long revision, String channelId, Map<String, Long> segments) {
        CompletionStage<Void> confirmed = CompletableFuture.completedFuture(null);
        for (String stream : STREAMS) {
            confirmed = confirmed.thenCompose(ignored -> confirm(lease, binding, revision,
                    channelId, stream, segments.get(stream)));
        }
        return confirmed;
    }

    /**
     * The copy loop already acknowledged every block as it advanced, so only
     * the EOF sequence is still owed. Re-reading the whole stream here would
     * double the traffic for no additional evidence.
     */
    private CompletionStage<Void> confirm(RuntimeLease lease, RuntimeBindingRecord binding,
            long revision, String channelId, String stream, long sequence) {
        return transport.externalPublicationRead(lease, binding.getRequest(),
                binding.getProvisionSeed(), revision, channelId, stream, sequence, sequence)
                .thenAccept(answer -> {
                    require("ready".equals(answer.get("state"))
                            && Boolean.TRUE.equals(answer.get("eof"))
                            && ((byte[]) answer.get("bytes")).length == 0,
                            "External Shell capture changed while draining");
                });
    }

    /**
     * One publication operation, driven to its terminal state. The store's
     * verification pool answers PENDING first, so the producer polls the same
     * operation and recovers an expired claim rather than publishing the bytes
     * twice under a new id. The operation id is derived from the bytes and the
     * slot, so a resubmission after a lost answer meets the same row.
     */
    private JsonNode operation(JsonNode key, String publicationId, String token,
            String operationId, Supplier<JsonNode> submit) {
        long deadline = System.nanoTime() + Duration.ofMinutes(30).toNanos();
        int recoveries = 0;
        JsonNode status;
        while (System.nanoTime() < deadline) {
            try {
                status = submit.get();
            } catch (ManagedAgentException refused) {
                if (PERMANENT.contains(refused.getCode())
                        || !retryable(refused) && !RESUMABLE.contains(refused.getCode())) {
                    throw refused;
                }
                status = observe(key, publicationId, token, operationId, deadline);
                if (status == null) {
                    // The row never existed, so the refusal came before it was
                    // written (`busy` rolls back while claiming the active
                    // slot). A retryable refusal is resubmitted; a terminal one
                    // is the store's real answer and must not be retried into a
                    // 30-minute spin.
                    if (!retryable(refused)) {
                        throw refused;
                    }
                    pause();
                    continue;
                }
            }
            String state = status.path("state").asText();
            if ("SUCCEEDED".equals(state)) {
                return status.path("receipt");
            }
            if ("FAILED".equals(state)) {
                JsonNode error = status.path("error");
                throw new ManagedAgentException(error.path("status").asInt(500),
                        error.path("code").asText("managed_tool_publication_failed"),
                        "Publication operation failed");
            }
            if ("RETRYABLE".equals(state)) {
                pause();
                continue;
            }
            if ("EXPIRED".equals(state)) {
                // A permanently expired operation is terminal once the recovery
                // budget is spent; looping would spin to the observation
                // deadline and report a timeout instead of the real failure.
                if (recoveries >= 3) {
                    throw new ManagedAgentException(409,
                            "managed_tool_publication_operation_expired",
                            "Publication operation stayed expired after its recovery budget");
                }
                recoveries++;
                try {
                    publications.recoverOperation(key, publicationId, token, operationId);
                } catch (ManagedAgentException refused) {
                    if (!retryable(refused)) {
                        throw refused;
                    }
                    recoveries--;
                    pause();
                    observe(key, publicationId, token, operationId, deadline);
                }
                continue;
            }
            if (!"PENDING".equals(state) && !"EXPIRED".equals(state)) {
                throw new ManagedAgentException(409, "managed_tool_publication_failed",
                        "Publication operation ended as " + state);
            }
            pause();
            status = observe(key, publicationId, token, operationId, deadline);
            if (status == null) {
                throw new ManagedAgentException(409, "managed_tool_publication_failed",
                        "Publication operation disappeared while draining");
            }
        }
        throw new ManagedAgentException(504, "managed_tool_publication_timeout",
                "Publication operation exceeded its observation deadline");
    }

    /** The saved operation, or null when the store never created that row. */
    private JsonNode observe(JsonNode key, String publicationId, String token,
            String operationId, long deadline) {
        while (System.nanoTime() < deadline) {
            try {
                return publications.operationStatus(key, publicationId, token, operationId);
            } catch (ManagedAgentException failure) {
                if ("managed_tool_publication_operation_unknown".equals(failure.getCode())) {
                    return null;
                }
                if (!retryable(failure)) {
                    throw failure;
                }
                pause();
            }
        }
        throw new ManagedAgentException(504, "managed_tool_publication_timeout",
                "Publication operation exceeded its observation deadline");
    }

    private static boolean retryable(ManagedAgentException failure) {
        return failure.getStatus() == 429 || failure.getStatus() >= 500
                || failure.getStatus() == 409
                        && "managed_tool_publication_busy".equals(failure.getCode());
    }

    @Override
    public void close() {
        worker.shutdownNow();
    }

    private static void pause() {
        try {
            Thread.sleep(50);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new ManagedAgentException(503, "managed_tool_publication_interrupted",
                    "Publication drain was interrupted", interrupted);
        }
    }

    private long revision(RuntimeBindingRecord binding) {
        if (binding == null || binding.getLease() == null || binding.getProvisionSeed() == null
                || !WorkspaceExecutionProfile.isExternalShellRequest(binding.getRequest())) {
            throw new RuntimeBrokerException(409, "external_shell_publication_unavailable",
                    "External Shell capture requires its original binding.", false);
        }
        var registered = registrations.find(binding.getRequest().getScope().getTenantId(),
                binding.getRequest().getStorageId());
        if (registered.isEmpty()) {
            throw new RuntimeBrokerException(409, "external_shell_publication_unavailable",
                    "External Shell capture requires durable registered storage.", false);
        }
        return registered.get().registrationRevision();
    }

    private static Map<String, Object> reference(RuntimeBindingRecord binding,
            ToolExecutionRecord execution, RuntimePublicationGrant grant) {
        Map<String, Object> saved = map(grant.binding().get("reference"));
        Map<String, Object> reference = new LinkedHashMap<>();
        reference.put("sessionId", execution.getRuntimeSessionId());
        reference.put("promptId", execution.getTurnId());
        reference.put("callId", execution.getToolCallId());
        // The worker replays the dispatch reference's own prefixed digest, and
        // the manifest identity is that same value; a stripped digest here
        // would make every finished capture conflict.
        reference.put("argsDigest", execution.getReference().get("argsDigest"));
        require(saved.get("sessionId").equals(reference.get("sessionId"))
                && saved.get("promptId").equals(reference.get("promptId"))
                && saved.get("callId").equals(reference.get("callId"))
                && saved.get("argsDigest").equals(reference.get("argsDigest")),
                "Publication reference differs from its execution");
        return Map.copyOf(reference);
    }

    private static Map<String, Object> capture(ToolExecutionRecord execution,
            RuntimePublicationGrant grant) {
        Map<String, Object> binding = grant.binding();
        Map<String, Object> key = map(binding.get("sessionKey"));
        Map<String, Object> capture = new LinkedHashMap<>();
        capture.put("tenantId", key.get("tenantId"));
        capture.put("sessionId", key.get("sessionId"));
        capture.put("turnId", binding.get("turnId"));
        capture.put("executionCallId", binding.get("executionCallId"));
        capture.put("bindingGeneration", binding.get("bindingGeneration"));
        capture.put("capturePolicy", "complete_required");
        require(execution.getExecutionCallId().equals(capture.get("executionCallId"))
                && execution.getHarnessSessionId().equals(capture.get("sessionId"))
                && Long.toString(execution.getRuntimeGeneration()).equals(capture.get("bindingGeneration")),
                "Publication capture differs from its execution");
        return Map.copyOf(capture);
    }

    private static String requireCaptureId(Object captureId) {
        if (!(captureId instanceof String token) || !token.matches("[a-z0-9_-]{1,128}")) {
            throw new RuntimeBrokerException(409, "external_shell_publication_unavailable",
                    "External Shell publication binding has no capture identity.", false);
        }
        return token;
    }

    private static long expiry(RuntimePublicationGrant grant) {
        long horizon = grant.expiresAt();
        if (horizon <= System.currentTimeMillis() || horizon > 9_007_199_254_740_991L) {
            throw new RuntimeBrokerException(409, "external_shell_publication_unavailable",
                    "External Shell publication grant has expired.", false);
        }
        return horizon;
    }

    private static JsonNode key(RuntimePublicationGrant grant) {
        Map<String, Object> key = map(grant.binding().get("sessionKey"));
        return JSON.createObjectNode().put("tenantId", String.valueOf(key.get("tenantId")))
                .put("workspaceId", String.valueOf(key.get("workspaceId")))
                .put("sessionId", String.valueOf(key.get("sessionId")));
    }

    private static JsonNode manifestIdentity(JsonNode key, Map<String, Object> binding) {
        Map<String, Object> reference = map(binding.get("reference"));
        ObjectNode identity = JSON.createObjectNode();
        identity.put("tenantId", key.path("tenantId").asText());
        identity.put("sessionId", key.path("sessionId").asText());
        identity.put("turnId", String.valueOf(binding.get("turnId")));
        identity.put("executionCallId", String.valueOf(binding.get("executionCallId")));
        identity.put("callId", String.valueOf(reference.get("callId")));
        identity.put("invocationDigest", String.valueOf(reference.get("argsDigest")));
        identity.put("bindingGeneration", String.valueOf(binding.get("bindingGeneration")));
        identity.put("captureId", String.valueOf(binding.get("captureId")));
        identity.put("revision", ((Number) binding.get("revision")).intValue());
        return identity;
    }

    /**
     * A signal kill leaves the exit code null, and an ordinary exit leaves the
     * signal null. Both keys are required by the result contract, so a null
     * answer has to stay an explicit JSON null rather than a missing field.
     */
    private static JsonNode fact(Object value) {
        return value == null ? NullNode.getInstance() : JSON.valueToTree(value);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        if (!(value instanceof Map<?, ?> fields)) {
            throw new RuntimeBrokerException(409, "external_shell_publication_unavailable",
                    "External Shell publication binding is invalid.", false);
        }
        return (Map<String, Object>) fields;
    }

    private static void require(boolean valid, String message) {
        if (!valid) {
            throw new RuntimeBrokerException(409, "external_shell_publication_conflict",
                    message + ".", false);
        }
    }
}
