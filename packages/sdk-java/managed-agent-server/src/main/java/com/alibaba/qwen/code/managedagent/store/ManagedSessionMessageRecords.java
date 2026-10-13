package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Set;
import java.util.function.BooleanSupplier;

/**
 * The {@code managed-session_message} body (H4d of #12827): one message
 * between a parent Session and one of its child Sessions, committed once in
 * each journal by that journal's own writer — the sender's
 * {@code outbound} outbox entry and the target's {@code inbound} receipt,
 * both keyed by the same {@code messageId}. The shared fixtures in
 * packages/core pin the validator, and managed-session-message-record.ts
 * there replays the same cases. H4d-b's runtime produces it: the managed
 * send_message and the session message relay.
 */
public final class ManagedSessionMessageRecords {
    /**
     * Bytes of stored content, within the durable inline bound. Legacy
     * send_message caps 65536 characters, so multi-byte text it admits may
     * exceed this; a producer bounds bytes before it commits.
     */
    public static final long MAX_CONTENT_BYTES = 64 * 1024;

    private static final Set<String> KEYS = Set.of("childRunId",
            "contentDigest", "contentRef", "direction", "inputId",
            "messageId", "route", "run", "senderSessionId",
            "targetSessionId");
    /** Every key but the run is fixed across revisions, except
     * targetSessionId and inputId, which are set once. */
    private static final List<String> FIXED = List.of("childRunId",
            "contentDigest", "contentRef", "direction", "messageId", "route",
            "senderSessionId");

    private ManagedSessionMessageRecords() {
    }

    /**
     * Checks the body of a managed-session_message domain record. Nothing
     * executes for a message: the send is an act completed by the commit
     * of its content, so the run is settled from its first revision and
     * only its session delivery moves. The outbound run names the sending
     * call; the inbound run, the receipt of an act, names nothing.
     */
    public static void requireMessage(JsonNode record) {
        ManagedExtensionRecords.closed(record, KEYS, "Session message");
        JsonNode run = record.get("run");
        ManagedExtensionRecords.requireRun(run);
        String direction = record.get("direction").textValue();
        require("outbound".equals(direction) || "inbound".equals(direction),
                "Session message direction must be outbound or inbound");
        String route = record.get("route").textValue();
        require("to_child".equals(route) || "to_parent".equals(route),
                "Session message route must be to_child or to_parent");
        require(run.get("definition").isNull()
                && run.get("effectId").isNull()
                && run.get("dispatchId").isNull()
                && run.get("deliveryId").isNull()
                && run.get("execution").isNull()
                && run.get("runtime").isNull(),
                "Session message run must be purely logical");
        require("settled".equals(run.get("state").textValue()),
                "Session message run must be settled");
        JsonNode delivery = run.get("delivery");
        // The run carries no deliveryId, so the delivery is a session one.
        require(!delivery.isNull(),
                "Session message delivery must be a session delivery");
        String state = delivery.get("state").textValue();
        ManagedExtensionRecords.id(record.get("messageId"), "messageId");
        ManagedExtensionRecords.id(record.get("childRunId"), "childRunId");
        String sender = ManagedExtensionRecords.id(
                record.get("senderSessionId"), "senderSessionId");
        String target = nullableId(record.get("targetSessionId"),
                "targetSessionId");
        String input = nullableId(record.get("inputId"), "inputId");
        JsonNode contentRef = record.get("contentRef");
        ManagedExtensionRecords.durableRef(contentRef, "contentRef");
        require(contentRef.get("byteLength").longValue() <= MAX_CONTENT_BYTES,
                "Session message content exceeds " + MAX_CONTENT_BYTES
                        + " bytes");
        ManagedExtensionRecords.digest(record.get("contentDigest"),
                "contentDigest");
        require(record.get("contentDigest").textValue().equals(
                contentRef.get("digest").textValue()),
                "Session message contentDigest must name the content's"
                        + " digest");
        require(!sender.equals(target),
                "Session message cannot address its own sender");
        if ("outbound".equals(direction)) {
            require(!run.get("executionCallId").isNull(),
                    "Outbound session message run must name its sending"
                            + " call");
            require(target != null || "planned".equals(state)
                    || "cancelled".equals(state),
                    "Outbound session message must fix its target once its"
                            + " delivery is claimed");
            require((input != null) == ("accepted".equals(state)
                    || "consumed".equals(state)),
                    "Outbound session message names its target's input"
                            + " exactly once accepted");
        } else {
            require(run.get("executionCallId").isNull(),
                    "Inbound session message run must name no call");
            require("accepted".equals(state) || "consumed".equals(state),
                    "Inbound session message delivery must be accepted or"
                            + " consumed");
            require(target != null && input != null,
                    "Inbound session message must name its target and its"
                            + " input");
        }
    }

    /**
     * Whether {@code record} may open a message chain: an outbox entry
     * still planned, or a receipt that opens accepted — never already
     * consumed.
     */
    public static boolean isMessageStart(JsonNode record) {
        return accepts(() -> {
            requireMessage(record);
            String opening = "outbound".equals(record.get("direction")
                    .textValue()) ? "planned" : "accepted";
            return opening.equals(record.at("/run/delivery/state")
                    .textValue());
        });
    }

    /**
     * Whether {@code next} may follow {@code previous}: the message, its
     * edge, its sender and its content never change, the target and the
     * input are set once, and the delivery takes one shared step at a
     * time. A receipt only moves from accepted to consumed, so a consumed
     * receipt can never be restated.
     */
    public static boolean isMessageSuccessor(JsonNode previous,
            JsonNode next) {
        return accepts(() -> {
            requireMessage(previous);
            requireMessage(next);
            for (String key : FIXED) {
                if (!ManagedExtensionRecords.same(previous.get(key),
                        next.get(key))) {
                    return false;
                }
            }
            for (String key : List.of("targetSessionId", "inputId")) {
                if (!previous.get(key).isNull()
                        && !ManagedExtensionRecords.same(previous.get(key),
                                next.get(key))) {
                    return false;
                }
            }
            if (!ManagedExtensionRecords.isRunSuccessor(previous.get("run"),
                    next.get("run"))) {
                return false;
            }
            if ("outbound".equals(previous.get("direction").textValue())) {
                return true;
            }
            if (!"accepted".equals(previous.at("/run/delivery/state")
                    .textValue())) {
                return false;
            }
            return "consumed".equals(next.at("/run/delivery/state")
                    .textValue())
                    || ManagedExtensionRecords.same(previous.get("run"),
                            next.get("run"));
        });
    }

    private static String nullableId(JsonNode node, String label) {
        return node.isNull() ? null : ManagedExtensionRecords.id(node, label);
    }

    private static boolean accepts(BooleanSupplier check) {
        try {
            return check.getAsBoolean();
        } catch (InvalidRecordException exception) {
            return false;
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new InvalidRecordException(message + ".");
        }
    }
}
