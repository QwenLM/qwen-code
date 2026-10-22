package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Set;
import java.util.function.BooleanSupplier;

/**
 * The {@code managed-session_command} body (H4e-b3 of #12827): one
 * command a member Session sends its leader, committed once in each
 * journal by that journal's own writer — the member's {@code outbound}
 * outbox entry and the lead's {@code inbound} receipt, both keyed by the
 * same {@code commandId}. The shared fixtures in packages/core pin the
 * validator, and managed-session-command-record.ts there replays the same
 * cases. H4e-b3's runtime produces it: the member board tools and the
 * session message relay's command pass.
 */
public final class ManagedSessionCommandRecords {
    /** Bytes of stored arguments, bound exactly like a message's content. */
    public static final long MAX_ARGS_BYTES = 64 * 1024;
    /** Bytes of the stored reply document, bound never refused. */
    public static final long MAX_REPLY_BYTES = 64 * 1024;

    private static final Set<String> KEYS = Set.of("argsDigest", "argsRef",
            "childRunId", "commandId", "direction", "kind", "replyDigest",
            "replyRef", "route", "run", "senderSessionId",
            "targetSessionId");
    /** Every key but the run is fixed across revisions, except
     * targetSessionId and the reply pair, which are set once. */
    private static final List<String> FIXED = List.of("argsDigest",
            "argsRef", "childRunId", "commandId", "direction", "kind",
            "route", "senderSessionId");
    private static final Set<String> KINDS = Set.of("board_read",
            "board_write", "member_message", "plan_submit");

    private ManagedSessionCommandRecords() {
    }

    /**
     * Checks the body of a managed-session_command domain record. Nothing
     * executes for a command record itself — the board act is the lead's —
     * so the run is settled from its first revision and only its session
     * delivery moves. The outbound run names the commanding call; the
     * inbound run, the receipt of an executed command, names nothing.
     */
    public static void requireCommand(JsonNode record) {
        ManagedExtensionRecords.closed(record, KEYS, "Session command");
        JsonNode run = record.get("run");
        ManagedExtensionRecords.requireRun(run);
        String direction = record.get("direction").textValue();
        require("outbound".equals(direction) || "inbound".equals(direction),
                "Session command direction must be outbound or inbound");
        require("to_parent".equals(record.get("route").textValue()),
                "Session command route must be to_parent");
        String kind = record.get("kind").textValue();
        require(KINDS.contains(kind),
                "Session command kind must be one of board_read,"
                        + " board_write, member_message, plan_submit");
        require(run.get("definition").isNull()
                && run.get("effectId").isNull()
                && run.get("dispatchId").isNull()
                && run.get("deliveryId").isNull()
                && run.get("execution").isNull()
                && run.get("runtime").isNull(),
                "Session command run must be purely logical");
        require("settled".equals(run.get("state").textValue()),
                "Session command run must be settled");
        JsonNode delivery = run.get("delivery");
        // The run carries no deliveryId, so the delivery is a session one.
        require(!delivery.isNull(),
                "Session command delivery must be a session delivery");
        String state = delivery.get("state").textValue();
        ManagedExtensionRecords.id(record.get("commandId"), "commandId");
        ManagedExtensionRecords.id(record.get("childRunId"), "childRunId");
        String sender = ManagedExtensionRecords.id(
                record.get("senderSessionId"), "senderSessionId");
        String target = nullableId(record.get("targetSessionId"),
                "targetSessionId");
        JsonNode argsRef = record.get("argsRef");
        ManagedExtensionRecords.durableRef(argsRef, "argsRef");
        require(argsRef.get("byteLength").longValue() <= MAX_ARGS_BYTES,
                "Session command arguments exceed " + MAX_ARGS_BYTES
                        + " bytes");
        ManagedExtensionRecords.digest(record.get("argsDigest"),
                "argsDigest");
        require(record.get("argsDigest").textValue().equals(
                argsRef.get("digest").textValue()),
                "Session command argsDigest must name the arguments'"
                        + " digest");
        JsonNode replyRef = record.get("replyRef");
        require((replyRef == null || replyRef.isNull())
                        == record.get("replyDigest").isNull(),
                "Session command names its reply as a pair, or not at all");
        if (replyRef != null && !replyRef.isNull()) {
            ManagedExtensionRecords.durableRef(replyRef, "replyRef");
            require(replyRef.get("byteLength").longValue()
                            <= MAX_REPLY_BYTES,
                    "Session command reply exceeds " + MAX_REPLY_BYTES
                            + " bytes");
            ManagedExtensionRecords.digest(record.get("replyDigest"),
                    "replyDigest");
            require(record.get("replyDigest").textValue().equals(
                    replyRef.get("digest").textValue()),
                    "Session command replyDigest must name the reply's"
                            + " digest");
        }
        require(target == null || !sender.equals(target),
                "Session command cannot address its own sender");
        boolean reply = replyRef != null && !replyRef.isNull();
        if ("outbound".equals(direction)) {
            require(!run.get("executionCallId").isNull(),
                    "Outbound session command run must name its commanding"
                            + " call");
            require(target != null || "planned".equals(state)
                    || "cancelled".equals(state),
                    "Outbound session command must fix its target once its"
                            + " delivery is claimed");
            require(reply == ("accepted".equals(state)
                    || "consumed".equals(state)),
                    "Outbound session command names its reply exactly once"
                            + " accepted");
        } else {
            require(!"board_read".equals(kind),
                    "Inbound session command is never a board read; reads"
                            + " commit nothing");
            require(run.get("executionCallId").isNull(),
                    "Inbound session command run must name no call");
            require("consumed".equals(state),
                    "Inbound session command opens consumed with its reply");
            require(target != null,
                    "Inbound session command must name its target");
            require(reply,
                    "Inbound session command opens with its reply");
        }
    }

    /**
     * Whether {@code record} may open a command chain: an outbox entry
     * still planned, or a receipt that opens consumed — the only inbound
     * state.
     */
    public static boolean isCommandStart(JsonNode record) {
        return accepts(() -> {
            requireCommand(record);
            String state = record.get("run").get("delivery").get("state")
                    .textValue();
            if ("outbound".equals(record.get("direction").textValue())) {
                return "planned".equals(state);
            }
            return "consumed".equals(state);
        });
    }

    /**
     * Whether {@code after} may follow {@code before}: the command, its
     * edge, its sender and its arguments never change, the target and the
     * reply pair are set once, and the delivery takes one shared step at
     * a time. A receipt opens consumed, so only an identical restatement
     * follows it.
     */
    public static boolean isCommandSuccessor(JsonNode before,
            JsonNode after) {
        return accepts(() -> {
            requireCommand(before);
            requireCommand(after);
            for (String key : FIXED) {
                if (!ManagedExtensionRecords.same(before.get(key),
                        after.get(key))) {
                    return false;
                }
            }
            if (!before.get("targetSessionId").isNull()
                    && !before.get("targetSessionId").equals(
                            after.get("targetSessionId"))) {
                return false;
            }
            if (!before.get("replyRef").isNull()
                    && !before.get("replyRef").equals(after.get("replyRef"))) {
                return false;
            }
            if (!before.get("replyDigest").isNull()
                    && !before.get("replyDigest").equals(
                            after.get("replyDigest"))) {
                return false;
            }
            if (!ManagedExtensionRecords.isRunSuccessor(before.get("run"),
                    after.get("run"))) {
                return false;
            }
            if ("outbound".equals(before.get("direction").textValue())) {
                return true;
            }
            return ManagedExtensionRecords.same(before.get("run"),
                    after.get("run"));
        });
    }

    private static boolean accepts(BooleanSupplier check) {
        try {
            return check.getAsBoolean();
        } catch (InvalidRecordException | NullPointerException
                | ClassCastException refused) {
            return false;
        }
    }

    private static String nullableId(JsonNode node, String label) {
        if (node == null || node.isNull()) {
            return null;
        }
        return ManagedExtensionRecords.id(node, label);
    }

    private static void require(boolean check, String message) {
        if (!check) {
            throw new InvalidRecordException(message);
        }
    }
}
