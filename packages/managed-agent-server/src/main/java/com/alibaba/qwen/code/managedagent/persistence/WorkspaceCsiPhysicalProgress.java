package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.provisioning.CsiPodDeletion;
import com.alibaba.qwen.code.runtimebroker.transport.CsiNodeSourceJournal;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationJson.require;

/** Durable progress only. UNPUBLISHED is not a qualified physical release. */
final class WorkspaceCsiPhysicalProgress {
    static final int LIMIT = 16 * 1024 * 1024;
    static final int MAX_ATTEMPTS = 8;
    private static final Set<String> FIELDS = Set.of("format", "retirementId", "bindingId", "physicalKey", "stage",
            "planBase64", "planSha256", "intent", "attempts", "observations");
    private static final Set<String> EVIDENCE_FIELDS = Set.of("bytesBase64", "sequence", "hash");
    private static final Set<String> ATTEMPT_FIELDS = Set.of("ordinal", "namespace", "podName", "podUid", "resourceVersion",
            "requestBase64", "requestSha256", "statusCode", "responseBase64", "responseSha256");
    private final long version;
    private final byte[] bytes;
    private final ObjectNode value;

    private WorkspaceCsiPhysicalProgress(long version, byte[] bytes) {
        this.version = version;
        this.bytes = bytes.clone();
        this.value = (ObjectNode) WorkspaceCsiApplicationJson.object(bytes, LIMIT);
    }

    static WorkspaceCsiPhysicalProgress planned(byte[] plan) {
        var identity = WorkspaceCsiApplicationJson.object(plan, 64 * 1024);
        var value = new LinkedHashMap<String, Object>();
        value.put("format", "qwen-csi-physical-progress/1");
        for (String field : List.of("retirementId", "bindingId", "physicalKey")) {
            value.put(field, identity.path(field).textValue());
        }
        value.put("stage", "PLANNED");
        value.put("planBase64", encoded(plan));
        value.put("planSha256", hash(plan));
        value.put("intent", null);
        value.put("attempts", List.of());
        value.put("observations", List.of());
        return new WorkspaceCsiPhysicalProgress(1, WorkspaceCsiApplicationJson.encode(value));
    }

    static WorkspaceCsiPhysicalProgress restore(long version, byte[] bytes, String sha256, JsonNode expectedPlan,
            WorkspaceCsiNodeSourceStore.Association source) {
        require(bytes != null && hash(bytes).equals(sha256));
        var result = new WorkspaceCsiPhysicalProgress(version, bytes);
        WorkspaceCsiApplicationJson.closed(result.value, FIELDS);
        var value = result.value;
        require("qwen-csi-physical-progress/1".equals(value.path("format").textValue()));
        byte[] plan = WorkspaceCsiApplicationJson.base64(value.path("planBase64"), 64 * 1024);
        require(hash(plan).equals(value.path("planSha256").textValue())
                && Arrays.equals(plan, WorkspaceCsiApplicationJson.encode(expectedPlan)));
        for (String field : List.of("retirementId", "bindingId", "physicalKey")) {
            require(expectedPlan.path(field).isTextual() && expectedPlan.path(field).equals(value.path(field)));
        }
        require(value.path("attempts").isArray() && value.path("attempts").size() <= MAX_ATTEMPTS
                && value.path("observations").isArray() && value.path("observations").size() <= 2);
        long writes = 1;
        CsiNodeSourceJournal.Evidence previous = null;
        if (!value.path("intent").isNull()) {
            previous = evidence(value.path("intent"));
            var observed = WorkspaceCsiPhysicalSource.validate(source, result.retirementId(), result.planSha256(), previous);
            require("STOP_INTENT".equals(observed.state()));
            writes++;
        }
        Set<String> versions = new java.util.HashSet<>();
        for (int index = 0; index < value.path("attempts").size(); index++) {
            require(previous != null);
            JsonNode attempt = value.path("attempts").get(index);
            WorkspaceCsiApplicationJson.closed(attempt, ATTEMPT_FIELDS);
            require(attempt.path("ordinal").isIntegralNumber() && attempt.path("ordinal").longValue() == index + 1L);
            var request = request(attempt);
            require(expectedPlan.path("namespace").textValue().equals(request.namespace())
                    && expectedPlan.path("podName").textValue().equals(request.name())
                    && expectedPlan.path("podUid").textValue().equals(request.uid()) && versions.add(request.resourceVersion()));
            writes++;
            if (attempt.path("statusCode").isNull()) {
                require(attempt.path("responseBase64").isNull() && attempt.path("responseSha256").isNull());
            } else {
                require(attempt.path("statusCode").isIntegralNumber() && attempt.path("statusCode").canConvertToInt() && attempt.path("statusCode").intValue() >= 100
                        && attempt.path("statusCode").intValue() <= 599);
                byte[] response = response(attempt);
                require(hash(response).equals(attempt.path("responseSha256").textValue()));
                writes++;
            }
        }
        String state = previous == null ? "PLANNED" : "INTENT";
        for (JsonNode entry : value.path("observations")) {
            require(previous != null);
            var evidence = evidence(entry);
            evidence.requireExtends(previous);
            var observation = WorkspaceCsiPhysicalSource.validate(source, result.retirementId(), result.planSha256(), evidence);
            require("STOPPED".equals(observation.state()) && state.equals("INTENT")
                    || "UNPUBLISHED".equals(observation.state()) && List.of("INTENT", "STOPPED").contains(state));
            state = observation.state();
            previous = evidence;
            writes++;
        }
        require(state.equals(value.path("stage").textValue()) && version == writes);
        return result;
    }

    WorkspaceCsiPhysicalProgress withIntent(CsiNodeSourceJournal.Evidence evidence,
            WorkspaceCsiNodeSourceStore.Association source) {
        var observation = WorkspaceCsiPhysicalSource.validate(source, retirementId(), planSha256(), evidence);
        if (!value.path("intent").isNull()) {
            evidence.requireExtends(evidence(value.path("intent")));
            return this;
        }
        require("PLANNED".equals(stage()));
        var intent = prefix(evidence, observation.intent());
        require("STOP_INTENT".equals(WorkspaceCsiPhysicalSource.validate(source, retirementId(), planSha256(), intent).state()));
        var next = value.deepCopy();
        next.set("intent", evidenceJson(intent));
        next.put("stage", "INTENT");
        return next(next);
    }

    WorkspaceCsiPhysicalProgress withAttempt(CsiPodDeletion.Request request) {
        require(List.of("INTENT", "STOPPED").contains(stage()) && request != null);
        var plan = WorkspaceCsiApplicationJson.object(planBytes(), 64 * 1024);
        require(plan.path("namespace").textValue().equals(request.namespace()) && plan.path("podName").textValue().equals(request.name())
                && plan.path("podUid").textValue().equals(request.uid()));
        for (JsonNode attempt : value.path("attempts")) {
            if (request.resourceVersion().equals(attempt.path("resourceVersion").textValue())) {
                require(Arrays.equals(request.bytes(), request(attempt).bytes()));
                return this;
            }
        }
        require(value.path("attempts").size() < MAX_ATTEMPTS);
        var attempt = new LinkedHashMap<String, Object>();
        attempt.put("ordinal", value.path("attempts").size() + 1);
        attempt.put("namespace", request.namespace());
        attempt.put("podName", request.name());
        attempt.put("podUid", request.uid());
        attempt.put("resourceVersion", request.resourceVersion());
        attempt.put("requestBase64", encoded(request.bytes()));
        attempt.put("requestSha256", hash(request.bytes()));
        attempt.put("statusCode", null);
        attempt.put("responseBase64", null);
        attempt.put("responseSha256", null);
        var next = value.deepCopy();
        ((ArrayNode) next.path("attempts")).add(WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(attempt), 4096));
        return next(next);
    }

    WorkspaceCsiPhysicalProgress withReply(int ordinal, CsiPodDeletion.Result result) {
        require(result != null && ordinal > 0 && ordinal <= value.path("attempts").size());
        var previous = value.path("attempts").get(ordinal - 1);
        var request = request(previous);
        require(request.namespace().equals(result.request().namespace()) && request.name().equals(result.request().name())
                && Arrays.equals(request.bytes(), result.request().bytes()) && result.responseBytes().length <= 1024 * 1024);
        if (!previous.path("statusCode").isNull()) {
            require(previous.path("statusCode").intValue() == result.statusCode() && Arrays.equals(response(previous), result.responseBytes()));
            return this;
        }
        var next = value.deepCopy();
        var attempt = (ObjectNode) next.path("attempts").get(ordinal - 1);
        attempt.put("statusCode", result.statusCode());
        attempt.put("responseBase64", encoded(result.responseBytes()));
        attempt.put("responseSha256", hash(result.responseBytes()));
        return next(next);
    }

    WorkspaceCsiPhysicalProgress withObservation(CsiNodeSourceJournal.Evidence evidence,
            WorkspaceCsiNodeSourceStore.Association source) {
        require(!value.path("intent").isNull());
        var entries = value.path("observations");
        evidence.requireExtends(evidence(entries.isEmpty() ? value.path("intent") : entries.get(entries.size() - 1)));
        var observed = WorkspaceCsiPhysicalSource.validate(source, retirementId(), planSha256(), evidence);
        if (observed.state().equals(stage()) || "STOP_INTENT".equals(observed.state()) && "INTENT".equals(stage())) {
            return this;
        }
        require("STOPPED".equals(observed.state()) && "INTENT".equals(stage())
                || "UNPUBLISHED".equals(observed.state()) && List.of("INTENT", "STOPPED").contains(stage()));
        var next = value.deepCopy();
        ((ArrayNode) next.path("observations")).add(evidenceJson(evidence));
        next.put("stage", observed.state());
        return next(next);
    }

    long version() { return version; }
    byte[] bytes() { return bytes.clone(); }
    String sha256() { return hash(bytes); }
    String retirementId() { return value.path("retirementId").textValue(); }
    String bindingId() { return value.path("bindingId").textValue(); }
    String physicalKey() { return value.path("physicalKey").textValue(); }
    String stage() { return value.path("stage").textValue(); }
    String planSha256() { return value.path("planSha256").textValue(); }
    byte[] planBytes() { return WorkspaceCsiApplicationJson.base64(value.path("planBase64"), 64 * 1024); }
    int attempts() { return value.path("attempts").size(); }
    CsiPodDeletion.Request attempt(int ordinal) { return request(value.path("attempts").get(ordinal - 1)); }
    CsiNodeSourceJournal.Evidence latestEvidence() {
        var entries = value.path("observations");
        return entries.isEmpty() ? value.path("intent").isNull() ? null : evidence(value.path("intent"))
                : evidence(entries.get(entries.size() - 1));
    }

    private WorkspaceCsiPhysicalProgress next(ObjectNode next) {
        require(version < 32);
        return new WorkspaceCsiPhysicalProgress(version + 1, WorkspaceCsiApplicationJson.encode(next));
    }

    private static CsiPodDeletion.Request request(JsonNode value) {
        byte[] bytes = WorkspaceCsiApplicationJson.base64(value.path("requestBase64"), 4096);
        require(hash(bytes).equals(value.path("requestSha256").textValue()));
        return CsiPodDeletion.restore(value.path("namespace").textValue(), value.path("podName").textValue(),
                value.path("podUid").textValue(), value.path("resourceVersion").textValue(), bytes);
    }

    private static byte[] response(JsonNode value) {
        JsonNode encoded = value.path("responseBase64");
        require(encoded.isTextual() && encoded.textValue().length() <= (1024 * 1024 + 2L) / 3 * 4);
        byte[] bytes = Base64.getDecoder().decode(encoded.textValue());
        require(bytes.length <= 1024 * 1024 && encoded(bytes).equals(encoded.textValue()));
        return bytes;
    }

    private static CsiNodeSourceJournal.Evidence evidence(JsonNode value) {
        WorkspaceCsiApplicationJson.closed(value, EVIDENCE_FIELDS);
        require(value.path("sequence").isIntegralNumber() && value.path("sequence").canConvertToLong());
        byte[] bytes = WorkspaceCsiApplicationJson.base64(value.path("bytesBase64"), WorkspaceCsiNodeSourceStore.EVIDENCE_LIMIT);
        return CsiNodeSourceJournal.verify(bytes, new CsiNodeSourceJournal.Cursor(value.path("sequence").longValue(), value.path("hash").textValue()));
    }

    private static JsonNode evidenceJson(CsiNodeSourceJournal.Evidence evidence) {
        return WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(Map.of("bytesBase64", encoded(evidence.bytes()),
                "sequence", evidence.stream().head().sequence(), "hash", evidence.stream().head().hash())), LIMIT);
    }

    private static CsiNodeSourceJournal.Evidence prefix(CsiNodeSourceJournal.Evidence evidence, CsiNodeSourceJournal.Cursor cursor) {
        evidence.record(cursor);
        byte[] bytes = evidence.bytes();
        var input = ByteBuffer.wrap(bytes);
        for (long sequence = 1; sequence <= cursor.sequence(); sequence++) {
            int length = input.getInt();
            input.position(input.position() + length);
        }
        return CsiNodeSourceJournal.verify(Arrays.copyOf(bytes, input.position()), cursor);
    }

    private static String encoded(byte[] bytes) { return Base64.getEncoder().encodeToString(bytes); }
    private static String hash(byte[] bytes) { return CsiNativeActivationProof.sha256(bytes); }
}
