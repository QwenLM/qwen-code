package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection.TaskProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelContext;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.Map;
import java.util.Optional;

public interface ManagedExtensionRecordStore {
    public com.fasterxml.jackson.databind.JsonNode currentMcpSettings(String tenant, String session);

    public static final String ERROR_MESSAGE_LINEAGE =
            "session_message_lineage_refused";

    public static final String ERROR_COMMAND_LINEAGE =
            "session_command_lineage_refused";

    public static final String ERROR_REJECTED =
            "managed_session_extension_record_rejected";

    public record TaskRow(String taskId, String kind,
            TaskProjection projection, String resourceId) {
    }

    public record TaskPage(List<TaskRow> tasks, boolean hasMore) {
    }

    public record TaskTarget(String domain, String recordId, String kind,
            String state, long revision, JsonNode body) {
    }

    public Optional<JsonNode> findRecord(String tenantId, String sessionId, String domain, String recordId);

    public List<JsonNode> listRecords(String tenantId, String sessionId,
            String domain);

    public Map<String, WebShellModelContext> findModelContexts(
            String tenantId, List<String> sessionIds);

    public Optional<JsonNode> latestHookRegistration(String tenantId, String sessionId);

    public Optional<TaskTarget> findTaskTarget(String tenantId,
            String sessionId, String taskId);

    public JsonNode readRecordResource(String tenantId, String sessionId,
            JsonNode ref);

    public StoredResource readCommittedResource(String tenantId, String sessionId,
            JsonNode ref);

    public TaskPage listTasks(String tenantId, String sessionId,
            Long beforeCreatedAt, String beforeTaskId, int limit);

    public Optional<TaskRow> findTask(String tenantId, String sessionId,
            String taskId);

    public record ChildTaskDetails(String sessionId, Boolean stopRequested, String approvalMode) { }

    public Long activeChildCount(String tenantId, String sessionId);

    public String childSessionId(String tenantId, String sessionId, TaskRow task);

    public ChildTaskDetails childTaskDetails(String tenantId, String sessionId, TaskRow task);

    public static JsonNode parse(String text) {
        try {
            JsonNode node = Codec.JSON.readTree(text);
            return node != null && node.isObject() && finite(node) ? node
                    : null;
        } catch (JsonProcessingException error) {
            return null;
        }
    }

    public static boolean finite(JsonNode node) {
        if (node.isNumber()) {
            return Double.isFinite(node.doubleValue());
        }
        for (JsonNode child : node) {
            if (!finite(child)) {
                return false;
            }
        }
        return true;
    }
    final class Codec {
        private static final ObjectMapper JSON =
                JsonMapper.builder(
                                JsonFactory.builder()
                                        .streamReadConstraints(
                                                StreamReadConstraints.builder()
                                                        .maxNestingDepth(
                                                                ManagedSessionStoreModels
                                                                        .MAX_JSON_DEPTH)
                                                        .build())
                                        .build())
                        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                        .build();

        private Codec() { }
    }
}
