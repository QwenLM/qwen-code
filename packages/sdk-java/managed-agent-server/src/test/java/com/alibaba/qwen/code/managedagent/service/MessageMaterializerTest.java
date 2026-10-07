package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;

class MessageMaterializerTest {
    private static final MaterializationTarget POISON =
            new MaterializationTarget("tenant", "poison");

    @Test
    void backsOffAndRotatesAFailingTarget() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(32))
                .thenReturn(List.of(POISON));
        when(store.materializeNextBatch(anyString(), anyString(), anyInt()))
                .thenThrow(new IllegalStateException("gap"));
        MessageMaterializer materializer = new MessageMaterializer(store);

        // A hard-poisoned target used to head every pass at 10 Hz and starve
        // every healthy session behind it; now it retries on streaks
        // 1, 2, 4, 8, ... and a failed attempt rotates it to the back of
        // the queue. Nine passes attempt on streaks 1, 2, 4 and 8 plus the
        // first look and write one rotation each. The skipped passes write
        // nothing: this single-row window is below TARGET_LIMIT, so the row
        // would be selected again with or without the write.
        for (int pass = 0; pass < 9; pass++) {
            materializer.materialize();
        }

        verify(store, times(5)).materializeNextBatch("tenant", "poison",
                200);
        verify(store, times(5)).deferMaterializationTarget("tenant",
                "poison");
    }

    @Test
    void warnsWithTheStackOnlyDuringTheExponentialPhase() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(32))
                .thenReturn(List.of(POISON));
        when(store.materializeNextBatch(anyString(), anyString(), anyInt()))
                .thenThrow(new IllegalStateException("gap"));
        MessageMaterializer materializer = new MessageMaterializer(store);
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                        .getLogger(MessageMaterializer.class);
        ch.qos.logback.core.read.ListAppender<
                ch.qos.logback.classic.spi.ILoggingEvent> logged =
                        new ch.qos.logback.core.read.ListAppender<>();
        logged.start();
        logger.addAppender(logged);
        try {
            // Attempts land on streaks 0, 1, 2, 4, 8, 16, 32, 64 and 128;
            // only the seven exponential ones keep the stack.
            for (int pass = 0; pass < 129; pass++) {
                materializer.materialize();
            }
        } finally {
            logger.detachAppender(logged);
        }

        verify(store, times(9)).materializeNextBatch("tenant", "poison",
                200);
        long stacked = logged.list.stream()
                .filter(event -> event.getThrowableProxy() != null).count();
        assertThat(stacked).isEqualTo(7);
        // The two steady-state attempts still surface, as one-line WARNs.
        long steady = logged.list.stream()
                .filter(event -> event.getThrowableProxy() == null)
                .filter(event -> event.getFormattedMessage()
                        .contains("Failed to materialize"))
                .count();
        assertThat(steady).isEqualTo(2);
    }

    @Test
    void atTheCapRetriesOnceEveryMaxStreakPasses() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(32))
                .thenReturn(List.of(POISON));
        when(store.materializeNextBatch(anyString(), anyString(), anyInt()))
                .thenThrow(new IllegalStateException("gap"));
        MessageMaterializer materializer = new MessageMaterializer(store);

        // Attempts land on streaks 0, 1, 2, 4, 8, 16 and 32; the streak
        // reaches the 64 cap after 64 passes.
        for (int pass = 0; pass < 64; pass++) {
            materializer.materialize();
        }
        verify(store, times(7)).materializeNextBatch("tenant", "poison",
                200);

        // At the cap the gate retries once every MAX_BACKOFF_STREAK passes
        // instead of attempting and warning on every pass.
        for (int pass = 0; pass < 64; pass++) {
            materializer.materialize();
        }
        verify(store, times(8)).materializeNextBatch("tenant", "poison",
                200);
        materializer.materialize();
        verify(store, times(9)).materializeNextBatch("tenant", "poison",
                200);
    }

    @Test
    void aFailingDeferralDegradesOnlyItsOwnTarget() {
        AgentStateStore store = mock(AgentStateStore.class);
        // A saturated window (TARGET_LIMIT rows) with the poisoned row at
        // its head: only a full window rotates on the skip path, and the
        // faulting first row is the one that must not abort the pass.
        List<MaterializationTarget> targets = new ArrayList<>();
        targets.add(POISON);
        for (int i = 1; i < 32; i++) {
            targets.add(new MaterializationTarget("tenant", "healthy-" + i));
        }
        when(store.findMaterializationTargets(32)).thenReturn(targets);
        when(store.materializeNextBatch(anyString(), anyString(), anyInt()))
                .thenThrow(new IllegalStateException("gap"));
        doThrow(new DataAccessResourceFailureException("lock wait"))
                .when(store)
                .deferMaterializationTarget(anyString(), anyString());
        MessageMaterializer materializer = new MessageMaterializer(store);
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                        .getLogger(MessageMaterializer.class);
        ch.qos.logback.core.read.ListAppender<
                ch.qos.logback.classic.spi.ILoggingEvent> logged =
                        new ch.qos.logback.core.read.ListAppender<>();
        logged.start();
        logger.addAppender(logged);
        try {
            // Four passes: attempts land on streaks 0, 1 and 2, and streak
            // 3 is the first non-due streak, so pass four is the first that
            // exercises the skip-path deferral — under a fault, and in a
            // saturated window so the rotation actually fires. Catching the
            // escape keeps the verdict on the assertions below rather than
            // on which call threw.
            try {
                for (int pass = 0; pass < 4; pass++) {
                    materializer.materialize();
                }
            } catch (RuntimeException escaped) {
                // An unguarded deferral lets the store fault escape the pass.
            }
        } finally {
            logger.detachAppender(logged);
        }

        // A store fault while deferring must not abort the pass: the tail
        // target is still attempted on every due pass and still rotated on
        // the skipped one — three catch-path rotations plus one skip-path
        // rotation, and the WARNs still name the failing sessions.
        verify(store, times(3)).materializeNextBatch("tenant", "healthy-31",
                200);
        verify(store, times(4)).deferMaterializationTarget("tenant",
                "healthy-31");
        assertThat(logged.list).anySatisfy(event -> {
            assertThat(event.getLevel())
                    .isEqualTo(ch.qos.logback.classic.Level.WARN);
            assertThat(event.getFormattedMessage())
                    .contains("Failed to materialize Managed Agent session")
                    .contains("poison");
        });
        // The rotation failure is logged, and never with a stack: a
        // persistently faulting deferral must not bury the one-line signal
        // at scheduler rate.
        assertThat(logged.list).anySatisfy(event -> {
            assertThat(event.getLevel())
                    .isEqualTo(ch.qos.logback.classic.Level.WARN);
            assertThat(event.getFormattedMessage())
                    .contains("Failed to defer Managed Agent session")
                    .contains("poison");
        });
        assertThat(logged.list.stream()
                .filter(event -> event.getFormattedMessage()
                        .contains("Failed to defer")))
                .allSatisfy(event -> assertThat(event.getThrowableProxy())
                        .isNull());
    }

    @Test
    void clearsTheStreakAfterASuccess() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(32))
                .thenReturn(List.of(POISON));
        when(store.materializeNextBatch(anyString(), anyString(), anyInt()))
                .thenThrow(new IllegalStateException("gap"))
                .thenThrow(new IllegalStateException("gap"))
                .thenThrow(new IllegalStateException("gap"))
                .thenReturn(new MaterializationResult(true, 1L))
                .thenThrow(new IllegalStateException("gap"))
                .thenReturn(new MaterializationResult(true, 2L));
        MessageMaterializer materializer = new MessageMaterializer(store);

        // Seven passes: fail on 1-3, pass 4 skips because streak 3 is not
        // due, pass 5 succeeds and must clear the streak, pass 6 fails and
        // pass 7 retries on streak 1 — six attempts. Without the reset
        // pass 7 would read streak 5, skip, and the count would be five.
        for (int pass = 0; pass < 7; pass++) {
            materializer.materialize();
        }

        verify(store, times(6)).materializeNextBatch("tenant", "poison",
                200);
        // One rotation per failed attempt; the skipped pass 4 writes
        // nothing below TARGET_LIMIT, and a due retry does not write the
        // progress row ahead of the attempt.
        verify(store, times(4)).deferMaterializationTarget("tenant",
                "poison");
    }
}
