package com.alibaba.qwen.code.managedagent.store;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * H4b: the JDBC side of the child result relay — its V54 ledger plus the
 * small reads the worker needs (pending child-agent rows over the
 * delivery-pending index, launch bodies and envelopes from the Session
 * resource store, the child turn line, and the terminal result content).
 * The ledger's classifications (`orphaned`, `unknown`) are terminal: they
 * never represent consumption and never authorize re-execution, surviving
 * worker restarts by construction.
 */
@Repository
public class ChildResultRelayStore {
    /** One child run the delivery-pending index surfaced. */
    public record PendingChild(String tenantId, String parentSessionId,
            String childRunId, long revision, String deliveryState,
            String recordResourceId) {
    }

    /** One relay ledger row. */
    public record RelayRow(String tenantId, String parentSessionId,
            String childRunId, String creationKey, String childSessionId,
            String state, String claimedBy, long claimedUntil, int attempts,
            long nextRetryAt, String lastError, long createdAt,
            long updatedAt) {
    }

    /** The child Session's latest Turn line, as the relay reads it —
     * with the G3 dispatch pair on board: a Turn whose admission never
     * landed (no submission mark, no harness epoch) is a pre-admission
     * failure, never proof that a Runtime binding ever existed. */
    public record TurnLine(String turnId, String status, Long completedAt,
            String errorCode, boolean submissionAttempted,
            String harnessEventEpoch) {
        /** Whether this Turn proves a dispatch went out — the same pair
         * the G3 submission machinery guards with. */
        public boolean dispatched() {
            return submissionAttempted || harnessEventEpoch != null;
        }

        /** Whether this Turn is the terminal pre-admission failure: an
         * undispatched, terminally failed (or cancelled) admission. A
         * live enqueued ACCEPTED Turn shares `!dispatched()` with it —
         * only the terminal half may ever settle a never-started
         * verdict (R24's runnable-Turn guard). */
        public boolean preAdmissionTerminal() {
            return ("FAILED".equals(status) || "CANCELLED".equals(status))
                    && !dispatched();
        }
    }

    // delivery_state is null on the shell kind, and the relay drives only
    // the child_agent kind: a workflow child's execution belongs to the
    // workflow runtime, which does not exist yet (H4c registers the kind
    // disabled), so its rows never reach this page; the ledger join
    // drops every row whose classification is terminal (delivered,
    // orphaned or given up), because the bounded discovery set is for
    // work still owed — accumulated terminal rows would otherwise starve
    // the fleet-wide scan behind an ORDER BY created_at LIMIT. The
    // eligibility halves apply to both delivery arms: an unfiltered
    // accepted/consumed arm lets backed-off or foreign-leased rows squat
    // every slot of the bounded page, so a newer due launch is never
    // reached. A lease hides a row from other workers, never from its
    // claimant (claim() lets that owner continue immediately, and the
    // five-second heartbeat would otherwise wait out the thirty-second
    // lease). A record whose delivery already advanced (the consumer
    // raced ahead) owes its ledger the owed-work walk no matter which
    // intermediate state an interruption left it in — a watching or
    // delivering row owes mark_accepted/close/classify; a binding row
    // whose settle committed (and whose close_debt write then failed) is
    // owed exactly the same retention, so the arm admits every
    // non-terminal state. The cancelled arm is the same debt: the
    // FAILED/CANCELLED arm's fail commit moves delivery to `cancelled`
    // while the close admission may still be owed, and this page is the
    // only thing that can ever drive that admission again. `close_debt`
    // rides the same arm: the parent's settlement commits first so
    // quota never waits on a host's close capability, and the ledger
    // row keeps the retained close admission discoverable until a
    // capable scan discharges it.
    // Debts sort after every other due row: they accumulate one per
    // finished child where close is unavailable, and ahead of the page
    // they would keep a newer launch from ever being reached.
    private static final String PENDING_SQL =
            "SELECT r.tenant_id, r.session_id, r.record_id, r.revision,"
                    + " r.delivery_state, r.record_resource_id"
                    + " FROM qwen_managed_session_extension_record r"
                    + " LEFT JOIN qwen_managed_child_result_relay l"
                    + " ON l.parent_session_id = r.session_id"
                    + " AND l.child_run_id = r.record_id"
                    + " WHERE r.domain = 'child_run'"
                    + " AND r.task_kind = 'child_agent'"
                    + " AND ((r.delivery_state IN ('planned', 'accepting',"
                    + " 'unknown') AND (l.state IS NULL OR l.state NOT IN"
                    + " ('done', 'orphaned', 'unknown')))"
                    + " OR (r.delivery_state IN ('accepted', 'consumed',"
                    + " 'cancelled') AND l.state NOT IN ('done',"
                    + " 'orphaned', 'unknown')))"
                    + " AND (l.next_retry_at IS NULL OR l.next_retry_at <= ?)"
                    + " AND (l.claimed_until IS NULL OR l.claimed_until <="
                    + " ? OR l.claimed_by = ?)"
                    + " ORDER BY CASE WHEN l.state = 'close_debt' THEN 1"
                    + " ELSE 0 END, r.created_at, r.session_id, r.record_id"
                    + " LIMIT ?";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final JdbcTemplate jdbc;

    public ChildResultRelayStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<PendingChild> findPendingChildren(String workerId, int limit) {
        return findPendingChildren(workerId, System.currentTimeMillis(),
                limit);
    }

    /** The owed-work page for one worker: either arm, not terminal, not
     * parked ahead, never leased to another worker — the scanning worker's
     * own claim stays visible, so the heartbeat can fire on time. */
    public List<PendingChild> findPendingChildren(String workerId, long now,
            int limit) {
        return jdbc.query(PENDING_SQL, (result, row) -> new PendingChild(
                result.getString("tenant_id"), result.getString("session_id"),
                result.getString("record_id"), result.getLong("revision"),
                result.getString("delivery_state"),
                result.getString("record_resource_id")), now, now, workerId,
                limit);
    }

    /** The record's delivery state as committed NOW, for the worker that
     * claimed its ledger row: the discovery page's own captured value can
     * be wholesale older than a settlement committed between the page
     * and the claim — retirement authorization always reads it here. */
    public String deliveryState(String tenantId, String parentSessionId,
            String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT delivery_state FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("delivery_state"),
                tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The record's execution line as committed — the give-up's proof
     * of start. The `runtime_state` column is the Runtime projection
     * (`unbound`, `provisioning`, `ready`), never the execution enum, so
     * the proof reads the record's own body: the wire's transition
     * legality already says whether a dispatch ever attached (`intent →
     * dispatch_started → running_attached` only). A null answer means no
     * committed record row at all; a row whose body cannot prove its
     * line owes the caller a bounded retry, never a guessed verdict. */
    public String executionState(String tenantId, String parentSessionId,
            String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("record_resource_id"),
                tenantId, parentSessionId, childRunId);
        if (rows.isEmpty()) {
            return null;
        }
        String text = readResource(tenantId, rows.getFirst());
        JsonNode execution;
        try {
            execution = text == null ? null
                    : MAPPER.readTree(text).path("run").path("execution");
        } catch (Exception error) {
            throw new IllegalStateException("Child run " + childRunId
                    + "'s committed record is unreadable", error);
        }
        if (execution == null || !execution.isTextual()) {
            throw new IllegalStateException("Child run " + childRunId
                    + "'s committed record holds no execution line");
        }
        return execution.textValue();
    }

    /** One inline resource's bytes, or null when it is not inline-held. */
    public String readResource(String tenantId, String resourceId) {
        byte[] bytes = readResourceBytes(tenantId, resourceId);
        return bytes == null ? null
                : new String(bytes, StandardCharsets.UTF_8);
    }

    /** The same read, as the exact bytes a digest binds. */
    public byte[] readResourceBytes(String tenantId, String resourceId) {
        List<byte[]> rows = jdbc.query(
                "SELECT inline_bytes FROM qwen_managed_session_resource"
                        + " WHERE tenant_id = ? AND resource_id = ?"
                        + " AND storage_kind = 'MYSQL_INLINE'"
                        + " AND state = 'REFERENCED'",
                (result, row) -> result.getBytes("inline_bytes"), tenantId,
                resourceId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The newest settled Turn of a Session's own journal, with the
     * source of the input that started it. */
    public record SettledTurn(String turnId, String outcome, String source,
            long settledAt) {
    }

    /**
     * What a child Session's journal proves about the turns that decide its
     * result: how many messages it accepted still wait for the turn that
     * reads them, the input of every message it accepted, when it last
     * committed any event, and its newest settled API or message turn (null
     * while none settled). Other wake inputs — a Monitor's, an
     * automation's — neither hold nor decide.
     */
    public record JournalTurns(int pendingMessageInputs,
            Set<String> messageInputs, long lastActivityAt,
            SettledTurn lastSettled) {
    }

    /** The messages on one parent–child edge, as committed now:
     * `receivedToChild` names the input of each of the parent's messages
     * to this run its target already received. */
    public record EdgeMessages(int undelivered, int toChild,
            List<String> receivedToChild) {
    }

    private static final String MESSAGES_SQL =
            "SELECT delivery_state, record_resource_id"
                    + " FROM qwen_managed_session_extension_record"
                    + " WHERE tenant_id = ? AND session_id = ?"
                    + " AND domain = 'session_message'";

    // A child's own outbox entries still owing their handover, less those
    // the message relay gave up on: a child that can take no further
    // revision (a declined recovery) never lets the give-up's own sender
    // step land, so its ledger row past the bound — or classified — is the
    // only proof the entry will never move.
    private static final String CHILD_OUTBOX_OWED_SQL =
            "SELECT COUNT(*) FROM qwen_managed_session_extension_record r"
                    + " LEFT JOIN qwen_managed_session_message_relay l"
                    + " ON l.tenant_id = r.tenant_id"
                    + " AND l.sender_session_id = r.session_id"
                    + " AND l.message_id = r.record_id"
                    + " WHERE r.tenant_id = ? AND r.session_id = ?"
                    + " AND r.domain = 'session_message'"
                    + " AND r.delivery_state IN ('planned', 'accepting')"
                    + " AND (l.message_id IS NULL OR (l.state NOT IN"
                    + " ('done', 'orphaned', 'unknown') AND l.attempts < "
                    + SessionMessageRelayStore.MAX_ATTEMPTS + "))";

    /**
     * H4d-b: the messages on one parent–child edge. `undelivered` counts
     * those still owing their handover — the parent's to this run and every
     * one the child sent while it is active (a child's outbox entries all
     * go to its parent; a closed child's are orphaned by the message relay
     * and never move again); `toChild` counts every message the parent
     * sent this run, in any state, which the settlement names so the parent
     * can refuse it over a message opened after this read. An unreadable
     * body cannot prove which edge it is on and owes a retry.
     */
    public EdgeMessages edgeMessages(String tenantId, String parentSessionId,
            String childRunId, String childSessionId) {
        int undelivered = 0;
        int toChild = 0;
        List<String> received = new ArrayList<>();
        for (Map<String, Object> row : jdbc.queryForList(MESSAGES_SQL,
                tenantId, parentSessionId)) {
            JsonNode body = body(tenantId, row);
            if (!"outbound".equals(body.path("direction").asText())
                    || !"to_child".equals(body.path("route").asText())
                    || !childRunId.equals(body.path("childRunId").asText())) {
                continue;
            }
            toChild++;
            String state = (String) row.get("delivery_state");
            if (owesHandover(state)) {
                undelivered++;
            } else if (("accepted".equals(state) || "consumed".equals(state))
                    && body.path("inputId").isTextual()) {
                received.add(body.path("inputId").textValue());
            }
        }
        undelivered += childOutboxOwed(tenantId, childSessionId);
        return new EdgeMessages(undelivered, toChild, List.copyOf(received));
    }

    /** Whether an active child still owes its parent a handover: its
     * Session closes only after its own messages left (or were given up). */
    public boolean childOwesHandover(String tenantId, String childSessionId) {
        return childOutboxOwed(tenantId, childSessionId) > 0;
    }

    private int childOutboxOwed(String tenantId, String childSessionId) {
        if (!"ACTIVE".equals(sessionStatus(tenantId, childSessionId))) {
            return 0;
        }
        Integer owed = jdbc.queryForObject(CHILD_OUTBOX_OWED_SQL,
                Integer.class, tenantId, childSessionId);
        return owed == null ? 0 : owed;
    }

    /** Planned or being handed over: a receipt never reaches either. */
    private static boolean owesHandover(String deliveryState) {
        return "planned".equals(deliveryState)
                || "accepting".equals(deliveryState);
    }

    private JsonNode body(String tenantId, Map<String, Object> row) {
        JsonNode body = readTree(readResource(tenantId,
                (String) row.get("record_resource_id")));
        if (body == null) {
            throw new IllegalStateException(
                    "a session message body is not readable yet");
        }
        return body;
    }

    /** Whether a Session's journal holds any session message at all. */
    public boolean hasSessionMessages(String tenantId, String sessionId) {
        return !jdbc.query("SELECT record_key FROM"
                        + " qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'session_message' LIMIT 1",
                (result, row) -> result.getString("record_key"), tenantId,
                sessionId).isEmpty();
    }

    /**
     * H4d-b: the turns a child Session's own journal proves — the wake
     * turns that read its messages never become API Turns, so the journal
     * is their only record. A compacted journal cannot prove what it
     * dropped and answers by refusal, never by guess.
     */
    public JournalTurns journalTurns(String tenantId, String sessionId) {
        Set<String> pending = new HashSet<>();
        Set<String> messages = new HashSet<>();
        Map<String, String> sources = new HashMap<>();
        SettledTurn[] last = {null};
        long[] activity = {0};
        forEachJournalEvent(tenantId, sessionId, event -> {
            JsonNode payload = event.path("payload");
            String turnId = payload.path("turnId").asText(null);
            String kind = event.path("kind").asText();
            // Any event is activity: a long turn commits its model
            // attempts, tool steps and messages as it goes.
            activity[0] = Math.max(activity[0],
                    event.path("occurredAt").asLong(0));
            if ("input.accepted".equals(kind)) {
                String source = payload.path("source").asText(null);
                sources.put(turnId, source);
                if ("session_message".equals(source)) {
                    pending.add(turnId);
                    messages.add(turnId);
                }
            } else if ("turn.settled".equals(kind)) {
                pending.remove(turnId);
                String source = sources.get(turnId);
                if ("session_message".equals(source)
                        || "hosted-harness".equals(source)) {
                    last[0] = new SettledTurn(turnId,
                            payload.path("outcome").asText(null), source,
                            event.path("occurredAt").asLong(0));
                }
            }
        });
        return new JournalTurns(pending.size(), Set.copyOf(messages),
                activity[0], last[0]);
    }

    /** The joined text of the newest assistant message one journal Turn
     * committed, or null while it committed none. */
    public String journalTurnText(String tenantId, String sessionId,
            String turnId) {
        List<JsonNode> refs = new ArrayList<>();
        forEachJournalEvent(tenantId, sessionId, event -> {
            if ("message.committed".equals(event.path("kind").asText())
                    && "assistant".equals(event.path("payload").path("role")
                            .asText())) {
                refs.add(event.path("payload").path("contentRef"));
            }
        });
        for (int index = refs.size() - 1; index >= 0; index--) {
            byte[] bytes = readMessageBody(tenantId, refs.get(index));
            JsonNode record = bytes == null ? null
                    : readTree(new String(bytes, StandardCharsets.UTF_8));
            if (record == null) {
                throw new IllegalStateException("Session " + sessionId
                        + "'s assistant message is unreadable");
            }
            if (!turnId.equals(record.path("daemonPromptId").asText())) {
                continue;
            }
            // Text runs a thought separates join with a newline, the way the
            // API Turn's output_text parts do (terminalResultText).
            StringBuilder text = new StringBuilder();
            boolean separated = false;
            for (JsonNode part : record.path("message").path("parts")) {
                if (part.path("thought").asBoolean(false)) {
                    separated = !text.isEmpty();
                } else if (part.path("text").isTextual()
                        && !part.path("text").textValue().isEmpty()) {
                    if (separated) {
                        text.append('\n');
                        separated = false;
                    }
                    text.append(part.path("text").textValue());
                }
            }
            return text.isEmpty() ? null : text.toString();
        }
        return null;
    }

    /** The latest committed body of one child run, or null without one. */
    public JsonNode childRunBody(String tenantId, String parentSessionId,
            String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("record_resource_id"),
                tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null
                : readTree(readResource(tenantId, rows.getFirst()));
    }

    private void forEachJournalEvent(String tenantId, String sessionId,
            java.util.function.Consumer<JsonNode> visitor) {
        List<Long> heads = jdbc.query("SELECT compacted_through_revision"
                        + " FROM qwen_managed_session_journal_head"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> result.getLong(1), tenantId, sessionId);
        if (!heads.isEmpty() && heads.getFirst() != 0) {
            throw new IllegalStateException("Session " + sessionId
                    + "'s journal is compacted");
        }
        for (byte[] bytes : jdbc.query("SELECT record_bytes FROM"
                        + " qwen_managed_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " ORDER BY journal_revision",
                (result, row) -> result.getBytes(1), tenantId, sessionId)) {
            for (String line : new String(bytes, StandardCharsets.UTF_8)
                    .split("\n")) {
                JsonNode record = line.isBlank() ? null : readTree(line);
                if (record == null) {
                    throw new IllegalStateException("Session " + sessionId
                            + "'s journal is unreadable");
                }
                JsonNode event = record.path("managedSession");
                if (event.isObject()) {
                    visitor.accept(event);
                }
            }
        }
    }

    /** A message body, joined from its parts when it was published in
     * chunks; null while any part is not inline-held. */
    private byte[] readMessageBody(String tenantId, JsonNode ref) {
        byte[] bytes = readResourceBytes(tenantId,
                ref.path("resourceId").asText());
        if (bytes == null
                || !"managed-message-chunks".equals(ref.path("kind").asText())) {
            return bytes;
        }
        JsonNode chunks = readTree(new String(bytes, StandardCharsets.UTF_8));
        if (chunks == null) {
            return null;
        }
        ByteArrayOutputStream joined = new ByteArrayOutputStream();
        for (JsonNode part : chunks.path("parts")) {
            byte[] chunk = readResourceBytes(tenantId,
                    part.path("resourceId").asText());
            if (chunk == null) {
                return null;
            }
            joined.writeBytes(chunk);
        }
        return joined.toByteArray();
    }

    private static JsonNode readTree(String text) {
        if (text == null) {
            return null;
        }
        try {
            return MAPPER.readTree(text);
        } catch (Exception error) {
            return null;
        }
    }

    /** One non-terminal child run a closing Session still owns. */
    public record LiveScope(String childRunId, String recordResourceId) {
    }

    /**
     * The non-terminal child-agent runs of one Session, for the close
     * cascade: task projections say what is still alive; the bodies name
     * the child Sessions (null when creation never attached). Like the
     * relay's discovery page, the cascade acts on the child_agent kind
     * only until the workflow runtime exists.
     */
    public List<LiveScope> findLiveScopes(String tenantId,
            String parentSessionId) {
        return jdbc.query(
                "SELECT record_id, record_resource_id"
                        + " FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND delivery_state IS NOT NULL"
                        + " AND task_kind = 'child_agent'"
                        + " AND task_state NOT IN ('completed', 'failed',"
                        + " 'cancelled')"
                        + " ORDER BY created_at, record_id",
                (result, row) -> new LiveScope(
                        result.getString("record_id"),
                        result.getString("record_resource_id")),
                tenantId, parentSessionId);
    }

    /** Whether a Session currently holds the acceptance of one child run. */
    public boolean hasAcceptance(String tenantId, String sessionId,
            String childRunId) {
        return !jdbc.query(
                "SELECT record_key FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_acceptance'"
                        + " AND record_id = ?",
                (result, row) -> result.getString("record_key"), tenantId,
                sessionId, childRunId).isEmpty();
    }

    public String sessionStatus(String tenantId, String sessionId) {
        List<String> rows = jdbc.query(
                "SELECT status FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> result.getString("status"), tenantId,
                sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The child Session's newest Turn, or null while none exists. */
    public TurnLine latestTurn(String tenantId, String sessionId) {
        List<TurnLine> rows = jdbc.query(
                "SELECT turn_id, status, completed_at, error_code,"
                        + " submission_attempted, harness_event_epoch"
                        + " FROM managed_agent_turn"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " ORDER BY created_at DESC, turn_id DESC LIMIT 1",
                (result, row) -> new TurnLine(result.getString("turn_id"),
                        result.getString("status"),
                        (Long) result.getObject("completed_at"),
                        result.getString("error_code"),
                        result.getBoolean("submission_attempted"),
                        result.getString("harness_event_epoch")),
                tenantId, sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The terminal result content: the completed Turn's newest assistant
     * message's joined text, or null while none exists. */
    public String terminalResultText(String tenantId, String sessionId,
            String turnId) {
        List<String> items = jdbc.query(
                "SELECT i.item_id FROM managed_agent_item i"
                        + " WHERE i.tenant_id = ? AND i.session_id = ?"
                        + " AND i.turn_id = ? AND i.item_type = 'message'"
                        + " AND i.item_role = 'assistant'"
                        + " ORDER BY i.last_sequence DESC, i.item_id DESC"
                        + " LIMIT 1",
                (result, row) -> result.getString("item_id"), tenantId,
                sessionId, turnId);
        if (items.isEmpty()) {
            return null;
        }
        List<String> parts = jdbc.query(
                "SELECT part_text FROM managed_agent_item_part"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND item_id = ? AND part_type = 'output_text'"
                        + " ORDER BY last_sequence, part_id",
                (result, row) -> result.getString("part_text"), tenantId,
                sessionId, items.getFirst());
        return parts.isEmpty() ? null : String.join("\n", parts);
    }

    /** Insert-or-claim: returns the row this worker now owns, or null when
     * another live claim holds it. The creation key dedupes racing scans. */
    public RelayRow claim(String tenantId, String parentSessionId,
            String childRunId, String creationKey, String owner,
            long leaseUntil, long now) {
        RelayRow existing = find(tenantId, parentSessionId, childRunId);
        if (existing == null) {
            jdbc.update("INSERT IGNORE INTO qwen_managed_child_result_relay"
                            + " (tenant_id, parent_session_id, child_run_id,"
                            + " creation_key, child_session_id, state,"
                            + " claimed_by, claimed_until, attempts,"
                            + " next_retry_at, created_at, updated_at)"
                            + " VALUES (?, ?, ?, ?, NULL, 'creating', ?, ?,"
                            + " 0, ?, ?, ?)",
                    tenantId, parentSessionId, childRunId, creationKey, owner,
                    leaseUntil, now, now, now);
            existing = find(tenantId, parentSessionId, childRunId);
        }
        if (existing == null) {
            return null;
        }
        if (owner.equals(existing.claimedBy())
                || existing.claimedUntil() < now) {
            int claimed = jdbc.update(
                    "UPDATE qwen_managed_child_result_relay SET claimed_by = ?,"
                            + " claimed_until = ?, updated_at = ?"
                            + " WHERE tenant_id = ? AND parent_session_id = ?"
                            + " AND child_run_id = ? AND (claimed_by = ? OR"
                            + " claimed_until < ?)",
                    owner, leaseUntil, now, tenantId, parentSessionId,
                    childRunId, existing.claimedBy(), now);
            if (claimed == 1) {
                return find(tenantId, parentSessionId, childRunId);
            }
        }
        return null;
    }

    public RelayRow find(String tenantId, String parentSessionId,
            String childRunId) {
        List<RelayRow> rows = jdbc.query(
                "SELECT * FROM qwen_managed_child_result_relay"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ?",
                (result, row) -> new RelayRow(result.getString("tenant_id"),
                        result.getString("parent_session_id"),
                        result.getString("child_run_id"),
                        result.getString("creation_key"),
                        result.getString("child_session_id"),
                        result.getString("state"),
                        result.getString("claimed_by"),
                        result.getLong("claimed_until"),
                        result.getInt("attempts"),
                        result.getLong("next_retry_at"),
                        result.getString("last_error"),
                        result.getLong("created_at"),
                        result.getLong("updated_at")),
                tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /**
     * The child Session the committed lineage names for one run, whatever
     * any ledger row remembers: createChildSession stamps the child's own
     * row before the relay records its answer, so a window where both the
     * parent body and the ledger lack the id still identifies the child
     * here — the disproving evidence for `not_started_proven`.
     */
    public String findLineageChild(String tenantId, String parentSessionId,
            String childRunId) {
        List<String> rows = jdbc.query("SELECT session_id FROM"
                        + " managed_agent_session WHERE tenant_id = ?"
                        + " AND parent_session_id = ?"
                        + " AND parent_child_run_id = ?",
                (result, row) -> result.getString("session_id"), tenantId,
                parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** One held claim advances: state, optional child Session, and the
     * retry/backoff line, all flagged to the claiming worker. */
    public void advance(RelayRow row, String owner, String state,
            String childSessionId, long nextRetryAt, String lastError,
            long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET state = ?,"
                        + " child_session_id = ?, attempts = ?,"
                        + " next_retry_at = ?, last_error = ?,"
                        + " claimed_by = ?, claimed_until = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ? AND claimed_by = ?",
                state, childSessionId, Math.max(row.attempts(), 0),
                nextRetryAt, lastError, owner, leaseUntil, now,
                row.tenantId(), row.parentSessionId(), row.childRunId(),
                owner);
    }

    /** A still-running child is not a failed step: no attempt, just the
     * next look. */
    public void scheduleRetry(RelayRow row, String owner, long nextRetryAt,
            long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET"
                        + " next_retry_at = ?, claimed_until = ?,"
                        + " updated_at = ? WHERE tenant_id = ?"
                        + " AND parent_session_id = ? AND child_run_id = ?"
                        + " AND claimed_by = ?",
                nextRetryAt, leaseUntil, now, row.tenantId(),
                row.parentSessionId(), row.childRunId(), owner);
    }

    /** A failed step counts an attempt and reschedules with backoff. */
    public void defer(RelayRow row, String owner, long nextRetryAt,
            String lastError, long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET attempts = ?,"
                        + " next_retry_at = ?, last_error = ?,"
                        + " claimed_by = ?, claimed_until = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ? AND claimed_by = ?",
                row.attempts() + 1, nextRetryAt,
                lastError == null ? null
                        : lastError.substring(0,
                                Math.min(lastError.length(), 1024)),
                owner, leaseUntil, now, row.tenantId(), row.parentSessionId(),
                row.childRunId(), owner);
    }

    /** A Classification is terminal: no claim, no retry, no redelivery —
     * and only the claimant may write it. */
    public void classify(RelayRow row, String owner, String state,
            String lastError, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET state = ?,"
                        + " claimed_by = NULL, claimed_until = NULL,"
                        + " last_error = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ? AND claimed_by = ?",
                state,
                lastError == null ? null
                        : lastError.substring(0,
                                Math.min(lastError.length(), 1024)),
                now, row.tenantId(), row.parentSessionId(), row.childRunId(),
                owner);
    }
}
