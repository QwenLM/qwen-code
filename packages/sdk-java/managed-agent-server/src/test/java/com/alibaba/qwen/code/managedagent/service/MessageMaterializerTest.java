package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.atLeast;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
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
        // 1, 2, 4, 8, ... and rotates to the back of the queue otherwise.
        for (int pass = 0; pass < 9; pass++) {
            materializer.materialize();
        }

        verify(store, times(5)).materializeNextBatch("tenant", "poison",
                200);
        verify(store, atLeast(8)).deferMaterializationTarget("tenant",
                "poison");
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
        MaterializationTarget healthy =
                new MaterializationTarget("tenant", "healthy");
        when(store.findMaterializationTargets(32))
                .thenReturn(List.of(POISON, healthy));
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
            // Pass one poisons the target; pass two retries it (streak 1 is
            // due) and exercises the catch-path deferral, both throwing.
            // Catching the escape keeps the verdict on the assertions below
            // rather than on which call threw.
            try {
                materializer.materialize();
                materializer.materialize();
            } catch (RuntimeException escaped) {
                // An unguarded deferral lets the store fault escape the pass.
            }
        } finally {
            logger.detachAppender(logged);
        }

        // A store fault while deferring must not abort the pass: the healthy
        // target is still attempted on every pass, and the WARN still names
        // the poisoned session.
        verify(store, times(2)).materializeNextBatch("tenant", "healthy",
                200);
        assertThat(logged.list).anySatisfy(event -> {
            assertThat(event.getLevel())
                    .isEqualTo(ch.qos.logback.classic.Level.WARN);
            assertThat(event.getFormattedMessage())
                    .contains("Failed to materialize Managed Agent session")
                    .contains("poison");
        });
    }

    @Test
    void clearsTheStreakAfterASuccess() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(32))
                .thenReturn(List.of(POISON));
        when(store.materializeNextBatch(anyString(), anyString(), anyInt()))
                .thenThrow(new IllegalStateException("gap"))
                .thenReturn(new MaterializationResult(true, 1L),
                        new MaterializationResult(true, 2L));
        MessageMaterializer materializer = new MessageMaterializer(store);

        materializer.materialize();
        materializer.materialize();
        materializer.materialize();

        // fail, retry-and-succeed, then a normal pass: full attempts, and
        // the only rotation is the first failure's catch-path deferral — a
        // due retry does not write the progress row ahead of the attempt.
        verify(store, times(3)).materializeNextBatch("tenant", "poison",
                200);
        verify(store, times(1)).deferMaterializationTarget("tenant",
                "poison");
    }
}
