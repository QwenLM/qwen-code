package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

@Service
@Transactional(transactionManager = "managedAgentTransactionManager", readOnly = true, isolation = Isolation.REPEATABLE_READ)
public class ManagedSessionActivityService {
    private final ManagedAgentService sessions;
    private final ManagedExtensionRecordStore records;

    public ManagedSessionActivityService(ManagedAgentService sessions, ManagedExtensionRecordStore records) {
        this.sessions = sessions;
        this.records = records;
    }

    public JsonNode statistics(String tenant, String actor, String session) {
        sessions.requireReadableSession(tenant, actor, session);
        JsonNode statistics = records.findActivityStatistics(tenant, session);
        ObjectNode result = envelope(tenant, session, statistics);
        if (statistics == null || !"ready".equals(statistics.path("readiness").asText())) {
            result.putNull("statistics");
        } else {
            ObjectNode value = result.putObject("statistics");
            for (String field : List.of("tools", "files", "fileOperations", "skills", "skillLoads", "extensionCommands", "toolBuckets", "skillBuckets", "otherTools", "otherSkills")) {
                value.set(field, statistics.path(field));
            }
        }
        return result;
    }

    public JsonNode list(String tenant, String actor, String session, String kind, String cursor, int limit) {
        sessions.requireReadableSession(tenant, actor, session);
        String domain = switch (kind) {
            case "tools" -> ManagedActivityDiagnostics.TOOLS;
            case "files" -> ManagedActivityDiagnostics.FILES;
            case "skills" -> ManagedActivityDiagnostics.SKILLS;
            default -> throw new ManagedAgentException(400, "invalid_activity_kind", "Unknown activity kind.");
        };
        if (limit < 1 || limit > 100) {
            throw new ManagedAgentException(400, "invalid_limit", "Limit must be between 1 and 100.");
        }
        JsonNode statistics = records.findActivityStatistics(tenant, session);
        ObjectNode result = envelope(tenant, session, statistics).put("kind", kind);
        result.putArray("items");
        result.put("hasMore", false).putNull("nextCursor");
        String head = records.diagnosticCommittedSequence(tenant, session);
        if (statistics == null || !"ready".equals(statistics.path("readiness").asText()) || head == null) {
            return result;
        }
        String subject = DigestUtils.sha256Hex(JsonNodeFactory.instance.arrayNode().add("managed-activity/1")
                .add(tenant).add(actor).add(session).add(kind).toString().getBytes(StandardCharsets.UTF_8));
        Position position = position(subject, cursor, Long.parseLong(head));
        var page = records.listActivity(tenant, session, domain, position.upper(), position.time(), position.key(), limit);
        if (page.partial()) {
            result.put("availability", "partial");
            result.withArray("coverageReasons").add("page_budget_exhausted");
        }
        var items = result.putArray("items");
        for (JsonNode saved : page.items()) {
            ObjectNode item = saved.deepCopy();
            if (!saved.path("taskId").isNull()) {
                records.findTask(tenant, session, saved.path("taskId").asText()).ifPresent(task -> {
                    item.put("taskState", task.projection().state());
                    item.put("taskRuntimeState", task.projection().runtimeState());
                });
            }
            items.add(item);
        }
        result.put("hasMore", page.hasMore());
        if (page.hasMore()) {
            result.put("nextCursor", Base64.getUrlEncoder().withoutPadding().encodeToString(
                    (subject + ":" + position.upper() + ":" + page.lastTime() + ":" + page.lastKey()).getBytes(StandardCharsets.UTF_8)));
        }
        return result;
    }

    private ObjectNode envelope(String tenant, String session, JsonNode statistics) {
        boolean ready = statistics != null && "ready".equals(statistics.path("readiness").asText());
        ObjectNode result = JsonNodeFactory.instance.objectNode().put("schemaVersion", 1).put("sessionId", session)
                .put("scope", "self").put("availability", statistics == null ? "not_recorded"
                        : !ready || !statistics.path("coverageReasons").isEmpty() ? "partial" : "available");
        result.put("readRevision", records.diagnosticReadRevision(tenant, session));
        if (statistics == null) {
            result.putNull("coverageStartSequence").putNull("coveredThroughSequence").putNull("startedAt");
            result.putArray("coverageReasons").add("not_recorded");
        } else {
            result.set("coverageStartSequence", statistics.path("coverageStartSequence"));
            result.set("startedAt", statistics.path("startedAt"));
            if (ready) {
                result.put("coveredThroughSequence", records.diagnosticCommittedSequence(tenant, session));
            } else {
                result.set("coveredThroughSequence", statistics.path("rebuiltThroughSequence"));
            }
            result.set("coverageReasons", statistics.path("coverageReasons"));
        }
        return result;
    }

    private static Position position(String subject, String cursor, long head) {
        if (cursor == null || cursor.isEmpty()) {
            return new Position(head, null, null);
        }
        try {
            if (cursor.length() > 512) {
                throw new IllegalArgumentException();
            }
            String[] parts = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8).split(":", -1);
            if (parts.length != 4 || !subject.equals(parts[0]) || !parts[1].matches("[0-9]{1,19}")
                    || !parts[2].matches("[0-9]{1,16}") || !parts[3].matches("[0-9a-f]{64}")) {
                throw new IllegalArgumentException();
            }
            long upper = Long.parseLong(parts[1]);
            long time = Long.parseLong(parts[2]);
            if (upper < 0 || upper > head || time > 9_007_199_254_740_991L) {
                throw new IllegalArgumentException();
            }
            return new Position(upper, time, parts[3]);
        } catch (IllegalArgumentException error) {
            throw new ManagedAgentException(400, "invalid_cursor", "Activity cursor is invalid.");
        }
    }

    private record Position(long upper, Long time, String key) { }
}
