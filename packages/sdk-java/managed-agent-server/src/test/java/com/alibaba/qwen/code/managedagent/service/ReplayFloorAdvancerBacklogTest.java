package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * A backlog bigger than one batch: the candidate query orders by
 * {@code updated_at}, which the advance never moves, so a Session that keeps
 * appending sorts last of every full batch and starves unless the pass
 * drains past the first batch (#12380). The scheduled passes are pinned an
 * hour out so the test drives the pass itself.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-replay-backlog;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.dispatch.scan-delay=1h",
        "qwen.managed-agent.events.materialize-interval=1h",
        "qwen.managed-agent.events.replay-floor-enabled=true",
        "qwen.managed-agent.events.replay-floor-interval=1h"
})
class ReplayFloorAdvancerBacklogTest {
    private static final int BATCH_LIMIT = 64;

    @Autowired
    private ManagedAgentStore store;

    @Test
    void theAppendingSessionAdvancesInOnePassOverAFullBacklog() {
        String tenant = "tenant-replay-backlog-" + UUID.randomUUID();
        List<String> quiet = new ArrayList<>();
        for (int index = 0; index < BATCH_LIMIT; index++) {
            String sessionId = store.insertSessionCommand(tenant,
                    "CREATE_SESSION", "backlog-" + UUID.randomUUID(),
                    "digest", "qwen-code", null, null, List.of(), "payload")
                    .sessionId();
            append(tenant, sessionId, 5);
            quiet.add(sessionId);
        }
        String busy = store.insertSessionCommand(tenant, "CREATE_SESSION",
                "backlog-busy-" + UUID.randomUUID(), "digest", "qwen-code",
                null, null, List.of(), "payload").sessionId();
        append(tenant, busy, 5);
        // The Session that keeps appending sorts last on updated_at, out of
        // the first batch.
        long busyCoverage = append(tenant, busy, 1);
        for (String sessionId : quiet) {
            store.materializeNextBatch(tenant, sessionId, 100);
        }
        store.materializeNextBatch(tenant, busy, 100);
        assertThat(store.findReplayFloorTargets(BATCH_LIMIT))
                .hasSize(BATCH_LIMIT);

        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getEvents().setReplayFloorEnabled(true);
        new ReplayFloorAdvancer(store, properties).advance();

        assertThat(store.findReplayWindow(tenant, busy).floorSequence())
                .isEqualTo(busyCoverage);
        assertThat(store.findReplayFloorTargets(BATCH_LIMIT)).isEmpty();
    }

    private long append(String tenant, String sessionId, int count) {
        for (int index = 0; index < count; index++) {
            store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn_replay_backlog", "test.progress",
                    Map.of("index", index), false,
                    "replay-backlog:" + UUID.randomUUID());
        }
        return store.requireSession(tenant, sessionId).lastSequence();
    }
}
