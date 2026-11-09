package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.closed;
import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.count;
import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.oneOf;

/** Source facts and the deterministic contribution reducer shared by SQL and recovery. */
public final class ManagedActivityDiagnostics {
    public static final String KIND = "managed-execution-diagnostics";
    public static final String PROJECTION_KIND = "managed-activity-projection";
    public static final String TOOLS = "hosted_tool_diagnostic";
    public static final String FILES = "hosted_file_diagnostic";
    public static final String SKILLS = "hosted_skill_diagnostic";
    public static final String LINKS = "hosted_tool_execution_link";
    public static final String STATS = "hosted_activity_statistics";
    public static final Set<String> DOMAINS = Set.of(TOOLS, FILES, SKILLS, LINKS, STATS);
    public static final List<String> ADMISSIONS = List.of("allowed", "denied", "invalid", "unknown");
    public static final List<String> EXECUTIONS = List.of("not_started", "running", "success", "error", "cancelled", "unknown");
    public static final List<String> DELIVERIES = List.of("pending", "complete", "partial", "unavailable", "unknown");
    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;
    private static final Set<String> FACT_FIELDS = Set.of("invocationId", "assistantMessageId", "ordinal", "toolName",
            "functionCallId", "providerCallId", "executionCallId", "taskId", "toolKind", "serverId", "admission",
            "execution", "delivery", "capture", "file", "skill");

    private ManagedActivityDiagnostics() { }

    public static String invocationId(String tenant, String session, String message, int ordinal) {
        return DigestUtils.sha256Hex(JSON.arrayNode().add("managed-tool-invocation/1").add(tenant).add(session)
                .add(message).add(ordinal).toString().getBytes(StandardCharsets.UTF_8));
    }

    public static String commitDigest(String original, JsonNode ref) {
        return DigestUtils.sha256Hex(JSON.arrayNode().add("managed-execution-commit/1").add(original)
                .add(ref.path("digest").asText()).toString().getBytes(StandardCharsets.UTF_8));
    }

    public static String carrierDigest(List<JsonNode> events) {
        if (events.size() == 1) {
            JsonNode payload = events.getFirst().path("payload");
            String kind = events.getFirst().path("kind").asText();
            require(List.of("message.committed", "tool.intent").contains(kind), "Invalid diagnostic carrier.");
            return commitDigest(payload.path("tool.intent".equals(kind) ? "argsRef" : "contentRef").path("digest").asText(), payload.path("diagnosticsRef"));
        }
        require(events.size() == 2 && "model.attempt".equals(events.getFirst().path("kind").asText())
                && "message.committed".equals(events.getLast().path("kind").asText()), "Invalid atomic diagnostic carrier.");
        JsonNode attempt = events.getFirst().path("payload");
        JsonNode message = events.getLast().path("payload");
        ArrayNode digest = JSON.arrayNode().add("managed-final-output/2").add(attempt.path("attemptId").asText());
        for (JsonNode ref : List.of(attempt.path("routeRef"), attempt.path("inputCheckpointRef"), attempt.path("usageRef"),
                message.path("contentRef"), message.path("diagnosticsRef"))) {
            if (ref.isNull()) {
                digest.addNull();
            } else {
                digest.add(JSON.arrayNode().add(ref.path("resourceId")).add(ref.path("kind"))
                        .add(ref.path("schemaVersion")).add(ref.path("byteLength")).add(ref.path("digest")));
            }
        }
        return DigestUtils.sha256Hex(digest.toString().getBytes(StandardCharsets.UTF_8));
    }

    public static void requireEvidence(JsonNode body) {
        closed(body, Set.of("schemaVersion", "reducerVersion", "epochId", "startEventId", "sourceEventId",
                "observations", "coverageReasons", "omittedObservationCount"), "execution diagnostics");
        count(body.get("schemaVersion"), 1, 1, "schemaVersion");
        count(body.get("reducerVersion"), 1, 1, "reducerVersion");
        for (String field : List.of("epochId", "startEventId", "sourceEventId")) {
            text(body.get(field), false);
        }
        require(body.path("observations").isArray() && body.path("coverageReasons").isArray()
                && body.path("coverageReasons").size() <= 16, "Invalid diagnostic arrays.");
        body.path("coverageReasons").forEach(value -> oneOf(value, List.of("observations_omitted", "file_path_unavailable", "history_before_collection"), "coverage reason"));
        count(body.get("omittedObservationCount"), 0, 9_007_199_254_740_991L, "omittedObservationCount");
        body.path("observations").forEach(ManagedActivityDiagnostics::requireFact);
        require(body.toString().getBytes(StandardCharsets.UTF_8).length <= 65_536, "Diagnostic evidence exceeds 64 KiB.");
    }

    public static void requireFact(JsonNode fact) {
        closed(fact, FACT_FIELDS, "invocation observation");
        require(fact.path("invocationId").asText().matches("[0-9a-f]{64}"), "Invalid invocation identity.");
        text(fact.get("assistantMessageId"), false);
        text(fact.get("toolName"), false);
        count(fact.get("ordinal"), 0, Integer.MAX_VALUE, "ordinal");
        for (String field : List.of("functionCallId", "providerCallId", "executionCallId", "taskId", "serverId")) {
            text(fact.get(field), true);
        }
        oneOf(fact.get("toolKind"), List.of("builtin", "mcp", "hosted", "unknown"), "toolKind");
        oneOf(fact.get("admission"), ADMISSIONS, "admission");
        oneOf(fact.get("execution"), EXECUTIONS, "execution");
        oneOf(fact.get("delivery"), DELIVERIES, "delivery");
        oneOf(fact.get("capture"), List.of("complete", "partial", "unavailable", "unknown"), "capture");
        JsonNode file = fact.get("file");
        if (!file.isNull()) {
            String tool = fact.path("toolName").asText();
            require("builtin".equals(fact.path("toolKind").asText()) && List.of("read_file", "write_file", "edit").contains(tool)
                    && ("read_file".equals(tool) ? "read" : "write_file".equals(tool) ? "write" : "edit").equals(file.path("operation").asText()),
                    "File observation does not belong to an explicit builtin tool.");
            closed(file, Set.of("operation", "path", "cwdRelative"), "file observation");
            oneOf(file.get("operation"), List.of("read", "write", "edit"), "operation");
            text(file.get("path"), true);
            text(file.get("cwdRelative"), true);
            for (String field : List.of("path", "cwdRelative")) {
                if (!file.get(field).isNull()) {
                    String path = file.get(field).asText();
                    require(!path.startsWith("/") && !path.contains("\\") && !path.contains("://")
                            && path.codePoints().noneMatch(code -> code < 32)
                            && !List.of(path.split("/", -1)).contains(".."), "Invalid diagnostic file path.");
                }
            }
        }
        JsonNode skill = fact.get("skill");
        if (!skill.isNull()) {
            require("hosted".equals(fact.path("toolKind").asText()) && "skill".equals(fact.path("toolName").asText()),
                    "Skill observation does not belong to the Skill resolver.");
            closed(skill, Set.of("resourceKind", "name", "pin", "origin", "delivery"), "skill observation");
            oneOf(skill.get("resourceKind"), List.of("skill", "extension_command"), "resourceKind");
            text(skill.get("name"), false);
            text(skill.get("pin"), false);
            oneOf(skill.get("origin"), List.of("user", "model", "unknown"), "origin");
            oneOf(skill.get("delivery"), List.of("complete", "partial", "unknown"), "skill delivery");
        }
    }

    public static ObjectNode request(String tenant, String session, String message, int ordinal, JsonNode call,
            long sequence, long at) {
        ObjectNode fact = JSON.objectNode().put("invocationId", invocationId(tenant, session, message, ordinal))
                .put("assistantMessageId", message).put("ordinal", ordinal).put("toolName", call.path("name").asText("unknown"))
                .put("toolKind", "unknown").put("admission", "unknown").put("execution", "unknown")
                .put("delivery", "pending").put("capture", "unknown");
        for (String field : List.of("functionCallId", "providerCallId", "executionCallId", "taskId", "serverId", "file", "skill")) {
            fact.putNull(field);
        }
        if (call.path("id").isTextual()) {
            fact.set("functionCallId", call.get("id"));
        }
        fact.put("requestSequence", Long.toString(sequence)).put("requestedAt", at);
        return fact;
    }

    public static ObjectNode merge(JsonNode before, JsonNode observation, boolean executorAuthority) {
        ObjectNode next = before.deepCopy();
        for (String field : List.of("invocationId", "assistantMessageId", "ordinal", "toolName", "functionCallId")) {
            require(before.path(field).equals(observation.path(field)), "Diagnostic invocation binding changed.");
        }
        for (String field : FACT_FIELDS) {
            if (List.of("invocationId", "assistantMessageId", "ordinal", "toolName", "functionCallId").contains(field)) {
                continue;
            }
            JsonNode value = observation.get(field);
            if (value == null || value.isNull() || List.of("toolKind", "admission", "execution", "delivery", "capture").contains(field)
                    && "unknown".equals(value.asText())) {
                continue;
            }
            if ("delivery".equals(field) && "pending".equals(value.asText())
                    && !List.of("pending", "unknown").contains(before.path(field).asText())) {
                continue;
            }
            if (List.of("file", "skill").contains(field) && before.path(field).isObject()) {
                ObjectNode resource = before.path(field).deepCopy();
                for (var properties = value.fields(); properties.hasNext();) {
                    var property = properties.next();
                    JsonNode old = resource.path(property.getKey());
                    JsonNode update = property.getValue();
                    boolean state = List.of("origin", "delivery").contains(property.getKey());
                    if (update.isNull() || state && "unknown".equals(update.asText())) {
                        continue;
                    }
                    if (!old.isMissingNode() && !old.isNull() && !(state && "unknown".equals(old.asText()))
                            && !old.equals(update) && !"delivery".equals(property.getKey())) {
                        next.put("conflictingEvidence", true);
                    } else {
                        resource.set(property.getKey(), update.deepCopy());
                    }
                }
                next.set(field, resource);
                continue;
            }
            if ("execution".equals(field) && List.of("success", "error", "cancelled").contains(before.path(field).asText())
                    && !before.path(field).equals(value) && !executorAuthority) {
                next.put("conflictingEvidence", true);
                continue;
            }
            next.set(field, value.deepCopy());
        }
        return next;
    }

    public static ObjectNode summary(JsonNode evidence, long sequence, long at) {
        ObjectNode result = JSON.objectNode().put("schemaVersion", 1).put("reducerVersion", 1)
                .put("epochId", evidence.path("epochId").asText()).put("startEventId", evidence.path("startEventId").asText())
                .put("coverageStartSequence", Long.toString(sequence)).put("startedAt", at).put("readiness", "ready")
                .put("lastEvidenceSequence", Long.toString(sequence));
        result.set("tools", metrics());
        result.set("files", metrics());
        ObjectNode operations = result.putObject("fileOperations");
        for (String operation : List.of("read", "write", "edit")) {
            operations.set(operation, metrics());
        }
        result.set("skills", metrics());
        result.set("skillLoads", metrics());
        result.set("extensionCommands", metrics());
        result.set("otherTools", metrics());
        result.set("otherSkills", metrics());
        result.putArray("toolBuckets");
        result.putArray("skillBuckets");
        result.putArray("coverageReasons");
        return result;
    }

    public static ObjectNode metrics() {
        ObjectNode result = JSON.objectNode().put("requested", 0);
        ObjectNode admission = result.putObject("admission");
        ADMISSIONS.forEach(value -> admission.put(value, 0));
        ObjectNode execution = result.putObject("execution");
        EXECUTIONS.forEach(value -> execution.put(value, 0));
        ObjectNode delivery = result.putObject("delivery");
        DELIVERIES.forEach(value -> delivery.put(value, 0));
        return result;
    }

    public static void contribute(ObjectNode summary, JsonNode before, JsonNode after) {
        if (before != null) {
            contribution(summary, before, -1);
        }
        contribution(summary, after, 1);
        if (after.path("conflictingEvidence").asBoolean()) {
            gap(summary, "conflicting_evidence");
        }
    }

    private static void contribution(ObjectNode summary, JsonNode fact, int delta) {
        add((ObjectNode) summary.path("tools"), fact, delta);
        if ("unknown".equals(fact.path("toolKind").asText())) {
            add((ObjectNode) summary.path("otherTools"), fact, delta);
        } else {
            String key = DigestUtils.sha256Hex(JSON.arrayNode().add(fact.path("toolKind")).add(fact.path("serverId"))
                    .add(fact.path("toolName")).toString().getBytes(StandardCharsets.UTF_8));
            String label = fact.path("toolKind").asText() + ": " + fact.path("toolName").asText();
            bucket(summary, "toolBuckets", "otherTools", key, label, fact, delta);
        }
        if (!fact.path("file").isNull()) {
            add((ObjectNode) summary.path("files"), fact, delta);
            add((ObjectNode) summary.path("fileOperations").path(fact.path("file").path("operation").asText()), fact, delta);
        }
        if (!fact.path("skill").isNull()) {
            add((ObjectNode) summary.path("skills"), fact, delta);
            JsonNode skill = fact.path("skill");
            add((ObjectNode) summary.path("skill".equals(skill.path("resourceKind").asText()) ? "skillLoads" : "extensionCommands"), fact, delta);
            String key = DigestUtils.sha256Hex(JSON.arrayNode().add(skill.path("resourceKind")).add(skill.path("name"))
                    .add(skill.path("pin")).toString().getBytes(StandardCharsets.UTF_8));
            bucket(summary, "skillBuckets", "otherSkills", key, skill.path("name").asText(), fact, delta);
        }
    }

    private static void bucket(ObjectNode summary, String field, String overflow, String key, String label, JsonNode fact, int delta) {
        ArrayNode buckets = (ArrayNode) summary.path(field);
        ObjectNode selected = null;
        for (JsonNode bucket : buckets) {
            if (key.equals(bucket.path("key").asText())) {
                selected = (ObjectNode) bucket;
                break;
            }
        }
        if (selected == null && !summary.path(field + "Closed").asBoolean() && buckets.size() < 64 && delta > 0
                && JSON.arrayNode().add(summary.path("toolBuckets")).add(summary.path("skillBuckets"))
                        .toString().getBytes(StandardCharsets.UTF_8).length < 40 * 1024) {
            selected = buckets.addObject().put("key", key).put("name", label.substring(0,
                    label.offsetByCodePoints(0, Math.min(128, label.codePointCount(0, label.length())))));
            selected.set("metrics", metrics());
            if ("skillBuckets".equals(field)) {
                selected.set("resource", skillIdentity(fact.path("skill")));
            }
        }
        if (selected == null && delta > 0) {
            summary.put(field + "Closed", true);
        }
        add(selected == null ? (ObjectNode) summary.path(overflow) : (ObjectNode) selected.path("metrics"), fact, delta);
    }

    public static ObjectNode skillIdentity(JsonNode resource) {
        return JSON.objectNode().put("resourceKind", resource.path("resourceKind").asText())
                .put("name", resource.path("name").asText()).put("pin", resource.path("pin").asText());
    }

    private static void add(ObjectNode metrics, JsonNode fact, int delta) {
        metrics.put("requested", Math.addExact(metrics.path("requested").longValue(), delta));
        for (String field : List.of("admission", "execution", "delivery")) {
            String state = fact.path(field).asText();
            ObjectNode counts = (ObjectNode) metrics.path(field);
            counts.put(state, Math.addExact(counts.path(state).longValue(), delta));
        }
    }

    public static void gap(ObjectNode summary, String reason) {
        ArrayNode reasons = (ArrayNode) summary.path("coverageReasons");
        for (JsonNode existing : reasons) {
            if (reason.equals(existing.asText())) {
                return;
            }
        }
        if (reasons.size() < 16) {
            reasons.add(reason);
        }
    }

    private static void text(JsonNode value, boolean nullable) {
        require(value != null && (nullable && value.isNull() || value.isTextual() && !value.asText().isEmpty()
                && value.asText().getBytes(StandardCharsets.UTF_8).length <= 4096
                && value.asText().codePoints().noneMatch(c -> c >= 0xd800 && c <= 0xdfff)), "Invalid diagnostic text.");
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new ManagedExtensionRecords.InvalidRecordException(message);
        }
    }
}
