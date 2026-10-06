package com.alibaba.qwen.code.managedagent.service;

import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.atLeast;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import java.util.List;
import org.junit.jupiter.api.Test;

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
        // the deferred rotation left the row alone once healthy.
        verify(store, times(3)).materializeNextBatch("tenant", "poison",
                200);
        verify(store, times(2)).deferMaterializationTarget("tenant",
                "poison");
    }
}
