package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionResyncRequired;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;

/**
 * A stream reconciliation discards the Snapshot without lowering the replay
 * floor, so the floor can exceed the coverage while the Items rebuild.
 * Nothing prunes events yet, so a cursor below the floor is still served
 * during that window instead of looping {@code 409}/resync frames; once the
 * rebuilt Snapshot backs the floor again, the cursor expires (#12380). The
 * materializer and the dispatch scanners are paused, so the test controls
 * when the window opens and closes.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-replay-retract;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.dispatch.scan-delay=1h",
        "qwen.managed-agent.events.materialize-interval=1h"
})
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class ReplayFloorRetractionTest {
    @Autowired
    private MockMvc mvc;

    @Autowired
    private ManagedAgentStore store;

    @Autowired
    private ManagedAgentService agentService;

    @Autowired
    private SessionEventHub hub;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void aDiscardedSnapshotDoesNotExpireCursorsBelowTheRaisedFloor()
            throws Exception {
        String tenant = "tenant-floor-retract-" + UUID.randomUUID();
        String sessionId = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "floor-retract-" + UUID.randomUUID(),
                "digest", "qwen-code", null, null, List.of(), "payload")
                .sessionId();
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "floor-retract-turn-" + UUID.randomUUID(), "digest-turn",
                sessionId, List.of(), "payload-turn");
        String owner = "floor-retract-owner";
        assertThat(store.claimTurn(tenant, sessionId, turn.turnId(), owner,
                Duration.ofMinutes(1))).isPresent();
        long covered = append(tenant, sessionId, 5);
        store.materializeNextBatch(tenant, sessionId, 100);
        ReplayWindow raised = store.advanceReplayFloor(tenant, sessionId,
                Long.MAX_VALUE);
        assertThat(raised.floorSequence()).isEqualTo(covered);
        assertThat(raised.snapshotThroughSequence()).isEqualTo(covered);

        store.retractContinuationOutput(tenant, sessionId, turn.turnId(),
                owner, "boot-floor-retract", "epoch-floor-retract");

        // The retraction discards the Snapshot but never lowers the floor.
        ReplayWindow window = store.findReplayWindow(tenant, sessionId);
        assertThat(window.snapshotThroughSequence()).isZero();
        assertThat(window.floorSequence()).isEqualTo(covered);
        long last = store.requireSession(tenant, sessionId).lastSequence();
        assertThat(last).isEqualTo(covered + 1);

        MockHttpServletResponse below = mvc.perform(EventStreams.events(
                        tenant, sessionId)
                        .param("after", Long.toString(covered - 1)))
                .andReturn().getResponse();
        assertThat(below.getStatus()).isEqualTo(200);
        assertThat(sequences(EventStreams.json(objectMapper, below)))
                .containsExactlyElementsOf(EventStreams.range(covered, last));
        MockHttpServletResponse omitted = mvc.perform(EventStreams.events(
                        tenant, sessionId))
                .andReturn().getResponse();
        assertThat(omitted.getStatus()).isEqualTo(200);
        assertThat(sequences(EventStreams.json(objectMapper, omitted)))
                .containsExactlyElementsOf(EventStreams.range(1, last));

        // Once the rebuilt Snapshot backs the floor, the cursor expires.
        store.materializeNextBatch(tenant, sessionId, 100);
        assertThat(store.findReplayWindow(tenant, sessionId)
                .snapshotThroughSequence()).isEqualTo(last);
        MockHttpServletResponse expired = mvc.perform(EventStreams.events(
                        tenant, sessionId)
                        .param("after", Long.toString(covered - 1)))
                .andReturn().getResponse();
        assertThat(expired.getStatus()).isEqualTo(409);
        JsonNode error = EventStreams.json(objectMapper, expired).get("error");
        assertThat(error.get("code").asText()).isEqualTo("cursor_expired");
        assertThat(error.get("replay_floor_sequence").asLong())
                .isEqualTo(covered);
        assertThat(error.get("snapshot_through_sequence").asLong())
                .isEqualTo(last);
    }

    @Test
    void aHalfRebuiltSnapshotStillServesBothReadPathsBelowTheFloor()
            throws Exception {
        String tenant = "tenant-floor-mid-" + UUID.randomUUID();
        String sessionId = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "floor-mid-" + UUID.randomUUID(),
                "digest", "qwen-code", null, null, List.of(), "payload")
                .sessionId();
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "floor-mid-turn-" + UUID.randomUUID(), "digest-turn",
                sessionId, List.of(), "payload-turn");
        String owner = "floor-mid-owner";
        assertThat(store.claimTurn(tenant, sessionId, turn.turnId(), owner,
                Duration.ofMinutes(1))).isPresent();
        long covered = append(tenant, sessionId, 5);
        store.materializeNextBatch(tenant, sessionId, 100);
        ReplayWindow raised = store.advanceReplayFloor(tenant, sessionId,
                Long.MAX_VALUE);
        assertThat(raised.floorSequence()).isEqualTo(covered);

        store.retractContinuationOutput(tenant, sessionId, turn.turnId(),
                owner, "boot-floor-mid", "epoch-floor-mid");
        long last = store.requireSession(tenant, sessionId).lastSequence();

        // A rebuild is multi-batch, so the window normally sits at a floor
        // above a non-zero coverage, not only at a discarded Snapshot.
        store.materializeNextBatch(tenant, sessionId, 1);
        ReplayWindow mid = store.findReplayWindow(tenant, sessionId);
        assertThat(mid.floorSequence()).isEqualTo(covered);
        assertThat(mid.snapshotThroughSequence()).isPositive()
                .isLessThan(covered);

        MockHttpServletResponse midRead = mvc.perform(EventStreams.events(
                        tenant, sessionId)
                        .param("after", Long.toString(covered - 1)))
                .andReturn().getResponse();
        assertThat(midRead.getStatus()).isEqualTo(200);
        assertThat(sequences(EventStreams.json(objectMapper, midRead)))
                .containsExactlyElementsOf(EventStreams.range(covered, last));

        ExecutorService executor = Executors.newCachedThreadPool();
        try {
            EventStreams.RecordingEmitter open =
                    new EventStreams.RecordingEmitter();
            EventStreams.streams(agentService, hub, executor, open)
                    .publicStream(tenant, null, sessionId, covered - 1);
            await().atMost(Duration.ofSeconds(10)).until(
                    () -> open.ids.contains(last) || !open.resync.isEmpty()
                            || !open.failed.isEmpty());
            assertThat(open.failed).isEmpty();
            assertThat(open.resync).isEmpty();
            assertThat(open.ids)
                    .containsExactlyElementsOf(EventStreams.range(covered,
                            last));

            // The rewrite of a one-batch-behind Snapshot defers until it
            // ages out, so the rebuild converges over later passes.
            await().atMost(Duration.ofSeconds(15)).until(() -> {
                store.materializeNextBatch(tenant, sessionId, 100);
                return store.findReplayWindow(tenant, sessionId)
                        .snapshotThroughSequence() == last;
            });

            EventStreams.RecordingEmitter expired =
                    new EventStreams.RecordingEmitter();
            EventStreams.streams(agentService, hub, executor, expired)
                    .publicStream(tenant, null, sessionId, covered - 1);
            assertThat(expired.completed.await(10, TimeUnit.SECONDS))
                    .isTrue();
            assertThat(expired.failed).isEmpty();
            assertThat(expired.ids).isEmpty();
            assertThat(expired.resync).containsExactly(
                    new SessionResyncRequired(ManagedEventStreamService.RESYNC,
                            sessionId, covered, last,
                            ManagedEventStreamService.RESYNC_ACTION));
        } finally {
            executor.shutdownNow();
        }
    }

    private long append(String tenant, String sessionId, int count) {
        for (int index = 0; index < count; index++) {
            store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn_floor_retract", "test.progress",
                    Map.of("index", index), false,
                    "floor-retract:" + UUID.randomUUID());
        }
        return store.requireSession(tenant, sessionId).lastSequence();
    }

    private static List<Long> sequences(JsonNode page) {
        List<Long> sequences = new ArrayList<>();
        page.get("data").forEach(
                event -> sequences.add(event.get("sequence").asLong()));
        return sequences;
    }
}
