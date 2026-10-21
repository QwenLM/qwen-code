package com.alibaba.qwen.code.managedagent.event;

import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class MessageMaterializerTest {
    private static final MaterializationTarget POISON =
            new MaterializationTarget("tenant", "poison");

    @Test
    void backsOffAndRotatesAFailingTarget() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(33))
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
        when(store.findMaterializationTargets(33))
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
        when(store.findMaterializationTargets(33))
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

        // 192 is the first post-cap due streak that is not also a power of
        // two, so it separates the modulo rule from unbounded doubling.
        for (int pass = 0; pass < 64; pass++) {
            materializer.materialize();
        }
        verify(store, times(10)).materializeNextBatch("tenant", "poison",
                200);
    }

    @Test
    void aFailingDeferralDegradesOnlyItsOwnTarget() {
        AgentStateStore store = mock(AgentStateStore.class);
        // A saturated window — a 33rd row behind the TARGET_LIMIT rows —
        // with the poisoned row at its head: only then does the skip path
        // rotate, and the faulting first row is the one that must not abort
        // the pass.
        List<MaterializationTarget> targets = new ArrayList<>();
        targets.add(POISON);
        for (int i = 1; i <= 31; i++) {
            targets.add(new MaterializationTarget("tenant", "healthy-" + i));
        }
        // Row 33 is the saturation probe: the pass derives `saturated` from
        // it but must never work on it — a write would move a row the
        // selection window was only peeking at.
        targets.add(new MaterializationTarget("tenant", "probe-32"));
        when(store.findMaterializationTargets(33)).thenReturn(targets);
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
        verify(store, never()).materializeNextBatch(eq("tenant"),
                eq("probe-32"), anyInt());
        verify(store, never()).deferMaterializationTarget("tenant",
                "probe-32");
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
    void anExactlyFullWindowDoesNotRotateOnTheSkipPath() {
        AgentStateStore store = mock(AgentStateStore.class);
        // Exactly TARGET_LIMIT candidates: no row sits behind the window,
        // so the skipped pass's rotation write would move a row that is
        // selected again anyway. Only the failed attempts rotate.
        List<MaterializationTarget> targets = new ArrayList<>();
        targets.add(POISON);
        for (int i = 1; i < 32; i++) {
            targets.add(new MaterializationTarget("tenant", "healthy-" + i));
        }
        when(store.findMaterializationTargets(33)).thenReturn(targets);
        when(store.materializeNextBatch(anyString(), anyString(), anyInt()))
                .thenThrow(new IllegalStateException("gap"));
        MessageMaterializer materializer = new MessageMaterializer(store);

        // Four passes: attempts land on streaks 0, 1 and 2, and pass four
        // is the skipped one.
        for (int pass = 0; pass < 4; pass++) {
            materializer.materialize();
        }

        verify(store, times(3)).materializeNextBatch("tenant", "healthy-31",
                200);
        verify(store, times(3)).deferMaterializationTarget("tenant",
                "healthy-31");
    }

    @Test
    void clearsTheStreakAfterASuccess() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(33))
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

    @Test
    void aNotifiedSessionRunsOneBatchThroughTheSameStoreCall() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.materializeNextBatch("tenant", "notified", 200))
                .thenReturn(new MaterializationResult(true, 4L));
        MessageMaterializer materializer = new MessageMaterializer(store);

        assertThat(materializer.materializeNotified("tenant", "notified"))
                .isTrue();

        verify(store, times(1)).materializeNextBatch("tenant", "notified",
                200);
        verify(store, never()).deferMaterializationTarget(anyString(),
                anyString());
    }

    // A transport notice must never bypass the pass's backoff, or a poisoned
    // Session would warn at the event rate.
    @Test
    void aNotifiedFailureHandsTheSessionToThePassBackoff() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(33))
                .thenReturn(List.of(POISON));
        when(store.materializeNextBatch(anyString(), anyString(), anyInt()))
                .thenThrow(new IllegalStateException("gap"));
        MessageMaterializer materializer = new MessageMaterializer(store);

        assertThat(materializer.materializeNotified("tenant", "poison"))
                .isFalse();
        // Backing off now: further notices defer without touching the store.
        assertThat(materializer.materializeNotified("tenant", "poison"))
                .isFalse();
        verify(store, times(1)).materializeNextBatch("tenant", "poison",
                200);

        // The pass then owns the cadence from streak 1: due at once, and
        // after its failure the notice still defers.
        materializer.materialize();
        verify(store, times(2)).materializeNextBatch("tenant", "poison",
                200);
        assertThat(materializer.materializeNotified("tenant", "poison"))
                .isFalse();
        verify(store, times(2)).materializeNextBatch("tenant", "poison",
                200);
    }

    @Test
    void aStuckProjectionSurfacesOnceAtTheCap() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(33))
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
            // Attempts land on streaks 0, 1, 2, 4, 8, 16, 32 and 64; the
            // cap attempt (streak 64, pass 65) is the once-only surface,
            // and the later due attempts (128, 192) must not repeat it.
            for (int pass = 0; pass < 200; pass++) {
                materializer.materialize();
            }
        } finally {
            logger.detachAppender(logged);
        }

        var errors = logged.list.stream()
                .filter(event -> event.getLevel()
                        == ch.qos.logback.classic.Level.ERROR)
                .toList();
        // One line, no stack: the exponential phase already logged it seven
        // times, so the escalation is the level, not another stack dump.
        assertThat(errors).singleElement().satisfies(event -> {
            assertThat(event.getFormattedMessage())
                    .contains("projection is stuck");
            assertThat(event.getThrowableProxy()).isNull();
        });
    }

    // A saturated window is truncated: a session crowded out of this
    // pass's target list is not "gone", so its backoff must survive the
    // absence instead of restarting on its next appearance (review round
    // 12, R12-1).
    @Test
    void aCrowdedOutFailingSessionKeepsItsBackoff() {
        AgentStateStore store = mock(AgentStateStore.class);
        // Two alternating halves of a pool twice the window size: the
        // poisoned session is absent every second pass while the window
        // stays saturated throughout, so a prune-on-absence would reset
        // its streak on every absence.
        List<MaterializationTarget> pool = new ArrayList<>();
        pool.add(POISON);
        for (int i = 0; i < 65; i++) {
            pool.add(new MaterializationTarget("tenant", "healthy-" + i));
        }
        AtomicInteger pass = new AtomicInteger();
        when(store.findMaterializationTargets(33)).thenAnswer(
                invocation -> {
                    int from = pass.getAndIncrement() % 2 == 0 ? 0 : 33;
                    return new ArrayList<>(pool.subList(from, from + 33));
                });
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
            // 200 passes, 100 of them visible to the poisoned session.
            for (int i = 0; i < 200; i++) {
                materializer.materialize();
            }
        } finally {
            logger.detachAppender(logged);
        }

        // The streak accumulates across the crowded-out passes, so the
        // attempts land only on the exponential-gate streaks 0, 1, 2, 4, 8,
        // 16, 32 and 64 of the 100 visible passes; a pruned streak would
        // re-attempt on every appearance instead.
        verify(store, times(8)).materializeNextBatch("tenant", "poison",
                200);
        // The once-only surface rides the same streak: it must reach the
        // cap exactly once despite the absences (every saturated session
        // surfaces once here, so the count is scoped to the poison one).
        var errors = logged.list.stream()
                .filter(event -> event.getLevel()
                        == ch.qos.logback.classic.Level.ERROR)
                .filter(event -> event.getFormattedMessage()
                        .contains("poison"))
                .toList();
        assertThat(errors).singleElement().satisfies(event -> {
            assertThat(event.getFormattedMessage())
                    .contains("projection is stuck");
            assertThat(event.getThrowableProxy()).isNull();
        });
    }

    @Test
    void aSessionThatLeavesTheTargetListLosesItsBackoff() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.materializeNextBatch(anyString(), anyString(), anyInt()))
                .thenThrow(new IllegalStateException("gap"));
        when(store.findMaterializationTargets(33))
                .thenReturn(List.of(POISON))
                .thenReturn(List.of(POISON))
                .thenReturn(List.of(POISON))
                .thenReturn(List.of())
                .thenReturn(List.of(POISON));
        MessageMaterializer materializer = new MessageMaterializer(store);

        // Three failures take the streak to 3, which is not a due streak;
        // the pass with the session gone prunes its entry, so its return
        // attempts immediately instead of skipping on the stale streak.
        for (int pass = 0; pass < 5; pass++) {
            materializer.materialize();
        }

        verify(store, times(4)).materializeNextBatch("tenant", "poison",
                200);
    }
}
