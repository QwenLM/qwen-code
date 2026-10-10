package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

/** Original private CSI activation and bounded conversation proof. */
public final class CsiNativeActivationProof {
    private static final long MAX_SAFE = 9_007_199_254_740_990L;
    private static final Set<String> ENVELOPE = Set.of("uuid", "parentUuid", "sessionId", "timestamp",
            "type", "subtype", "cwd", "version", "managedSession");
    private static final Set<String> MARKER = Set.of("transactionId", "commandId", "operation", "contentDigest",
            "firstSequence", "lastSequence", "eventCount", "eventsDigest", "previousCommitDigest");
    private static final Set<String> PAYLOAD = Set.of("activationId", "epoch", "workerId", "subject",
            "phase", "leaseDurationMs", "expiresAt", "installRef", "boundaryRef");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(64).build()).build())
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

    private CsiNativeActivationProof() {
    }

    public record Genesis(String definitionDigest, String definitionResourceId,
            String rootResourceId, String lastRecordUuid) {
    }

    public record Transaction(List<JsonNode> events, String lastRecordUuid) {
    }

    public record Activation(String activationId, String workerId, JsonNode installRef,
            long leaseDurationMs, long expiresAt, long renewalSequence, long epoch, long writerGeneration) {
    }

    public record TerminalProof(Activation predecessorActivation, Prefix predecessorPrefix, JsonNode boundaryRef,
            long predecessorSequence, String predecessorLastRecordUuid, String predecessorCommitDigest,
            long terminalSequence, String lastRecordUuid) {
        public TerminalProof {
            predecessorActivation = snapshot(predecessorActivation, Activation.class);
            predecessorPrefix = snapshot(predecessorPrefix, Prefix.class);
            boundaryRef = boundaryRef.deepCopy();
        }

        @Override
        public Activation predecessorActivation() {
            return snapshot(predecessorActivation, Activation.class);
        }

        @Override
        public Prefix predecessorPrefix() {
            return snapshot(predecessorPrefix, Prefix.class);
        }

        @Override
        public JsonNode boundaryRef() {
            return boundaryRef.deepCopy();
        }

        private static <T> T snapshot(T value, Class<T> type) {
            return JSON.convertValue(JSON.valueToTree(value).deepCopy(), type);
        }
    }

    public record Input(String inputId, String text, String userMessageId, boolean noDeadline) {
    }

    public record Checkpoint(JsonNode ref, JsonNode state) {
    }

    public record Attempt(String attemptId, JsonNode routeRef, JsonNode checkpointRef, JsonNode route, String stage,
            JsonNode finalMessageRef) {
        public Attempt(String attemptId, JsonNode routeRef, JsonNode checkpointRef, JsonNode route, String stage) {
            this(attemptId, routeRef, checkpointRef, route, stage, null);
        }
    }

    public record Stream(String messageId, long firstSequence, String text) {
    }

    public record FunctionCall(String id, String name, JsonNode args, int partIndex, int ordinal) {
    }

    public record PendingBatch(String messageId, JsonNode contentRef, List<FunctionCall> calls) {
    }

    public record OriginalBatch(String promptId, PendingBatch batch) {
    }

    public record FrozenBatch(JsonNode intentRef, JsonNode preparedRef, List<JsonNode> invocations, long intentSequence, long preparedSequence) {
        public FrozenBatch {
            invocations = List.copyOf(invocations);
        }
    }

    public record FileHistory(JsonNode ref, JsonNode body, Map<String, FrozenBatch> batches) {
        public FileHistory {
            batches = Map.copyOf(batches);
        }
    }

    public record ToolIntent(JsonNode payload, long revision, long sequence, String inputDigest) {
    }

    public record ToolReceipt(JsonNode ref, JsonNode body, long revision, long sequence, long messageSequence) {
    }

    public record Prefix(Input input, Checkpoint checkpoint, String lastMessageId, Attempt attempt,
            boolean assistantCommitted, Stream stream, Set<String> usedIds, PendingBatch pendingBatch,
            Map<String, OriginalBatch> batches, FileHistory fileHistory, Map<String, ToolIntent> intents, Map<String, ToolReceipt> receipts,
            long nextDeltaOrdinal) {
        public Prefix {
            batches = Map.copyOf(batches);
            intents = Map.copyOf(intents);
            receipts = Map.copyOf(receipts);
        }

        public static Prefix empty() {
            return new Prefix(null, null, null, null, false, null, Set.of(), null, Map.of(), null, Map.of(), Map.of(), 0);
        }

        public String checkpointResourceId() {
            return checkpoint == null ? null : id(checkpoint.ref(), "resourceId");
        }
    }

    public static List<JsonNode> records(byte[] bytes) {
        require(bytes != null && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            require(text.endsWith("\n"));
            List<JsonNode> result = new ArrayList<>();
            for (String line : text.substring(0, text.length() - 1).split("\n", -1)) {
                JsonNode record = object(JSON.readTree(line));
                require(line.getBytes(StandardCharsets.UTF_8).length <=
                        ("managed_session_commit_v1".equals(record.path("subtype").textValue()) ? 64 * 1024 : 1024 * 1024));
                result.add(record);
            }
            require(result.size() <= 257);
            return List.copyOf(result);
        } catch (IOException error) {
            throw invalid();
        }
    }

    public static Genesis genesis(List<JsonNode> records, RuntimeProvisionRequest original,
            Function<JsonNode, byte[]> resources) {
        require(records.size() == 2);
        JsonNode engine = records.getFirst();
        Set<String> engineFields = new java.util.HashSet<>(ENVELOPE);
        engineFields.remove("managedSession");
        engineFields.add("systemPayload");
        closed(engine, engineFields);
        envelope(engine, original, "session_execution_engine", null);
        closed(engine.path("systemPayload"), Set.of("version", "engine"));
        require(number(engine.path("systemPayload").get("version")) == 1
                && "managed".equals(text(engine.path("systemPayload"), "engine")));
        JsonNode headerRecord = records.getLast();
        closed(headerRecord, ENVELOPE);
        envelope(headerRecord, original, "managed_session_header_v1", text(engine, "uuid"));
        JsonNode header = headerRecord.path("managedSession");
        closed(header, Set.of("formatVersion", "minimumReader", "sessionKey", "engine",
                "definitionRef", "rootSnapshotRef", "createdBy"));
        require(number(header.get("formatVersion")) == 1
                && "managed-session/1".equals(text(header, "minimumReader"))
                && "managed".equals(text(header, "engine")));
        key(header.path("sessionKey"), original);
        require("hosted-harness".equals(text(header, "createdBy")));
        JsonNode definition = readObject(reference(header.path("definitionRef"), "managed-definition", resources));
        closed(definition, Set.of("engine", "sessionId", "toolProfile"));
        require("managed".equals(text(definition, "engine"))
                && original.getIsolationKey().equals(text(definition, "sessionId"))
                && CsiFilesRetirementProfile.PROFILE.equals(text(definition, "toolProfile")));
        JsonNode root = readObject(reference(header.path("rootSnapshotRef"), "managed-root", resources));
        closed(root, Set.of("cwd"));
        require(original.getScope().getCanonicalCwd().equals(text(root, "cwd")));
        return new Genesis(text(header.path("definitionRef"), "digest"),
                id(header.path("definitionRef"), "resourceId"), id(header.path("rootSnapshotRef"), "resourceId"),
                text(headerRecord, "uuid"));
    }

    public static Transaction transaction(List<JsonNode> records, JsonNode metadata,
            RuntimeProvisionRequest original, String parentUuid) {
        long count = number(metadata.get("eventCount"));
        require(count > 0 && count <= 256 && records.size() == count + 1);
        long first = number(metadata.get("firstSequence"));
        require(first > 0 && number(metadata.get("lastSequence")) == first + count - 1);
        List<JsonNode> events = new ArrayList<>();
        for (int index = 0; index < records.size(); index++) {
            JsonNode record = records.get(index);
            closed(record, ENVELOPE);
            envelope(record, original, index < count ? "managed_session_event_v1"
                    : "managed_session_commit_v1", parentUuid);
            parentUuid = text(record, "uuid");
            if (index < count) {
                JsonNode event = object(record.path("managedSession"));
                require(number(event.get("v")) == 1 && number(event.get("sequence")) == first + index);
                key(event.path("sessionKey"), original);
                events.add(event);
            }
        }
        JsonNode marker = records.getLast().path("managedSession");
        closed(marker, MARKER);
        id(marker, "transactionId");
        id(marker, "commandId");
        require(number(marker.get("firstSequence")) == first
                && number(marker.get("lastSequence")) == first + count - 1
                && number(marker.get("eventCount")) == count);
        text(marker, "operation");
        text(marker, "contentDigest");
        text(marker, "eventsDigest");
        if (!marker.path("previousCommitDigest").isNull()) {
            text(marker, "previousCommitDigest");
        }
        for (String field : MARKER) {
            require(metadata.has(field) && canonical(marker.get(field)).equals(canonical(metadata.get(field))));
        }
        require(sha256(canonical(marker).getBytes(StandardCharsets.UTF_8)).equals(text(metadata, "commitDigest")));
        var array = JSON.createArrayNode();
        events.forEach(array::add);
        require(sha256(canonical(array).getBytes(StandardCharsets.UTF_8)).equals(text(metadata, "eventsDigest")));
        return new Transaction(List.copyOf(events), parentUuid);
    }

    public static Prefix advance(Transaction transaction, JsonNode metadata,
            RuntimeProvisionRequest original, String writerId, Genesis genesis, Activation activation,
            long previousRevision, long previousSequence, Prefix previous, Function<JsonNode, byte[]> resources) {
        require(activation != null && writerId.equals(activation.workerId())
                && writerId.equals(text(metadata, "writerId"))
                && number(metadata.get("writerGeneration")) == activation.writerGeneration()
                && number(metadata.get("activationEpoch")) == activation.epoch());
        return switch (text(metadata, "operation")) {
            case "submitInput" -> {
                require(previous.input() == null && previous.pendingBatch() == null);
                Input input = input(transaction, metadata, original, activation, previousSequence, resources);
                yield new Prefix(input, previous.checkpoint(), previous.lastMessageId(), null, false,
                        null, useId(previous, input.inputId()), null, previous.batches(), previous.fileHistory(), previous.intents(), previous.receipts(), 0);
            }
            case "commitCheckpoint" -> {
                Checkpoint checkpoint = previous.checkpoint() == null
                        ? validatedInitialCheckpoint(transaction, metadata, original, writerId, genesis, activation,
                                previousSequence, resources)
                        : id(metadata, "commandId").startsWith("harness:await_runtime:")
                                && undispatched(previous)
                                ? dispatchCheckpoint(transaction, metadata, original, activation, previousSequence, previous, resources)
                                : resultCheckpoint(transaction, metadata, original, activation, previousSequence, previous, resources);
                boolean ready = "results_ready".equals(checkpoint.state().path("continuation").path("phase").textValue())
                        && previous.pendingBatch() != null;
                yield new Prefix(previous.input(), checkpoint, previous.lastMessageId(),
                        ready ? null : previous.attempt(), previous.assistantCommitted(), previous.stream(), previous.usedIds(),
                        ready ? null : previous.pendingBatch(), previous.batches(), previous.fileHistory(), previous.intents(), previous.receipts(), previous.nextDeltaOrdinal());
            }
            case "recordToolResult" -> receipt(transaction, metadata, original, activation,
                    previousRevision, previousSequence, previous, resources);
            case "toolIntent" -> toolIntent(transaction, metadata, original, activation,
                    previousRevision, previousSequence, previous, resources);
            case "commitMessage" -> message(transaction, metadata, original, genesis, activation,
                    previousSequence, previous, resources);
            case "hostedModelAttempt" -> attempt(transaction, metadata, original, activation,
                    previousSequence, previous, resources);
            case "assistantDelta" -> delta(transaction, metadata, original, activation, previousSequence, previous);
            case "assistantRetract" -> retract(transaction, metadata, original, activation, previousSequence, previous);
            case "settleTurn" -> settle(transaction, metadata, original, activation,
                    previousSequence, previous, resources);
            case "commitFileHistory" -> fileHistory(transaction, metadata, original, activation,
                    previousSequence, previous, resources);
            default -> throw invalid();
        };
    }

    private static boolean undispatched(Prefix prefix) {
        if (prefix.pendingBatch() == null) {
            return false;
        }
        for (JsonNode item : prefix.checkpoint().state().path("tools").path("items")) {
            if (prefix.pendingBatch().messageId().equals(item.path("modelMessageId").textValue())) {
                return false;
            }
        }
        return true;
    }

    private static Prefix receipt(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Activation activation, long previousRevision, long previousSequence, Prefix previous,
            Function<JsonNode, byte[]> resources) {
        conversation(previous);
        require(previous.pendingBatch() != null && transaction.events().size() == 1
                && "await_runtime".equals(previous.checkpoint().state().path("continuation").path("phase").textValue())
                && metadata.path("latestCheckpointResourceId").isNull());
        JsonNode event = transaction.events().getFirst();
        closed(event, Set.of("v", "sequence", "eventId", "sessionKey", "kind", "occurredAt", "payload"));
        key(event.path("sessionKey"), original);
        require(number(event.get("v")) == 1 && number(event.get("sequence")) == previousSequence + 1
                && "tool.receipt".equals(text(event, "kind")) && time(event.get("occurredAt")) < activation.expiresAt());
        JsonNode payload = event.path("payload");
        closed(payload, Set.of("executionCallId", "toolOutcomeRef", "resultRef", "resources", "historyRevision"));
        String execution = id(payload, "executionCallId");
        var intent = previous.intents().get(execution);
        require(intent != null && previous.pendingBatch().messageId().equals(id(intent.payload(), "batchId"))
                && !previous.receipts().containsKey(execution) && execution.equals(id(metadata, "commandId"))
                && ("tool-receipt:" + execution).equals(id(event, "eventId"))
                && payload.path("resultRef").isNull() && payload.path("resources").isArray() && payload.path("resources").isEmpty()
                && number(payload.get("historyRevision")) == previousSequence + 1);
        JsonNode ref = payload.path("toolOutcomeRef");
        byte[] bytes = reference(ref, "managed-tool-outcome", resources);
        require(bytes.length <= 64 * 1024 && text(ref, "digest").equals(text(metadata, "contentDigest")));
        JsonNode body = readObject(bytes);
        closed(body, Set.of("schemaVersion", "executionCallId", "envelope", "history"));
        require(number(body.get("schemaVersion")) == 1 && execution.equals(id(body, "executionCallId")));
        JsonNode history = body.path("history");
        closed(history, Set.of("messageId", "timestamp", "model", "parts"));
        uuid(id(history, "messageId"));
        try {
            Instant.parse(text(history, "timestamp"));
        } catch (java.time.DateTimeException error) {
            throw invalid();
        }
        require(previous.attempt() != null && text(previous.attempt().route(), "model").equals(text(history, "model")));
        var call = previous.pendingBatch().calls().get((int) number(intent.payload().get("ordinal")));
        require(canonical(convertedResult(body.path("envelope"), call)).equals(canonical(history.path("parts"))));
        Map<String, ToolReceipt> receipts = new HashMap<>(previous.receipts());
        receipts.put(execution, new ToolReceipt(ref.deepCopy(), body.deepCopy(), previousRevision + 1, previousSequence + 1, 0));
        return new Prefix(previous.input(), previous.checkpoint(), previous.lastMessageId(), previous.attempt(),
                previous.assistantCommitted(), previous.stream(), useId(previous, id(history, "messageId")),
                previous.pendingBatch(), previous.batches(), previous.fileHistory(), previous.intents(), receipts, previous.nextDeltaOrdinal());
    }

    static JsonNode convertedResult(JsonNode result, FunctionCall call) {
        closed(result, result.has("error") ? Set.of("executionStatus", "responseParts", "error")
                : Set.of("executionStatus", "responseParts"));
        String status = text(result, "executionStatus");
        require(Set.of("success", "error").contains(status) && result.path("responseParts").isArray());
        List<String> texts = new ArrayList<>();
        var media = JSON.createArrayNode();
        for (JsonNode part : result.path("responseParts")) {
            if (part.has("text")) {
                closed(part, part.has("type") ? Set.of("type", "text") : Set.of("text"));
                require(!part.has("type") || "text".equals(part.path("type").textValue()));
                require(part.path("text").isTextual());
                texts.add(part.path("text").textValue());
            } else {
                String field = part.has("inlineData") ? "inlineData" : "fileData";
                closed(part, Set.of(field));
                JsonNode value = part.path(field);
                closed(value, Set.of("mimeType", field.equals("inlineData") ? "data" : "fileUri"));
                text(value, "mimeType");
                text(value, field.equals("inlineData") ? "data" : "fileUri");
                media.add(part);
            }
        }
        String output = texts.isEmpty() ? result.path("responseParts").size() == 1 ? "" : "Tool execution succeeded."
                : String.join("\n", texts);
        ObjectNode function = JSON.createObjectNode().put("id", call.id()).put("name", call.name());
        ObjectNode response = function.putObject("response").put("executionStatus", status);
        if ("success".equals(status)) {
            response.put("output", output);
        } else {
            String fallback = result.has("error") ? text(result.path("error"), "message") : "Runtime tool " + status + ".";
            response.put("error", !CsiNativeToolReservation.trim(output).isEmpty() && !"Tool execution succeeded.".equals(output) ? output : fallback);
        }
        if (result.has("error")) {
            JsonNode error = result.path("error");
            closed(error, error.has("type") ? Set.of("message", "type") : Set.of("message"));
            text(error, "message");
            if (error.has("type")) {
                text(error, "type");
            }
            response.set("runtimeError", error);
        }
        if (!media.isEmpty()) {
            function.set("parts", media);
        }
        return JSON.createArrayNode().add(JSON.createObjectNode().set("functionResponse", function));
    }

    private static Prefix toolMessage(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Genesis genesis, Activation activation, long previousSequence, Prefix previous,
            Function<JsonNode, byte[]> resources) {
        require(previous.pendingBatch() != null && transaction.events().size() == 1
                && metadata.path("latestCheckpointResourceId").isNull()
                && genesis.definitionDigest().equals(text(metadata, "contentDigest")));
        JsonNode event = transaction.events().getFirst();
        JsonNode payload = harnessEvent(event, "message.committed", original, activation, previousSequence + 1);
        closed(payload, Set.of("messageId", "role", "contentRef", "parentMessageId"));
        String messageId = id(payload, "messageId");
        require("tool_result".equals(text(payload, "role")) && ("message:" + messageId).equals(id(event, "eventId"))
                && ("recorder:" + messageId).equals(id(metadata, "commandId")));
        var entry = previous.receipts().entrySet().stream().filter(item ->
                messageId.equals(item.getValue().body().path("history").path("messageId").textValue()))
                .findFirst().orElseThrow(CsiNativeActivationProof::invalid);
        var receipt = entry.getValue();
        require(receipt.messageSequence() == 0 && receipt.sequence() < previousSequence + 1);
        JsonNode record = messageBody(payload.path("contentRef"), resources);
        closed(record, Set.of("uuid", "parentUuid", "sessionId", "timestamp", "type", "cwd", "version", "daemonPromptId", "message", "model"));
        chatRecord(record, original);
        JsonNode history = receipt.body().path("history");
        require(messageId.equals(id(record, "uuid")) && "tool_result".equals(text(record, "type"))
                && previous.input().inputId().equals(id(record, "daemonPromptId"))
                && Objects.equals(previous.lastMessageId(), nullableId(payload, "parentMessageId"))
                && Objects.equals(previous.lastMessageId(), nullableId(record, "parentUuid"))
                && text(history, "timestamp").equals(text(record, "timestamp")) && text(history, "model").equals(text(record, "model")));
        closed(record.path("message"), Set.of("role", "parts"));
        require("user".equals(text(record.path("message"), "role"))
                && canonical(history.path("parts")).equals(canonical(record.path("message").path("parts"))));
        Map<String, ToolReceipt> receipts = new HashMap<>(previous.receipts());
        receipts.put(entry.getKey(), new ToolReceipt(receipt.ref(), receipt.body(), receipt.revision(), receipt.sequence(), previousSequence + 1));
        return new Prefix(previous.input(), previous.checkpoint(), messageId, previous.attempt(), false,
                previous.stream(), previous.usedIds(), previous.pendingBatch(), previous.batches(), previous.fileHistory(), previous.intents(), receipts, previous.nextDeltaOrdinal());
    }

    private static Checkpoint resultCheckpoint(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Activation activation, long previousSequence, Prefix previous, Function<JsonNode, byte[]> resources) {
        conversation(previous);
        require(transaction.events().size() == 1);
        JsonNode event = transaction.events().getFirst();
        JsonNode payload = harnessEvent(event, "checkpoint.committed", original, activation, previousSequence + 1);
        closed(payload, Set.of("checkpointId", "coveredSequence", "previousCheckpointId", "stateRef", "boundary"));
        String checkpointId = "ckpt-" + (previousSequence + 1);
        JsonNode prior = previous.checkpoint().state();
        String predecessor = id(prior.path("identity"), "checkpointId");
        require(checkpointId.equals(id(event, "eventId")) && checkpointId.equals(id(payload, "checkpointId"))
                && number(payload.get("coveredSequence")) == previousSequence && predecessor.equals(id(payload, "previousCheckpointId")));
        JsonNode ref = payload.path("stateRef");
        JsonNode state = readObject(reference(ref, "managed-checkpoint", resources));
        require(id(ref, "resourceId").equals(id(metadata, "latestCheckpointResourceId"))
                && text(ref, "digest").equals(text(metadata, "contentDigest")));
        ObjectNode expected = prior.deepCopy();
        ((ObjectNode) expected.path("identity")).put("checkpointId", checkpointId).put("coveredSequence", previousSequence)
                .put("previousCheckpointId", predecessor);
        ((ObjectNode) expected.path("resume")).put("throughSequence", previousSequence);
        String phase = text(prior.path("continuation"), "phase");
        String command;
        if ("await_runtime".equals(phase)) {
            var pending = new ArrayList<JsonNode>();
            for (JsonNode item : prior.path("tools").path("items")) {
                var receipt = previous.receipts().get(id(item, "executionCallId"));
                if ("in_progress".equals(item.path("state").textValue()) && receipt != null && receipt.messageSequence() > 0) {
                    pending.add(item);
                }
            }
            require(pending.size() == 1);
            String execution = id(pending.getFirst(), "executionCallId");
            var receipt = previous.receipts().get(execution);
            for (JsonNode item : expected.path("tools").path("items")) {
                if (execution.equals(id(item, "executionCallId"))) {
                    ((ObjectNode) item).put("state", "settled").set("outcomeRef", receipt.ref());
                }
            }
            boolean all = true;
            for (JsonNode item : expected.path("tools").path("items")) {
                all &= "settled".equals(item.path("state").textValue());
            }
            phase = all ? "results_ready" : "await_runtime";
            ((ObjectNode) expected.path("continuation")).put("phase", phase);
            for (JsonNode binding : expected.path("runtime").path("bindings")) {
                if (execution.equals(id(binding, "executionCallId"))) {
                    require("dispatch".equals(text(binding, "state")));
                    ((ObjectNode) binding).put("state", "settled");
                }
            }
            command = "harness:" + phase + ":" + activation.activationId() + ":" + execution + ":" + previousSequence;
        } else {
            require("results_ready".equals(phase) && previous.pendingBatch() == null && previous.attempt() != null
                    && "output_committed".equals(previous.attempt().stage()));
            boolean consume = id(metadata, "commandId").startsWith("harness:results_consumed:");
            boolean changed = false;
            for (JsonNode item : expected.path("tools").path("items")) {
                require("settled".equals(text(item, "state")));
                var receipt = previous.receipts().get(id(item, "executionCallId"));
                require(receipt != null && receipt.messageSequence() > 0 && receipt.messageSequence() <= previousSequence
                        && canonical(receipt.ref()).equals(canonical(item.path("outcomeRef"))));
                if (consume && !item.path("consumed").booleanValue()) {
                    ((ObjectNode) item).put("consumed", true);
                    changed = true;
                } else {
                    require(consume || item.path("consumed").booleanValue());
                }
            }
            if (consume) {
                require(changed && (!previous.assistantCommitted() || previous.attempt().finalMessageRef() != null)
                        && canonical(previous.attempt().checkpointRef()).equals(canonical(previous.checkpoint().ref())));
                ((ObjectNode) expected.path("identity")).put("activationId", activation.activationId());
                command = "harness:results_consumed:" + activation.activationId() + ":" + previousSequence;
            } else {
                require(previous.assistantCommitted());
                phase = "turn_settled";
                ((ObjectNode) expected.path("continuation")).put("phase", phase);
                command = "harness:turn_settled:" + activation.activationId() + ":" + previousSequence;
            }
        }
        require(command.equals(id(metadata, "commandId"))
                && ("await_runtime".equals(phase) ? "durable_wait".equals(payload.path("boundary").textValue()) : payload.path("boundary").isNull())
                && number(state.path("identity").get("schemaVersion")) == 1
                && number(state.path("identity").get("coveredSequence")) == previousSequence
                && number(state.path("resume").get("throughSequence")) == previousSequence
                && number(state.path("resume").get("initialTurn")) == number(prior.path("resume").get("initialTurn"))
                && canonical(expected).equals(canonical(state)));
        for (JsonNode item : state.path("tools").path("items")) {
            number(item.get("ordinal"));
            number(item.get("partIndex"));
        }
        number(state.path("attempt").get("budgetConsumed"));
        checkpointResources(state, resources);
        return new Checkpoint(ref.deepCopy(), state.deepCopy());
    }

    private static Prefix toolIntent(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Activation activation, long previousRevision, long previousSequence, Prefix previous,
            Function<JsonNode, byte[]> resources) {
        conversation(previous);
        require(previous.pendingBatch() != null && previous.attempt() != null
                && "output_committed".equals(previous.attempt().stage()) && !previous.assistantCommitted()
                && previous.stream() == null && transaction.events().size() == 1
                && metadata.path("latestCheckpointResourceId").isNull()
                && previousRevision > 0 && previousRevision < MAX_SAFE);
        JsonNode event = transaction.events().getFirst();
        JsonNode payload = harnessEvent(event, "tool.intent", original, activation, previousSequence + 1);
        closed(payload, Set.of("executionCallId", "batchId", "ordinal", "toolDefinitionRef", "argsRef", "outcomeSource"));
        String execution = id(payload, "executionCallId");
        String batchId = id(payload, "batchId");
        long ordinal = number(payload.get("ordinal"));
        var batch = previous.batches().get(batchId);
        require(batch != null && previous.pendingBatch().messageId().equals(batchId)
                && batch.promptId().equals(previous.input().inputId()) && ordinal < batch.batch().calls().size()
                && "runtime".equals(text(payload, "outcomeSource")) && !previous.intents().containsKey(execution)
                && ("tool-intent:" + execution).equals(id(event, "eventId"))
                && ("tool-intent:" + execution).equals(id(metadata, "commandId"))
                && text(payload.path("argsRef"), "digest").equals(text(metadata, "contentDigest")));
        for (var saved : previous.intents().values()) {
            if (batchId.equals(id(saved.payload(), "batchId"))) {
                require(number(saved.payload().get("ordinal")) < ordinal);
            }
        }
        byte[] input = reference(payload.path("argsRef"), "managed-tool-input", resources);
        byte[] definition = reference(payload.path("toolDefinitionRef"), "managed-tool-definition", resources);
        require(!id(payload.path("argsRef"), "resourceId").equals(id(payload.path("toolDefinitionRef"), "resourceId")));
        var content = CsiNativeToolReservation.content(original, batch.batch().calls().get((int) ordinal), input, definition);
        var frozen = previous.fileHistory() == null ? null : previous.fileHistory().batches().get(batchId);
        if (frozen == null) {
            require("read_file".equals(batch.batch().calls().get((int) ordinal).name()));
        } else {
            require(frozen.preparedRef() != null && frozen.invocations().stream().anyMatch(invocation ->
                    execution.equals(id(invocation, "executionCallId")) && ordinal == number(invocation.get("ordinal"))
                            && canonical(payload.path("argsRef")).equals(canonical(invocation.path("inputRef")))
                            && canonical(payload.path("toolDefinitionRef")).equals(canonical(invocation.path("toolDefinitionRef")))
                            && ("sha256:" + content.digest()).equals(text(invocation, "requestDigest"))));
        }
        Map<String, ToolIntent> intents = new HashMap<>(previous.intents());
        intents.put(execution, new ToolIntent(payload.deepCopy(), previousRevision + 1, previousSequence + 1, content.digest()));
        return new Prefix(previous.input(), previous.checkpoint(), previous.lastMessageId(), previous.attempt(),
                previous.assistantCommitted(), previous.stream(), previous.usedIds(), previous.pendingBatch(),
                previous.batches(), previous.fileHistory(), intents, previous.receipts(), previous.nextDeltaOrdinal());
    }

    private static Checkpoint dispatchCheckpoint(Transaction transaction, JsonNode metadata,
            RuntimeProvisionRequest original, Activation activation, long previousSequence, Prefix previous,
            Function<JsonNode, byte[]> resources) {
        conversation(previous);
        require(previous.pendingBatch() != null && transaction.events().size() == 1);
        var prior = previous.checkpoint().state();
        String phase = text(prior.path("continuation"), "phase");
        require(Set.of("before_model", "turn_settled", "results_ready", "await_runtime").contains(phase) && prior.path("approval").isNull());
        var priorItems = prior.path("tools").isNull() ? JSON.createArrayNode() : prior.path("tools").path("items");
        Set<String> recorded = new HashSet<>();
        long nextOrdinal = 0;
        for (JsonNode item : priorItems) {
            require(recorded.add(id(item, "executionCallId")));
            nextOrdinal = Math.max(nextOrdinal, number(item.get("ordinal")) + 1);
        }
        List<ToolIntent> pending = previous.intents().values().stream().filter(intent ->
                previous.pendingBatch().messageId().equals(id(intent.payload(), "batchId"))
                        && !recorded.contains(id(intent.payload(), "executionCallId")))
                .sorted(java.util.Comparator.comparingLong(ToolIntent::sequence)).toList();
        require(!pending.isEmpty());
        JsonNode event = transaction.events().getFirst();
        JsonNode payload = harnessEvent(event, "checkpoint.committed", original, activation, previousSequence + 1);
        closed(payload, Set.of("checkpointId", "coveredSequence", "previousCheckpointId", "stateRef", "boundary"));
        String checkpointId = "ckpt-" + (previousSequence + 1);
        String predecessor = id(prior.path("identity"), "checkpointId");
        String executions = String.join(",", pending.stream().map(intent -> id(intent.payload(), "executionCallId")).toList());
        require(checkpointId.equals(id(event, "eventId")) && checkpointId.equals(id(payload, "checkpointId"))
                && number(payload.get("coveredSequence")) == previousSequence
                && predecessor.equals(id(payload, "previousCheckpointId")) && "durable_wait".equals(text(payload, "boundary"))
                && ("harness:await_runtime:" + activation.activationId() + ":" + executions + ":" + previousSequence)
                        .equals(id(metadata, "commandId")));
        JsonNode ref = payload.path("stateRef");
        JsonNode state = readObject(reference(ref, "managed-checkpoint", resources));
        require(id(ref, "resourceId").equals(id(metadata, "latestCheckpointResourceId"))
                && text(ref, "digest").equals(text(metadata, "contentDigest")));
        ObjectNode expected = prior.deepCopy();
        ((ObjectNode) expected.path("identity")).put("checkpointId", checkpointId).put("coveredSequence", previousSequence)
                .put("previousCheckpointId", predecessor).put("activationId", activation.activationId())
                .put("turnId", previous.input().inputId()).put("promptId", previous.input().inputId());
        ((ObjectNode) expected.path("resume")).put("throughSequence", previousSequence);
        expected.set("continuation", JSON.createObjectNode().put("phase", "await_runtime").set("pendingEventIds", JSON.createArrayNode()));
        expected.putNull("approval");
        var batch = previous.batches().get(previous.pendingBatch().messageId());
        ToolIntent first = pending.getFirst();
        var firstCall = batch.batch().calls().get((int) number(first.payload().get("ordinal")));
        if (prior.path("attempt").isNull()) {
            ObjectNode attempt = expected.putObject("attempt").put("attemptId", batch.batch().messageId())
                    .put("outputState", "output_committed").put("budgetConsumed", 0);
            attempt.set("routeRef", first.payload().path("argsRef"));
            for (String field : List.of("capabilityRef", "samplingRef", "usageRef")) {
                attempt.putNull(field);
            }
        }
        ObjectNode tools = expected.putObject("tools").put("batchId", prior.path("tools").isNull()
                ? "batch-" + firstCall.id() : id(prior.path("tools"), "batchId"));
        var items = tools.putArray("items");
        priorItems.forEach(items::add);
        var bindings = expected.putObject("runtime").putArray("bindings");
        if (!prior.path("runtime").isNull()) {
            prior.path("runtime").path("bindings").forEach(bindings::add);
        }
        for (ToolIntent intent : pending) {
            long localOrdinal = number(intent.payload().get("ordinal"));
            var call = batch.batch().calls().get((int) localOrdinal);
            long ordinal = Math.max(localOrdinal, nextOrdinal);
            require(ordinal < MAX_SAFE);
            nextOrdinal = ordinal + 1;
            String execution = id(intent.payload(), "executionCallId");
            items.addObject().put("functionCallId", call.id()).put("toolName", call.name())
                    .put("executionCallId", execution).put("modelMessageId", batch.batch().messageId())
                    .put("partIndex", call.partIndex()).put("ordinal", ordinal).put("inputDigest", intent.inputDigest())
                    .put("outcomeSource", "runtime").put("state", "in_progress").putNull("outcomeRef").put("consumed", false);
            bindings.addObject().put("executionCallId", execution).put("invocationBindingId", execution)
                    .put("capabilityVersion", CsiFilesRetirementProfile.CAPABILITY_DIGEST)
                    .put("policyVersion", CsiFilesRetirementProfile.POLICY_REF).putNull("mediaVersion")
                    .put("state", "dispatch").putNull("progressCursor");
        }
        require(number(state.path("identity").get("schemaVersion")) == 1
                && number(state.path("identity").get("coveredSequence")) == previousSequence
                && number(state.path("resume").get("throughSequence")) == previousSequence
                && number(state.path("resume").get("initialTurn")) == number(prior.path("resume").get("initialTurn"))
                && canonical(expected).equals(canonical(state)));
        for (JsonNode item : state.path("tools").path("items")) {
            number(item.get("ordinal"));
            number(item.get("partIndex"));
        }
        if (prior.path("attempt").isNull()) {
            require(number(state.path("attempt").get("budgetConsumed")) == 0);
        }
        checkpointResources(state, resources);
        return new Checkpoint(ref.deepCopy(), state.deepCopy());
    }

    private static void checkpointResources(JsonNode node, Function<JsonNode, byte[]> resources) {
        if (node.isObject() && node.has("resourceId")) {
            reference(node, text(node, "kind"), resources);
        } else if (node.isContainerNode()) {
            node.forEach(child -> checkpointResources(child, resources));
        }
    }

    private static Prefix fileHistory(Transaction transaction, JsonNode metadata,
            RuntimeProvisionRequest original, Activation activation, long previousSequence,
            Prefix previous, Function<JsonNode, byte[]> resources) {
        require(transaction.events().size() == 1 && metadata.path("latestCheckpointResourceId").isNull());
        boolean initial = previous.fileHistory() == null;
        long revision = initial ? 1 : number(previous.fileHistory().body().get("revision")) + 1;
        require(revision <= MAX_SAFE);
        String command = id(metadata, "commandId");
        JsonNode event = transaction.events().getFirst();
        closed(event, Set.of("v", "sequence", "eventId", "sessionKey", "kind", "occurredAt", "payload"));
        key(event.path("sessionKey"), original);
        require(number(event.get("v")) == 1 && number(event.get("sequence")) == previousSequence + 1
                && ("file_history:" + revision).equals(id(event, "eventId")) && "domain.committed".equals(text(event, "kind"))
                && time(event.get("occurredAt")) < activation.expiresAt());
        JsonNode payload = event.path("payload");
        closed(payload, Set.of("domain", "version", "operationId", "recordRef"));
        require("file_history".equals(text(payload, "domain")) && number(payload.get("version")) == 1
                && command.equals(id(payload, "operationId")));
        JsonNode ref = payload.path("recordRef");
        byte[] bytes = reference(ref, "managed-file_history", resources);
        require(bytes.length <= 64 * 1024);
        JsonNode body = readObject(bytes);
        closed(body, Set.of("operationId", "revision", "previousRecordRef", "schemaVersion", "profile",
                "runtimeSessionId", "state", "backupDirectory", "retainedBackups", "preparation", "record"));
        require(command.equals(id(body, "operationId")) && number(body.get("revision")) == revision
                && (initial ? body.path("previousRecordRef").isNull()
                        : canonical(body.path("previousRecordRef")).equals(canonical(previous.fileHistory().ref())))
                && number(body.get("schemaVersion")) == 2
                && CsiFilesRetirementProfile.PROFILE.equals(text(body, "profile"))
                && original.getIsolationKey().equals(id(body, "runtimeSessionId")));
        ObjectNode observation = JSON.createObjectNode();
        for (String field : List.of("state", "backupDirectory", "retainedBackups")) {
            observation.set(field, body.get(field));
        }
        CsiFileHistoryProtocol.observation(observation, original.getIsolationKey());
        JsonNode projection = body.path("record");
        closed(projection, Set.of("uuid", "parentUuid", "sessionId", "timestamp", "type", "subtype", "cwd", "version", "systemPayload"));
        envelope(projection, original, "file_history_snapshot", previous.lastMessageId());
        require("hosted-harness/1".equals(text(projection, "version")));
        closed(projection.path("systemPayload"), Set.of("snapshots"));
        require(canonical(body.path("state").path("snapshots"))
                .equals(canonical(projection.path("systemPayload").path("snapshots"))));
        ObjectNode content = body.deepCopy();
        content.remove(List.of("operationId", "revision", "previousRecordRef", "record"));
        require(sha256(utf8(canonical(content))).equals(text(metadata, "contentDigest")));
        Map<String, FrozenBatch> frozen = initial ? new HashMap<>() : new HashMap<>(previous.fileHistory().batches());
        if (initial) {
            require(previous.input() == null && previous.checkpoint() == null && previous.lastMessageId() == null
                    && previous.pendingBatch() == null && previous.batches().isEmpty()
                    && command.equals("csi-file-history:bind:" + original.getIsolationKey())
                    && body.path("preparation").isNull() && body.path("state").path("snapshots").isEmpty()
                    && body.path("state").path("files").isEmpty() && body.path("retainedBackups").isEmpty());
        } else {
            conversation(previous);
            require(!previous.assistantCommitted() && previous.stream() == null);
            JsonNode preparation = body.path("preparation");
            if (preparation.isNull()) {
                resultHistory(previous, body, command, previousSequence);
                return new Prefix(previous.input(), previous.checkpoint(), previous.lastMessageId(), previous.attempt(),
                        previous.assistantCommitted(), previous.stream(), useId(previous, id(projection, "uuid")),
                        null, previous.batches(), new FileHistory(ref.deepCopy(), body.deepCopy(), frozen), previous.intents(), previous.receipts(), previous.nextDeltaOrdinal());
            }
            require(previous.pendingBatch() != null);
            String stage = text(preparation, "stage");
            closed(preparation, "prepared".equals(stage)
                    ? Set.of("stage", "turnId", "promptId", "batchId", "invocations", "paths", "intentRef")
                    : Set.of("stage", "turnId", "promptId", "batchId", "invocations", "paths"));
            String batchId = previous.pendingBatch().messageId();
            String prompt = previous.input().inputId();
            require(prompt.equals(id(preparation, "turnId")) && prompt.equals(id(preparation, "promptId"))
                    && batchId.equals(id(preparation, "batchId")));
            if ("intent".equals(stage)) {
                require(command.equals("csi-file-history:intent:" + batchId)
                        && previous.fileHistory().body().path("preparation").isNull() && !frozen.containsKey(batchId)
                        && previous.intents().values().stream().noneMatch(intent -> batchId.equals(id(intent.payload(), "batchId"))));
                sameObservation(previous.fileHistory().body(), body);
                List<JsonNode> invocations = historyInvocations(original, previous.batches().get(batchId), preparation, resources);
                frozen.put(batchId, new FrozenBatch(ref.deepCopy(), null, invocations, previousSequence + 1, 0));
            } else {
                require("prepared".equals(stage) && command.equals("csi-file-history:prepared:" + batchId));
                var saved = frozen.get(batchId);
                require(saved != null && saved.preparedRef() == null
                        && canonical(saved.intentRef()).equals(canonical(preparation.path("intentRef")))
                        && canonical(saved.intentRef()).equals(canonical(previous.fileHistory().ref())));
                JsonNode intent = readObject(reference(saved.intentRef(), "managed-file_history", resources));
                require(canonical(intent).equals(canonical(previous.fileHistory().body())));
                ObjectNode unchanged = preparation.deepCopy();
                unchanged.remove("intentRef");
                unchanged.put("stage", "intent");
                require(canonical(unchanged).equals(canonical(intent.path("preparation"))));
                historyInvocations(original, previous.batches().get(batchId), preparation, resources);
                preparedObservation(intent, body, prompt, preparation.path("paths"));
                frozen.put(batchId, new FrozenBatch(saved.intentRef(), ref.deepCopy(), saved.invocations(), saved.intentSequence(), previousSequence + 1));
            }
        }
        return new Prefix(previous.input(), previous.checkpoint(), previous.lastMessageId(), previous.attempt(),
                previous.assistantCommitted(), previous.stream(), useId(previous, id(projection, "uuid")),
                previous.pendingBatch(), previous.batches(), new FileHistory(ref.deepCopy(), body.deepCopy(), frozen), previous.intents(), previous.receipts(), previous.nextDeltaOrdinal());
    }

    private static void resultHistory(Prefix previous, JsonNode body, String command, long previousSequence) {
        JsonNode prepared = previous.fileHistory().body();
        JsonNode preparation = prepared.path("preparation");
        require("prepared".equals(preparation.path("stage").textValue()) && previous.pendingBatch() == null
                && previous.attempt() == null
                && previous.input().inputId().equals(id(preparation, "promptId"))
                && "results_ready".equals(previous.checkpoint().state().path("continuation").path("phase").textValue()));
        String batchId = id(preparation, "batchId");
        var frozen = previous.fileHistory().batches().get(batchId);
        require(command.equals("csi-file-history:result:" + batchId) && frozen != null
                && canonical(frozen.preparedRef()).equals(canonical(previous.fileHistory().ref())));
        Set<String> expected = new HashSet<>();
        frozen.invocations().forEach(invocation -> require(expected.add(id(invocation, "executionCallId"))));
        Set<String> actual = new HashSet<>();
        for (JsonNode item : previous.checkpoint().state().path("tools").path("items")) {
            require("settled".equals(item.path("state").textValue()));
            if (!batchId.equals(item.path("modelMessageId").textValue())) {
                continue;
            }
            String execution = id(item, "executionCallId");
            var receipt = previous.receipts().get(execution);
            require(actual.add(execution) && !item.path("consumed").booleanValue()
                    && receipt != null && receipt.messageSequence() > 0 && receipt.messageSequence() <= previousSequence
                    && canonical(receipt.ref()).equals(canonical(item.path("outcomeRef"))));
        }
        require(expected.equals(actual));
        for (String field : List.of("backupDirectory", "retainedBackups")) {
            require(canonical(prepared.path(field)).equals(canonical(body.path(field))));
        }
        JsonNode before = prepared.path("state");
        JsonNode after = body.path("state");
        require(canonical(before.path("snapshots")).equals(canonical(after.path("snapshots"))));
        Set<String> paths = new HashSet<>();
        preparation.path("paths").forEach(path -> paths.add(path.textValue()));
        Set<String> beforeKeys = new HashSet<>();
        Set<String> afterKeys = new HashSet<>();
        before.path("files").fieldNames().forEachRemaining(beforeKeys::add);
        after.path("files").fieldNames().forEachRemaining(afterKeys::add);
        require(beforeKeys.equals(afterKeys) && beforeKeys.containsAll(paths));
        before.path("files").fields().forEachRemaining(entry -> {
            if (!paths.contains(entry.getKey())) {
                require(canonical(entry.getValue()).equals(canonical(after.path("files").get(entry.getKey()))));
            }
        });
    }

    public static JsonNode historyExecutionReference(RuntimeProvisionRequest original, JsonNode preparation, JsonNode invocation) {
        ObjectNode result = JSON.createObjectNode().put("sessionId", original.getIsolationKey())
                .put("promptId", id(preparation, "promptId")).put("batchId", id(preparation, "batchId"))
                .put("dispatchMode", "deferred");
        for (String field : List.of("callId", "functionCallId", "partIndex", "ordinal", "inputRef", "toolDefinitionRef")) {
            result.set(field, invocation.get(field));
        }
        result.set("argsDigest", invocation.get("requestDigest"));
        return result;
    }

    private static List<JsonNode> historyInvocations(RuntimeProvisionRequest original, OriginalBatch batch,
            JsonNode preparation, Function<JsonNode, byte[]> resources) {
        require(batch != null && preparation.path("invocations").isArray() && !preparation.path("invocations").isEmpty()
                && preparation.path("invocations").size() <= batch.batch().calls().size());
        List<JsonNode> result = new ArrayList<>();
        Set<String> executions = new HashSet<>();
        Set<String> calls = new HashSet<>();
        var paths = new java.util.TreeSet<String>();
        long ordinal = -1;
        for (JsonNode invocation : preparation.path("invocations")) {
            closed(invocation, Set.of("executionCallId", "callId", "functionCallId", "toolName", "partIndex",
                    "ordinal", "requestDigest", "inputRef", "toolDefinitionRef"));
            require(executions.add(id(invocation, "executionCallId")) && calls.add(id(invocation, "callId"))
                    && number(invocation.get("ordinal")) > ordinal);
            ordinal = number(invocation.get("ordinal"));
            require(ordinal < batch.batch().calls().size()
                    && batch.batch().calls().get((int) ordinal).name().equals(text(invocation, "toolName")));
            JsonNode ref = historyExecutionReference(original, preparation, invocation);
            var input = CsiNativeToolReservation.qualifyContent(original, batch, ref, text(invocation, "requestDigest"),
                    reference(invocation.path("inputRef"), "managed-tool-input", resources),
                    reference(invocation.path("toolDefinitionRef"), "managed-tool-definition", resources));
            if (!"read_file".equals(text(invocation, "toolName"))) {
                paths.add(text(input, "file_path"));
            }
            result.add(invocation.deepCopy());
        }
        require(!paths.isEmpty() && preparation.path("paths").isArray()
                && canonical(JSON.valueToTree(paths)).equals(canonical(preparation.path("paths"))));
        return List.copyOf(result);
    }

    private static void sameObservation(JsonNode left, JsonNode right) {
        for (String field : List.of("state", "backupDirectory", "retainedBackups")) {
            require(canonical(left.path(field)).equals(canonical(right.path(field))));
        }
    }

    private static void preparedObservation(JsonNode intent, JsonNode prepared, String prompt, JsonNode paths) {
        require(canonical(intent.path("backupDirectory")).equals(canonical(prepared.path("backupDirectory"))));
        Map<String, JsonNode> pins = new HashMap<>();
        prepared.path("retainedBackups").forEach(pin -> pins.put(text(pin, "name"), pin));
        for (JsonNode pin : intent.path("retainedBackups")) {
            require(canonical(pin).equals(canonical(pins.get(text(pin, "name")))));
        }
        JsonNode before = intent.path("state");
        JsonNode after = prepared.path("state");
        var tracked = new HashSet<String>();
        before.path("files").fieldNames().forEachRemaining(tracked::add);
        paths.forEach(path -> tracked.add(path.textValue()));
        var actual = new HashSet<String>();
        after.path("files").fieldNames().forEachRemaining(actual::add);
        require(tracked.equals(actual));
        before.path("files").fields().forEachRemaining(entry ->
                require(canonical(entry.getValue()).equals(canonical(after.path("files").get(entry.getKey())))));
        JsonNode oldSnapshots = before.path("snapshots");
        JsonNode snapshots = after.path("snapshots");
        boolean extend = !oldSnapshots.isEmpty() && prompt.equals(oldSnapshots.get(oldSnapshots.size() - 1).path("promptId").textValue());
        require(snapshots.size() == oldSnapshots.size() + (extend ? 0 : 1));
        for (int index = 0; index < oldSnapshots.size() - (extend ? 1 : 0); index++) {
            require(canonical(oldSnapshots.get(index)).equals(canonical(snapshots.get(index))));
        }
        JsonNode last = snapshots.get(snapshots.size() - 1);
        require(prompt.equals(id(last, "promptId")));
        JsonNode backups = last.path("trackedFileBackups");
        var backed = new HashSet<String>();
        backups.fieldNames().forEachRemaining(backed::add);
        require(backed.equals(tracked));
        if (extend) {
            JsonNode previous = oldSnapshots.get(oldSnapshots.size() - 1);
            require(canonical(previous.path("timestamp")).equals(canonical(last.path("timestamp"))));
            previous.path("trackedFileBackups").fields().forEachRemaining(entry ->
                    require(canonical(entry.getValue()).equals(canonical(backups.get(entry.getKey())))));
        }
        for (String path : tracked) {
            JsonNode backup = backups.path(path);
            JsonNode fingerprint = after.path("files").get(path);
            if (extend && before.path("files").has(path)) {
                continue;
            }
            if (fingerprint.isNull()) {
                require(backup.path("backupFileName").isNull());
            } else {
                require(backup.path("backupFileName").isTextual());
                JsonNode pin = pins.get(backup.path("backupFileName").textValue());
                require(pin != null && ("sha256:" + text(pin, "digest")).equals(text(fingerprint, "digest"))
                        && number(pin.get("mode")) == number(fingerprint.get("mode")));
            }
        }
    }

    private static Set<String> useId(Prefix previous, String value) {
        Set<String> ids = new HashSet<>(previous.usedIds());
        require(ids.add(value));
        return Set.copyOf(ids);
    }

    private static void conversation(Prefix previous) {
        require(previous.input() != null && previous.input().noDeadline() && previous.checkpoint() != null);
    }

    private static JsonNode streamEvent(Transaction transaction, JsonNode metadata,
            RuntimeProvisionRequest original, Activation activation, long previousSequence, Prefix previous,
            String kind) {
        conversation(previous);
        require(previous.input().userMessageId() != null && previous.attempt() != null
                && "started".equals(previous.attempt().stage()) && !previous.assistantCommitted()
                && previous.pendingBatch() == null
                && transaction.events().size() == 1 && metadata.path("latestCheckpointResourceId").isNull());
        return harnessEvent(transaction.events().getFirst(), kind, original, activation, previousSequence + 1);
    }

    private static Prefix delta(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Activation activation, long previousSequence, Prefix previous) {
        JsonNode payload = streamEvent(transaction, metadata, original, activation, previousSequence, previous,
                "message.delta");
        closed(payload, Set.of("messageId", "turnId", "role", "text"));
        String messageId = id(payload, "messageId");
        uuid(messageId);
        String turnId = previous.input().inputId();
        require(turnId.equals(id(payload, "turnId")) && "assistant".equals(text(payload, "role")));
        String fragment = text(payload, "text");
        byte[] bytes = utf8(fragment);
        require(bytes.length > 0 && bytes.length <= 3072
                && sha256(bytes).equals(text(metadata, "contentDigest")));
        Stream prior = previous.stream();
        long ordinal = previous.nextDeltaOrdinal();
        // A retry before the first delta resets the Hosted stream without
        // emitting a retraction; assistant commits otherwise retain its ordinal.
        if (prior == null && ("assistant-delta:" + turnId + ":" + messageId + ":0").equals(id(metadata, "commandId"))) {
            ordinal = 0;
        }
        String commandId = "assistant-delta:" + turnId + ":" + messageId + ":" + ordinal;
        require(commandId.equals(id(metadata, "commandId"))
                && commandId.equals(id(transaction.events().getFirst(), "eventId"))
                && (prior == null || messageId.equals(prior.messageId())));
        Stream stream = new Stream(messageId, prior == null ? previousSequence + 1 : prior.firstSequence(),
                (prior == null ? "" : prior.text()) + fragment);
        return new Prefix(previous.input(), previous.checkpoint(), previous.lastMessageId(), previous.attempt(),
                false, stream, prior == null ? useId(previous, messageId) : previous.usedIds(), null, previous.batches(), previous.fileHistory(), previous.intents(), previous.receipts(), ordinal + 1);
    }

    private static Prefix retract(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Activation activation, long previousSequence, Prefix previous) {
        JsonNode payload = streamEvent(transaction, metadata, original, activation, previousSequence, previous,
                "message.retracted");
        closed(payload, Set.of("messageId", "turnId", "fromSequence"));
        Stream stream = previous.stream();
        require(stream != null && stream.messageId().equals(id(payload, "messageId"))
                && previous.input().inputId().equals(id(payload, "turnId"))
                && stream.firstSequence() == number(payload.get("fromSequence")));
        String commandId = "assistant-retract:" + previous.input().inputId() + ":" + stream.messageId();
        require(commandId.equals(id(metadata, "commandId"))
                && commandId.equals(id(transaction.events().getFirst(), "eventId"))
                && sha256(utf8(stream.messageId() + ":" + stream.firstSequence()))
                        .equals(text(metadata, "contentDigest")));
        return new Prefix(previous.input(), previous.checkpoint(), previous.lastMessageId(), previous.attempt(),
                false, null, previous.usedIds(), null, previous.batches(), previous.fileHistory(), previous.intents(), previous.receipts(), 0);
    }

    static byte[] utf8(String text) {
        try {
            ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(text));
            byte[] bytes = new byte[encoded.remaining()];
            encoded.get(bytes);
            return bytes;
        } catch (CharacterCodingException error) {
            throw invalid();
        }
    }

    private static JsonNode harnessEvent(JsonNode event, String kind, RuntimeProvisionRequest original,
            Activation activation, long sequence) {
        closed(event, Set.of("v", "sequence", "eventId", "sessionKey", "kind", "occurredAt", "subject", "payload"));
        key(event.path("sessionKey"), original);
        require(number(event.get("v")) == 1 && number(event.get("sequence")) == sequence
                && kind.equals(text(event, "kind")) && time(event.get("occurredAt")) < activation.expiresAt());
        JsonNode subject = event.path("subject");
        closed(subject, Set.of("type", "scopeId", "activationId", "epoch"));
        require("activation".equals(text(subject, "type"))
                && activation.activationId().equals(id(subject, "scopeId"))
                && activation.activationId().equals(id(subject, "activationId"))
                && number(subject.get("epoch")) == activation.epoch());
        return event.path("payload");
    }

    private static Prefix message(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Genesis genesis, Activation activation, long previousSequence, Prefix previous,
            Function<JsonNode, byte[]> resources) {
        conversation(previous);
        if ("tool_result".equals(transaction.events().getFirst().path("payload").path("role").textValue())) {
            return toolMessage(transaction, metadata, original, genesis, activation, previousSequence, previous, resources);
        }
        require(previous.pendingBatch() == null && transaction.events().size() == 1
                && metadata.path("latestCheckpointResourceId").isNull()
                && genesis.definitionDigest().equals(text(metadata, "contentDigest")));
        JsonNode event = transaction.events().getFirst();
        JsonNode payload = harnessEvent(event, "message.committed", original, activation, previousSequence + 1);
        closed(payload, Set.of("messageId", "role", "contentRef", "parentMessageId"));
        require(("recorder:" + id(payload, "messageId")).equals(id(metadata, "commandId")));
        return messageRecord(event, payload, original, previous, resources, false);
    }

    private static Prefix messageRecord(JsonNode event, JsonNode payload, RuntimeProvisionRequest original,
            Prefix previous, Function<JsonNode, byte[]> resources, boolean finalOutput) {
        String messageId = id(payload, "messageId");
        uuid(messageId);
        require(("message:" + messageId).equals(id(event, "eventId")));
        JsonNode record = messageBody(payload.path("contentRef"), resources);
        String role = text(payload, "role");
        boolean user = "user".equals(role);
        require((user || "assistant".equals(role)) && (!finalOutput || !user));
        Set<String> fields = new HashSet<>(Set.of("uuid", "parentUuid", "sessionId", "timestamp", "type", "cwd",
                "version", "daemonPromptId", "message"));
        if (!user) {
            fields.add("model");
        }
        closed(record, fields);
        chatRecord(record, original);
        require(messageId.equals(id(record, "uuid")) && role.equals(text(record, "type"))
                && previous.input().inputId().equals(id(record, "daemonPromptId"))
                && Objects.equals(previous.lastMessageId(), nullableId(payload, "parentMessageId"))
                && Objects.equals(previous.lastMessageId(), nullableId(record, "parentUuid")));
        JsonNode body = record.path("message");
        closed(body, Set.of("role", "parts"));
        require((user ? "user" : "model").equals(text(body, "role"))
                && body.path("parts").isArray() && !body.path("parts").isEmpty());
        List<FunctionCall> calls = new ArrayList<>();
        if (user) {
            require(previous.input().userMessageId() == null && previous.attempt() == null
                    && body.path("parts").size() == 1);
            JsonNode part = body.path("parts").get(0);
            closed(part, Set.of("text"));
            require(part.path("text").isTextual() && previous.input().text().equals(part.path("text").textValue()));
        } else {
            require(previous.attempt() != null && "output_committed".equals(previous.attempt().stage())
                    && !previous.assistantCommitted()
                    && text(previous.attempt().route(), "model").equals(text(record, "model")));
            Set<String> functions = new HashSet<>();
            for (int index = 0; index < body.path("parts").size(); index++) {
                JsonNode part = body.path("parts").get(index);
                if (finalOutput) {
                    finalPart(part);
                } else if (part.has("functionCall")) {
                    closed(part, Set.of("functionCall"));
                    JsonNode call = part.path("functionCall");
                    closed(call, Set.of("id", "name", "args"));
                    String functionId = id(call, "id");
                    String name = text(call, "name");
                    require(functions.add(functionId) && Set.of("read_file", "write_file", "edit").contains(name)
                            && call.path("args").isObject() && calls.size() < 256);
                    calls.add(new FunctionCall(functionId, name, call.path("args").deepCopy(), index, calls.size()));
                } else {
                    closed(part, part.has("thought") ? Set.of("text", "thought") : Set.of("text"));
                    require(part.path("text").isTextual()
                            && (!part.has("thought") || part.path("thought").isBoolean()));
                }
            }
            if (previous.stream() != null) {
                StringBuilder visible = new StringBuilder();
                for (JsonNode part : body.path("parts")) {
                    if (part.has("text") && !part.path("thought").asBoolean()) {
                        visible.append(part.path("text").textValue());
                    }
                }
                require(messageId.equals(previous.stream().messageId())
                        && previous.stream().text().contentEquals(visible));
            }
        }
        Input input = user ? new Input(previous.input().inputId(), previous.input().text(), messageId, true)
                : previous.input();
        PendingBatch batch = calls.isEmpty() ? null
                : new PendingBatch(messageId, payload.path("contentRef").deepCopy(), List.copyOf(calls));
        Map<String, OriginalBatch> batches = previous.batches();
        if (batch != null) {
            batches = new HashMap<>(batches);
            require(batches.put(messageId, new OriginalBatch(input.inputId(), batch)) == null);
        }
        Attempt attempt = previous.attempt();
        if (finalOutput) {
            attempt = new Attempt(attempt.attemptId(), attempt.routeRef(), attempt.checkpointRef(), attempt.route(),
                    attempt.stage(), payload.path("contentRef").deepCopy());
        }
        return new Prefix(input, previous.checkpoint(), messageId, attempt, !user && calls.isEmpty(),
                null, !user && previous.stream() != null ? previous.usedIds() : useId(previous, messageId),
                batch, batches, previous.fileHistory(), previous.intents(), previous.receipts(), previous.nextDeltaOrdinal());
    }

    private static void finalPart(JsonNode part) {
        boolean textPart = part.has("text");
        Set<String> fields = new HashSet<>(Set.of(textPart ? "text" : "inlineData"));
        if (part.has("thought")) {
            fields.add("thought");
            require(part.path("thought").isBoolean());
        }
        if (part.has("thoughtSignature")) {
            fields.add("thoughtSignature");
            require(part.path("thoughtSignature").isTextual());
        }
        closed(part, fields);
        if (textPart) {
            require(part.path("text").isTextual());
        } else {
            JsonNode data = part.path("inlineData");
            closed(data, Set.of("mimeType", "data"));
            require(text(data, "mimeType").matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+"));
            JsonNode encodedValue = data.path("data");
            require(encodedValue.isTextual() && !encodedValue.textValue().isEmpty());
            String encoded = encodedValue.textValue();
            try {
                require(java.util.Base64.getEncoder().encodeToString(java.util.Base64.getDecoder().decode(encoded))
                        .equals(encoded));
            } catch (IllegalArgumentException error) {
                throw invalid();
            }
        }
    }

    private static JsonNode messageBody(JsonNode ref, Function<JsonNode, byte[]> resources) {
        if ("managed-message".equals(ref.path("kind").textValue())) {
            byte[] bytes = reference(ref, "managed-message", resources);
            require(bytes.length <= 64 * 1024);
            return readObject(bytes);
        }
        byte[] manifestBytes = reference(ref, "managed-message-chunks", resources);
        require(manifestBytes.length <= 64 * 1024);
        JsonNode manifest = readObject(manifestBytes);
        closed(manifest, Set.of("parts"));
        JsonNode parts = manifest.path("parts");
        require(parts.isArray() && parts.size() > 1 && parts.size() <= 137);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < parts.size(); index++) {
            JsonNode part = parts.get(index);
            require(ids.add(id(part, "resourceId")));
            byte[] content = reference(part, "managed-message-part", resources);
            require(content.length > 0 && content.length <= 60 * 1024
                    && (index == parts.size() - 1 || content.length == 60 * 1024)
                    && bytes.size() + content.length <= 8 * 1024 * 1024);
            bytes.writeBytes(content);
        }
        require(bytes.size() > 64 * 1024);
        return readObject(bytes.toByteArray());
    }

    private static void chatRecord(JsonNode record, RuntimeProvisionRequest original) {
        uuid(id(record, "uuid"));
        require(original.getIsolationKey().equals(text(record, "sessionId"))
                && original.getScope().getCanonicalCwd().equals(text(record, "cwd"))
                && "hosted-harness/1".equals(text(record, "version")));
        try {
            Instant.parse(text(record, "timestamp"));
        } catch (java.time.DateTimeException error) {
            throw invalid();
        }
    }

    private static String nullableId(JsonNode node, String field) {
        require(node.has(field));
        return node.path(field).isNull() ? null : id(node, field);
    }

    private static Prefix attempt(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Activation activation, long previousSequence, Prefix previous, Function<JsonNode, byte[]> resources) {
        conversation(previous);
        require(previous.input().userMessageId() != null && !previous.assistantCommitted() && previous.pendingBatch() == null
                && (transaction.events().size() == 1 || transaction.events().size() == 2)
                && metadata.path("latestCheckpointResourceId").isNull());
        boolean finalOutput = transaction.events().size() == 2;
        JsonNode event = transaction.events().getFirst();
        JsonNode payload = harnessEvent(event, "model.attempt", original, activation, previousSequence + 1);
        closed(payload, Set.of("attemptId", "routeRef", "inputCheckpointRef", "state", "usageRef"));
        String attemptId = id(payload, "attemptId");
        String prefix = previous.input().inputId() + ":main:";
        require(attemptId.startsWith(prefix));
        uuid(attemptId.substring(prefix.length()));
        String stage = text(payload, "state");
        require((attemptId + ":" + stage).equals(id(event, "eventId"))
                && (attemptId + ":" + stage).equals(id(metadata, "commandId")));
        JsonNode routeRef = payload.path("routeRef");
        JsonNode route = readObject(reference(routeRef, "managed-hosted-model-route", resources));
        closed(route, Set.of("version", "turnId", "model", "budget"));
        require(number(route.get("version")) == 1 && previous.input().inputId().equals(id(route, "turnId"))
                && (finalOutput || text(routeRef, "digest").equals(text(metadata, "contentDigest"))));
        text(route, "model");
        JsonNode budget = route.path("budget");
        closed(budget, Set.of("sessionId", "promptId", "budget", "outputTokensAtTurnStart"));
        require(original.getIsolationKey().equals(text(budget, "sessionId"))
                && previous.input().inputId().equals(id(budget, "promptId")) && budget.path("budget").isNull());
        finite(budget.get("outputTokensAtTurnStart"));
        JsonNode checkpointRef = payload.path("inputCheckpointRef");
        require(canonical(checkpointRef).equals(canonical(previous.checkpoint().ref())));
        require(canonical(readObject(reference(checkpointRef, "managed-checkpoint", resources)))
                .equals(canonical(previous.checkpoint().state())));
        if (finalOutput) {
            require("output_committed".equals(stage)
                    && "results_ready".equals(previous.checkpoint().state().path("continuation").path("phase").textValue())
                    && previous.checkpoint().state().path("tools").path("items").isArray()
                    && !previous.checkpoint().state().path("tools").path("items").isEmpty());
            boolean pending = false;
            for (JsonNode item : previous.checkpoint().state().path("tools").path("items")) {
                var receipt = previous.receipts().get(id(item, "executionCallId"));
                require("settled".equals(text(item, "state")) && item.path("consumed").isBoolean()
                        && receipt != null && receipt.messageSequence() > 0
                        && canonical(item.path("outcomeRef")).equals(canonical(receipt.ref())));
                pending |= !item.path("consumed").booleanValue();
            }
            require(pending);
        }
        Set<String> ids = previous.usedIds();
        if ("started".equals(stage)) {
            require(previous.attempt() == null && payload.path("usageRef").isNull()
                    && (previous.fileHistory() == null || previous.fileHistory().body().path("preparation").isNull())
                    && (previous.checkpoint().state().path("tools").isNull()
                            || "results_ready".equals(previous.checkpoint().state().path("continuation").path("phase").textValue())));
            ids = useId(previous, attemptId);
        } else {
            require(previous.attempt() != null && "started".equals(previous.attempt().stage())
                    && attemptId.equals(previous.attempt().attemptId())
                    && canonical(routeRef).equals(canonical(previous.attempt().routeRef()))
                    && canonical(checkpointRef).equals(canonical(previous.attempt().checkpointRef()))
                    && canonical(route).equals(canonical(previous.attempt().route()))
                    && ("output_committed".equals(stage) || "abandoned".equals(stage)));
            usage(readObject(reference(payload.path("usageRef"), "managed-hosted-model-usage", resources)), route, stage);
        }
        Prefix completed = new Prefix(previous.input(), previous.checkpoint(), previous.lastMessageId(),
                new Attempt(attemptId, routeRef.deepCopy(), checkpointRef.deepCopy(), route.deepCopy(), stage), false,
                previous.stream(), ids, null, previous.batches(), previous.fileHistory(), previous.intents(), previous.receipts(), previous.nextDeltaOrdinal());
        if (!finalOutput) {
            return completed;
        }
        JsonNode message = transaction.events().get(1);
        JsonNode messagePayload = harnessEvent(message, "message.committed", original, activation, previousSequence + 2);
        closed(messagePayload, Set.of("messageId", "role", "contentRef", "parentMessageId", "modelAttemptId"));
        require(attemptId.equals(id(messagePayload, "modelAttemptId")));
        var digestInput = JSON.createArrayNode().add("managed-final-output/1").add(attemptId);
        for (JsonNode ref : List.of(routeRef, checkpointRef, payload.path("usageRef"), messagePayload.path("contentRef"))) {
            digestInput.add(JSON.createArrayNode().add(ref.path("resourceId")).add(ref.path("kind"))
                    .add(ref.path("schemaVersion")).add(ref.path("byteLength")).add(ref.path("digest")));
        }
        require(sha256(utf8(digestInput.toString())).equals(text(metadata, "contentDigest")));
        return messageRecord(message, messagePayload, original, completed, resources, true);
    }

    static Set<String> completeOutputTail(Prefix prefix, long sequence) {
        require(prefix.input() != null && prefix.input().noDeadline() && prefix.pendingBatch() == null
                && prefix.batches().size() == 1 && prefix.checkpoint() != null && prefix.attempt() != null
                && "output_committed".equals(prefix.attempt().stage()) && prefix.attempt().finalMessageRef() != null
                && prefix.assistantCommitted() && prefix.stream() == null && prefix.fileHistory() != null
                && prefix.fileHistory().body().path("preparation").isNull()
                && "results_ready".equals(prefix.checkpoint().state().path("continuation").path("phase").textValue())
                && canonical(prefix.attempt().checkpointRef()).equals(canonical(prefix.checkpoint().ref())));
        Set<String> executions = new HashSet<>();
        JsonNode items = prefix.checkpoint().state().path("tools").path("items");
        require(items.isArray() && !items.isEmpty());
        String batchId = prefix.batches().keySet().iterator().next();
        for (JsonNode item : items) {
            String execution = id(item, "executionCallId");
            ToolReceipt receipt = prefix.receipts().get(execution);
            require(executions.add(execution) && "settled".equals(text(item, "state"))
                    && item.path("consumed").isBoolean() && !item.path("consumed").booleanValue()
                    && batchId.equals(id(item, "modelMessageId")) && receipt != null
                    && receipt.messageSequence() > 0 && receipt.messageSequence() <= sequence
                    && canonical(item.path("outcomeRef")).equals(canonical(receipt.ref())));
        }
        require(executions.equals(prefix.intents().keySet()) && executions.equals(prefix.receipts().keySet()));
        return Set.copyOf(executions);
    }

    private static void usage(JsonNode usage, JsonNode route, String stage) {
        closed(usage, Set.of("version", "turnId", "model", "attempts", "budget", "models"));
        require(number(usage.get("version")) == 1 && id(route, "turnId").equals(id(usage, "turnId"))
                && text(route, "model").equals(text(usage, "model"))
                && canonical(route.path("budget")).equals(canonical(usage.path("budget")))
                && usage.path("attempts").isArray()
                && usage.path("attempts").size() == ("output_committed".equals(stage) ? 1 : 0));
        for (JsonNode value : usage.path("attempts")) {
            metrics(value, Set.of("promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount",
                    "totalTokenCount", "cachedContentTokenCount"));
        }
        JsonNode models = object(usage.path("models"));
        models.fields().forEachRemaining(entry -> {
            require(!entry.getKey().isEmpty() && entry.getKey().length() <= 4096);
            JsonNode model = entry.getValue();
            closed(model, Set.of("api", "tokens", "bySource"));
            modelMetrics(model);
            closed(model.path("bySource"), Set.of("main"));
            JsonNode main = model.path("bySource").path("main");
            closed(main, Set.of("api", "tokens"));
            modelMetrics(main);
        });
    }

    private static void modelMetrics(JsonNode node) {
        metrics(node.path("api"), Set.of("totalRequests", "totalErrors", "totalLatencyMs"));
        metrics(node.path("tokens"), Set.of("prompt", "candidates", "total", "cached", "thoughts"));
    }

    private static void metrics(JsonNode node, Set<String> fields) {
        closed(node, fields);
        fields.forEach(field -> finite(node.get(field)));
    }

    private static void finite(JsonNode node) {
        require(node != null && node.isNumber() && Double.isFinite(node.doubleValue()));
    }

    private static Prefix settle(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Activation activation, long previousSequence, Prefix previous, Function<JsonNode, byte[]> resources) {
        conversation(previous);
        require(previous.pendingBatch() == null && previous.attempt() != null && transaction.events().size() == 2);
        JsonNode event = transaction.events().getFirst();
        JsonNode payload = harnessEvent(event, "turn.settled", original, activation, previousSequence + 1);
        closed(payload, Set.of("turnId", "outcome", "stopReason", "resultRef", "usageRef", "pendingOwnersRef"));
        String turnId = previous.input().inputId();
        boolean completed = "output_committed".equals(previous.attempt().stage()) && previous.assistantCommitted();
        require(completed || "abandoned".equals(previous.attempt().stage()) && !previous.assistantCommitted());
        String outcome = completed ? "completed" : "error";
        String stopReason = completed ? "end_turn" : "error";
        require(turnId.equals(id(payload, "turnId")) && ("turn:" + turnId).equals(id(event, "eventId"))
                && outcome.equals(text(payload, "outcome")) && stopReason.equals(text(payload, "stopReason")));
        nullFields(payload, "usageRef", "pendingOwnersRef");
        JsonNode ref = payload.path("resultRef");
        JsonNode result = readObject(reference(ref, "managed-turn-result", resources));
        closed(result, Set.of("uuid", "parentUuid", "sessionId", "timestamp", "type", "cwd", "version",
                "subtype", "systemPayload"));
        chatRecord(result, original);
        require("system".equals(text(result, "type")) && "turn_result".equals(text(result, "subtype"))
                && result.path("parentUuid").isNull() && ("recorder:" + id(result, "uuid"))
                        .equals(id(metadata, "commandId")) && text(ref, "digest").equals(text(metadata, "contentDigest")));
        JsonNode body = result.path("systemPayload");
        closed(body, Set.of("promptId", "state", "stopReason", "endedAt"));
        require(turnId.equals(id(body, "promptId")) && outcome.equals(text(body, "state"))
                && stopReason.equals(text(body, "stopReason")));
        time(body.get("endedAt"));
        JsonNode checkpointEvent = transaction.events().getLast();
        JsonNode checkpoint = harnessEvent(checkpointEvent, "checkpoint.committed", original, activation,
                previousSequence + 2);
        closed(checkpoint, Set.of("checkpointId", "coveredSequence", "previousCheckpointId", "stateRef", "boundary"));
        String checkpointId = "ckpt-" + (previousSequence + 2);
        String previousId = id(previous.checkpoint().state().path("identity"), "checkpointId");
        require(checkpointId.equals(id(checkpointEvent, "eventId")) && checkpointId.equals(id(checkpoint, "checkpointId"))
                && number(checkpoint.get("coveredSequence")) == previousSequence
                && previousId.equals(id(checkpoint, "previousCheckpointId"))
                && "turn_complete".equals(text(checkpoint, "boundary")));
        JsonNode stateRef = checkpoint.path("stateRef");
        JsonNode state = readObject(reference(stateRef, "managed-checkpoint", resources));
        require(id(stateRef, "resourceId").equals(id(metadata, "latestCheckpointResourceId")));
        ObjectNode expected = previous.checkpoint().state().deepCopy();
        ObjectNode identity = (ObjectNode) expected.path("identity");
        identity.put("checkpointId", checkpointId).put("coveredSequence", previousSequence)
                .put("activationId", activation.activationId()).put("turnId", turnId).put("promptId", turnId)
                .put("previousCheckpointId", previousId);
        ((ObjectNode) expected.path("resume")).put("throughSequence", previousSequence);
        expected.set("continuation", JSON.createObjectNode().put("phase", "before_model")
                .set("pendingEventIds", JSON.createArrayNode()));
        for (String field : List.of("attempt", "tools", "runtime", "approval")) {
            expected.putNull(field);
        }
        ObjectNode output = expected.putObject("output");
        output.putNull("llmContentRef").putNull("physicalStatus").putNull("hookResultRef");
        output.set("mediaRefs", JSON.createArrayNode());
        output.set("parentHistory", previous.checkpoint().state().path("output").path("parentHistory"));
        require(previous.checkpoint().state().path("tools").isNull()
                || completed && "turn_settled".equals(previous.checkpoint().state().path("continuation").path("phase").textValue()));
        require(number(state.path("identity").get("schemaVersion")) == 1
                && number(state.path("identity").get("coveredSequence")) == previousSequence
                && number(state.path("resume").get("throughSequence")) == previousSequence
                && number(state.path("resume").get("initialTurn")) == 0
                && canonical(expected).equals(canonical(state)));
        return new Prefix(null, new Checkpoint(stateRef.deepCopy(), state.deepCopy()), previous.lastMessageId(),
                null, false, null, useId(previous, id(result, "uuid")), null, previous.batches(), previous.fileHistory(), previous.intents(), previous.receipts(), 0);
    }

    private static Input input(Transaction transaction, JsonNode metadata, RuntimeProvisionRequest original,
            Activation activation, long previousSequence, Function<JsonNode, byte[]> resources) {
        require(transaction.events().size() == 2 && metadata.path("latestCheckpointResourceId").isNull());
        JsonNode accepted = transaction.events().getFirst();
        JsonNode wake = transaction.events().getLast();
        for (JsonNode event : transaction.events()) {
            closed(event, Set.of("v", "sequence", "eventId", "sessionKey", "kind", "occurredAt", "payload"));
            key(event.path("sessionKey"), original);
            require(number(event.get("v")) == 1);
        }
        require("input.accepted".equals(text(accepted, "kind")) && "wake.requested".equals(text(wake, "kind"))
                && number(accepted.get("sequence")) == previousSequence + 1
                && number(wake.get("sequence")) == previousSequence + 2
                && time(accepted.get("occurredAt")) < activation.expiresAt()
                && time(wake.get("occurredAt")) == time(accepted.get("occurredAt")));
        JsonNode payload = accepted.path("payload");
        closed(payload, Set.of("inputId", "turnId", "source", "contentRef", "deadline", "admissionRef"));
        String inputId = id(payload, "inputId");
        require(inputId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
                && inputId.equals(id(payload, "turnId")) && inputId.equals(id(metadata, "commandId"))
                && "hosted-harness".equals(text(payload, "source"))
                && (inputId + ":accepted").equals(id(accepted, "eventId")));
        if (!payload.path("deadline").isNull()) {
            time(payload.get("deadline"));
        }
        byte[] inputBytes = reference(payload.path("contentRef"), "managed-input", resources);
        require(inputBytes.length <= 64 * 1024 && sha256(inputBytes).equals(text(metadata, "contentDigest")));
        JsonNode blocks = readJson(inputBytes);
        require(blocks != null && blocks.isArray() && !blocks.isEmpty());
        List<String> texts = new ArrayList<>();
        for (JsonNode block : blocks) {
            closed(block, Set.of("type", "text"));
            require("text".equals(text(block, "type")) && block.path("text").isTextual()
                    && !block.path("text").textValue().isEmpty());
            texts.add(block.path("text").textValue());
        }
        byte[] admissionBytes = reference(payload.path("admissionRef"), "managed-admission", resources);
        require(admissionBytes.length <= 64 * 1024);
        JsonNode admission = readObject(admissionBytes);
        closed(admission, Set.of("promptId", "digest"));
        require(inputId.equals(id(admission, "promptId"))
                && ("sha256:" + sha256(inputBytes)).equals(text(admission, "digest")));
        JsonNode wakePayload = wake.path("payload");
        closed(wakePayload, Set.of("wakeId", "reason", "subject", "sourceEventId", "requiredSequence"));
        require((inputId + ":wake").equals(id(wake, "eventId"))
                && (inputId + ":wake").equals(id(wakePayload, "wakeId"))
                && "input".equals(text(wakePayload, "reason"))
                && (inputId + ":accepted").equals(id(wakePayload, "sourceEventId"))
                && number(wakePayload.get("requiredSequence")) == previousSequence + 1);
        JsonNode subject = wakePayload.path("subject");
        closed(subject, Set.of("type", "turnId"));
        require("turn".equals(text(subject, "type")) && inputId.equals(id(subject, "turnId")));
        return new Input(inputId, String.join("\n", texts), null, payload.path("deadline").isNull());
    }

    public static String initialCheckpoint(Transaction transaction, JsonNode metadata,
            RuntimeProvisionRequest original, String writerId, Genesis genesis, Activation activation,
            long previousSequence, Function<JsonNode, byte[]> resources) {
        return id(validatedInitialCheckpoint(transaction, metadata, original, writerId,
                genesis, activation, previousSequence, resources).ref(), "resourceId");
    }

    private static Checkpoint validatedInitialCheckpoint(Transaction transaction, JsonNode metadata,
            RuntimeProvisionRequest original, String writerId, Genesis genesis, Activation activation,
            long previousSequence, Function<JsonNode, byte[]> resources) {
        require(activation != null && transaction.events().size() == 1
                && writerId.equals(activation.workerId()) && writerId.equals(text(metadata, "writerId"))
                && number(metadata.get("writerGeneration")) == 1 && number(metadata.get("activationEpoch")) == 1
                && "commitCheckpoint".equals(text(metadata, "operation")));
        JsonNode event = transaction.events().getFirst();
        closed(event, Set.of("v", "sequence", "eventId", "sessionKey", "kind", "occurredAt", "subject", "payload"));
        key(event.path("sessionKey"), original);
        require("checkpoint.committed".equals(text(event, "kind")) && number(event.get("v")) == 1
                && number(event.get("sequence")) == previousSequence + 1
                && time(event.get("occurredAt")) < activation.expiresAt());
        JsonNode subject = event.path("subject");
        closed(subject, Set.of("type", "scopeId", "activationId", "epoch"));
        require("activation".equals(text(subject, "type"))
                && activation.activationId().equals(id(subject, "scopeId"))
                && activation.activationId().equals(id(subject, "activationId")) && number(subject.get("epoch")) == 1);
        JsonNode payload = event.path("payload");
        closed(payload, Set.of("checkpointId", "coveredSequence", "previousCheckpointId", "stateRef", "boundary"));
        String checkpointId = "ckpt-" + (previousSequence + 1);
        require(checkpointId.equals(id(event, "eventId")) && checkpointId.equals(id(payload, "checkpointId"))
                && number(payload.get("coveredSequence")) == previousSequence
                && payload.path("previousCheckpointId").isNull() && payload.path("boundary").isNull()
                && ("harness:before_model:" + activation.activationId() + ":" + previousSequence)
                        .equals(id(metadata, "commandId")));
        JsonNode ref = payload.path("stateRef");
        JsonNode state = readObject(reference(ref, "managed-checkpoint", resources));
        require(id(ref, "resourceId").equals(id(metadata, "latestCheckpointResourceId"))
                && text(ref, "digest").equals(text(metadata, "contentDigest")));
        closed(state, Set.of("identity", "resume", "continuation", "attempt", "tools", "runtime", "approval",
                "output", "followUp"));
        JsonNode identity = state.path("identity");
        closed(identity, Set.of("schemaVersion", "sessionKey", "engine", "checkpointId", "coveredSequence",
                "activationId", "turnId", "promptId", "definitionRevision", "configRevision", "inputDigest",
                "previousCheckpointId"));
        key(identity.path("sessionKey"), original);
        require(number(identity.get("schemaVersion")) == 1 && "managed".equals(text(identity, "engine"))
                && checkpointId.equals(id(identity, "checkpointId"))
                && number(identity.get("coveredSequence")) == previousSequence
                && activation.activationId().equals(id(identity, "activationId"))
                && genesis.definitionResourceId().equals(id(identity, "definitionRevision"))
                && genesis.rootResourceId().equals(id(identity, "configRevision"))
                && genesis.definitionDigest().equals(text(identity, "inputDigest")));
        nullFields(identity, "turnId", "promptId", "previousCheckpointId");
        JsonNode resume = state.path("resume");
        closed(resume, Set.of("source", "throughSequence", "recording", "initialTurn", "consumedNotificationIds",
                "apiHistoryRef", "fileHistoryRef", "artifactRef", "goalRecordsRef", "goalCheckpointWindowRef",
                "tokenCountsRef", "uiTelemetryRef", "attributionRef", "goalRecoverySourceUuid"));
        require("session_log".equals(text(resume, "source"))
                && number(resume.get("throughSequence")) == previousSequence && number(resume.get("initialTurn")) == 0);
        emptyArrays(resume, "consumedNotificationIds");
        nullFields(resume, "apiHistoryRef", "fileHistoryRef", "artifactRef", "goalRecordsRef", "goalCheckpointWindowRef",
                "tokenCountsRef", "uiTelemetryRef", "attributionRef", "goalRecoverySourceUuid");
        JsonNode recording = resume.path("recording");
        closed(recording, Set.of("lastCompletedUuid", "turnParentUuids", "parentSessionId", "sourceType", "sourceId",
                "lastAssistantModel", "executionEngine"));
        require("managed".equals(text(recording, "executionEngine")));
        nullFields(recording, "lastCompletedUuid", "parentSessionId", "sourceType", "sourceId", "lastAssistantModel");
        emptyArrays(recording, "turnParentUuids");
        JsonNode continuation = state.path("continuation");
        closed(continuation, Set.of("phase", "pendingEventIds"));
        require("before_model".equals(text(continuation, "phase")));
        emptyArrays(continuation, "pendingEventIds");
        nullFields(state, "attempt", "tools", "runtime", "approval");
        JsonNode output = state.path("output");
        closed(output, Set.of("llmContentRef", "physicalStatus", "hookResultRef", "mediaRefs", "parentHistory"));
        nullFields(output, "llmContentRef", "physicalStatus", "hookResultRef", "parentHistory");
        emptyArrays(output, "mediaRefs");
        JsonNode followUp = state.path("followUp");
        closed(followUp, Set.of("pendingInputIds", "cancelRequestIds", "goalPermitIds", "cronIds", "notificationIds",
                "childRunIds", "stopBudgetRemaining", "scopeLineage"));
        nullFields(followUp, "stopBudgetRemaining");
        emptyArrays(followUp, "pendingInputIds", "cancelRequestIds", "goalPermitIds", "cronIds", "notificationIds",
                "childRunIds", "scopeLineage");
        var array = JSON.createArrayNode().add(event);
        require(sha256(canonical(array).getBytes(StandardCharsets.UTF_8)).equals(text(metadata, "eventsDigest")));
        return new Checkpoint(ref.deepCopy(), state.deepCopy());
    }

    private static void nullFields(JsonNode node, String... fields) {
        for (String field : fields) {
            require(node.path(field).isNull());
        }
    }

    private static void emptyArrays(JsonNode node, String... fields) {
        for (String field : fields) {
            require(node.path(field).isArray() && node.path(field).isEmpty());
        }
    }

    public static Activation activation(Transaction transaction, JsonNode metadata,
            RuntimeProvisionRequest original, String writerId, String definitionDigest,
            Activation previous, Function<JsonNode, byte[]> resources) {
        long generation = number(metadata.get("writerGeneration"));
        long epoch = number(metadata.get("activationEpoch"));
        boolean install = "installActivation".equals(text(metadata, "operation"));
        require(transaction.events().size() == 1 && generation > 0 && epoch > 0
                && definitionDigest.equals(text(metadata, "contentDigest"))
                && metadata.path("latestCheckpointResourceId").isNull());
        JsonNode event = transaction.events().getFirst();
        closed(event, Set.of("v", "sequence", "eventId", "sessionKey", "kind", "occurredAt", "payload"));
        require("activation.changed".equals(text(event, "kind")));
        key(event.path("sessionKey"), original);
        time(event.get("occurredAt"));
        JsonNode payload = event.path("payload");
        Set<String> payloadFields = new java.util.HashSet<>(PAYLOAD);
        if (!install) {
            payloadFields.add("renewalSeq");
        }
        closed(payload, payloadFields);
        String id = id(payload, "activationId");
        require(number(payload.get("epoch")) == epoch && "active".equals(text(payload, "phase"))
                && writerId.equals(text(payload, "workerId")) && writerId.equals(text(metadata, "writerId"))
                && payload.path("boundaryRef").isNull());
        uuid(writerId);
        JsonNode subject = payload.path("subject");
        closed(subject, Set.of("type", "scopeId", "activationId", "epoch"));
        require("activation".equals(text(subject, "type")) && id.equals(text(subject, "scopeId"))
                && id.equals(text(subject, "activationId")) && number(subject.get("epoch")) == epoch);
        long lease = number(payload.get("leaseDurationMs"));
        long expires = time(payload.get("expiresAt"));
        require(lease > 0 && expires > time(event.get("occurredAt")));
        JsonNode ref = payload.path("installRef");
        byte[] bytes = reference(ref, "managed-activation-install", resources);
        JsonNode body = readObject(bytes);
        closed(body, Set.of("version", "activationId", "epoch", "workerId", "leaseDurationMs"));
        require(number(body.get("version")) == 1 && id.equals(text(body, "activationId"))
                && number(body.get("epoch")) == epoch && writerId.equals(text(body, "workerId"))
                && number(body.get("leaseDurationMs")) > 0);
        long renewal = install ? 0 : number(payload.get("renewalSeq"));
        String suffix = install ? "" : ":renewal:" + renewal;
        require((install ? "installActivation" : "renewActivation").equals(text(metadata, "operation"))
                && (id + ":active" + suffix).equals(id(metadata, "commandId"))
                && ("activation:" + id + ":active" + suffix).equals(id(event, "eventId")));
        if (previous == null) {
            require(install && generation == 1 && epoch == 1 && number(metadata.get("firstSequence")) == 1
                    && number(body.get("leaseDurationMs")) == lease);
        } else if (install) {
            require(generation > previous.writerGeneration() && epoch == previous.epoch() + 1
                    && !id.equals(previous.activationId()) && !writerId.equals(previous.workerId())
                    && time(event.get("occurredAt")) >= previous.expiresAt()
                    && number(body.get("leaseDurationMs")) == lease);
        } else {
            require(id.equals(previous.activationId()) && writerId.equals(previous.workerId())
                    && generation == previous.writerGeneration() && epoch == previous.epoch()
                    && canonical(ref).equals(canonical(previous.installRef()))
                    && renewal == previous.renewalSequence() + 1);
        }
        var array = JSON.createArrayNode().add(event);
        require(sha256(canonical(array).getBytes(StandardCharsets.UTF_8)).equals(text(metadata, "eventsDigest")));
        return new Activation(id, writerId, ref.deepCopy(), lease, expires, renewal, epoch, generation);
    }

    public static boolean hasActivation(Transaction transaction) {
        return transaction.events().stream().anyMatch(event -> "activation.changed".equals(event.path("kind").textValue()));
    }

    /** Decodes facts from a validated, unmodified parser continuation; grants no live authority. */
    public static TerminalProof terminal(List<JsonNode> records, JsonNode metadata,
            RuntimeProvisionRequest original, Genesis genesis, Activation previous, Prefix prefix,
            long previousSequence, String previousUuid, String previousCommitDigest,
            Function<JsonNode, byte[]> resources) {
        require(genesis != null && previous != null && prefix != null
                && previous.writerGeneration() == 1 && previous.epoch() == 1
                && prefix.checkpoint() != null && prefix.input() == null && prefix.attempt() == null
                && prefix.stream() == null && prefix.pendingBatch() == null
                && previousSequence > 0 && previousSequence < MAX_SAFE
                && "releaseActivation".equals(text(metadata, "operation"))
                && (previous.activationId() + ":released").equals(id(metadata, "commandId"))
                && genesis.definitionDigest().equals(text(metadata, "contentDigest"))
                && number(metadata.get("eventCount")) == 1
                && number(metadata.get("firstSequence")) == previousSequence + 1
                && previousCommitDigest != null && previousCommitDigest.equals(text(metadata, "previousCommitDigest"))
                && previous.workerId().equals(text(metadata, "writerId"))
                && number(metadata.get("writerGeneration")) == 1 && number(metadata.get("activationEpoch")) == 1
                && metadata.path("latestCheckpointResourceId").isNull());
        uuid(previousUuid);
        Transaction transaction = transaction(records, metadata, original, previousUuid);
        JsonNode event = transaction.events().getFirst();
        closed(event, Set.of("v", "sequence", "eventId", "sessionKey", "kind", "occurredAt", "payload"));
        require("activation.changed".equals(text(event, "kind"))
                && ("activation:" + previous.activationId() + ":released").equals(id(event, "eventId")));
        time(event.get("occurredAt"));
        JsonNode payload = event.path("payload");
        closed(payload, PAYLOAD);
        require(previous.activationId().equals(id(payload, "activationId")) && number(payload.get("epoch")) == 1
                && previous.workerId().equals(text(payload, "workerId"))
                && "released".equals(text(payload, "phase")) && payload.path("leaseDurationMs").isNull()
                && time(payload.get("expiresAt")) == previous.expiresAt() && payload.path("installRef").isNull());
        JsonNode subject = payload.path("subject");
        closed(subject, Set.of("type", "scopeId", "activationId", "epoch"));
        require("activation".equals(text(subject, "type"))
                && previous.activationId().equals(text(subject, "scopeId"))
                && previous.activationId().equals(text(subject, "activationId")) && number(subject.get("epoch")) == 1);
        JsonNode ref = payload.path("boundaryRef");
        byte[] bytes = reference(ref, "managed-activation-boundary", resources);
        require(bytes.length <= 16 * 1024);
        JsonNode boundary = readObject(bytes);
        closed(boundary, Set.of("version", "activationId", "epoch", "committedSequence", "lastRecordUuid"));
        require(number(boundary.get("version")) == 1 && previous.activationId().equals(id(boundary, "activationId"))
                && number(boundary.get("epoch")) == 1 && number(boundary.get("committedSequence")) == previousSequence
                && previousUuid.equals(text(boundary, "lastRecordUuid")));
        return new TerminalProof(previous, prefix, ref, previousSequence, previousUuid, previousCommitDigest,
                previousSequence + 1, transaction.lastRecordUuid());
    }

    public static JsonNode readObject(byte[] bytes) {
        return object(readJson(bytes));
    }

    static JsonNode readJson(byte[] bytes) {
        require(bytes != null && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            return JSON.readTree(text);
        } catch (IOException error) {
            throw invalid();
        }
    }

    static byte[] reference(JsonNode ref, String kind, Function<JsonNode, byte[]> resources) {
        closed(ref, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        id(ref, "resourceId");
        require(kind.equals(text(ref, "kind")) && number(ref.get("schemaVersion")) == 1);
        byte[] bytes = resources.apply(ref);
        require(bytes != null && bytes.length == number(ref.get("byteLength"))
                && sha256(bytes).equals(text(ref, "digest")));
        return bytes;
    }

    private static void key(JsonNode key, RuntimeProvisionRequest original) {
        closed(key, Set.of("tenantId", "workspaceId", "sessionId"));
        require(original.getScope().getTenantId().equals(text(key, "tenantId"))
                && original.getScope().getWorkspaceId().equals(text(key, "workspaceId"))
                && original.getIsolationKey().equals(text(key, "sessionId")));
    }

    private static void envelope(JsonNode record, RuntimeProvisionRequest original, String subtype, String parentUuid) {
        require("system".equals(text(record, "type")) && subtype.equals(text(record, "subtype"))
                && original.getIsolationKey().equals(text(record, "sessionId"))
                && original.getScope().getCanonicalCwd().equals(text(record, "cwd"))
                && (parentUuid == null ? record.path("parentUuid").isNull()
                        : parentUuid.equals(text(record, "parentUuid"))));
        uuid(text(record, "uuid"));
        try {
            Instant.parse(text(record, "timestamp"));
        } catch (java.time.DateTimeException error) {
            throw invalid();
        }
        text(record, "version");
    }

    private static JsonNode object(JsonNode node) {
        require(node != null && node.isObject());
        return node;
    }

    static void uuid(String value) {
        try {
            require(UUID.fromString(value).toString().equals(value));
        } catch (IllegalArgumentException error) {
            throw invalid();
        }
    }

    static void closed(JsonNode node, Set<String> fields) {
        object(node);
        require(node.size() == fields.size());
        node.fieldNames().forEachRemaining(field -> require(fields.contains(field)));
    }

    static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        require(value != null && value.isTextual() && !value.textValue().isEmpty()
                && value.textValue().length() <= 4096);
        return value.textValue();
    }

    static long number(JsonNode value) {
        require(value != null && value.isIntegralNumber() && value.canConvertToLong()
                && value.longValue() >= 0 && value.longValue() <= MAX_SAFE);
        return value.longValue();
    }

    static String id(JsonNode node, String field) {
        String value = text(node, field);
        byte[] utf8 = value.getBytes(StandardCharsets.UTF_8);
        require(utf8.length <= 512 && new String(utf8, StandardCharsets.UTF_8).equals(value)
                && java.text.Normalizer.isNormalized(value, java.text.Normalizer.Form.NFC)
                && value.codePoints().noneMatch(character -> character < 0x20 || character >= 0x7f && character <= 0x9f));
        return value;
    }

    private static long time(JsonNode node) {
        long value = number(node);
        require(value <= 8_640_000_000_000_000L);
        return value;
    }

    static String canonical(JsonNode node) {
        require(node != null);
        if (node.isObject()) {
            List<String> fields = new ArrayList<>();
            node.fieldNames().forEachRemaining(fields::add);
            fields.sort(String::compareTo);
            List<String> entries = new ArrayList<>();
            for (String field : fields) {
                entries.add(quote(field) + ":" + canonical(node.get(field)));
            }
            return "{" + String.join(",", entries) + "}";
        }
        if (node.isArray()) {
            List<String> entries = new ArrayList<>();
            node.forEach(child -> entries.add(canonical(child)));
            return "[" + String.join(",", entries) + "]";
        }
        if (node.isTextual()) {
            return quote(node.textValue());
        }
        if (node.isNumber()) {
            return canonicalNumber(node.doubleValue());
        }
        require(node.isNull() || node.isBoolean());
        return node.toString();
    }

    private static String canonicalNumber(double value) {
        require(Double.isFinite(value));
        if (value == 0) {
            return "0";
        }
        double magnitude = Math.abs(value);
        BigDecimal decimal = BigDecimal.valueOf(magnitude).stripTrailingZeros();
        // Java 21 may prefer two digits when one suffices; native JSON uses one.
        if (decimal.precision() == 2) {
            BigDecimal exact = new BigDecimal(magnitude);
            BigDecimal lower = exact.round(new MathContext(1, RoundingMode.FLOOR)).stripTrailingZeros();
            BigDecimal upper = exact.round(new MathContext(1, RoundingMode.CEILING)).stripTrailingZeros();
            boolean lowerMatches = lower.doubleValue() == magnitude;
            if (lowerMatches) {
                decimal = lower;
            }
            if (upper.doubleValue() == magnitude) {
                int distance = upper.subtract(exact).abs().compareTo(lower.subtract(exact).abs());
                if (!lowerMatches || distance < 0 || distance == 0 && !upper.unscaledValue().testBit(0)) {
                    decimal = upper;
                }
            }
        }
        int exponent = decimal.precision() - decimal.scale() - 1;
        String encoded;
        if (exponent >= -6 && exponent < 21) {
            encoded = decimal.toPlainString();
        } else {
            String digits = decimal.unscaledValue().toString();
            encoded = digits.substring(0, 1) + (digits.length() == 1 ? "" : "." + digits.substring(1))
                    + "e" + (exponent < 0 ? "" : "+") + exponent;
        }
        return value < 0 ? "-" + encoded : encoded;
    }

    private static String quote(String text) {
        StringBuilder result = new StringBuilder("\"");
        for (int index = 0; index < text.length(); index++) {
            char value = text.charAt(index);
            switch (value) {
                case '"', '\\' -> result.append('\\').append(value);
                case '\b' -> result.append("\\b");
                case '\f' -> result.append("\\f");
                case '\n' -> result.append("\\n");
                case '\r' -> result.append("\\r");
                case '\t' -> result.append("\\t");
                default -> {
                    if (value < 0x20 || Character.isSurrogate(value)
                            && !(Character.isHighSurrogate(value) && index + 1 < text.length()
                                    && Character.isLowSurrogate(text.charAt(index + 1)))
                            && !(Character.isLowSurrogate(value) && index > 0
                                    && Character.isHighSurrogate(text.charAt(index - 1)))) {
                        result.append("\\u");
                        for (int shift = 12; shift >= 0; shift -= 4) {
                            result.append(Character.forDigit((value >> shift) & 15, 16));
                        }
                    } else {
                        result.append(value);
                    }
                }
            }
        }
        return result.append('"').toString();
    }

    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw invalid();
        }
    }

    private static RuntimeBrokerException invalid() {
        return new RuntimeBrokerException(409, "csi_original_activation_unavailable",
                "The original CSI native activation proof is unavailable.", false);
    }
}
