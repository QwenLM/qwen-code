package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * The four team record bodies (H4e of #12827): a team's roster and
 * lifecycle ({@code managed-team_state}), its board
 * ({@code managed-team_task}), its mailbox ({@code managed-team_message})
 * and its plan approvals ({@code managed-team_plan}), all held by the lead
 * Session. The shared fixtures in packages/core pin the validators, and
 * managed-team-record.ts there replays the same cases. The domains stay
 * disabled for submission until the slice that ships their producers.
 */
public final class ManagedTeamRecords {
    /** Legacy MAX_TEAMMATES; the lead is not a member. */
    public static final int MAX_MEMBERS = 10;
    public static final int MAX_NAME_LENGTH = 64;
    public static final int MAX_BLOCKERS = 64;
    /** Bytes of a description, a message, a plan or its feedback. */
    public static final long MAX_CONTENT_BYTES = 64 * 1024;
    /** Legacy MAX_METADATA_BYTES. */
    public static final long MAX_METADATA_BYTES = 32 * 1024;
    /** The name that stands for the lead wherever a record names a
     * participant. */
    public static final String LEADER = "leader";

    private static final Set<String> STATE_KEYS = Set.of("lifecycle",
            "leadSessionId", "members", "membershipRevision", "name", "run",
            "teamId");
    private static final Set<String> MEMBER_KEYS = Set.of("childRunId",
            "name", "planModeRequired");
    private static final Set<String> TASK_KEYS = Set.of("activeForm",
            "blockedBy", "descriptionRef", "metadataRef", "number", "owner",
            "run", "status", "subject", "taskId", "teamId");
    private static final Set<String> MESSAGE_KEYS = Set.of("contentDigest",
            "contentRef", "from", "inputId", "kind", "messageId", "run",
            "targetSessionId", "teamId", "to");
    private static final Set<String> PLAN_KEYS = Set.of("decision",
            "feedbackRef", "member", "planRef", "planRevision", "requestId",
            "run", "teamId");
    private static final List<String> STATE_FIXED = List.of("leadSessionId",
            "name", "teamId");
    private static final List<String> TASK_FIXED = List.of("number",
            "taskId", "teamId");
    /** Every message key but the run is fixed, except the two set once. */
    private static final List<String> MESSAGE_FIXED = List.of(
            "contentDigest", "contentRef", "from", "kind", "messageId",
            "teamId", "to");
    private static final List<String> PLAN_FIXED = List.of("member",
            "planRef", "planRevision", "requestId", "teamId");
    private static final List<String> LIFECYCLES = List.of("active",
            "closing", "deleted");
    private static final List<String> TASK_STATUSES = List.of("pending",
            "in_progress", "completed", "deleted");
    /** Who may send each kind: a member to the leader, or the reverse. */
    private static final List<String> TO_LEADER = List.of(
            "plan_approval_request", "shutdown_approved",
            "shutdown_rejected");
    private static final List<String> FROM_LEADER = List.of(
            "plan_approval_response", "shutdown_request");
    private static final List<String> MESSAGE_KINDS = List.of("message",
            "task_assignment", "plan_approval_request", "shutdown_approved",
            "shutdown_rejected", "plan_approval_response", "shutdown_request");
    private static final List<String> RUN_IDENTITIES = List.of("definition",
            "executionCallId", "effectId", "dispatchId", "deliveryId",
            "execution", "runtime", "delivery");
    /** Legacy sanitizeName output: dash-separated lowercase runs. */
    private static final Pattern NAME = Pattern.compile(
            "[a-z0-9]+(?:-[a-z0-9]+)*");
    /** The largest integer both validators read exactly. */
    private static final long MAX_COUNT = 9_007_199_254_740_990L;

    private ManagedTeamRecords() {
    }

    /**
     * Checks the body of a managed-team_state record: the append-only
     * roster and the lifecycle. The run is admitted while the team lives
     * and cancelled once it is deleted.
     */
    public static void requireState(JsonNode team) {
        ManagedExtensionRecords.closed(team, STATE_KEYS, "Team state");
        String lifecycle = oneOf(team.get("lifecycle"), LIFECYCLES,
                "Team lifecycle must be active, closing or deleted");
        String state = logicalRun(team.get("run"), "Team",
                List.of("admitted", "cancelled"));
        require("deleted".equals(lifecycle) == "cancelled".equals(state),
                "Team run must be cancelled exactly once the team is deleted");
        JsonNode members = team.get("members");
        require(members.isArray(), "Team members must be an array");
        require(members.size() <= MAX_MEMBERS,
                "Team members exceed " + MAX_MEMBERS + " entries");
        Set<String> names = new HashSet<>();
        Set<String> runs = new HashSet<>();
        for (JsonNode member : members) {
            ManagedExtensionRecords.closed(member, MEMBER_KEYS,
                    "Team member");
            String memberName = name(member.get("name"), "Team member name");
            require(!LEADER.equals(memberName),
                    "Team member cannot be named leader");
            String run = ManagedExtensionRecords.id(member.get("childRunId"),
                    "members.childRunId");
            require(member.get("planModeRequired").isBoolean(),
                    "members.planModeRequired must be boolean");
            names.add(memberName);
            runs.add(run);
        }
        require(names.size() == members.size()
                && runs.size() == members.size(),
                "Team members must have distinct names and child runs");
        long revision = ManagedExtensionRecords.count(
                team.get("membershipRevision"), 1, MAX_COUNT,
                "membershipRevision");
        require(revision == members.size() + 1L,
                "Team membershipRevision must be one more than its member"
                        + " count");
        ManagedExtensionRecords.id(team.get("teamId"), "teamId");
        name(team.get("name"), "Team name");
        ManagedExtensionRecords.id(team.get("leadSessionId"),
                "leadSessionId");
    }

    /** Whether {@code team} may open a team: active, with no members yet. */
    public static boolean isStateStart(JsonNode team) {
        return accepts(() -> {
            requireState(team);
            return "active".equals(team.get("lifecycle").textValue())
                    && team.get("members").isEmpty();
        });
    }

    /**
     * Whether {@code next} may follow {@code previous}: the team's identity
     * and lead never change, the lifecycle stays or takes one step, and an
     * active team that stays active may gain one member, appended. A
     * deleted team is frozen.
     */
    public static boolean isStateSuccessor(JsonNode previous, JsonNode next) {
        return accepts(() -> {
            requireState(previous);
            requireState(next);
            if (!fixed(previous, next, STATE_FIXED)
                    || !ManagedExtensionRecords.isRunSuccessor(
                            previous.get("run"), next.get("run"))) {
                return false;
            }
            String before = previous.get("lifecycle").textValue();
            String after = next.get("lifecycle").textValue();
            int from = LIFECYCLES.indexOf(before);
            int step = LIFECYCLES.indexOf(after);
            if (step != from && step != from + 1) {
                return false;
            }
            if (!prefix(previous.get("members"), next.get("members"))) {
                return false;
            }
            int joined = next.get("members").size()
                    - previous.get("members").size();
            return joined == 0 || (joined == 1 && "active".equals(before)
                    && "active".equals(after));
        });
    }

    /**
     * Checks the body of a managed-team_task record: one board item of the
     * Legacy task model. Its run is admitted until the task is deleted and
     * cancelled after.
     */
    public static void requireTask(JsonNode task) {
        ManagedExtensionRecords.closed(task, TASK_KEYS, "Team task");
        String status = oneOf(task.get("status"), TASK_STATUSES,
                "Team task status must be pending, in_progress, completed or"
                        + " deleted");
        String state = logicalRun(task.get("run"), "Team task",
                List.of("admitted", "cancelled"));
        require("deleted".equals(status) == "cancelled".equals(state),
                "Team task run must be cancelled exactly once the task is"
                        + " deleted");
        String taskId = ManagedExtensionRecords.id(task.get("taskId"),
                "taskId");
        JsonNode owner = task.get("owner");
        if (!owner.isNull()) {
            name(owner, "Team task owner");
        }
        require(!"in_progress".equals(status) || !owner.isNull(),
                "Team task in progress must have an owner");
        JsonNode blockedBy = task.get("blockedBy");
        require(blockedBy.isArray(), "Team task blockedBy must be an array");
        require(blockedBy.size() <= MAX_BLOCKERS,
                "Team task blockedBy exceeds " + MAX_BLOCKERS + " entries");
        Set<String> blockers = new HashSet<>();
        for (JsonNode blocker : blockedBy) {
            blockers.add(ManagedExtensionRecords.id(blocker, "blockedBy"));
        }
        require(blockers.size() == blockedBy.size()
                && !blockers.contains(taskId),
                "Team task blockedBy must name distinct other tasks");
        ManagedExtensionRecords.id(task.get("teamId"), "teamId");
        ManagedExtensionRecords.count(task.get("number"), 1, MAX_COUNT,
                "number");
        ManagedExtensionRecords.boundedText(task.get("subject"), "subject");
        ref(task.get("descriptionRef"), "descriptionRef", MAX_CONTENT_BYTES);
        if (!task.get("activeForm").isNull()) {
            ManagedExtensionRecords.boundedText(task.get("activeForm"),
                    "activeForm");
        }
        if (!task.get("metadataRef").isNull()) {
            ref(task.get("metadataRef"), "metadataRef", MAX_METADATA_BYTES);
        }
    }

    /** Whether {@code task} may open a task: any status but deleted. */
    public static boolean isTaskStart(JsonNode task) {
        return accepts(() -> {
            requireTask(task);
            return !"deleted".equals(task.get("status").textValue());
        });
    }

    /**
     * Whether {@code next} may follow {@code previous}: the task's identity
     * and number never change, its dependencies only grow, and every other
     * field moves freely until the task is deleted, which freezes it.
     */
    public static boolean isTaskSuccessor(JsonNode previous, JsonNode next) {
        return accepts(() -> {
            requireTask(previous);
            requireTask(next);
            if (!fixed(previous, next, TASK_FIXED)
                    || !ManagedExtensionRecords.isRunSuccessor(
                            previous.get("run"), next.get("run"))
                    || !prefix(previous.get("blockedBy"),
                            next.get("blockedBy"))) {
                return false;
            }
            return !"deleted".equals(previous.get("status").textValue())
                    || ManagedExtensionRecords.same(previous, next);
        });
    }

    /**
     * Checks the body of a managed-team_message record: one mailbox
     * message to one recipient, held as the lead's outbox entry. As with a
     * Session message, the send is an act completed by the commit, so the
     * run is settled from its first revision and only its session delivery
     * moves.
     */
    public static void requireMessage(JsonNode message) {
        ManagedExtensionRecords.closed(message, MESSAGE_KEYS,
                "Team message");
        String kind = oneOf(message.get("kind"), MESSAGE_KINDS,
                "Team message kind must be one of "
                        + String.join(", ", MESSAGE_KINDS));
        String from = name(message.get("from"), "Team message from");
        String to = name(message.get("to"), "Team message to");
        require(!from.equals(to), "Team message cannot address its own sender");
        require(!TO_LEADER.contains(kind)
                || (!LEADER.equals(from) && LEADER.equals(to)),
                "Team message of kind " + kind
                        + " must go from a member to the leader");
        require(!FROM_LEADER.contains(kind)
                || (LEADER.equals(from) && !LEADER.equals(to)),
                "Team message of kind " + kind
                        + " must go from the leader to a member");
        require(!"task_assignment".equals(kind) || !LEADER.equals(to),
                "Team message of kind task_assignment must go to a member");
        JsonNode run = message.get("run");
        ManagedExtensionRecords.requireRun(run);
        require(run.get("definition").isNull()
                && run.get("effectId").isNull()
                && run.get("dispatchId").isNull()
                && run.get("deliveryId").isNull()
                && run.get("execution").isNull()
                && run.get("runtime").isNull(),
                "Team message run must be purely logical");
        require("settled".equals(run.get("state").textValue()),
                "Team message run must be settled");
        require(!run.get("executionCallId").isNull(),
                "Team message run must name its sending call");
        JsonNode delivery = run.get("delivery");
        // The run carries no deliveryId, so the delivery is a session one.
        require(!delivery.isNull(),
                "Team message delivery must be a session delivery");
        String state = delivery.get("state").textValue();
        JsonNode contentRef = message.get("contentRef");
        ref(contentRef, "contentRef", MAX_CONTENT_BYTES);
        ManagedExtensionRecords.digest(message.get("contentDigest"),
                "contentDigest");
        require(message.get("contentDigest").textValue().equals(
                contentRef.get("digest").textValue()),
                "Team message contentDigest must name the content's digest");
        JsonNode target = message.get("targetSessionId");
        if (!target.isNull()) {
            ManagedExtensionRecords.id(target, "targetSessionId");
        }
        JsonNode input = message.get("inputId");
        if (!input.isNull()) {
            ManagedExtensionRecords.id(input, "inputId");
        }
        require(!target.isNull() || "planned".equals(state)
                || "cancelled".equals(state),
                "Team message must fix its target once its delivery is"
                        + " claimed");
        require(!input.isNull() == ("accepted".equals(state)
                || "consumed".equals(state)),
                "Team message names its target's input exactly once"
                        + " accepted");
        ManagedExtensionRecords.id(message.get("teamId"), "teamId");
        ManagedExtensionRecords.id(message.get("messageId"), "messageId");
    }

    /** Whether {@code message} may open a message: its delivery is still
     * planned. */
    public static boolean isMessageStart(JsonNode message) {
        return accepts(() -> {
            requireMessage(message);
            return "planned".equals(message.at("/run/delivery/state")
                    .textValue());
        });
    }

    /**
     * Whether {@code next} may follow {@code previous}: the message, its
     * parties and its content never change, the target and the input are
     * set once, and the delivery takes one shared step at a time.
     */
    public static boolean isMessageSuccessor(JsonNode previous,
            JsonNode next) {
        return accepts(() -> {
            requireMessage(previous);
            requireMessage(next);
            if (!fixed(previous, next, MESSAGE_FIXED)) {
                return false;
            }
            for (String key : List.of("targetSessionId", "inputId")) {
                if (!previous.get(key).isNull()
                        && !ManagedExtensionRecords.same(previous.get(key),
                                next.get(key))) {
                    return false;
                }
            }
            return ManagedExtensionRecords.isRunSuccessor(previous.get("run"),
                    next.get("run"));
        });
    }

    /**
     * Checks the body of a managed-team_plan record: one plan a member
     * submitted for the leader's approval. Its run waits for the decision,
     * settles with it, or is cancelled when the plan is withdrawn or
     * superseded.
     */
    public static void requirePlan(JsonNode plan) {
        ManagedExtensionRecords.closed(plan, PLAN_KEYS, "Team plan");
        String state = logicalRun(plan.get("run"), "Team plan",
                List.of("waiting", "settled", "cancelled"));
        String member = name(plan.get("member"), "Team plan member");
        require(!LEADER.equals(member),
                "Team plan member cannot be the leader");
        JsonNode decision = plan.get("decision");
        if (!decision.isNull()) {
            oneOf(decision, List.of("approved", "rejected"),
                    "Team plan decision must be approved or rejected");
        }
        require(!decision.isNull() == "settled".equals(state),
                "Team plan has a decision exactly once its run settled");
        JsonNode feedback = plan.get("feedbackRef");
        if (!feedback.isNull()) {
            ref(feedback, "feedbackRef", MAX_CONTENT_BYTES);
        }
        require(feedback.isNull() || !decision.isNull(),
                "Team plan feedback comes only with a decision");
        ManagedExtensionRecords.id(plan.get("teamId"), "teamId");
        ManagedExtensionRecords.id(plan.get("requestId"), "requestId");
        ManagedExtensionRecords.count(plan.get("planRevision"), 1, MAX_COUNT,
                "planRevision");
        ref(plan.get("planRef"), "planRef", MAX_CONTENT_BYTES);
    }

    /** Whether {@code plan} may open a plan request: it waits for its
     * decision. */
    public static boolean isPlanStart(JsonNode plan) {
        return accepts(() -> {
            requirePlan(plan);
            return "waiting".equals(plan.at("/run/state").textValue());
        });
    }

    /**
     * Whether {@code next} may follow {@code previous}: the request, its
     * member and its plan never change, and the run ends once, which fixes
     * the decision.
     */
    public static boolean isPlanSuccessor(JsonNode previous, JsonNode next) {
        return accepts(() -> {
            requirePlan(previous);
            requirePlan(next);
            return fixed(previous, next, PLAN_FIXED)
                    && ManagedExtensionRecords.isRunSuccessor(
                            previous.get("run"), next.get("run"))
                    && ("waiting".equals(previous.at("/run/state").textValue())
                            || ManagedExtensionRecords.same(previous, next));
        });
    }

    /**
     * A purely logical lifecycle in one of {@code states}: nothing runs for
     * a team record, so it pins no definition and names no physical
     * identity.
     */
    private static String logicalRun(JsonNode run, String label,
            List<String> states) {
        ManagedExtensionRecords.requireRun(run);
        for (String key : RUN_IDENTITIES) {
            require(run.get(key).isNull(), label + " run must be purely logical");
        }
        String state = run.get("state").textValue();
        require(states.contains(state),
                label + " run must be " + String.join(" or ", states));
        return state;
    }

    private static String name(JsonNode node, String label) {
        require(node.isTextual() && node.textValue().length() <= MAX_NAME_LENGTH
                && NAME.matcher(node.textValue()).matches(),
                label + " must be dash-separated lowercase letters and digits,"
                        + " at most " + MAX_NAME_LENGTH + " characters");
        return node.textValue();
    }

    private static void ref(JsonNode node, String label, long maxBytes) {
        ManagedExtensionRecords.durableRef(node, label);
        require(node.get("byteLength").longValue() <= maxBytes,
                label + " exceeds " + maxBytes + " bytes");
    }

    private static String oneOf(JsonNode node, List<String> allowed,
            String message) {
        require(node.isTextual() && allowed.contains(node.textValue()),
                message);
        return node.textValue();
    }

    private static boolean fixed(JsonNode previous, JsonNode next,
            List<String> keys) {
        for (String key : keys) {
            if (!ManagedExtensionRecords.same(previous.get(key),
                    next.get(key))) {
                return false;
            }
        }
        return true;
    }

    private static boolean prefix(JsonNode before, JsonNode after) {
        if (after.size() < before.size()) {
            return false;
        }
        for (int index = 0; index < before.size(); index++) {
            if (!ManagedExtensionRecords.same(before.get(index),
                    after.get(index))) {
                return false;
            }
        }
        return true;
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
