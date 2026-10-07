package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.LongStream;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

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
    private static final String TENANT = TenantContextFilter.HEADER;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ManagedAgentStore store;

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

        MockHttpServletResponse below = mvc.perform(events(tenant, sessionId)
                        .param("after", Long.toString(covered - 1)))
                .andReturn().getResponse();
        assertThat(below.getStatus()).isEqualTo(200);
        assertThat(sequences(json(below)))
                .containsExactlyElementsOf(range(covered, last));
        MockHttpServletResponse omitted = mvc.perform(events(tenant,
                        sessionId))
                .andReturn().getResponse();
        assertThat(omitted.getStatus()).isEqualTo(200);
        assertThat(sequences(json(omitted)))
                .containsExactlyElementsOf(range(1, last));

        // Once the rebuilt Snapshot backs the floor, the cursor expires.
        store.materializeNextBatch(tenant, sessionId, 100);
        assertThat(store.findReplayWindow(tenant, sessionId)
                .snapshotThroughSequence()).isEqualTo(last);
        MockHttpServletResponse expired = mvc.perform(events(tenant,
                        sessionId)
                        .param("after", Long.toString(covered - 1)))
                .andReturn().getResponse();
        assertThat(expired.getStatus()).isEqualTo(409);
        JsonNode error = json(expired).get("error");
        assertThat(error.get("code").asText()).isEqualTo("cursor_expired");
        assertThat(error.get("replay_floor_sequence").asLong())
                .isEqualTo(covered);
        assertThat(error.get("snapshot_through_sequence").asLong())
                .isEqualTo(last);
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

    private MockHttpServletRequestBuilder events(String tenant,
            String sessionId) {
        return get("/v1/agents/sessions/{id}/events", sessionId)
                .header(TENANT, tenant).accept(MediaType.APPLICATION_JSON);
    }

    private JsonNode json(MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(
                response.getContentAsString(StandardCharsets.UTF_8));
    }

    private static List<Long> sequences(JsonNode page) {
        List<Long> sequences = new ArrayList<>();
        page.get("data").forEach(
                event -> sequences.add(event.get("sequence").asLong()));
        return sequences;
    }

    private static List<Long> range(long first, long last) {
        return LongStream.rangeClosed(first, last).boxed().toList();
    }
}
