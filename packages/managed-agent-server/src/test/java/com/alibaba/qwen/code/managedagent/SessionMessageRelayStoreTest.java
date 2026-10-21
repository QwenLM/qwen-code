package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.persistence.ChildResultRelayStore.JournalTurns;
import com.alibaba.qwen.code.managedagent.persistence.SessionMessageRelayStore;
import com.alibaba.qwen.code.managedagent.persistence.SessionMessageRelayStore.MessageRow;
import com.alibaba.qwen.code.managedagent.persistence.SessionMessageRelayStore.PendingMessage;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H4d-b: the message relay's ledger and the journal reads behind the
 * child relay's completion rule, over H2 in MySQL mode. */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:session-message-relay;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class SessionMessageRelayStoreTest {
    private static final String TENANT = "tenant-messages";
    private static final AtomicLong IDS = new AtomicLong();

    @Autowired
    private SessionMessageRelayStore store;

    @Autowired
    private ChildResultRelayStore records;

    @Autowired
    private JdbcTemplate jdbc;

    private void message(String sessionId, String messageId, String state,
            String body) {
        extension("session_message", sessionId, messageId, state, body);
    }

    /** A member's outbound command entry, as the open team tools commit it. */
    private void command(String sessionId, String commandId, String state,
            String body) {
        extension("session_command", sessionId, commandId, state, body);
    }

    private void extension(String domain, String sessionId, String recordId,
            String state, String body) {
        String resource = "resource-" + IDS.incrementAndGet();
        resource(sessionId, resource, body.getBytes(StandardCharsets.UTF_8));
        // Each record opens at its own journal sequence, in insert order,
        // as a Session's commits do.
        long sequence = IDS.incrementAndGet();
        jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " delivery_target, delivery_state, gmt_create,"
                        + " first_sequence)"
                        + " VALUES (?, ?, ?, 'workspace', ?, ?, ?,"
                        + " 'h', 1, ?, 'session', ?, ?, ?)",
                com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore.sessionScopeKey(TENANT, sessionId),
                com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionProjection.recordKey(sessionId, domain, recordId), TENANT, sessionId, domain,
                recordId, resource, state, sequence, sequence);
    }

    private static String outbound(String route, String childRunId) {
        return "{\"direction\":\"outbound\",\"route\":\"" + route
                + "\",\"childRunId\":\"" + childRunId + "\"}";
    }

    private static String received(String childRunId, String inputId) {
        return "{\"direction\":\"outbound\",\"route\":\"to_child\","
                + "\"childRunId\":\"" + childRunId + "\",\"inputId\":\""
                + inputId + "\"}";
    }

    private void session(String sessionId, String status) {
        String scope = com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore.sessionScopeKey(TENANT, sessionId);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, tenant_key, session_key, session_scope_key, agent_id, status,"
                        + " gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, 'qwen-code', ?, 0, 0)"
                        + " ON DUPLICATE KEY UPDATE status = VALUES(status)", TENANT, sessionId,
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(TENANT),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(sessionId), scope, status);
    }

    private void resource(String sessionId, String resourceId, byte[] bytes) {
        String scope = com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore.sessionScopeKey(TENANT, sessionId);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, ?, ?, 'workspace', ?, ?, 'managed-message', 1, ?, ?, 'MYSQL_INLINE', ?, 'command', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(scope, resourceId), scope,
                TENANT, sessionId, resourceId, bytes.length, "a".repeat(64), bytes);
    }

    /** One journal transaction holding the given event lines. */
    private void journal(String sessionId, long revision, String... events) {
        StringBuilder lines = new StringBuilder();
        for (String event : events) {
            lines.append("{\"subtype\":\"managed_session_event_v1\","
                    + "\"managedSession\":").append(event).append("}\n");
        }
        byte[] bytes = lines.toString().getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision, command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch, record_encoding, record_bytes, byte_length, record_digest, gmt_create) VALUES (?, 'workspace', ?, ?, ?, 'tx', 'op', 'command', ?, 1, 1, ?, 1, 'writer', ?, 1, 'jsonl', ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                TENANT, sessionId, revision, hash(sessionId + revision),
                "c".repeat(64), events.length, "t".repeat(64), bytes,
                bytes.length, "d".repeat(64));
    }

    private static String hash(String text) {
        try {
            return java.util.HexFormat.of().formatHex(
                    java.security.MessageDigest.getInstance("SHA-256")
                            .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static String input(String turnId, String source) {
        return "{\"kind\":\"input.accepted\",\"occurredAt\":1,\"payload\":"
                + "{\"inputId\":\"" + turnId + "\",\"turnId\":\"" + turnId
                + "\",\"source\":\"" + source + "\"}}";
    }

    private static String settled(String turnId, String outcome, long at) {
        return "{\"kind\":\"turn.settled\",\"occurredAt\":" + at
                + ",\"payload\":{\"turnId\":\"" + turnId
                + "\",\"outcome\":\"" + outcome + "\"}}";
    }

    private static String assistant(String resourceId, String kind) {
        return "{\"kind\":\"message.committed\",\"occurredAt\":1,"
                + "\"payload\":{\"role\":\"assistant\",\"contentRef\":"
                + "{\"resourceId\":\"" + resourceId + "\",\"kind\":\"" + kind
                + "\"}}}";
    }

    private static byte[] chatRecord(String turnId, String text) {
        return ("{\"type\":\"assistant\",\"daemonPromptId\":\"" + turnId
                + "\",\"message\":{\"role\":\"model\",\"parts\":["
                + "{\"text\":\"thinking\",\"thought\":true},{\"text\":\""
                + text + "\"}]}}").getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void pagesOutboundWorkAndSkipsReceiptsAndFinishedRows() {
        String sender = UUID.randomUUID().toString();
        String target = UUID.randomUUID().toString();
        message(sender, "msg_planned", "planned", outbound("to_child", "r"));
        message(sender, "msg_waiting", "accepted", outbound("to_child", "r"));
        message(sender, "msg_given_up", "planned", outbound("to_child", "r"));
        message(target, "msg_receipt", "accepted", "{}");
        MessageRow waiting = store.claim(TENANT, sender, "msg_waiting",
                "owner-a", 31_000, 1_000);
        store.advance(waiting, "owner-a", "delivered", target, 0, 31_000,
                1_000);
        MessageRow givenUp = store.claim(TENANT, sender, "msg_given_up",
                "owner-a", 31_000, 1_000);
        store.classify(givenUp, "owner-a", "unknown", "gave up", 1_000);
        List<String> page = store.findPendingMessages("owner-a", 1_000, 50)
                .stream().filter(entry -> entry.tenantId().equals(TENANT)
                        && (entry.senderSessionId().equals(sender)
                                || entry.senderSessionId().equals(target)))
                .map(PendingMessage::messageId).toList();
        assertThat(page).containsExactlyInAnyOrder("msg_planned",
                "msg_waiting");
        // Another worker's live lease hides the rows from it.
        assertThat(store.findPendingMessages("owner-b", 1_000, 50).stream()
                .map(PendingMessage::messageId))
                .doesNotContain("msg_waiting");
        assertThat(
                store.deliveryState(TENANT, target, "session_message",
                        "msg_receipt")).isEqualTo("accepted");
        assertThat(store.deliveryState(TENANT, target, "session_message",
                "msg_none")).isNull();
    }

    @Test
    void discoversCommandsAndMessagesOfOneSenderWithTheirDomains() {
        String sender = UUID.randomUUID().toString();
        message(sender, "msg_planned", "planned", outbound("to_child", "r"));
        command(sender, "cmd_handover", "planned",
                "{\"route\":\"to_parent\"}");
        command(sender, "cmd_executing", "accepting",
                "{\"route\":\"to_parent\"}");
        command(sender, "cmd_finished", "consumed",
                "{\"route\":\"to_parent\"}");
        Map<String, String> page = new java.util.HashMap<>();
        for (PendingMessage entry : store.findPendingMessages("owner-a",
                1_000, 50)) {
            if (entry.tenantId().equals(TENANT)
                    && entry.senderSessionId().equals(sender)) {
                page.put(entry.messageId(), entry.domain());
            }
        }
        assertThat(page).containsExactlyInAnyOrderEntriesOf(Map.of(
                "msg_planned", "session_message",
                "cmd_handover", "session_command",
                "cmd_executing", "session_command"));
    }

    // One sender's commands pass strictly in order — but only across the
    // open window: an unclassified row over a planned/accepting record.
    // A cancelled entry's leftover relaying row never gets another scan
    // (HANDOVER_SQL no longer sees the record), so it must not hold the
    // younger command behind it; a classified row never holds either.
    @Test
    void ordersCommandsByTheirOpenWindowOnly() {
        String sender = UUID.randomUUID().toString();
        command(sender, "cmd_1_cancelled", "cancelled",
                "{\"route\":\"to_parent\"}");
        command(sender, "cmd_2_open", "accepting",
                "{\"route\":\"to_parent\"}");
        command(sender, "cmd_3_new", "planned", "{\"route\":\"to_parent\"}");
        store.claim(TENANT, sender, "cmd_1_cancelled", "owner-a", 31_000,
                1_000);
        assertThat(store.olderOpenCommand(TENANT, sender, "cmd_2_open"))
                .isFalse();
        store.claim(TENANT, sender, "cmd_2_open", "owner-a", 31_000, 1_000);
        assertThat(store.olderOpenCommand(TENANT, sender, "cmd_3_new"))
                .isTrue();
        store.classify(store.find(TENANT, sender, "cmd_2_open"), "owner-a",
                "unknown", "gave up", 2_000);
        assertThat(store.olderOpenCommand(TENANT, sender, "cmd_3_new"))
                .isFalse();
    }

    // Older is commit order, never the hashed id's spelling: a command id
    // is a digest, so a later command may sort before an earlier one. And
    // an older entry discovery has not opened a row for yet still holds
    // the younger one back.
    @Test
    void ordersCommandsByCommitOrderAndCountsAnEntryWithoutARow() {
        String sender = UUID.randomUUID().toString();
        command(sender, "cmd_z_first", "planned", "{\"route\":\"to_parent\"}");
        command(sender, "cmd_a_second", "planned",
                "{\"route\":\"to_parent\"}");
        assertThat(store.olderOpenCommand(TENANT, sender, "cmd_a_second"))
                .isTrue();
        assertThat(store.olderOpenCommand(TENANT, sender, "cmd_z_first"))
                .isFalse();
        store.claim(TENANT, sender, "cmd_z_first", "owner-a", 31_000, 1_000);
        assertThat(store.olderOpenCommand(TENANT, sender, "cmd_a_second"))
                .isTrue();
        store.classify(store.find(TENANT, sender, "cmd_z_first"), "owner-a",
                "unknown", "gave up", 2_000);
        assertThat(store.olderOpenCommand(TENANT, sender, "cmd_a_second"))
                .isFalse();
    }

    private static String owed(String messageId) {
        return "{\"direction\":\"outbound\",\"route\":\"to_child\","
                + "\"childRunId\":\"r\",\"messageId\":\"" + messageId + "\"}";
    }

    /** The ids of the sender's older messages the store reports owed. */
    private List<String> olderOwed(String sender, String messageId) {
        return store.olderOwedMessages(TENANT, sender, messageId).stream()
                .map(resource -> records.readResource(TENANT, sender,
                        resource))
                .map(body -> body.replaceAll(
                        ".*\"messageId\":\"([^\"]+)\".*", "$1"))
                .toList();
    }

    // A message waits behind the sender's older ones that still owe their
    // handover or receipt: older by commit order, never the hashed id's
    // spelling, and only while the record and its row are both open.
    @Test
    void listsTheSendersOlderMessagesStillOwedByCommitOrder() {
        String sender = UUID.randomUUID().toString();
        message(sender, "msg_z_consumed", "consumed", owed("msg_z_consumed"));
        message(sender, "msg_y_accepting", "accepting",
                owed("msg_y_accepting"));
        message(sender, "msg_x_given_up", "planned", owed("msg_x_given_up"));
        message(sender, "msg_w_unknown", "unknown", owed("msg_w_unknown"));
        // Rows the relay finished with, over records still owing: a closed
        // sender's or target's leftovers, never scanned again.
        message(sender, "msg_v_done", "accepting", owed("msg_v_done"));
        message(sender, "msg_u_orphaned", "planned", owed("msg_u_orphaned"));
        command(sender, "cmd_open", "planned", "{\"route\":\"to_parent\"}");
        message(sender, "msg_b_planned", "planned", owed("msg_b_planned"));
        message(sender, "msg_a_new", "planned", owed("msg_a_new"));
        store.claim(TENANT, sender, "msg_y_accepting", "owner-a", 31_000,
                1_000);
        store.classify(store.claim(TENANT, sender, "msg_x_given_up",
                "owner-a", 31_000, 1_000), "owner-a", "unknown", "gave up",
                1_000);
        store.classify(store.claim(TENANT, sender, "msg_v_done", "owner-a",
                31_000, 1_000), "owner-a", "done", "target closed", 1_000);
        store.classify(store.claim(TENANT, sender, "msg_u_orphaned",
                "owner-a", 31_000, 1_000), "owner-a", "orphaned",
                "sender closed", 1_000);
        assertThat(olderOwed(sender, "msg_a_new")).containsExactlyInAnyOrder(
                "msg_y_accepting", "msg_w_unknown", "msg_b_planned");
        assertThat(olderOwed(sender, "msg_b_planned"))
                .containsExactlyInAnyOrder("msg_y_accepting", "msg_w_unknown");
        assertThat(olderOwed(sender, "msg_y_accepting")).isEmpty();
        // An entry past the attempt bound holds nothing, even before its
        // give-up landed on a sender that takes no further revision.
        String bound = "UPDATE ma_delivery SET attempt_count = ?"
                + " WHERE source_session_id = ? AND delivery_id = ?";
        byte[] accepting = "msg_y_accepting".getBytes(StandardCharsets.UTF_8);
        jdbc.update(bound, SessionMessageRelayStore.MAX_ATTEMPTS - 1, sender,
                accepting);
        assertThat(olderOwed(sender, "msg_b_planned"))
                .contains("msg_y_accepting");
        jdbc.update(bound, SessionMessageRelayStore.MAX_ATTEMPTS, sender,
                accepting);
        assertThat(olderOwed(sender, "msg_b_planned"))
                .containsExactly("msg_w_unknown");
    }

    // One commit can open several entries at the same millisecond: the
    // handover page then takes them in commit order, so the younger one
    // never meets the older one still owed.
    @Test
    void pagesASendersSameMillisecondEntriesInCommitOrder() {
        String sender = UUID.randomUUID().toString();
        message(sender, "msg_z_first", "planned", outbound("to_child", "r"));
        message(sender, "msg_a_second", "planned", outbound("to_child", "r"));
        jdbc.update("UPDATE ma_session_record SET gmt_create = 5"
                + " WHERE session_scope_key = ?",
                com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore
                        .sessionScopeKey(TENANT, sender));
        assertThat(store.findPendingMessages("owner-a", 1_000, 50).stream()
                .filter(entry -> entry.senderSessionId().equals(sender))
                .map(PendingMessage::messageId))
                .containsExactly("msg_z_first", "msg_a_second");
    }

    @Test
    void leasesAdvancesDefersAndClassifiesOnlyForTheClaimant() {
        String sender = UUID.randomUUID().toString();
        MessageRow claimed = store.claim(TENANT, sender, "msg_1", "owner-a",
                31_000, 1_000);
        assertThat(claimed.state()).isEqualTo("relaying");
        assertThat(store.claim(TENANT, sender, "msg_1", "owner-b", 31_000,
                1_000)).isNull();
        store.defer(claimed, "owner-a", 5_000, "flap", 31_000, 1_000);
        assertThat(store.find(TENANT, sender, "msg_1").attempts())
                .isEqualTo(1);
        store.classify(claimed, "owner-b", "orphaned", "fake", 1_000);
        assertThat(store.find(TENANT, sender, "msg_1").state())
                .isEqualTo("relaying");
        store.advance(store.find(TENANT, sender, "msg_1"), "owner-a",
                "delivered", "target-1", 2_000, 31_000, 1_000);
        MessageRow advanced = store.find(TENANT, sender, "msg_1");
        assertThat(advanced.state()).isEqualTo("delivered");
        assertThat(advanced.targetSessionId()).isEqualTo("target-1");
        // A forward step keeps the failures it was preceded by counted.
        assertThat(advanced.attempts()).isEqualTo(1);
        // An expired lease yields the row to the next worker.
        assertThat(store.claim(TENANT, sender, "msg_1", "owner-b", 64_000,
                40_000)).isNotNull();
    }

    // Two workers read the same expired lease; the first renews it. The
    // second, deciding from its stale read, must meet that fresh lease
    // rather than take the row over as well.
    @Test
    void anExpiredLeaseIsWonByOneOfTwoWorkersThatReadIt() {
        String sender = UUID.randomUUID().toString();
        store.claim(TENANT, sender, "msg_race", "owner-a", 31_000, 1_000);
        MessageRow stale = store.find(TENANT, sender, "msg_race");
        assertThat(store.claim(TENANT, sender, "msg_race", "owner-a",
                70_000, 40_000)).isNotNull();
        SessionMessageRelayStore staleReader = new SessionMessageRelayStore(
                jdbc) {
            @Override
            public MessageRow find(String tenantId, String senderSessionId,
                    String messageId) {
                return stale;
            }
        };
        assertThat(staleReader.claim(TENANT, sender, "msg_race", "owner-b",
                70_000, 40_000)).isNull();
        assertThat(store.find(TENANT, sender, "msg_race").claimedBy())
                .isEqualTo("owner-a");
    }

    @Test
    void readsTheLineageOfAChildOnly() {
        String child = UUID.randomUUID().toString();
        String parent = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session (tenant_id,"
                        + " session_id, agent_id, status, gmt_create,"
                        + " gmt_modified, parent_session_id, root_session_id,"
                        + " parent_child_run_id, child_depth) VALUES (?, ?,"
                        + " 'qwen-code', 'ACTIVE', 0, 0, ?, ?, 'run-1', 1)",
                TENANT, child, parent, parent);
        jdbc.update("INSERT INTO ma_session (tenant_id,"
                        + " session_id, agent_id, status, gmt_create,"
                        + " gmt_modified) VALUES (?, ?, 'qwen-code', 'ACTIVE',"
                        + " 0, 0)", TENANT, parent);
        assertThat(store.lineage(TENANT, child)).isEqualTo(
                new SessionMessageRelayStore.Lineage(parent, "run-1"));
        assertThat(store.lineage(TENANT, parent)).isNull();
    }

    @Test
    void countsTheMessagesOnOneEdgeAndThoseStillOwingAHandover() {
        String parent = UUID.randomUUID().toString();
        String child = UUID.randomUUID().toString();
        session(child, "ACTIVE");
        assertThat(records.edgeMessages(TENANT, parent, "run-1", child))
                .isEqualTo(new ChildResultRelayStore.EdgeMessages(0, 0,
                        List.of()));
        message(parent, "msg_a", "planned", outbound("to_child", "run-1"));
        message(parent, "msg_b", "accepting", outbound("to_child", "run-2"));
        message(parent, "msg_c", "accepted",
                received("run-1", "msg_c:message"));
        // A given-up entry the relay ended on its sender holds nothing.
        message(parent, "msg_d", "unknown", outbound("to_child", "run-1"));
        message(parent, "msg_f", "accepted",
                "{\"direction\":\"inbound\",\"route\":\"to_parent\","
                        + "\"childRunId\":\"run-1\"}");
        message(child, "msg_e", "accepting", outbound("to_parent", "run-1"));
        // The received one names its input, for the journal cross-check.
        assertThat(records.edgeMessages(TENANT, parent, "run-1", child))
                .isEqualTo(new ChildResultRelayStore.EdgeMessages(2, 3,
                        List.of("msg_c:message")));
        assertThat(records.childOwesHandover(TENANT, child)).isTrue();
        // An entry the message relay gave up on holds nothing, even when
        // the give-up's own sender step never landed (a child that takes no
        // further revision): past the bound, then classified.
        store.claim(TENANT, child, "msg_e", "owner-a", 31_000, 1_000);
        jdbc.update("UPDATE ma_delivery SET attempt_count"
                + " = ? WHERE source_session_id = ? AND delivery_id = X'6d73675f65'",
                SessionMessageRelayStore.MAX_ATTEMPTS - 1, child);
        assertThat(records.childOwesHandover(TENANT, child)).isTrue();
        jdbc.update("UPDATE ma_delivery SET attempt_count"
                + " = ? WHERE source_session_id = ? AND delivery_id = X'6d73675f65'",
                SessionMessageRelayStore.MAX_ATTEMPTS, child);
        assertThat(records.childOwesHandover(TENANT, child)).isFalse();
        assertThat(records.edgeMessages(TENANT, parent, "run-1", child)
                .undelivered()).isEqualTo(1);
        jdbc.update("UPDATE ma_delivery SET attempt_count"
                + " = 0, transport_state = 'orphaned' WHERE source_session_id = ?"
                + " AND delivery_id = X'6d73675f65'", child);
        assertThat(records.childOwesHandover(TENANT, child)).isFalse();
        jdbc.update("UPDATE ma_delivery SET transport_state ="
                + " 'relaying' WHERE source_session_id = ?"
                + " AND delivery_id = X'6d73675f65'", child);
        assertThat(records.childOwesHandover(TENANT, child)).isTrue();
        // A closed child's outbox is orphaned and never moves again: it
        // holds neither the settlement nor the close.
        session(child, "CLOSED");
        assertThat(records.edgeMessages(TENANT, parent, "run-1", child)
                .undelivered()).isEqualTo(1);
        assertThat(records.childOwesHandover(TENANT, child)).isFalse();
        assertThat(records.hasSessionMessages(TENANT, child)).isTrue();
        assertThat(records.hasSessionMessages(TENANT,
                UUID.randomUUID().toString())).isFalse();
    }

    @Test
    void refusesToCountAnEdgeOverAnUnreadableBody() {
        String parent = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO ma_session_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " delivery_target, delivery_state, gmt_create)"
                        + " VALUES (?, ?, ?, 'workspace', ?,"
                        + " 'session_message', 'msg_x', 'h', 1, 'missing',"
                        + " 'session', 'planned', 1)",
                com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore.sessionScopeKey(TENANT, parent),
                com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionProjection.recordKey(parent, "session_message", "msg_x"), TENANT, parent);
        assertThatThrownBy(() -> records.edgeMessages(TENANT, parent,
                "run-1", UUID.randomUUID().toString()))
                .isInstanceOf(IllegalStateException.class);
    }

    // A ledger row still `relaying` over an accepted entry lost its advance
    // after the sender's step committed: it is waiting, never stranded.
    @Test
    void pagesAnAcceptedEntryWhoseLedgerAdvanceWasLost() {
        String sender = UUID.randomUUID().toString();
        message(sender, "msg_lost", "accepted", outbound("to_child", "r"));
        store.claim(TENANT, sender, "msg_lost", "owner-a", 31_000, 1_000);
        assertThat(store.findPendingMessages("owner-a", 1_000, 50).stream()
                .map(PendingMessage::messageId)).contains("msg_lost");
    }

    @Test
    void readsTheJournalsPendingInputsAndItsNewestSettledTurn() {
        String child = UUID.randomUUID().toString();
        journal(child, 1, input("turn-api", "hosted-harness"),
                settled("turn-api", "completed", 10));
        journal(child, 2, input("msg_1:message", "session_message"));
        // A Monitor's waiting input neither holds the child nor decides it.
        journal(child, 3, input("mon:notify:1", "monitor"));
        JournalTurns pending = records.journalTurns(TENANT, child);
        assertThat(pending.pendingMessageInputs()).isEqualTo(1);
        assertThat(pending.messageInputs()).containsExactly("msg_1:message");
        assertThat(pending.lastActivityAt()).isEqualTo(10);
        assertThat(pending.lastSettled().turnId()).isEqualTo("turn-api");
        assertThat(pending.lastSettled().source()).isEqualTo("hosted-harness");
        resource(child, "assistant-old", chatRecord("turn-api", "first"));
        resource(child, "assistant-new",
                chatRecord("msg_1:message", "updated"));
        journal(child, 4, assistant("assistant-old", "managed-message"),
                assistant("assistant-new", "managed-message"),
                settled("msg_1:message", "completed", 20),
                settled("mon:notify:1", "completed", 30));
        JournalTurns idle = records.journalTurns(TENANT, child);
        assertThat(idle.pendingMessageInputs()).isZero();
        assertThat(idle.lastActivityAt()).isEqualTo(30);
        // Any event is activity, not only inputs and settlements: a long
        // turn's model attempts and tool steps keep it alive.
        journal(child, 5, "{\"kind\":\"model.attempt\",\"occurredAt\":50,"
                + "\"payload\":{\"attemptId\":\"a\",\"state\":\"started\"}}");
        assertThat(records.journalTurns(TENANT, child).lastActivityAt())
                .isEqualTo(50);
        // A resident Session's lease renewal is not the child's work: it
        // would keep a blocked child alive forever.
        journal(child, 6, "{\"kind\":\"activation.changed\",\"occurredAt\":90,"
                + "\"payload\":{\"phase\":\"active\"}}");
        assertThat(records.journalTurns(TENANT, child).lastActivityAt())
                .isEqualTo(50);
        assertThat(idle.lastSettled()).isEqualTo(
                new ChildResultRelayStore.SettledTurn("msg_1:message",
                        "completed", "session_message", 20));
        assertThat(records.journalTurnText(TENANT, child, "msg_1:message"))
                .isEqualTo("updated");
        assertThat(records.journalTurnText(TENANT, child, "turn-api"))
                .isEqualTo("first");
        assertThat(records.journalTurnText(TENANT, child, "turn-none"))
                .isNull();
    }

    @Test
    void joinsTextRunsAThoughtSeparatesWithANewline() {
        String child = UUID.randomUUID().toString();
        resource(child, "split", ("{\"type\":\"assistant\","
                + "\"daemonPromptId\":\"msg_3:message\",\"message\":{"
                + "\"role\":\"model\",\"parts\":[{\"text\":\"first \"},"
                + "{\"text\":\"half\"},{\"text\":\"plan\",\"thought\":true},"
                + "{\"text\":\"second\"}]}}").getBytes(StandardCharsets.UTF_8));
        journal(child, 1, input("msg_3:message", "session_message"),
                assistant("split", "managed-message"),
                settled("msg_3:message", "completed", 5));
        // As the API Turn's output_text parts join: adjacent text runs
        // concatenate, a thought between them starts a new line.
        assertThat(records.journalTurnText(TENANT, child, "msg_3:message"))
                .isEqualTo("first half\nsecond");
    }

    @Test
    void joinsAChunkedAssistantMessageByteForByte() {
        String child = UUID.randomUUID().toString();
        byte[] whole = chatRecord("msg_2:message", "审阅通过");
        // Split inside a multi-byte character: parts join as bytes.
        int cut = new String(whole, StandardCharsets.UTF_8)
                .indexOf("审") + 4;
        resource(child, "part-1", Arrays.copyOfRange(whole, 0, cut));
        resource(child, "part-2", Arrays.copyOfRange(whole, cut,
                whole.length));
        resource(child, "chunks", ("{\"parts\":[{\"resourceId\":\"part-1\"},"
                + "{\"resourceId\":\"part-2\"}]}")
                .getBytes(StandardCharsets.UTF_8));
        journal(child, 1, input("msg_2:message", "session_message"),
                assistant("chunks", "managed-message-chunks"),
                settled("msg_2:message", "completed", 5));
        assertThat(records.journalTurnText(TENANT, child, "msg_2:message"))
                .isEqualTo("审阅通过");
    }

    @Test
    void refusesToProveTurnsFromACompactedJournal() {
        String child = UUID.randomUUID().toString();
        journal(child, 1, input("turn-api", "hosted-harness"));
        jdbc.update("INSERT INTO ma_session_head (head_kind, tenant_key, harness_key, harness_session_id, tenant_id, workspace_id, session_id, storage_version, state, writer_generation, journal_revision, committed_sequence, activation_epoch, compacted_through_revision, recovery_status, gmt_create, gmt_modified) VALUES ('MANAGED_SESSION', ?, ?, ?, ?, 'workspace', ?, 1, 'ACTIVE', 1, 1, 1, 1, 1, 'NONE', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(TENANT),
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(child), child, TENANT, child);
        assertThatThrownBy(() -> records.journalTurns(TENANT, child))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("compacted");
    }
}
