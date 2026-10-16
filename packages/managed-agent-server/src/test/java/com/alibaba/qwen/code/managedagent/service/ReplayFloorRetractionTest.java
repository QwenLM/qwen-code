package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionResyncRequired;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        properties = {
            "spring.datasource.url=jdbc:h2:mem:managed-replay-retract;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
            "spring.datasource.driver-class-name=org.h2.Driver",
            "spring.datasource.username=sa",
            "spring.datasource.password=",
            "qwen.managed-agent.harness.enabled=false",
            "qwen.managed-agent.dispatch.scan-delay=1h",
            "qwen.managed-agent.events.materialize-interval=1h"
        })
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class ReplayFloorRetractionTest {
    @Autowired private MockMvc mvc;
    @Autowired private ManagedAgentStore store;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ManagedAgentService service;
    @Autowired private SessionEventHub hub;
    @Autowired private ObjectMapper mapper;

    @Test
    void retractionPreservesSnapshotCursorsAndStreamBoundaries() throws Exception {
        String tenant = "retraction-" + UUID.randomUUID();
        String session = session(tenant);
        var turn =
                store.insertTurnCommand(
                        tenant,
                        "SUBMIT_TURN",
                        UUID.randomUUID().toString(),
                        "digest-turn",
                        session,
                        List.of(),
                        "payload-turn");
        String owner = "owner";
        assertThat(store.claimTurn(tenant, session, turn.turnId(), owner, Duration.ofMinutes(1)))
                .isPresent();
        for (int i = 0; i < 2; i++) {
            store.appendPublicEventIfAbsent(
                    tenant,
                    session,
                    turn.turnId(),
                    "item.output_text.delta",
                    Map.of("itemId", "item-" + i, "text", "text-" + i),
                    false,
                    "boot:epoch:" + i);
        }
        store.materializeNextBatch(tenant, session, 100);
        var page = store.findSnapshotPage(tenant, session, null, 0, 1);
        assertThat(page.nextCursor()).isNotNull();
        long covered = page.coveredSequence();
        long start =
                jdbc.queryForObject(
                        "SELECT MIN(sequence_id) FROM ma_public_event WHERE tenant_id = ?"
                                + " AND session_id = ? AND event_type = 'turn.accepted'",
                        Long.class,
                        tenant,
                        session);
        var raised = store.advanceReplayFloor(tenant, session, Long.MAX_VALUE);
        assertThat(raised.floorSequence()).isLessThan(start);
        long projection =
                jdbc.queryForObject(
                        "SELECT projection_version FROM ma_event_stream WHERE tenant_id = ?"
                                + " AND session_id = ? AND stream_kind = 'SESSION'",
                        Long.class,
                        tenant,
                        session);
        store.retractContinuationOutput(tenant, session, turn.turnId(), owner, "boot", "epoch");
        assertThat(store.requireSession(tenant, session).lastSequence()).isEqualTo(covered + 1);
        var rebuilt = store.findReplayWindow(tenant, session);
        assertThat(rebuilt.floorSequence()).isEqualTo(raised.floorSequence());
        assertThat(rebuilt.snapshotThroughSequence()).isEqualTo(covered);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT projection_version FROM ma_event_stream WHERE tenant_id = ?"
                                        + " AND session_id = ? AND stream_kind = 'SESSION'",
                                Long.class,
                                tenant,
                                session))
                .isEqualTo(projection + 1);
        var old = store.findSnapshotPage(tenant, session, page.nextCursor(), 0, 10);
        assertThat(old.items())
                .extracting(item -> item.content().getFirst().text())
                .containsExactly("text-0", "text-1");
        assertThat(old.coveredSequence()).isEqualTo(covered);
        assertThat(
                        store.findSnapshot(tenant, session).orElseThrow().items().stream()
                                .flatMap(item -> item.content().stream())
                                .map(part -> part.text())
                                .toList())
                .doesNotContain("text-0", "text-1");
    }

    @Test
    void emptyRetainedEventRowsDoNotEraseAnExpiredCursorBoundary() throws Exception {
        String tenant = "empty-events-" + UUID.randomUUID();
        String session = session(tenant);
        for (int i = 0; i < 5; i++) {
            store.appendPublicEventIfAbsent(
                    tenant,
                    session,
                    "turn",
                    "test.progress",
                    Map.of("index", i),
                    false,
                    UUID.randomUUID().toString());
        }
        store.materializeNextBatch(tenant, session, 100);
        var window = store.advanceReplayFloor(tenant, session, Long.MAX_VALUE);
        assertThat(window.floorSequence()).isPositive();
        jdbc.update(
                "DELETE FROM ma_public_event WHERE tenant_id = ? AND session_id = ?",
                tenant,
                session);
        var response =
                mvc.perform(
                                EventStreams.events(tenant, session)
                                        .param("after", Long.toString(window.floorSequence() - 1)))
                        .andReturn()
                        .getResponse();
        assertThat(response.getStatus()).isEqualTo(409);
        JsonNode error = EventStreams.json(mapper, response).get("error");
        assertThat(error.get("code").asText()).isEqualTo("cursor_expired");
        var current =
                mvc.perform(
                                EventStreams.events(tenant, session)
                                        .param("after", Long.toString(window.floorSequence())))
                        .andReturn()
                        .getResponse();
        assertThat(current.getStatus()).isEqualTo(200);
        assertThat(EventStreams.json(mapper, current).get("data")).isEmpty();
        try (var executor = Executors.newCachedThreadPool()) {
            var expired = new EventStreams.RecordingEmitter();
            EventStreams.streams(service, hub, executor, expired)
                    .publicStream(tenant, null, session, window.floorSequence() - 1);
            assertThat(expired.completed.await(10, TimeUnit.SECONDS)).isTrue();
            assertThat(expired.ids).isEmpty();
            assertThat(expired.failed).isEmpty();
            assertThat(expired.resync)
                    .containsExactly(
                            new SessionResyncRequired(
                                    ManagedEventStreamService.RESYNC,
                                    session,
                                    window.floorSequence(),
                                    window.snapshotThroughSequence(),
                                    ManagedEventStreamService.RESYNC_ACTION));
        }
    }

    @Test
    void itemsAfterWithdrawnSequenceIncludesReissuedMessageAndKeepsOldCursor() throws Exception {
        String tenant = "reissued-items-" + UUID.randomUUID();
        String session = session(tenant);
        String turn =
                store.insertTurnCommand(
                                tenant,
                                "SUBMIT_TURN",
                                "turn",
                                "digest",
                                session,
                                List.of(),
                                "payload")
                        .turnId();
        store.claimTurn(tenant, session, turn, "owner", Duration.ofMinutes(1));
        store.appendPublicEventIfAbsent(
                tenant,
                session,
                turn,
                "item.output_text.delta",
                Map.of("itemId", "withdrawn", "text", "old"),
                false,
                "boot:old:1");
        store.materializeNextBatch(tenant, session, 100);
        var frozen = store.findSnapshotPage(tenant, session, null, 0, 1);
        long oldSequence =
                store.findSnapshot(tenant, session).orElseThrow().items().stream()
                        .filter(item -> "withdrawn".equals(item.itemId()))
                        .findFirst()
                        .orElseThrow()
                        .firstSequence();
        store.retractContinuationOutput(tenant, session, turn, "owner", "boot", "old");
        var empty =
                mvc.perform(
                                org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                        .get("/v1/agents/sessions/{id}/items", session)
                                        .header(
                                                com.alibaba.qwen.code.managedagent.api
                                                        .TenantContextFilter.HEADER,
                                                tenant))
                        .andReturn()
                        .getResponse();
        assertThat(empty.getStatus()).isEqualTo(200);
        assertThat(EventStreams.json(mapper, empty).get("data").toString())
                .doesNotContain("withdrawn");
        store.appendPublicEventIfAbsent(
                tenant,
                session,
                turn,
                "item.output_text.delta",
                Map.of("itemId", "withdrawn", "text", "new"),
                false,
                "boot:new:1");
        store.appendPublicEventIfAbsent(
                tenant, session, turn, "turn.completed", Map.of(), true, "boot:new:2");
        store.materializeNextBatch(tenant, session, 100);
        var latest =
                mvc.perform(
                                org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                        .get("/v1/agents/sessions/{id}/items", session)
                                        .header(
                                                com.alibaba.qwen.code.managedagent.api
                                                        .TenantContextFilter.HEADER,
                                                tenant)
                                        .param("after", Long.toString(oldSequence)))
                        .andReturn()
                        .getResponse();
        assertThat(latest.getStatus()).isEqualTo(200);
        JsonNode data = EventStreams.json(mapper, latest).get("data");
        assertThat(data).hasSize(1);
        assertThat(data.get(0).get("id").asText()).isEqualTo("withdrawn");
        assertThat(data.get(0).get("content").get(0).get("text").asText()).isEqualTo("new");
        var old =
                mvc.perform(
                                org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                        .get("/v1/agents/sessions/{id}/items", session)
                                        .header(
                                                com.alibaba.qwen.code.managedagent.api
                                                        .TenantContextFilter.HEADER,
                                                tenant)
                                        .param("after", frozen.nextCursor()))
                        .andReturn()
                        .getResponse();
        assertThat(old.getStatus()).isEqualTo(200);
        JsonNode retained = EventStreams.json(mapper, old).get("data");
        assertThat(retained).hasSize(1);
        assertThat(retained.get(0).get("id").asText()).isEqualTo("withdrawn");
        assertThat(retained.get(0).get("content").get(0).get("text").asText()).isEqualTo("old");
    }

    private String session(String tenant) {
        return store.insertSessionCommand(
                        tenant,
                        "CREATE_SESSION",
                        UUID.randomUUID().toString(),
                        "digest",
                        "qwen-code",
                        null,
                        null,
                        List.of(),
                        "payload")
                .sessionId();
    }
}
