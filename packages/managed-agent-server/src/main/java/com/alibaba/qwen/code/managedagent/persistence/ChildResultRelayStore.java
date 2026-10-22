package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
            long updatedAt, long claimGeneration, String operationKind) {
        public RelayRow(String tenantId, String parentSessionId, String childRunId, String creationKey,
                String childSessionId, String state, String claimedBy, long claimedUntil, int attempts,
                long nextRetryAt, String lastError, long createdAt, long updatedAt) {
            this(tenantId, parentSessionId, childRunId, creationKey, childSessionId, state, claimedBy,
                    claimedUntil, attempts, nextRetryAt, lastError, createdAt, updatedAt, 0, "CHILD_SESSION_START");
        }
    }

    /** A child Session's Turn line (its latest, or its first), as the
     * relays read it —
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

    /**
     * The child Session kinds — the {@code task_kind} values the relay
     * discovery page and the close cascade both act on (#13803): one SQL
     * list, so a third kind joins both queries or neither.
     */
    private static final String CHILD_SESSION_KINDS_SQL =
            "('child_agent', 'workflow')";

    // delivery_state is null on the shell kind, and the relay drives the
    // two child Session kinds (`child_agent` and `workflow`, the latter
    // since the workflow runtime slice of #13803); the ledger join drops
    // every row whose classification is terminal (delivered, orphaned or
    // given up), because the bounded discovery set is for work still
    // owed — accumulated terminal rows would otherwise starve the
    // fleet-wide scan behind an ORDER BY gmt_create LIMIT. The
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
            "SELECT pending.tenant_id, pending.session_id, pending.record_id, pending.revision, pending.delivery_state, pending.record_resource_id FROM ("
                    + " SELECT r.tenant_id, r.session_id, r.record_id, r.revision, r.delivery_state, r.record_resource_id,"
                    + " 0 AS priority, r.gmt_create FROM ma_session_record r LEFT JOIN ma_operation l"
                    + " ON l.scope_key = r.session_scope_key AND l.operation_id = r.record_id"
                    + " AND l.operation_kind = 'CHILD_SESSION_START' WHERE r.domain = 'child_run'"
                    + " AND r.task_kind IN " + CHILD_SESSION_KINDS_SQL + " AND NOT EXISTS (SELECT 1 FROM ma_operation c WHERE c.scope_key = r.session_scope_key AND c.operation_id = r.record_id AND c.operation_kind = 'CHILD_SESSION_CLOSE') AND ((r.delivery_state IN ('planned', 'accepting', 'unknown') AND (l.state IS NULL OR l.state NOT IN ('done', 'orphaned', 'unknown'))) OR (r.delivery_state IN ('accepted', 'consumed', 'cancelled') AND l.state NOT IN ('done', 'orphaned', 'unknown'))) AND (l.available_at IS NULL OR l.available_at <= ?) AND (l.claim_until IS NULL OR l.claim_until <= ? OR l.claim_owner = ?) UNION ALL SELECT o.tenant_id, o.session_id, o.operation_id AS record_id, COALESCE(r.revision, 0) AS revision, COALESCE(r.delivery_state, 'accepted') AS delivery_state, r.record_resource_id, 1 AS priority, o.gmt_create FROM ma_operation o LEFT JOIN ma_session_record r ON r.session_scope_key = o.scope_key AND r.domain = 'child_run' AND r.record_id = o.operation_id WHERE o.operation_kind = 'CHILD_SESSION_CLOSE' AND o.state = 'close_debt' AND o.available_at <= ? AND (o.claim_until IS NULL OR o.claim_until <= ? OR o.claim_owner = ?) ) pending ORDER BY pending.priority, pending.gmt_create, pending.session_id, pending.record_id LIMIT ?";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    public ChildResultRelayStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
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
                now, now, workerId, limit);
    }

    /** The record's delivery state as committed NOW, for the worker that
     * claimed its ledger row: the discovery page's own captured value can
     * be wholesale older than a settlement committed between the page
     * and the claim — retirement authorization always reads it here. */
    public String deliveryState(String tenantId, String parentSessionId,
            String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT delivery_state FROM ma_session_record"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("delivery_state"),
                ManagedSessionStore.sessionScopeKey(tenantId, parentSessionId), tenantId, parentSessionId, childRunId);
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
                        + " ma_session_record"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("record_resource_id"),
                ManagedSessionStore.sessionScopeKey(tenantId, parentSessionId), tenantId, parentSessionId, childRunId);
        if (rows.isEmpty()) {
            return null;
        }
        String text = readResource(tenantId, parentSessionId, rows.getFirst());
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

    /** The run's stop request and whether its run line has ended, as
     * the latest committed body states them (H4f). */
    public record StopState(boolean stopRequested, boolean ended) {
    }

    /** The committed stop state of one child run, or null when no record
     * row exists; an unreadable body owes the caller a bounded retry. */
    public StopState stopState(String tenantId, String parentSessionId,
            String childRunId) {
        // A primary-key read: the relay walks this on every heartbeat.
        List<String> rows = jdbc.query(
                "SELECT record_resource_id FROM"
                        + " ma_session_record"
                        + " WHERE session_scope_key = ? AND record_key = ?"
                        + " AND tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("record_resource_id"),
                ManagedSessionStore.sessionScopeKey(tenantId,
                        parentSessionId),
                ManagedExtensionProjection.recordKey(parentSessionId,
                        "child_run", childRunId),
                tenantId, parentSessionId, childRunId);
        if (rows.isEmpty()) {
            return null;
        }
        String text = readResource(tenantId, parentSessionId, rows.getFirst());
        JsonNode body;
        try {
            body = text == null ? null : MAPPER.readTree(text);
        } catch (Exception error) {
            throw new IllegalStateException("Child run " + childRunId
                    + "'s committed record is unreadable", error);
        }
        if (body == null || !body.path("stopRequested").isBoolean()
                || !body.path("run").path("state").isTextual()) {
            throw new IllegalStateException("Child run " + childRunId
                    + "'s committed record holds no stop line");
        }
        return new StopState(body.path("stopRequested").booleanValue(),
                ManagedExtensionRecords.TERMINAL.contains(
                        body.path("run").path("state").textValue()));
    }

    /**
     * H4f: whether a cancel took effect on this Turn — the Turn moved to
     * CANCELLING and {@code turn.cancel.requested} was appended in the same
     * transaction. A cancel command admitted on a Turn that had already
     * ended appends nothing, so a natural end that raced ahead of the stop
     * is never read as the stop's outcome.
     */
    public boolean turnCancelRequested(String tenantId, String sessionId,
            String turnId) {
        return !jdbc.query("SELECT sequence_id FROM ma_public_event"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND stream_kind = 'SESSION' AND stream_id = X'' AND event_type = 'turn.cancel.requested'"
                        + " AND turn_id = ? LIMIT 1",
                (result, row) -> result.getLong("sequence_id"), tenantId,
                sessionId, turnId).isEmpty();
    }

    public String readResource(String tenantId, String sessionId, String resourceId) {
        byte[] bytes = readResourceBytes(tenantId, sessionId, resourceId);
        return bytes == null ? null : new String(bytes, StandardCharsets.UTF_8);
    }

    public byte[] readResourceBytes(String tenantId, String sessionId, String resourceId) {
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        return jdbc.query("SELECT inline_bytes FROM ma_resource WHERE resource_key = ? AND session_scope_key = ?"
                        + " AND tenant_id = ? AND session_id = ? AND resource_id = ? AND storage_kind = 'MYSQL_INLINE'"
                        + " AND state = 'REFERENCED' AND deletion_operation_key IS NULL",
                (row, index) -> row.getBytes(1), ManagedSchemaKeys.key(scope, resourceId), scope, tenantId, sessionId, resourceId)
                .stream().findFirst().orElse(null);
    }

    public String readResource(String tenantId, String resourceId) {
        byte[] bytes = readResourceBytes(tenantId, resourceId);
        return bytes == null ? null : new String(bytes, StandardCharsets.UTF_8);
    }

    public byte[] readResourceBytes(String tenantId, String resourceId) {
        List<byte[]> rows = jdbc.query("SELECT inline_bytes FROM ma_resource WHERE tenant_id = ? AND resource_id = ?"
                        + " AND storage_kind = 'MYSQL_INLINE' AND state = 'REFERENCED' AND deletion_operation_key IS NULL",
                (row, index) -> row.getBytes(1), tenantId, resourceId);
        if (rows.size() > 1) {
            throw new IllegalStateException("Resource identity requires its Session scope");
        }
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
                    + " FROM ma_session_record"
                    + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                    + " AND domain = 'session_message'";

    // A child's own outbox entries still owing their handover, less those
    // the message relay gave up on: a child that can take no further
    // revision (a declined recovery) never lets the give-up's own sender
    // step land, so its ledger row past the bound — or classified — is the
    // only proof the entry will never move.
    private static final String CHILD_OUTBOX_OWED_SQL =
            "SELECT COUNT(*) FROM ma_session_record r"
                    + " LEFT JOIN ma_delivery l"
                    + " ON l.delivery_kind = 'SESSION_MESSAGE' AND l.tenant_id = r.tenant_id"
                    + " AND l.source_scope_key = r.session_scope_key"
                    + " AND l.source_session_id = r.session_id"
                    + " AND l.delivery_id = r.record_id"
                    + " WHERE r.session_scope_key = ? AND r.tenant_id = ? AND r.session_id = ?"
                    + " AND r.domain = 'session_message'"
                    + " AND r.delivery_state IN ('planned', 'accepting')"
                    + " AND " + SessionMessageRelayStore.LEDGER_OWES_WORK;

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
        for (Map<String, Object> row : jdbc.query(MESSAGES_SQL, (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                ManagedSessionStore.sessionScopeKey(tenantId, parentSessionId), tenantId, parentSessionId)) {
            JsonNode body = body(tenantId, parentSessionId, row);
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
                Integer.class, ManagedSessionStore.sessionScopeKey(tenantId, childSessionId), tenantId, childSessionId);
        return owed == null ? 0 : owed;
    }

    /** Planned or being handed over: a receipt never reaches either. */
    private static boolean owesHandover(String deliveryState) {
        return "planned".equals(deliveryState)
                || "accepting".equals(deliveryState);
    }

    private JsonNode body(String tenantId, String sessionId, Map<String, Object> row) {
        JsonNode body = readTree(readResource(tenantId, sessionId,
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
                        + " ma_session_record"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND domain = 'session_message' LIMIT 1",
                (result, row) -> result.getString("record_key"), ManagedSessionStore.sessionScopeKey(tenantId, sessionId), tenantId,
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
            // attempts, tool steps and messages as it goes. A resident
            // Session's lease renewals are not: they would keep a blocked
            // child alive forever.
            if (!"activation.changed".equals(kind)) {
                activity[0] = Math.max(activity[0],
                        event.path("occurredAt").asLong(0));
            }
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
            byte[] bytes = readMessageBody(tenantId, sessionId, refs.get(index));
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
                        + " ma_session_record"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("record_resource_id"),
                ManagedSessionStore.sessionScopeKey(tenantId, parentSessionId), tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null
                : readTree(readResource(tenantId, parentSessionId, rows.getFirst()));
    }

    private void forEachJournalEvent(String tenantId, String sessionId,
            java.util.function.Consumer<JsonNode> visitor) {
        List<Long> heads = jdbc.query("SELECT compacted_through_revision"
                        + " FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'"
                        + " AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                (result, row) -> result.getLong(1), ManagedSchemaKeys.key(tenantId), ManagedSchemaKeys.key(sessionId), tenantId, sessionId);
        if (!heads.isEmpty() && heads.getFirst() != 0) {
            throw new IllegalStateException("Session " + sessionId
                    + "'s journal is compacted");
        }
        for (byte[] bytes : jdbc.query("SELECT record_bytes FROM"
                        + " ma_session_journal_tx"
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
    private byte[] readMessageBody(String tenantId, String sessionId, JsonNode ref) {
        byte[] bytes = readResourceBytes(tenantId, sessionId,
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
            byte[] chunk = readResourceBytes(tenantId, sessionId,
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
     * The non-terminal child runs of one Session, for the close cascade:
     * task projections say what is still alive; the bodies name the child
     * Sessions (null when creation never attached). Like the relay's
     * discovery page, the cascade acts on both child Session kinds
     * (`child_agent` and `workflow`, #13803).
     */
    public List<LiveScope> findLiveScopes(String tenantId,
            String parentSessionId) {
        return jdbc.query(
                "SELECT record_id, record_resource_id"
                        + " FROM ma_session_record"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND delivery_state IS NOT NULL"
                        + " AND task_kind IN " + CHILD_SESSION_KINDS_SQL
                        + " AND task_state NOT IN ('completed', 'failed',"
                        + " 'cancelled')"
                        + " ORDER BY gmt_create, record_id",
                (result, row) -> new LiveScope(
                        result.getString("record_id"),
                        result.getString("record_resource_id")),
                ManagedSessionStore.sessionScopeKey(tenantId, parentSessionId), tenantId, parentSessionId);
    }

    /** Whether a Session currently holds the acceptance of one child run. */
    public boolean hasAcceptance(String tenantId, String sessionId,
            String childRunId) {
        return !jdbc.query(
                "SELECT record_key FROM ma_session_record"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_acceptance'"
                        + " AND record_id = ?",
                (result, row) -> result.getString("record_key"), ManagedSessionStore.sessionScopeKey(tenantId, sessionId), tenantId,
                sessionId, childRunId).isEmpty();
    }

    public String sessionStatus(String tenantId, String sessionId) {
        List<String> rows = jdbc.query(
                "SELECT status FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> result.getString("status"), tenantId,
                sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The child Session's newest Turn, or null while none exists. */
    public TurnLine latestTurn(String tenantId, String sessionId) {
        return turnLine(tenantId, sessionId, "DESC");
    }

    /** H4d-b: the child Session's first Turn — the task its launch created
     * with it — or null while none exists. */
    public TurnLine firstTurn(String tenantId, String sessionId) {
        return turnLine(tenantId, sessionId, "ASC");
    }

    private TurnLine turnLine(String tenantId, String sessionId,
            String order) {
        List<TurnLine> rows = jdbc.query(
                "SELECT turn_id, status, completed_at, error_code,"
                        + " submission_attempted, harness_event_epoch"
                        + " FROM ma_turn"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " ORDER BY gmt_create " + order + ", turn_id "
                        + order + " LIMIT 1",
                (result, row) -> new TurnLine(result.getString("turn_id"),
                        result.getString("status"),
                        result.getObject("completed_at", Long.class),
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
        List<String> messages = jdbc.query(
                "SELECT i.parts_json, i.body_resource_key, r.inline_bytes, r.kind, r.schema_version, r.byte_length, r.sha256,"
                        + " r.state, r.deletion_operation_key FROM ma_message i LEFT JOIN ma_resource r"
                        + " ON r.resource_key = i.body_resource_key AND r.session_scope_key = ?"
                        + " AND r.tenant_id = i.tenant_id AND r.session_id = i.session_id"
                        + " WHERE i.tenant_id = ? AND i.session_id = ?"
                        + " AND i.turn_id = ? AND i.item_type = 'message'"
                        + " AND i.item_role = 'assistant'"
                        + " ORDER BY i.last_sequence DESC, i.item_id DESC LIMIT 1",
                (result, row) -> {
                    if (result.getString("body_resource_key") == null) {
                        return result.getString("parts_json");
                    }
                    byte[] bytes = result.getBytes("inline_bytes");
                    if (!"REFERENCED".equals(result.getString("state"))
                            || !"managed-message-parts".equals(result.getString("kind"))
                            || result.getInt("schema_version") != 1
                            || result.getString("deletion_operation_key") != null || bytes == null
                            || bytes.length != result.getLong("byte_length")
                            || !ToolPublicationContract.sha256(bytes).equals(result.getString("sha256"))) {
                        throw new IllegalStateException("Child message body resource is unavailable or corrupt");
                    }
                    return new String(bytes, StandardCharsets.UTF_8);
                }, ManagedSessionStore.sessionScopeKey(tenantId, sessionId), tenantId, sessionId, turnId);
        if (messages.isEmpty()) {
            return null;
        }
        try {
            JsonNode parts = MAPPER.readTree(messages.getFirst());
            if (!parts.isArray()) {
                throw new IllegalStateException("Message parts are not an ordered array");
            }
            List<JsonNode> text = new ArrayList<>();
            parts.forEach(part -> {
                if ("output_text".equals(part.path("type").asText())) {
                    text.add(part);
                }
            });
            text.sort(java.util.Comparator.comparingLong((JsonNode part) -> part.path("lastSequence").asLong())
                    .thenComparing(part -> part.path("partId").asText()));
            return text.isEmpty() ? null : String.join("\n", text.stream()
                    .map(part -> part.path("text").asText()).toList());
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Message parts are invalid", error);
        }
    }

    private static String scope(String tenant, String parent) {
        return ManagedSessionStore.sessionScopeKey(tenant, parent);
    }

    private static String operationKey(String kind, String tenant, String parent, String run) {
        return ManagedSchemaKeys.operationKey(OperationKind.valueOf(kind), scope(tenant, parent), ManagedSchemaKeys.key(run), run);
    }

    public RelayRow claim(String tenantId, String parentSessionId, String childRunId, String creationKey,
            String owner, long leaseUntil, long now) {
        String request = MAPPER.createObjectNode().put("version", 1).put("creationKey", creationKey).toString();
        jdbc.update("INSERT IGNORE INTO ma_operation (operation_key, session_scope_key, scope_key, operation_kind, operation_id,"
                        + " tenant_id, session_id, target_kind, target_key, request_digest, request_json, state, phase,"
                        + " gmt_create, gmt_modified) VALUES (?, ?, ?, 'CHILD_SESSION_START', ?, ?, ?, 'CHILD_RUN', ?, ?, ?,"
                        + " 'creating', 'STARTING', ?, ?)",
                operationKey("CHILD_SESSION_START", tenantId, parentSessionId, childRunId), scope(tenantId, parentSessionId), scope(tenantId, parentSessionId),
                childRunId, tenantId, parentSessionId, ManagedSchemaKeys.key(childRunId), ManagedSchemaKeys.key(request), request, now, now);
        RelayRow existing = find(tenantId, parentSessionId, childRunId);
        if (existing == null || !creationKey.equals(existing.creationKey())) {
            return null;
        }
        int claimed = jdbc.update("UPDATE ma_operation SET claim_owner = ?, claim_until = ?, claim_generation = claim_generation + 1, gmt_modified = ? WHERE operation_key = ? AND state NOT IN ('done', 'orphaned', 'unknown') AND (claim_owner = ? OR claim_until IS NULL OR claim_until < ?)",
                owner, leaseUntil, now,
                operationKey(existing.operationKind(), tenantId, parentSessionId, childRunId), owner, now);
        return claimed == 1 ? find(tenantId, parentSessionId, childRunId) : null;
    }

    public RelayRow find(String tenantId, String parentSessionId, String childRunId) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns() + ", claim_until AS claim_until_epoch FROM ma_operation WHERE scope_key = ? AND tenant_id = ? AND session_id = ? AND operation_id = ? AND operation_kind IN ('CHILD_SESSION_START', 'CHILD_SESSION_CLOSE') ORDER BY CASE WHEN operation_kind = 'CHILD_SESSION_CLOSE' THEN 0 ELSE 1 END LIMIT 1",
                (row, index) -> {
                    JsonNode request = readBody(row.getString("request_json"));
                    JsonNode result = readBody(row.getString("result_json"));
                    Long until = row.getObject("claim_until_epoch", Long.class);
                    String child = result.path("childSessionId").isTextual() ? result.path("childSessionId").asText() : null;
                    String error = result.path("lastError").isTextual() ? result.path("lastError").asText() : null;
                    return new RelayRow(row.getString("tenant_id"), row.getString("session_id"), row.getString("operation_id"),
                            request.path("creationKey").asText(), child, row.getString("state"), row.getString("claim_owner"),
                            until == null ? 0 : until, row.getInt("attempt_count"), row.getLong("available_at"),
                            error, row.getLong("gmt_create"), row.getLong("gmt_modified"), row.getLong("claim_generation"),
                            row.getString("operation_kind"));
                }, scope(tenantId, parentSessionId), tenantId, parentSessionId, childRunId).stream().findFirst().orElse(null);
    }

    private static JsonNode readBody(String value) {
        return value == null ? MAPPER.createObjectNode() : ManagedToolResultStore.parse(value);
    }

    private static String resultBody(String child, String error) {
        var body = MAPPER.createObjectNode().put("version", 1);
        if (child != null) {
            body.put("childSessionId", child);
        }
        if (error != null) {
            body.put("lastError", StringUtils.truncate(error, 1024));
        }
        return body.toString();
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
                        + " ma_session WHERE tenant_id = ?"
                        + " AND parent_session_id = ?"
                        + " AND parent_child_run_id = ?",
                (result, row) -> result.getString("session_id"), tenantId,
                parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public void advance(RelayRow row, String owner, String state, String childSessionId, long nextRetryAt,
            String lastError, long leaseUntil, long now) {
        if (!Set.of("creating", "binding", "watching", "delivering", "close_debt").contains(state)) {
            throw new IllegalArgumentException("Unknown child operation state " + state);
        }
        if ("close_debt".equals(state) && !"CHILD_SESSION_CLOSE".equals(row.operationKind())) {
            retainCloseDebt(row, owner, "done", childSessionId, nextRetryAt, lastError, leaseUntil, now);
            return;
        }
        jdbc.update("UPDATE ma_operation SET state = ?, result_json = ?, available_at = ?, claim_until = ?, gmt_modified = ? WHERE operation_key = ? AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                state, resultBody(childSessionId, lastError), nextRetryAt, leaseUntil, now,
                operationKey(row.operationKind(), row.tenantId(), row.parentSessionId(), row.childRunId()),
                owner, row.claimGeneration(), now);
    }

    /**
     * Retires the walk under its proven classification and parks the child close it still owes on
     * its own {@code CHILD_SESSION_CLOSE} row. The classification is the result's truth, never the
     * host's close capability: a run whose outcome was never witnessed stays {@code unknown} on
     * both the walk and its delivery row, exactly as when the close is admitted at once (#14165
     * FG10d found the debt arm writing {@code done}/{@code delivered} for such a run).
     */
    public void retainCloseDebt(RelayRow row, String owner, String classification, String childSessionId,
            long nextRetryAt, String lastError, long leaseUntil, long now) {
        if (!Set.of("done", "unknown").contains(classification)) {
            throw new IllegalArgumentException("Unknown close-debt classification " + classification);
        }
        if ("CHILD_SESSION_CLOSE".equals(row.operationKind())) {
            throw new IllegalArgumentException("A close-debt row cannot retain another close debt");
        }
        transactions.executeWithoutResult(status -> {
            int changed = jdbc.update("UPDATE ma_operation SET state = ?, claim_owner = NULL, claim_until = NULL, result_json = ?, gmt_modified = ? WHERE operation_key = ? AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                    classification, resultBody(childSessionId, lastError), now, operationKey(row.operationKind(),
                            row.tenantId(), row.parentSessionId(), row.childRunId()), owner, row.claimGeneration(), now);
            if (changed != 1) {
                return;
            }
            String request = MAPPER.createObjectNode().put("version", 1).put("creationKey", row.creationKey()).toString();
            jdbc.update("INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_kind, operation_id, tenant_id, session_id, target_kind, target_key, request_digest, request_json, result_json, state, phase, claim_owner, claim_generation, claim_until, available_at, gmt_create, gmt_modified) VALUES (?, ?, ?, 'CHILD_SESSION_CLOSE', ?, ?, ?, 'CHILD_RUN', ?, ?, ?, ?, 'close_debt', 'CLOSING', ?, 1, ?, ?, ?, ?)",
                    operationKey("CHILD_SESSION_CLOSE", row.tenantId(), row.parentSessionId(), row.childRunId()),
                    scope(row.tenantId(), row.parentSessionId()), scope(row.tenantId(), row.parentSessionId()), row.childRunId(), row.tenantId(), row.parentSessionId(),
                    ManagedSchemaKeys.key(row.childRunId()), ManagedSchemaKeys.key(request), request,
                    resultBody(childSessionId, lastError), owner, leaseUntil, nextRetryAt, now, now);
            recordDelivery(row, childSessionId, "done".equals(classification) ? "delivered" : classification, now);
        });
    }

    public void scheduleRetry(RelayRow row, String owner, long nextRetryAt, long leaseUntil, long now) {
        jdbc.update("UPDATE ma_operation SET available_at = ?, claim_until = ?, gmt_modified = ? WHERE operation_key = ? AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                nextRetryAt, leaseUntil, now, operationKey(row.operationKind(), row.tenantId(),
                        row.parentSessionId(), row.childRunId()), owner, row.claimGeneration(), now);
    }

    public void defer(RelayRow row, String owner, long nextRetryAt, String lastError, long leaseUntil, long now) {
        jdbc.update("UPDATE ma_operation SET attempt_count = ?, available_at = ?, result_json = ?, claim_until = ?, gmt_modified = ? WHERE operation_key = ? AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                row.attempts() + 1, nextRetryAt, resultBody(row.childSessionId(), lastError), leaseUntil, now,
                operationKey(row.operationKind(), row.tenantId(), row.parentSessionId(), row.childRunId()),
                owner, row.claimGeneration(), now);
    }

    public void classify(RelayRow row, String owner, String state, String lastError, long now) {
        if (!Set.of("done", "orphaned", "unknown").contains(state)) {
            throw new IllegalArgumentException("Unknown child result classification " + state);
        }
        transactions.executeWithoutResult(status -> {
            int changed = jdbc.update("UPDATE ma_operation SET state = ?, result_json = ?, claim_owner = NULL, claim_until = NULL, gmt_modified = ?, completed_at = ? WHERE operation_key = ? AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                    state, resultBody(row.childSessionId(), lastError), now, now,
                    operationKey(row.operationKind(), row.tenantId(), row.parentSessionId(), row.childRunId()),
                    owner, row.claimGeneration(), now);
            if (changed == 1 && !"CHILD_SESSION_CLOSE".equals(row.operationKind())) {
                recordDelivery(row, row.childSessionId(), "done".equals(state) ? "delivered" : state, now);
            }
        });
    }

    private void recordDelivery(RelayRow row, String child, String transport, long now) {
        String delivery = deliveryState(row.tenantId(), row.parentSessionId(), row.childRunId());
        String reception = Set.of("accepted", "consumed").contains(delivery == null ? "" : delivery) ? "accepted" : "pending";
        String consumption = "consumed".equals(delivery) ? "consumed" : "pending";
        String sourceScope = scope(row.tenantId(), row.parentSessionId());
        String key = ManagedSchemaKeys.key("delivery", "CHILD_RESULT", sourceScope, row.childRunId());
        jdbc.update("INSERT INTO ma_delivery (delivery_key, delivery_kind, tenant_id, source_scope_key, source_session_id,"
                        + " target_session_id, delivery_id, creation_key, payload_json, transport_state, reception_state,"
                        + " consumption_state, gmt_create, gmt_modified) VALUES (?, 'CHILD_RESULT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                        + " ON DUPLICATE KEY UPDATE transport_state = VALUES(transport_state),"
                        + " reception_state = VALUES(reception_state), consumption_state = VALUES(consumption_state),"
                        + " gmt_modified = VALUES(gmt_modified)",
                key, row.tenantId(), sourceScope, child == null ? row.parentSessionId() : child, row.parentSessionId(),
                row.childRunId(), row.creationKey(), resultBody(child, null), transport, reception, consumption, now, now);
    }
}
