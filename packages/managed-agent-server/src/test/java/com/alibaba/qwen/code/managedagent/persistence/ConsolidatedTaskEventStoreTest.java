package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ConsolidatedTaskEventStoreTest {
    private ConsolidatedStoreFixture fixture;
    private JdbcTemplate jdbc;
    private ManagedTaskEventStore events;

    @BeforeEach
    void initialize() {
        fixture = ConsolidatedStoreFixture.open("taskevent");
        var source = fixture.source();
        ManagedSchema.initialize(source);
        jdbc = new JdbcTemplate(source);
        events = new ManagedTaskEventStore(jdbc);
        jdbc.update("INSERT INTO ma_session (tenant_id,session_id,session_kind,workspace_id,gmt_create,gmt_modified)"
                + " VALUES ('tenant','session','CONTROL','workspace',0,0)");
    }

    @AfterEach
    void closeFixture() {
        if (fixture != null) {
            fixture.close();
        }
    }

    @Test
    void opaqueCursorBindsTenantSessionAndTaskWithoutDelimiterAmbiguity() {
        String task = "任务:child:1";
        String cursor = ManagedTaskEventStore.encodeCursor("tenant", "session", task, 14);
        assertThat(ManagedTaskEventStore.decodeCursor("tenant", "session", task, cursor)).isEqualTo(14);
        assertThatThrownBy(() -> ManagedTaskEventStore.decodeCursor("another", "session", task, cursor)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> ManagedTaskEventStore.decodeCursor("tenant", "another", task, cursor)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> ManagedTaskEventStore.decodeCursor("tenant", "session", task + " ", cursor)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> ManagedTaskEventStore.decodeCursor("tenant", "session", task, "x".repeat(129))).isInstanceOf(ManagedAgentException.class);
        String old = java.util.Base64.getUrlEncoder().encodeToString("tev1:task:14".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        assertThatThrownBy(() -> ManagedTaskEventStore.decodeCursor("tenant", "session", "task", old)).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void taskTailAndFloorStayAfterAllEventsExpireAndDoNotMixWithSessionStream() {
        events.appendStateChange("tenant", "session", "task", "running", "ready", 1);
        events.appendStateChange("tenant", "session", "task", "completed", "ready", 2);
        jdbc.update("INSERT INTO ma_event_stream (tenant_id,session_id,stream_kind,stream_id,last_sequence,gmt_modified)"
                + " VALUES ('tenant','session','SESSION','',1,0)");
        jdbc.update("INSERT INTO ma_public_event (tenant_id,session_id,stream_kind,stream_id,sequence_id,event_id,"
                + "event_type,data_json,terminal,gmt_create) VALUES ('tenant','session','SESSION','',1,'session-event',"
                + "'session.updated','{}',FALSE,1)");
        assertThat(events.expireThrough("tenant", "session", "task", 2)).isEqualTo(2);
        assertThat(events.read("tenant", "session", "task", 0, 100).events()).isEmpty();
        assertThat(events.positions("tenant", "session", "task").lastSequence()).isEqualTo(2);
        assertThat(events.positions("tenant", "session", "task").expiredThrough()).isEqualTo(2);
        events.appendStateChange("tenant", "session", "task", "running", "ready", 3);
        assertThat(events.read("tenant", "session", "task", 2, 100).events().getFirst().sequence()).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE stream_kind='SESSION'", Long.class))
                .isEqualTo(1);
    }

    @Test
    void archivalBarrierAndOrdinalProofSurviveExpiryWithoutDuplicatingCursorResources() {
        long first = events.appendOutput("tenant", "session", "task", "chunk", false,
                "capture", "stdout", 0L, 1L, 1);
        assertThatThrownBy(() -> events.expireThrough("tenant", "session", "task", first))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(events.markOutputArchived("tenant", "session", "task", first)).isEqualTo(1);
        events.expireThrough("tenant", "session", "task", first);
        assertThatThrownBy(() -> events.appendOutput("tenant", "session", "task", "again", false,
                "capture", "stdout", 0L, 1L, 2)).isInstanceOf(ManagedAgentException.class);
        assertThat(events.positions("tenant", "session", "task").lastSequence()).isEqualTo(1);
        assertThat(events.appendOutput("tenant", "session", "task", "next", false,
                "capture", "stdout", 1L, 2L, 3)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Long.class)).isZero();
    }

    @Test
    void derivedFeedBackpressureDoesNotMarkItsOwningDomainTransactionRollbackOnly() {
        events.appendOutput("tenant", "session", "task", "unarchived", false, null, null, null, null, 1);
        for (int i = 1; i < ManagedTaskEventStore.BACKLOG_BOUND; i++) {
            events.appendStateChange("tenant", "session", "task", "running", "ready", i + 1);
        }
        new org.springframework.transaction.support.TransactionTemplate(
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource()))
                .executeWithoutResult(status -> {
                    assertThatThrownBy(() -> events.appendStateChange("tenant", "session", "task", "completed", "ready", 1000))
                            .isInstanceOf(ManagedAgentException.class);
                    jdbc.update("UPDATE ma_session SET title=? WHERE tenant_id=? AND session_id=?", "committed-domain", "tenant", "session");
                });
        assertThat(jdbc.queryForObject("SELECT title FROM ma_session WHERE tenant_id=? AND session_id=?", String.class,
                "tenant", "session")).isEqualTo("committed-domain");
        assertThat(events.positions("tenant", "session", "task").lastSequence()).isEqualTo(ManagedTaskEventStore.BACKLOG_BOUND);
    }

    @Test
    void artifactRefsAreImmutableProtectedResourcesAndRetirementRejectsNewOutput() {
        events.appendArtifact("tenant", "session", "task", "artifact1", 1);
        events.appendArtifact("tenant", "session", "task", "artifact2", 2);
        assertThat(events.positions("tenant", "session", "task").artifactRefs()).containsExactly("artifact1", "artifact2");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind='EVENT_STREAM'", Long.class))
                .isEqualTo(1);
        events.expireThrough("tenant", "session", "task", 2);
        assertThat(events.positions("tenant", "session", "task").artifactRefs()).containsExactly("artifact1", "artifact2");
        jdbc.update("UPDATE ma_session SET retired_at=1, retirement_generation=1 WHERE tenant_id=? AND session_id=?",
                "tenant", "session");
        assertThatThrownBy(() -> events.appendArtifact("tenant", "session", "task", "artifact3", 3))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(events.positions("tenant", "session", "task").lastSequence()).isEqualTo(2);
    }
}
