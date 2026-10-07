package com.alibaba.qwen.code.managedagent.store;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

/**
 * The Item and content Part that an event changes, named as the Items
 * projection names them. Projection version 1 derives both from the event and
 * the event right before it, so they are fixed when the event is accepted.
 *
 * <p>Stored events and the V15 backfill use this rule as version 1. A
 * different rule needs a new projection version, not a change to this one.
 */
public final class EventIdentity {
    public static final int SCHEMA_VERSION = 1;
    public static final int PROJECTION_VERSION = 1;

    private EventIdentity() {
    }

    /**
     * Returns the identity of an event.
     *
     * @param previous the identity of the Session's event at
     *     {@code sequence - 1}, or null for the first event
     */
    public static Identity of(String type, String turnId, long sequence,
            Map<String, Object> data, Identity previous) {
        return switch (type) {
            case "turn.accepted" -> new Identity(type,
                    itemId(data, StoreModels.inputItemId(turnId)), null);
            case "item.output_text.delta", "item.reasoning.delta" ->
                    textIdentity(type, turnId, sequence, data, previous);
            case "item.tool_call.updated", "item.tool_result.updated" -> new Identity(type,
                    toolItemId(turnId, sequence, data), null);
            default -> new Identity(type, null, null);
        };
    }

    /** Whether the identity of an event of this type depends on the last. */
    public static boolean continuesPrevious(String type) {
        return "item.output_text.delta".equals(type)
                || "item.reasoning.delta".equals(type);
    }

    static String assistantItemId(String turnId) {
        return "item_" + turnId + "_assistant";
    }

    static String partType(String type) {
        return "item.reasoning.delta".equals(type) ? "reasoning"
                : "output_text";
    }

    static String textPartId(String turnId, String partType, long sequence) {
        return "part_" + turnId + "_" + partType + "_" + sequence;
    }

    static String toolItemId(String turnId, long sequence,
            Map<String, Object> data) {
        String itemId = string(data.get("itemId"));
        if (itemId != null) {
            return itemId;
        }
        String callId = string(data.get("toolCallId"));
        if (callId == null) {
            callId = string(data.get("callId"));
        }
        String identity = callId == null
                ? turnId + ":sequence:" + sequence
                : turnId + ":" + callId;
        return "item_tool_" + UUID.nameUUIDFromBytes(
                identity.getBytes(StandardCharsets.UTF_8));
    }

    // A text delta continues the Part of the delta right before it when both
    // belong to the same Item and Part type; the projection skips empty text.
    private static Identity textIdentity(String type, String turnId,
            long sequence, Map<String, Object> data, Identity previous) {
        String text = string(data.get("text"));
        if (text == null || text.isEmpty()) {
            return new Identity(type, null, null);
        }
        String itemId = itemId(data, assistantItemId(turnId));
        boolean continues = previous != null
                && type.equals(previous.type())
                && itemId.equals(previous.itemId())
                && previous.contentPartId() != null;
        return new Identity(type, itemId, continues
                ? previous.contentPartId()
                : textPartId(turnId, partType(type), sequence));
    }

    private static String itemId(Map<String, Object> data, String fallback) {
        String itemId = string(data.get("itemId"));
        return itemId == null ? fallback : itemId;
    }

    private static String string(Object value) {
        return value instanceof String ? (String) value : null;
    }

    public record Identity(String type, String itemId, String contentPartId) {
    }
}
