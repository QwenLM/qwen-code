package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionAdmissionStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskRow;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.TaskTarget;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

@Service
public class ManagedAgentTraceService {
    private static final Pattern POSITION = Pattern.compile("([0-9]{1,16}):(task_[0-9a-f]{64})");
    private final ManagedAgentService sessions;
    private final ManagedExtensionRecordStore records;
    private final SessionAdmissionStore lineage;
    private final ObjectMapper json;

    public ManagedAgentTraceService(ManagedAgentService sessions, ManagedExtensionRecordStore records,
            SessionAdmissionStore lineage, @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.sessions = sessions;
        this.records = records;
        this.lineage = lineage;
        this.json = json;
    }

    @Transactional(transactionManager = "managedAgentTransactionManager", readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public JsonNode list(String tenant, String actor, String sessionId, String cursor, int limit) {
        sessions.requireReadableSession(tenant, actor, sessionId);
        if (limit < 1 || limit > 100) {
            throw new ManagedAgentException(400, "invalid_limit", "Limit must be between 1 and 100.");
        }
        String subject = subject(tenant, actor, sessionId);
        Position position = position(subject, cursor);
        var page = records.listChildTasks(tenant, sessionId, position.time(), position.taskId(), limit);
        ObjectNode result = json.createObjectNode().put("schemaVersion", 1).put("sessionId", sessionId)
                .put("readRevision", records.diagnosticReadRevision(tenant, sessionId))
                .put("availability", "available").put("scope", "direct-invocations");
        ArrayNode reasons = result.putArray("coverageReasons");
        ArrayNode items = result.putArray("items");
        for (TaskRow task : page.tasks()) {
            var projection = task.projection();
            ObjectNode item = items.addObject().put("taskId", task.taskId()).put("parentSessionId", sessionId)
                    .putNull("childSessionId").putNull("description").put("state", projection.state())
                    .put("runtimeState", projection.runtimeState()).put("createdAt", projection.createdAt());
            item.set("startedAt", json.valueToTree(projection.startedAt()));
            item.set("settledAt", json.valueToTree(projection.settledAt()));
            Optional<TaskTarget> target;
            try {
                target = records.findTaskTarget(tenant, sessionId, task.taskId());
            } catch (ManagedAgentException error) {
                if (error.getStatus() != 409) {
                    throw error;
                }
                reason(reasons, "invocation_unavailable");
                continue;
            } catch (InvalidRecordException error) {
                reason(reasons, "invocation_unavailable");
                continue;
            }
            if (target.isEmpty() || !"child_agent".equals(target.get().kind())) {
                reason(reasons, "invocation_unavailable");
                continue;
            }
            JsonNode body = target.get().body();
            String predecessor = body.path("predecessorChildRunId").isTextual() ? body.path("predecessorChildRunId").asText() : null;
            item.putNull("predecessorTaskId");
            if (predecessor != null && !predecessor.equals(target.get().recordId())) {
                String previousTask = com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection.taskId(
                        com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection.recordKey(sessionId, "child_run", predecessor));
                try {
                    var previous = records.findTaskTarget(tenant, sessionId, previousTask);
                    if (previous.isPresent() && "child_agent".equals(previous.get().kind())) {
                        item.put("predecessorTaskId", previousTask);
                    }
                } catch (ManagedAgentException error) {
                    if (error.getStatus() != 409) {
                        throw error;
                    }
                    reason(reasons, "predecessor_unavailable");
                } catch (InvalidRecordException error) {
                    reason(reasons, "predecessor_unavailable");
                }
            }
            description(tenant, sessionId, body, item, reasons);
            String child = body.path("childSessionId").isTextual() ? body.get("childSessionId").asText() : null;
            if (child == null) {
                continue;
            }
            try {
                sessions.requireReadableSession(tenant, actor, child);
                var relation = lineage.findChildLineage(tenant, child);
                if (relation != null && sessionId.equals(relation.parentSessionId())
                        && target.get().recordId().equals(relation.parentChildRunId())
                        && relation.depth() == body.path("depth").asInt(-1)) {
                    item.put("childSessionId", child);
                } else {
                    reason(reasons, "child_unavailable");
                }
            } catch (ManagedAgentException error) {
                if (error.getStatus() != 404) {
                    throw error;
                }
                reason(reasons, "child_unavailable");
            }
        }
        result.put("hasMore", page.hasMore());
        if (page.hasMore() && !page.tasks().isEmpty()) {
            TaskRow last = page.tasks().getLast();
            result.put("nextCursor", Base64.getUrlEncoder().withoutPadding().encodeToString(
                    (subject + ":" + last.projection().createdAt() + ":" + last.taskId()).getBytes(StandardCharsets.UTF_8)));
        } else {
            result.putNull("nextCursor");
        }
        if (!reasons.isEmpty()) {
            result.put("availability", "partial");
        }
        return result;
    }

    private void description(String tenant, String session, JsonNode body, ObjectNode item, ArrayNode reasons) {
        JsonNode ref = body.path("inputRef");
        if (!ref.isObject()) {
            return;
        }
        try {
            if (ref.path("byteLength").asLong(Long.MAX_VALUE) > 65536) {
                reason(reasons, "description_unavailable");
                return;
            }
            JsonNode input = records.readRecordResource(tenant, session, ref);
            JsonNode description = input.get("description");
            if (description != null && description.isTextual()) {
                if (description.textValue().getBytes(StandardCharsets.UTF_8).length <= 4096) {
                    item.put("description", description.textValue());
                } else {
                    reason(reasons, "description_unavailable");
                }
            }
        } catch (ManagedAgentException error) {
            if (error.getStatus() != 409) {
                throw error;
            }
            reason(reasons, "description_unavailable");
        } catch (InvalidRecordException error) {
            reason(reasons, "description_unavailable");
        }
    }

    private String subject(String tenant, String actor, String session) {
        try {
            return DigestUtils.sha256Hex(json.writeValueAsBytes(List.of("agent-trace/1", tenant, actor == null ? "" : actor, session)));
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Cannot encode trace subject", error);
        }
    }

    private static Position position(String subject, String cursor) {
        if (cursor == null || cursor.isEmpty()) {
            return new Position(null, null);
        }
        try {
            if (cursor.length() > 256) {
                throw new IllegalArgumentException();
            }
            String decoded = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
            if (!decoded.startsWith(subject + ":")) {
                throw new IllegalArgumentException();
            }
            var match = POSITION.matcher(decoded.substring(subject.length() + 1));
            if (!match.matches()) {
                throw new IllegalArgumentException();
            }
            long time = Long.parseLong(match.group(1));
            if (time > 9_007_199_254_740_991L) {
                throw new IllegalArgumentException();
            }
            return new Position(time, match.group(2));
        } catch (IllegalArgumentException error) {
            throw new ManagedAgentException(400, "invalid_cursor", "Agent trace cursor is invalid.");
        }
    }

    private static void reason(ArrayNode reasons, String value) {
        for (JsonNode reason : reasons) {
            if (value.equals(reason.asText())) {
                return;
            }
        }
        reasons.add(value);
    }

    private record Position(Long time, String taskId) { }
}
