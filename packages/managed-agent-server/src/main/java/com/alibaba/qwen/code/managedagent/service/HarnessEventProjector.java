package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.store.EventIdentity;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

@Component
public class HarnessEventProjector {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern SAFE_ERROR_CODE = Pattern.compile(
            "^[A-Za-z0-9._:-]{1,128}$");

    public ProjectedEvent project(SourceEvent event, String turnId) {
        return project(event, turnId, false);
    }

    public ProjectedEvent project(SourceEvent event, String turnId,
            boolean toolDetailsEnabled) {
        if ("turn_complete".equals(event.type())) {
            Map<String, Object> data = object(event.data());
            String stopReason = string(data.get("stopReason"));
            boolean cancelled = stopReason != null
                    && stopReason.toLowerCase(java.util.Locale.ROOT).contains("cancel");
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
            String message = switch (code) {
                case "hosted_turn_limit_exceeded" ->
                        "The Hosted Harness Turn reached its configured model round limit.";
                case "hosted_turn_deadline_exceeded" ->
                        "The Hosted Harness Turn exceeded its deadline.";
                default -> "The Hosted Harness Turn failed.";
            };
            return new ProjectedEvent("turn.failed", Map.of(
                    "code", code, "message", message),
                    true, "FAILED", code, message);
        }
        Map<String, Object> data = object(event.data());
        Map<String, Object> update = object(data.get("update"));
        String kind = string(update.get("sessionUpdate"));
        if (!"session_update".equals(event.type())
                && !("managed_journal_event".equals(event.type())
                        && "tool_call_update".equals(kind))) {
            return null;
        }
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
                    safeToolData(update, turnId, event.id(), toolDetailsEnabled), false, null,
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
            Map<String, Object> update, String turnId, Long sourceId,
            boolean toolDetailsEnabled) {
        Map<String, Object> safe = new LinkedHashMap<>();
        safe.put("kind", string(update.get("sessionUpdate")));
        copyScalar(update, safe, "toolCallId");
        copyScalar(update, safe, "callId");
        copyScalar(update, safe, "title");
        copyScalar(update, safe, "status");
        copyScalar(update, safe, "name");
        if (toolDetailsEnabled) {
            copyToolDetails(update, safe);
        }
        String callId = string(update.get("toolCallId"));
        if (callId == null) {
            callId = string(update.get("callId"));
        }
        // EventIdentity.toolCallItemId is the version-1 rule the stored
        // event and the published tool result share; only the no-id fallback
        // diverges, to a separator that no "turnId:callId" can spell.
        safe.put("itemId", callId == null
                ? "item_tool_" + UUID.nameUUIDFromBytes(
                        (turnId + "#source:" + sourceId)
                                .getBytes(StandardCharsets.UTF_8))
                : EventIdentity.toolCallItemId(turnId, callId));
        return Map.copyOf(safe);
    }

    private static void copyToolDetails(Map<String, Object> source,
            Map<String, Object> target) {
        String name = string(source.get("name"));
        if (!"read_file".equals(name) && !"run_shell_command".equals(name)) {
            return;
        }
        List<String> keys = "read_file".equals(name)
                ? List.of("file_path", "path", "offset", "limit")
                : List.of("command", "directory", "timeout");
        Map<String, Object> input = new LinkedHashMap<>();
        Map<String, Object> args = object(source.get("input"));
        for (String key : keys) {
            Object value = args.get(key);
            boolean numeric = List.of("timeout", "offset", "limit").contains(key);
            if (!numeric && value instanceof String || numeric && value instanceof Number number
                    && Double.isFinite(number.doubleValue())) {
                input.put(key, value);
            }
        }
        boolean truncated = Boolean.TRUE.equals(source.get("truncated"));
        if (!input.isEmpty()) {
            if (fitsJson(input, 4096)) {
                target.put("input", Map.copyOf(input));
            } else {
                truncated = true;
            }
        }
        if (source.get("output") instanceof String output) {
            if (fitsJson(output, 8192)) {
                target.put("output", output);
            } else {
                truncated = true;
            }
        }
        if (truncated) {
            target.put("truncated", true);
        }
    }

    private static boolean fitsJson(Object value, int limit) {
        try {
            return JSON.writeValueAsString(value).getBytes(StandardCharsets.UTF_8).length <= limit;
        } catch (JsonProcessingException error) {
            return false;
        }
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
