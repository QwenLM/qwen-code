package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.service.EventTransportConsumer.MaterializeOutcome;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelope;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelopes;
import com.alibaba.qwen.code.managedagent.store.TransportConsumerStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.apache.rocketmq.client.apis.message.MessageView;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The MQ2c consumer roles against the real schema (H2, MySQL mode): every
 * decision is read from SQL — the activation fence from the Session and its
 * journal head, the wake dedup from the consumer-progress watermark, the
 * materialization dedup from the message projection's covered sequence —
 * and the broker is stood in for by handing the listener the message.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:transport-consumer;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.session-store.enabled=true",
        // The scheduled pass would race the notices this test hands over.
        "qwen.managed-agent.events.materialize-interval=1h"
})
class EventTransportConsumerSqlTest {
    private static final String TENANT = "tenant-transport";
    private static final String WORKSPACE = "workspace-transport";
    private static final String DIGEST = "c".repeat(64);

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private Clock clock;

    @Autowired
    private MessageMaterializer materializer;

    private HarnessConnector harness;
    private List<String> activated;
    private EventTransportConsumer consumer;

    @BeforeEach
    void setUp() {
        harness = mock(HarnessConnector.class);
        when(harness.isAvailable()).thenReturn(true);
        when(harness.activateForWake(anyString(), anyString()))
                .thenReturn(true);
        activated = new ArrayList<>();
        TransportConsumerStore store = new TransportConsumerStore(jdbc, clock);
        // Loads and batches run inline, so each delivery is settled when
        // consume returns.
        consumer = new EventTransportConsumer(
                new TransportWakeActivator(store, harness, activated::add,
                        Runnable::run),
                store, materializer, Runnable::run);
    }

    @Test
    void aRedeliveredOrOlderWakeIsANoOpAndANewerOneActivatesAgain() {
        String session = session("ACTIVE");
        head(session, "SEALED", 5, -60);

        deliver(wake(session, WORKSPACE, 3));
        deliver(wake(session, WORKSPACE, 3));
        deliver(wake(session, WORKSPACE, 2));

        verify(harness, times(1)).activateForWake(TENANT, session);
        assertThat(activated).containsExactly(session);
        assertThat(wakeWatermark(session)).isEqualTo(3);

        deliver(wake(session, WORKSPACE, 5));

        verify(harness, times(2)).activateForWake(TENANT, session);
        assertThat(wakeWatermark(session)).isEqualTo(5);
    }

    @Test
    void aStaleWakeForAFencedSessionIsANoOp() {
        // A live writer: the owner's own wake pump runs the input, and the
        // notice claims nothing, so the wake stays claimable once the lease
        // lapses.
        String held = session("ACTIVE");
        head(held, "ACTIVE", 5, 60);
        deliver(wake(held, WORKSPACE, 3));
        assertThat(wakeWatermark(held)).isNull();

        String closed = session("CLOSED");
        head(closed, "SEALED", 5, -60);
        deliver(wake(closed, WORKSPACE, 3));

        String deleted = session("ACTIVE");
        head(deleted, "DELETED", 5, null);
        deliver(wake(deleted, WORKSPACE, 3));

        String unwritten = session("ACTIVE");
        head(unwritten, "SEALED", 2, -60);
        deliver(wake(unwritten, WORKSPACE, 3));

        String foreign = session("ACTIVE");
        head(foreign, "SEALED", 5, -60);
        deliver(wake(foreign, "workspace-other", 3));

        String journalless = session("ACTIVE");
        deliver(wake(journalless, WORKSPACE, 3));

        verify(harness, never()).activateForWake(anyString(), anyString());
        assertThat(activated).isEmpty();

        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " writer_lease_until = TIMESTAMPADD(SECOND, -60,"
                + " CURRENT_TIMESTAMP(6)) WHERE tenant_id = ? AND"
                + " session_id = ?", TENANT, held);
        deliver(wake(held, WORKSPACE, 3));
        verify(harness, times(1)).activateForWake(TENANT, held);
    }

    // Sealing leaves the lease column set, but a SEALED journal is
    // re-acquirable at once: it holds no writer, so its wake is attempted.
    @Test
    void aSealedJournalsLeftoverLeaseIsNoWriter() {
        String sealed = session("ACTIVE");
        head(sealed, "SEALED", 5, 60);

        deliver(wake(sealed, WORKSPACE, 3));

        verify(harness, times(1)).activateForWake(TENANT, sealed);
        assertThat(wakeWatermark(sealed)).isEqualTo(3);
    }

    @Test
    void aDuplicateClaimIsRefusedOnTheInsertAndTheUpdatePath() {
        String session = session("ACTIVE");
        TransportConsumerStore store = new TransportConsumerStore(jdbc, clock);

        // The first claim inserts the row; a duplicate takes the
        // DuplicateKey path a racing loser takes, and refuses; only a strict
        // advance wins.
        assertThat(store.claimWake(TENANT, session, 4)).isTrue();
        assertThat(store.claimWake(TENANT, session, 4)).isFalse();
        assertThat(store.claimWake(TENANT, session, 1)).isFalse();
        assertThat(store.claimWake(TENANT, session, 6)).isTrue();
        assertThat(wakeWatermark(session)).isEqualTo(6);
    }

    @Test
    void anEnvelopeNamesTheBindingOrElseTheJournalsWorkspace() {
        TransportConsumerStore store = new TransportConsumerStore(jdbc, clock);
        String bound = session("ACTIVE");
        head(bound, "ACTIVE", 1, 60, "workspace-journal");
        // The binding wins over a journal that names another workspace.
        assertThat(store.workspaceOf(TENANT, bound)).contains(WORKSPACE);

        String unbound = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                + " session_id, agent_id, status, created_at, updated_at)"
                + " VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)", TENANT,
                unbound);
        assertThat(store.workspaceOf(TENANT, unbound)).isEmpty();
        head(unbound, "ACTIVE", 1, 60);
        assertThat(store.workspaceOf(TENANT, unbound)).contains(WORKSPACE);

        assertThat(store.workspaceOf(TENANT, "no-such-session")).isEmpty();
    }

    @Test
    void theHeldSetIsTheJournalsThisWriterHoldsUnderALiveLease() {
        TransportConsumerStore store = new TransportConsumerStore(jdbc, clock);
        String held = session("ACTIVE");
        head(held, "ACTIVE", 1, 60);
        String lapsed = session("ACTIVE");
        head(lapsed, "ACTIVE", 1, -60);
        String sealed = session("ACTIVE");
        head(sealed, "SEALED", 1, 60);
        String foreign = session("ACTIVE");
        head(foreign, "ACTIVE", 1, 60);
        jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_id ="
                + " 'other-writer' WHERE tenant_id = ? AND session_id = ?",
                TENANT, foreign);

        assertThat(store.heldBy("writer", TENANT,
                List.of(held, lapsed, sealed, foreign, "no-such-session")))
                .containsExactly(held);
        assertThat(store.heldBy("writer", "other-tenant", List.of(held)))
                .isEmpty();
    }

    @Test
    void aPublicEventMaterializesAndItsRedeliveryIsANoOp() {
        String session = session("ACTIVE");
        event(session, 1, "session.updated");
        event(session, 2, "session.updated");

        assertThat(consumer.materialize(publicEvent(session, 2)))
                .isEqualTo(MaterializeOutcome.QUEUED);
        assertThat(projectionWatermark(session)).isEqualTo(2);

        assertThat(consumer.materialize(publicEvent(session, 2)))
                .isEqualTo(MaterializeOutcome.DUPLICATE);
        assertThat(consumer.materialize(publicEvent(session, 1)))
                .isEqualTo(MaterializeOutcome.DUPLICATE);
        assertThat(projectionWatermark(session)).isEqualTo(2);

        // Through the listener end to end: parse, dispatch, acknowledge.
        event(session, 3, "session.updated");
        deliver(publicEvent(session, 3));
        assertThat(projectionWatermark(session)).isEqualTo(3);
    }

    private void deliver(ManagedEventEnvelope envelope) {
        MessageView message = mock(MessageView.class);
        when(message.getBody()).thenReturn(ByteBuffer.wrap(
                ManagedEventEnvelopes.toJson(envelope)
                        .getBytes(StandardCharsets.UTF_8)));
        consumer.consume(message);
    }

    private static ManagedEventEnvelope wake(String session, String workspace,
            long sequence) {
        return new ManagedEventEnvelope(1, session, TENANT, workspace,
                ManagedEventEnvelopes.STREAM_AUTHORITATIVE_JOURNAL, sequence,
                "wake-" + sequence, "wake.requested", 1_760_000_000_000L,
                new ManagedEventEnvelope.PayloadRef(DIGEST));
    }

    private static ManagedEventEnvelope publicEvent(String session,
            long sequence) {
        return new ManagedEventEnvelope(1, session, TENANT, WORKSPACE,
                ManagedEventEnvelopes.STREAM_PUBLIC_EVENT, sequence,
                "public-" + sequence, "session.updated", 1_760_000_000_000L,
                new ManagedEventEnvelope.PayloadRef(DIGEST));
    }

    private String session(String status) {
        String session = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO managed_agent_session (tenant_id, session_id,"
                + " agent_id, status, created_at, updated_at,"
                + " workspace_storage_id, workspace_id, workspace_generation,"
                + " cwd_relative, context_config_ref, context_revision,"
                + " workspace_config_ref, workspace_policy_ref) VALUES (?, ?,"
                + " 'qwen-code', ?, 1, 1, ?, ?, 1, '.', ?, 1, ?, ?)",
                TENANT, session, status, "storage-" + session, WORKSPACE,
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF,
                WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_agent_consumer_progress (tenant_id,"
                + " session_id, consumer_name, covered_sequence, updated_at)"
                + " VALUES (?, ?, 'message_projection', 0, 1)",
                TENANT, session);
        return session;
    }

    private void head(String session, String state, long committed,
            Integer leaseOffsetSeconds) {
        head(session, state, committed, leaseOffsetSeconds, WORKSPACE);
    }

    private void head(String session, String state, long committed,
            Integer leaseOffsetSeconds, String workspace) {
        jdbc.update("INSERT INTO qwen_managed_session_journal_head (tenant_id,"
                + " workspace_id, session_id, storage_version, state,"
                + " writer_generation, writer_id, writer_lease_until,"
                + " journal_revision, committed_sequence, activation_epoch,"
                + " compacted_through_revision, recovery_status, created_at,"
                + " updated_at) VALUES (?, ?, ?, 1, ?, 1, 'writer', "
                + (leaseOffsetSeconds == null ? "NULL"
                        : "TIMESTAMPADD(SECOND, " + leaseOffsetSeconds
                                + ", CURRENT_TIMESTAMP(6))")
                + ", 3, ?, 0, 0, 'READY', CURRENT_TIMESTAMP(6),"
                + " CURRENT_TIMESTAMP(6))",
                TENANT, workspace, session, state, committed);
    }

    private void event(String session, long sequence, String type) {
        jdbc.update("INSERT INTO managed_agent_event (tenant_id, session_id,"
                + " sequence_id, event_id, turn_id, event_type, data_json,"
                + " terminal, source_key, created_at) VALUES (?, ?, ?, ?,"
                + " NULL, ?, '{}', FALSE, NULL, ?)",
                TENANT, session, sequence, "evt-" + UUID.randomUUID(), type,
                1_760_000_000_000L + sequence);
        jdbc.update("UPDATE managed_agent_session SET last_sequence = ? WHERE"
                + " tenant_id = ? AND session_id = ?", sequence, TENANT,
                session);
    }

    private Long wakeWatermark(String session) {
        List<Long> covered = jdbc.queryForList("SELECT covered_sequence FROM"
                + " managed_agent_consumer_progress WHERE tenant_id = ? AND"
                + " session_id = ? AND consumer_name = ?", Long.class, TENANT,
                session, TransportConsumerStore.WAKE_CONSUMER);
        return covered.isEmpty() ? null : covered.getFirst();
    }

    private long projectionWatermark(String session) {
        return jdbc.queryForObject("SELECT covered_sequence FROM"
                + " managed_agent_consumer_progress WHERE tenant_id = ? AND"
                + " session_id = ? AND consumer_name = 'message_projection'",
                Long.class, TENANT, session);
    }
}
