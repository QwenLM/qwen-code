package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayFloorTarget;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * The retention pass raises a Session's replay floor as far as its Snapshot
 * proves safe, and only when it is enabled: the store is never touched while
 * {@code replay-floor-enabled} is false, a converged Session is never
 * selected again, and one failing Session does not stop the rest.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-replay-floor;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.events.materialize-interval=10ms",
        "qwen.managed-agent.events.replay-floor-enabled=true",
        "qwen.managed-agent.events.replay-floor-interval=10ms"
})
class ReplayFloorAdvancerTest {

    @Autowired
    private ManagedAgentStore store;

    @Test
    void scheduledPassRaisesTheFloorToTheSnapshotCoverage() {
        String tenant = tenant();
        String sessionId = session(tenant);
        long last = append(tenant, sessionId, 5);

        await().atMost(Duration.ofSeconds(10)).until(() ->
                store.findReplayWindow(tenant, sessionId)
                        .snapshotThroughSequence() == last);
        await().atMost(Duration.ofSeconds(10)).until(() ->
                store.findReplayWindow(tenant, sessionId)
                        .floorSequence() == last);
    }

    @Test
    void convergedSessionsAreNotSelectedAgain() {
        String tenant = tenant();
        String sessionId = session(tenant);
        long last = append(tenant, sessionId, 3);
        await().atMost(Duration.ofSeconds(10)).until(() ->
                store.findReplayWindow(tenant, sessionId)
                        .floorSequence() == last);

        assertThat(store.findReplayFloorTargets(64))
                .noneMatch(target -> target.sessionId().equals(sessionId));
    }

    @Test
    void disabledPassNeverTouchesTheStore() {
        AgentStateStore mockStore = mock(AgentStateStore.class);

        new ReplayFloorAdvancer(mockStore, new ManagedAgentProperties())
                .advance();

        verifyNoInteractions(mockStore);
    }

    @Test
    void enabledPassAdvancesEveryTargetAsFarAsTheSnapshotProves() {
        AgentStateStore mockStore = mock(AgentStateStore.class);
        when(mockStore.findReplayFloorTargets(anyInt())).thenReturn(List.of(
                new ReplayFloorTarget("tenant-a", "session-a"),
                new ReplayFloorTarget("tenant-b", "session-b")));

        enabledAdvancer(mockStore).advance();

        verify(mockStore).advanceReplayFloor("tenant-a", "session-a",
                Long.MAX_VALUE);
        verify(mockStore).advanceReplayFloor("tenant-b", "session-b",
                Long.MAX_VALUE);
    }

    @Test
    void oneFailingTargetDoesNotStopTheRest() {
        AgentStateStore mockStore = mock(AgentStateStore.class);
        when(mockStore.findReplayFloorTargets(anyInt())).thenReturn(List.of(
                new ReplayFloorTarget("tenant-a", "session-a"),
                new ReplayFloorTarget("tenant-b", "session-b")));
        doThrow(new IllegalStateException("locked")).when(mockStore)
                .advanceReplayFloor("tenant-a", "session-a", Long.MAX_VALUE);

        enabledAdvancer(mockStore).advance();

        verify(mockStore).advanceReplayFloor("tenant-b", "session-b",
                Long.MAX_VALUE);
    }

    private static ReplayFloorAdvancer enabledAdvancer(AgentStateStore store) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getEvents().setReplayFloorEnabled(true);
        return new ReplayFloorAdvancer(store, properties);
    }

    private String session(String tenant) {
        return store.insertSessionCommand(tenant, "CREATE_SESSION",
                "replay-floor-" + UUID.randomUUID(), "digest", "qwen-code",
                null, null, List.of(), "payload").sessionId();
    }

    private long append(String tenant, String sessionId, int count) {
        for (int index = 0; index < count; index++) {
            store.appendPublicEventIfAbsent(tenant, sessionId,
                    "turn_replay_floor", "test.progress",
                    Map.of("index", index), false,
                    "replay-floor:" + UUID.randomUUID());
        }
        return store.requireSession(tenant, sessionId).lastSequence();
    }

    private static String tenant() {
        return "tenant-replay-floor-" + UUID.randomUUID();
    }
}
