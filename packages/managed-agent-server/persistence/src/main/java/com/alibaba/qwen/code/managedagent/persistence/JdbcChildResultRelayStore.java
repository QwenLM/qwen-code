package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.repository.ChildResultRelayStore;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRef;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.ConnectionCallback;
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
 * H4b: the JDBC side of the child result relay — its V54 ledger plus the small reads the worker
 * needs (pending child-agent rows over the delivery-pending index, launch bodies and envelopes from
 * the Session resource store, the child turn line, and the terminal result content). The ledger's
 * classifications (`orphaned`, `unknown`) are terminal: they never represent consumption and never
 * authorize re-execution, surviving worker restarts by construction.
 */
@Repository
public class JdbcChildResultRelayStore
        implements ChildResultRelayStore {
    /** One child run the delivery-pending index surfaced. */

    /** One relay ledger row. */

    /** A child Session's Turn line (its latest, or its first), as the
     * relays read it —
     * with the G3 dispatch pair on board: a Turn whose admission never
     * landed (no submission mark, no harness epoch) is a pre-admission
     * failure, never proof that a Runtime binding ever existed. */

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    private JdbcJournalPacks packs;

    public JdbcChildResultRelayStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setJournalPacks(JdbcJournalPacks packs) { this.packs = packs; }

    public List<PendingChild> findPendingChildren(String workerId, int limit) {
        return findPendingChildren(workerId, System.currentTimeMillis(),
                limit);
    }

    /** The owed-work page for one worker: either arm, not terminal, not
     * parked ahead, never leased to another worker — the scanning worker's
     * own claim stays visible, so the heartbeat can fire on time. */
    public List<PendingChild> findPendingChildren(String workerId, long now, int limit) {
        boolean h2 = Boolean.TRUE.equals(jdbc.execute((ConnectionCallback<Boolean>) connection ->
                "H2".equals(connection.getMetaData().getDatabaseProductName())));
        return jdbc.query(ChildResultRelayQueries.pendingSql(h2), (result, row) -> new PendingChild(
                result.getString("tenant_id"), result.getString("session_id"),
                result.getString("record_id"), result.getLong("revision"),
                result.getString("delivery_state"),
                result.getString("record_resource_id")), now, now, workerId, limit,
                now, now, workerId, limit, limit);
    }

    /** The record's delivery state as committed NOW, for the worker that
     * claimed its ledger row: the discovery page's own captured value can
     * be wholesale older than a settlement committed between the page
     * and the claim — retirement authorization always reads it here. */
    public String deliveryState(String tenantId, String parentSessionId, String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT delivery_state FROM ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("delivery_state"),
                tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The classification's read locks exactly the record row it mirrors:
     * a consumption commit that lands between this read and the mirror
     * write would otherwise leave the stale snapshot behind a row the
     * correction could not see yet. The parent's consuming revision
     * updates that same record row first, so the two commits serialize.
     * The lookup names the record's unique business key; matching only the
     * session scope would make MySQL lock every row the scan touches. */
    private String lockedDeliveryState(String tenantId, String parentSessionId, String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT delivery_state FROM ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?"
                        + " FOR UPDATE",
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
    public String executionState(String tenantId, String parentSessionId, String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT record_resource_id FROM"
                        + " ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("record_resource_id"),
                tenantId, parentSessionId, childRunId);
        if (rows.isEmpty()) {
            return null;
        }
        String text = readResource(tenantId, parentSessionId, rows.getFirst());
        JsonNode execution;
        try {
            execution = text == null ? null
                    : MAPPER.readTree(text).path("run").path("execution");
        } catch (java.io.IOException error) {
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

    /** The committed stop state of one child run, or null when no record
     * row exists; an unreadable body owes the caller a bounded retry. */
    public StopState stopState(String tenantId, String parentSessionId, String childRunId) {
        // A primary-key read: the relay walks this on every heartbeat.
        List<String> rows = jdbc.query(
                "SELECT record_resource_id FROM"
                        + " ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("record_resource_id"),
                tenantId, parentSessionId, childRunId);
        if (rows.isEmpty()) {
            return null;
        }
        String text = readResource(tenantId, parentSessionId, rows.getFirst());
        JsonNode body;
        try {
            body = text == null ? null : MAPPER.readTree(text);
        } catch (java.io.IOException error) {
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
    public boolean turnCancelRequested(String tenantId, String sessionId, String turnId) {
        return !jdbc.query("SELECT sequence_id FROM ma_public_event"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND stream_kind = 'SESSION' AND stream_id = '' AND event_type = 'turn.cancel.requested'"
                        + " AND turn_id = ? LIMIT 1",
                (result, row) -> result.getLong("sequence_id"), tenantId,
                sessionId, turnId).isEmpty();
    }

    public String readResource(String tenantId, String sessionId, String resourceId) {
        byte[] bytes = readResourceBytes(tenantId, sessionId, resourceId);
        return bytes == null ? null : new String(bytes, StandardCharsets.UTF_8);
    }

    public byte[] readResourceBytes(String tenantId, String sessionId, String resourceId) {
        return jdbc.query("SELECT inline_bytes FROM ma_resource WHERE"
                        + " tenant_id = ? AND session_id = ? AND resource_id = ? AND storage_kind = 'MYSQL_INLINE'"
                        + " AND state = 'REFERENCED' AND deletion_operation_ref IS NULL",
                (row, index) -> row.getBytes(1), tenantId, sessionId, resourceId)
                .stream().findFirst().orElse(null);
    }

    public String readResource(String tenantId, String resourceId) {
        byte[] bytes = readResourceBytes(tenantId, resourceId);
        return bytes == null ? null : new String(bytes, StandardCharsets.UTF_8);
    }

    public byte[] readResourceBytes(String tenantId, String resourceId) {
        List<byte[]> rows = jdbc.query("SELECT inline_bytes FROM ma_resource WHERE tenant_id = ? AND resource_id = ?"
                        + " AND storage_kind = 'MYSQL_INLINE' AND state = 'REFERENCED' AND deletion_operation_ref IS NULL",
                (row, index) -> row.getBytes(1), tenantId, resourceId);
        if (rows.size() > 1) {
            throw new IllegalStateException("Resource identity requires its Session scope");
        }
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The newest settled Turn of a Session's own journal, with the
     * source of the input that started it. */

    /**
     * What a child Session's journal proves about the turns that decide its
     * result: how many messages it accepted still wait for the turn that
     * reads them, the input of every message it accepted, when it last
     * committed any event, and its newest settled API or message turn (null
     * while none settled). Other wake inputs — a Monitor's, an
     * automation's — neither hold nor decide.
     */

    /** The messages on one parent–child edge, as committed now:
     * `receivedToChild` names the input of each of the parent's messages
     * to this run its target already received. */

    private static final String MESSAGES_SQL =
            "SELECT delivery_state, record_resource_id"
                    + " FROM ma_session_record"
                    + " WHERE tenant_id = ? AND session_id = ?"
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
                    + " AND l.source_scope_id = ?"
                    + " AND l.source_session_id = r.session_id"
                    + " AND l.delivery_id = r.record_id"
                    + " WHERE r.tenant_id = ? AND r.session_id = ?"
                    + " AND r.domain = 'session_message'"
                    + " AND r.delivery_state IN ('planned', 'accepting')"
                    + " AND " + JdbcSessionMessageRelayStore.LEDGER_OWES_WORK;

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
    public EdgeMessages edgeMessages(String tenantId, String parentSessionId, String childRunId, String childSessionId) {
        int undelivered = 0;
        int toChild = 0;
        List<String> received = new ArrayList<>();
        for (Map<String, Object> row : jdbc.query(MESSAGES_SQL, (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                tenantId, parentSessionId)) {
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
                Integer.class, ManagedSchemaKeys.identity(childSessionId), tenantId, childSessionId);
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
        return !jdbc.query("SELECT record_id FROM"
                        + " ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'session_message' LIMIT 1",
                (result, row) -> result.getString("record_id"), tenantId,
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
    public String journalTurnText(String tenantId, String sessionId, String turnId) {
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
    public JsonNode childRunBody(String tenantId, String parentSessionId, String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT record_resource_id FROM"
                        + " ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("record_resource_id"),
                tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null
                : readTree(readResource(tenantId, parentSessionId, rows.getFirst()));
    }

    private void forEachJournalEvent(String tenantId, String sessionId, java.util.function.Consumer<JsonNode> visitor) {
        List<Long> heads = jdbc.query("SELECT compacted_through_revision"
                        + " FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'"
                        + " AND tenant_id = ? AND harness_session_id = ? AND session_id = ?",
                (result, row) -> result.getLong(1), tenantId, sessionId, sessionId);
        if (!heads.isEmpty() && heads.getFirst() != 0) {
            throw new IllegalStateException("Session " + sessionId
                    + "'s journal is compacted");
        }
        for (byte[] bytes : jdbc.query("SELECT record_bytes, journal_revision, record_digest,"
                        + " byte_length FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " ORDER BY journal_revision",
                (result, row) -> {
                    byte[] value = result.getBytes(1);
                    if (value == null && packs != null) {
                        value = packs.resolveBytes(tenantId, sessionId, result.getLong(2),
                                result.getString(3), result.getLong(4));
                    }
                    return value;
                }, tenantId, sessionId)) {
            if (bytes == null) {
                throw new IllegalStateException("Session " + sessionId
                        + "'s journal is unreadable");
            }
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

    /**
     * The non-terminal child runs of one Session, for the close cascade:
     * task projections say what is still alive; the bodies name the child
     * Sessions (null when creation never attached). Like the relay's
     * discovery page, the cascade acts on both child Session kinds
     * (`child_agent` and `workflow`, #13803).
     */
    public List<LiveScope> findLiveScopes(String tenantId, String parentSessionId) {
        return jdbc.query(
                "SELECT record_id, record_resource_id"
                        + " FROM ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND delivery_state IS NOT NULL"
                        + " AND task_kind IN " + ChildResultRelayQueries.CHILD_SESSION_KINDS_SQL
                        + " AND task_state NOT IN ('completed', 'failed',"
                        + " 'cancelled')"
                        + " ORDER BY gmt_create, record_id",
                (result, row) -> new LiveScope(
                        result.getString("record_id"),
                        result.getString("record_resource_id")),
                tenantId, parentSessionId);
    }

    /** Whether a Session currently holds the acceptance of one child run. */
    public boolean hasAcceptance(String tenantId, String sessionId, String childRunId) {
        return !jdbc.query(
                "SELECT record_id FROM ma_session_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_acceptance'"
                        + " AND record_id = ?",
                (result, row) -> result.getString("record_id"), tenantId,
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

    private TurnLine turnLine(String tenantId, String sessionId, String order) {
        List<TurnLine> rows = jdbc.query(
                "SELECT turn_id, status, completed_at, error_code,"
                        + " is_submission_attempted, harness_event_epoch"
                        + " FROM ma_turn"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " ORDER BY gmt_create " + order + ", turn_id "
                        + order + " LIMIT 1",
                (result, row) -> new TurnLine(result.getString("turn_id"),
                        result.getString("status"),
                        result.getObject("completed_at", Long.class),
                        result.getString("error_code"),
                        result.getBoolean("is_submission_attempted"),
                        result.getString("harness_event_epoch")),
                tenantId, sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The terminal result content: the completed Turn's newest assistant
     * message's joined text, or null while none exists. */
    public String terminalResultText(String tenantId, String sessionId, String turnId) {
        List<String[]> messages = jdbc.query(
                "SELECT parts_json, body_resource_ref FROM ma_message"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND turn_id = ? AND item_type = 'message'"
                        + " AND item_role = 'assistant'"
                        + " ORDER BY last_sequence DESC, item_id DESC LIMIT 1",
                (result, row) -> new String[] {
                        result.getString("parts_json"), result.getString("body_resource_ref") },
                tenantId, sessionId, turnId);
        if (messages.isEmpty()) {
            return null;
        }
        // The body reference encodes (tenant, Session, resource id); the
        // resource row is keyed by that raw tuple, so decode the id and read
        // the body with the same integrity gate the join used to apply.
        String body = messages.getFirst()[1] == null
                ? messages.getFirst()[0]
                : messageBodyText(tenantId, sessionId, ManagedIdentityRef.decode(
                        messages.getFirst()[1].getBytes(StandardCharsets.US_ASCII)).get(2));
        try {
            JsonNode parts = MAPPER.readTree(body);
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

    private String messageBodyText(String tenantId, String sessionId, String resourceId) {
        return jdbc.query(
                "SELECT inline_bytes, kind, schema_version, byte_length, sha256, state, deletion_operation_ref"
                        + " FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                (result, row) -> {
                    byte[] bytes = result.getBytes("inline_bytes");
                    if (!"REFERENCED".equals(result.getString("state"))
                            || !"managed-message-parts".equals(result.getString("kind"))
                            || result.getInt("schema_version") != 1
                            || result.getString("deletion_operation_ref") != null || bytes == null
                            || bytes.length != result.getLong("byte_length")
                            || !ToolPublicationContract.sha256(bytes).equals(result.getString("sha256"))) {
                        throw new IllegalStateException("Child message body resource is unavailable or corrupt");
                    }
                    return new String(bytes, StandardCharsets.UTF_8);
                }, tenantId, sessionId, resourceId)
                .stream().findFirst()
                .orElseThrow(() -> new IllegalStateException("Child message body resource is unavailable or corrupt"));
    }

    private static String operationKey(String kind, String tenant, String parent, String run) {
        return ManagedIdentityRefs.operationRef(OperationKind.valueOf(kind).name(), tenant, "SESSION", parent, run, run);
    }

    public RelayRow claim(String tenantId, String parentSessionId, String childRunId, String creationKey, String owner, long leaseUntil, long now) {
        // The Harness supplies the run id; the operation column admits only
        // a bounded identity, never a truncated INSERT IGNORE duplicate.
        BrokerValues.requireOperationId(childRunId, "childRunId");
        String request = MAPPER.createObjectNode().put("version", 1).put("creationKey", creationKey).toString();
        jdbc.update("INSERT IGNORE INTO ma_operation (operation_ref, scope_kind, scope_id, operation_kind, operation_id,"
                        + " tenant_id, session_id, target_kind, target_id, request_digest, request_json, state, phase,"
                        + " gmt_create, gmt_modified) VALUES (?, ?, ?, 'CHILD_SESSION_START', ?, ?, ?, 'CHILD_RUN', ?, ?, ?,"
                        + " 'creating', 'STARTING', ?, ?)",
                ManagedSchemaKeys.identity(operationKey("CHILD_SESSION_START", tenantId, parentSessionId, childRunId)),
                "SESSION", ManagedSchemaKeys.identity(parentSessionId),
                childRunId, tenantId, parentSessionId, ManagedSchemaKeys.identity(childRunId), ManagedSchemaKeys.key(request), request, now, now);
        RelayRow existing = find(tenantId, parentSessionId, childRunId);
        if (existing == null || !creationKey.equals(existing.creationKey())) {
            return null;
        }
        int claimed = jdbc.update("UPDATE ma_operation SET claim_owner = ?, claim_until = ?, claim_generation = claim_generation + 1, gmt_modified = ? WHERE operation_ref = ? AND state NOT IN ('done', 'orphaned', 'unknown') AND (claim_owner = ? OR claim_until IS NULL OR claim_until < ?)",
                owner, leaseUntil, now,
                ManagedSchemaKeys.identity(operationKey(existing.operationKind(), tenantId, parentSessionId, childRunId)), owner, now);
        return claimed == 1 ? find(tenantId, parentSessionId, childRunId) : null;
    }

    public RelayRow find(String tenantId, String parentSessionId, String childRunId) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns() + ", claim_until AS claim_until_epoch FROM ma_operation WHERE scope_kind = 'SESSION' AND scope_id = ? AND tenant_id = ? AND session_id = ? AND operation_id = ? AND operation_kind IN ('CHILD_SESSION_START', 'CHILD_SESSION_CLOSE') ORDER BY CASE WHEN operation_kind = 'CHILD_SESSION_CLOSE' THEN 0 ELSE 1 END LIMIT 1",
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
                }, ManagedSchemaKeys.identity(parentSessionId), tenantId, parentSessionId, childRunId).stream().findFirst().orElse(null);
    }

    private static JsonNode readBody(String value) {
        return value == null ? MAPPER.createObjectNode() : JdbcManagedToolResultStore.parse(value);
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
    public String findLineageChild(String tenantId, String parentSessionId, String childRunId) {
        List<String> rows = jdbc.query("SELECT session_id FROM"
                        + " ma_session WHERE tenant_id = ?"
                        + " AND parent_session_id = ?"
                        + " AND parent_child_run_id = ?",
                (result, row) -> result.getString("session_id"), tenantId,
                parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public void advance(RelayRow row, String owner, String state, String childSessionId, long nextRetryAt, String lastError, long leaseUntil, long now) {
        if (!Set.of("creating", "binding", "watching", "delivering", "close_debt").contains(state)) {
            throw new IllegalArgumentException("Unknown child operation state " + state);
        }
        if ("close_debt".equals(state) && !"CHILD_SESSION_CLOSE".equals(row.operationKind())) {
            retainCloseDebt(row, owner, "done", childSessionId, nextRetryAt, lastError, leaseUntil, now);
            return;
        }
        jdbc.update("UPDATE ma_operation SET state = ?, result_json = ?, available_at = ?, claim_until = ?, gmt_modified = ? WHERE operation_ref = ? AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                state, resultBody(childSessionId, lastError), nextRetryAt, leaseUntil, now,
                ManagedSchemaKeys.identity(operationKey(row.operationKind(), row.tenantId(), row.parentSessionId(), row.childRunId())),
                owner, row.claimGeneration(), now);
    }

    /**
     * Retires the walk under its proven classification and parks the child close it still owes on
     * its own {@code CHILD_SESSION_CLOSE} row. The classification is the result's truth, never the
     * host's close capability: a run whose outcome was never witnessed stays {@code unknown} on
     * both the walk and its delivery row, exactly as when the close is admitted at once (#14165
     * FG10d found the debt arm writing {@code done}/{@code delivered} for such a run).
     */
    public void retainCloseDebt(RelayRow row, String owner, String classification, String childSessionId, long nextRetryAt, String lastError, long leaseUntil, long now) {
        if (!Set.of("done", "unknown").contains(classification)) {
            throw new IllegalArgumentException("Unknown close-debt classification " + classification);
        }
        if ("CHILD_SESSION_CLOSE".equals(row.operationKind())) {
            throw new IllegalArgumentException("A close-debt row cannot retain another close debt");
        }
        BrokerValues.requireOperationId(row.childRunId(), "childRunId");
        transactions.executeWithoutResult(status -> {
            int changed = jdbc.update("UPDATE ma_operation SET state = ?, claim_owner = NULL, claim_until = NULL, result_json = ?, gmt_modified = ? WHERE operation_ref = ? AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                    classification, resultBody(childSessionId, lastError), now, ManagedSchemaKeys.identity(operationKey(row.operationKind(),
                            row.tenantId(), row.parentSessionId(), row.childRunId())), owner, row.claimGeneration(), now);
            if (changed != 1) {
                return;
            }
            String request = MAPPER.createObjectNode().put("version", 1).put("creationKey", row.creationKey()).toString();
            jdbc.update("INSERT INTO ma_operation (operation_ref, scope_kind, scope_id, operation_kind, operation_id, tenant_id, session_id, target_kind, target_id, request_digest, request_json, result_json, state, phase, claim_owner, claim_generation, claim_until, available_at, gmt_create, gmt_modified) VALUES (?, ?, ?, 'CHILD_SESSION_CLOSE', ?, ?, ?, 'CHILD_RUN', ?, ?, ?, ?, 'close_debt', 'CLOSING', ?, 1, ?, ?, ?, ?)",
                    ManagedSchemaKeys.identity(operationKey("CHILD_SESSION_CLOSE", row.tenantId(), row.parentSessionId(), row.childRunId())),
                    "SESSION", ManagedSchemaKeys.identity(row.parentSessionId()), row.childRunId(), row.tenantId(), row.parentSessionId(),
                    ManagedSchemaKeys.identity(row.childRunId()), ManagedSchemaKeys.key(request), request,
                    resultBody(childSessionId, lastError), owner, leaseUntil, nextRetryAt, now, now);
            recordDelivery(row, childSessionId, "done".equals(classification) ? "delivered" : classification, now);
        });
    }

    public void scheduleRetry(RelayRow row, String owner, long nextRetryAt, long leaseUntil, long now) {
        jdbc.update("UPDATE ma_operation SET available_at = ?, claim_until = ?, gmt_modified = ? WHERE operation_ref = ? AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                nextRetryAt, leaseUntil, now, ManagedSchemaKeys.identity(operationKey(row.operationKind(), row.tenantId(),
                        row.parentSessionId(), row.childRunId())), owner, row.claimGeneration(), now);
    }

    public void defer(RelayRow row, String owner, long nextRetryAt, String lastError, long leaseUntil, long now) {
        jdbc.update("UPDATE ma_operation SET attempt_count = ?, available_at = ?, result_json = ?, claim_until = ?, gmt_modified = ? WHERE operation_ref = ? AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                row.attempts() + 1, nextRetryAt, resultBody(row.childSessionId(), lastError), leaseUntil, now,
                ManagedSchemaKeys.identity(operationKey(row.operationKind(), row.tenantId(), row.parentSessionId(), row.childRunId())),
                owner, row.claimGeneration(), now);
    }

    public void classify(RelayRow row, String owner, String state, String lastError, long now) {
        if (!Set.of("done", "orphaned", "unknown").contains(state)) {
            throw new IllegalArgumentException("Unknown child result classification " + state);
        }
        transactions.executeWithoutResult(status -> {
            int changed = jdbc.update("UPDATE ma_operation SET state = ?, result_json = ?, claim_owner = NULL, claim_until = NULL, gmt_modified = ?, completed_at = ? WHERE operation_ref = ? AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                    state, resultBody(row.childSessionId(), lastError), now, now,
                    ManagedSchemaKeys.identity(operationKey(row.operationKind(), row.tenantId(), row.parentSessionId(), row.childRunId())),
                    owner, row.claimGeneration(), now);
            if (changed == 1 && !"CHILD_SESSION_CLOSE".equals(row.operationKind())) {
                recordDelivery(row, row.childSessionId(), "done".equals(state) ? "delivered" : state, now);
            }
        });
    }

    /**
     * The parent's consumption revision corrects the classification's
     * snapshot: classify may commit between acceptance and the wake Turn's
     * read, and a row left `pending` there would keep claiming a consumed
     * result never reached the parent. The parent's commit owns the fact,
     * so it amends the mirror in its own transaction; a row not written
     * yet is left to its classification, which reads the record's state.
     */
    public void markConsumed(String tenantId, String parentSessionId, String childRunId, long now) {
        jdbc.update("UPDATE ma_delivery SET consumption_state = 'consumed',"
                        + " gmt_modified = ? WHERE delivery_kind = 'CHILD_RESULT'"
                        + " AND tenant_id = ? AND source_scope_id = ?"
                        + " AND delivery_id = ?",
                now, tenantId, ManagedSchemaKeys.identity(parentSessionId), childRunId);
    }

    private void recordDelivery(RelayRow row, String child, String transport, long now) {
        String delivery = lockedDeliveryState(row.tenantId(), row.parentSessionId(), row.childRunId());
        String reception = Set.of("accepted", "consumed").contains(delivery == null ? "" : delivery) ? "accepted" : "pending";
        String consumption = "consumed".equals(delivery) ? "consumed" : "pending";
        jdbc.update("INSERT INTO ma_delivery (delivery_kind, tenant_id, source_scope_id, source_session_id,"
                        + " target_session_id, delivery_id, creation_key, payload_json, transport_state, reception_state,"
                        + " consumption_state, gmt_create, gmt_modified) VALUES ('CHILD_RESULT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                        + " ON DUPLICATE KEY UPDATE transport_state = VALUES(transport_state),"
                        + " reception_state = VALUES(reception_state), consumption_state = VALUES(consumption_state),"
                        + " gmt_modified = VALUES(gmt_modified)",
                row.tenantId(), ManagedSchemaKeys.identity(row.parentSessionId()), child == null ? row.parentSessionId() : child, row.parentSessionId(),
                row.childRunId(), row.creationKey(), resultBody(child, null), transport, reception, consumption, now, now);
    }
}
