package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

@Component
public class HarnessEventProjector {
    private static final Pattern SAFE_ERROR_CODE = Pattern.compile(
            "^[A-Za-z0-9._:-]{1,128}$");

    public ProjectedEvent project(SourceEvent event, String turnId) {
        if ("turn_complete".equals(event.type())) {
            Map<String, Object> data = object(event.data());
            String stopReason = string(data.get("stopReason"));
            boolean cancelled = stopReason != null
                    && stopReason.toLowerCase().contains("cancel");
            String type = cancelled ? "turn.cancelled" : "turn.completed";
            String status = cancelled ? "CANCELLED" : "COMPLETED";
            return new ProjectedEvent(type,
                    stopReason == null ? Map.of()
                            : Map.of("stopReason", stopReason),
                    true, status, null, null);
        }
        if ("turn_error".equals(event.type())) {
            Map<String, Object> data = object(event.data());
            String sourceCode = string(data.get("code"));
            String code = sourceCode != null
                    && SAFE_ERROR_CODE.matcher(sourceCode).matches()
                            ? sourceCode : "hosted_harness_error";
            String message = "The Hosted Harness Turn failed.";
            return new ProjectedEvent("turn.failed", Map.of(
                    "code", code, "message", message),
                    true, "FAILED", code, message);
        }
        if (!"session_update".equals(event.type())) {
            return null;
        }
        Map<String, Object> data = object(event.data());
        Map<String, Object> update = object(data.get("update"));
        String kind = string(update.get("sessionUpdate"));
        if ("agent_message_chunk".equals(kind)) {
            return textEvent("item.output_text.delta", "output_text",
                    update, turnId);
        }
        if ("agent_thought_chunk".equals(kind)) {
            return textEvent("item.reasoning.delta", "reasoning",
                    update, turnId);
        }
        if ("tool_call".equals(kind)
                || "tool_call_update".equals(kind)) {
            return new ProjectedEvent("item.tool_call.updated",
                    safeToolData(update, turnId, event.id()), false, null,
                    null, null);
        }
        return null;
    }

    private static ProjectedEvent textEvent(String type, String partType,
            Map<String, Object> update, String turnId) {
        Map<String, Object> content = object(update.get("content"));
        String text = string(content.get("text"));
        if (text == null || text.isEmpty()) {
            return null;
        }
        return new ProjectedEvent(type, Map.of(
                "itemId", "item_" + turnId + "_assistant",
                "contentPartId", "part_" + turnId + "_" + partType,
                "text", text), false, null, null, null);
    }

    private static Map<String, Object> safeToolData(
            Map<String, Object> update, String turnId, Long sourceId) {
        Map<String, Object> safe = new LinkedHashMap<>();
        safe.put("kind", string(update.get("sessionUpdate")));
        copyScalar(update, safe, "toolCallId");
        copyScalar(update, safe, "callId");
        copyScalar(update, safe, "title");
        copyScalar(update, safe, "status");
        copyScalar(update, safe, "name");
        String callId = string(update.get("toolCallId"));
        if (callId == null) {
            callId = string(update.get("callId"));
        }
        String identity = callId == null
                ? turnId + ":source:" + sourceId : turnId + ":" + callId;
        safe.put("itemId", "item_tool_" + UUID.nameUUIDFromBytes(
                identity.getBytes(StandardCharsets.UTF_8)));
        return Map.copyOf(safe);
    }

    private static void copyScalar(Map<String, Object> source,
            Map<String, Object> target, String key) {
        Object value = source.get(key);
        if (value instanceof String || value instanceof Number
                || value instanceof Boolean) {
            target.put(key, value);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) {
        return value instanceof Map ? (Map<String, Object>) value : Map.of();
    }

    private static String string(Object value) {
        return value instanceof String ? (String) value : null;
    }
}
