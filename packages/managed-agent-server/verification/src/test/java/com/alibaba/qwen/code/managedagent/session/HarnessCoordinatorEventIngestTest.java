package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.Admission;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class HarnessCoordinatorEventIngestTest {
    private static final List<Map<String, Object>> INPUT = List.of(Map.of("type", "text", "text", "hello"));
    private static final String DIGEST = "sha256:" + "a".repeat(64);
    private final AgentStateStore store = mock(AgentStateStore.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private final TurnRecord claimed = turn("ACCEPTED", null, null);

    @BeforeEach
    void setUp() {
        when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(claimed));
        when(store.requireSession("tenant", "session")).thenReturn(new SessionRecord("tenant", "session",
                "qwen-code", null, "ACTIVE", null, null, 0, 0, 0, 0, null, 1));
        when(store.bindHarness(eq("tenant"), eq("session"), eq("turn"), anyString(), eq("boot-1")))
                .thenReturn(true);
        when(store.findTurn("tenant", "session", "turn")).thenReturn(Optional.of(claimed));
        when(harness.createOrLoad("tenant", "session", false)).thenReturn(new Attachment("boot-1", null, null, null));
    }

    @Test
    void handsAFreshSubmissionToTheHarnessWithoutOpeningAStream() {
        when(harness.supportsEventIngest()).thenReturn(true);
        when(harness.submit("tenant", "session", "prompt", INPUT, DIGEST, "turn")).thenReturn(new Admission(4, "epoch-1"));
        when(store.recordAdmissionHandOff(eq("tenant"), eq("session"), eq("turn"), anyString(), eq("epoch-1"),
                eq(4L), eq("harness:boot-1"), any(Duration.class))).thenReturn(true);

        dispatch(true);

        verify(store).recordAdmissionHandOff(eq("tenant"), eq("session"), eq("turn"), anyString(), eq("epoch-1"),
                eq(4L), eq("harness:boot-1"), eq(Duration.ofSeconds(60)));
        verify(store, never()).recordAdmission(anyString(), anyString(), anyString(), anyString(), anyString(),
                anyLong());
        verify(store, never()).releaseTurnLease(anyString(), anyString(), anyString(), anyString());
        verify(harness, never()).stream(anyString(), anyString(), anyLong(), anyString());
    }

    @Test
    void keepsATurnCancelledBeforeItsAdmissionOnTheStream() {
        when(harness.supportsEventIngest()).thenReturn(true);
        when(harness.submit("tenant", "session", "prompt", INPUT, DIGEST, "turn")).thenReturn(new Admission(4, "epoch-1"));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed), Optional.of(turn("CANCELLING", "epoch-1", 4L)));
        when(harness.stream("tenant", "session", 4, "epoch-1")).thenThrow(new IllegalStateException("stop"));

        dispatch(true);

        verify(store).recordAdmissionHandOff(eq("tenant"), eq("session"), eq("turn"), anyString(), eq("epoch-1"),
                eq(4L), eq("harness:boot-1"), any(Duration.class));
        verify(harness).cancel("tenant", "session");
        verify(harness).stream("tenant", "session", 4, "epoch-1");
    }

    @ParameterizedTest
    @CsvSource({"false, true", "true, false"})
    void streamsWhenIngestIsOffOrUnsupported(boolean enabled, boolean supported) {
        when(harness.supportsEventIngest()).thenReturn(supported);
        when(harness.submit("tenant", "session", "prompt", INPUT, DIGEST)).thenReturn(new Admission(4, "epoch-1"));
        when(store.findTurn("tenant", "session", "turn"))
                .thenReturn(Optional.of(claimed), Optional.of(turn("RUNNING", "epoch-1", 4L)));
        when(harness.stream("tenant", "session", 4, "epoch-1")).thenThrow(new IllegalStateException("stop"));

        dispatch(enabled);

        verify(store).recordAdmission(eq("tenant"), eq("session"), eq("turn"), anyString(), eq("epoch-1"), eq(4L));
        verify(store, never()).recordAdmissionHandOff(anyString(), anyString(), anyString(), anyString(),
                anyString(), anyLong(), anyString(), any(Duration.class));
        verify(harness, never()).submit(anyString(), anyString(), anyString(), any(), anyString(), anyString());
        verify(harness).stream("tenant", "session", 4, "epoch-1");
    }

    private void dispatch(boolean ingestEnabled) {
        HarnessCoordinator coordinator = new HarnessCoordinator(store, harness, new HarnessEventProjector(),
                mock(RuntimeWarmer.class), CoordinatorTestSupport.directExecutor(), Clock.systemUTC(),
                new ManagedAgentProperties());
        ReflectionTestUtils.setField(coordinator, "eventIngestEnabled", ingestEnabled);
        try {
            coordinator.dispatch("tenant", "session", "turn");
        } finally {
            coordinator.close();
        }
    }

    private static TurnRecord turn(String status, String eventEpoch, Long lastEventId) {
        return new TurnRecord("tenant", "session", "turn", "prompt", INPUT, DIGEST, status, false, eventEpoch,
                lastEventId, "previous-owner", Long.MAX_VALUE, 0, 0, 0, null, null, null, 1, 1, null, 1);
    }
}
