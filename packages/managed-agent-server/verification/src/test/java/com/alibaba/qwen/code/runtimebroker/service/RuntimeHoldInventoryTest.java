package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolHoldRow;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Unit coverage for the tool-hold seam extracted from RuntimeBrokerService:
 * the durable hold inventory. The integrated behavior stays covered by
 * RuntimeBrokerServiceTest, BindingExecutionInventoryTest and
 * ExecutionTakeoverContract.
 */
class RuntimeHoldInventoryTest {
    private final ToolExecutionRepository executionRepository = mock(ToolExecutionRepository.class);
    private final RuntimeSessionRepository sessionRepository = mock(RuntimeSessionRepository.class);
    private final RuntimeHoldInventory inventory =
            new RuntimeHoldInventory(executionRepository, sessionRepository);

    private static ToolHoldRow row(String callId, String sessionId) {
        return new ToolHoldRow(callId, sessionId);
    }

    private static RuntimeSessionRecord session(String sessionId, RuntimeSessionRecord.State state) {
        RuntimeSessionRecord record = mock(RuntimeSessionRecord.class);
        when(record.getRuntimeSessionId()).thenReturn(sessionId);
        when(record.getState()).thenReturn(state);
        return record;
    }

    @Test
    void anEmptyLedgerHoldsNothing() {
        when(executionRepository.findHoldRowsByHarnessSession(eq("hs"), isNull(), eq(100)))
                .thenReturn(List.of());
        assertThat(inventory.activeRuntimeSessionIds("hs", "tenant")).isEmpty();
    }

    @Test
    void aDurablyReleasedSessionIsDischarged() {
        when(executionRepository.findHoldRowsByHarnessSession(eq("hs"), isNull(), eq(100)))
                .thenReturn(List.of(row("e1", "sA"), row("e2", "sB"), row("e3", "sC")));
        RuntimeSessionRecord released = session("sB", RuntimeSessionRecord.State.RELEASED);
        when(sessionRepository.findHistoricalByIds(eq("tenant"), eq("hs"), anyList()))
                .thenReturn(List.of(released));
        assertThat(inventory.activeRuntimeSessionIds("hs", "tenant"))
                .containsExactly("sA", "sC");
    }

    @Test
    void aMissingRecordIsNotADurableRelease() {
        when(executionRepository.findHoldRowsByHarnessSession(eq("hs"), isNull(), eq(100)))
                .thenReturn(List.of(row("e1", "sA"), row("e2", "sB")));
        // Only sA has a historical record; sB's release was never recorded.
        RuntimeSessionRecord released = session("sA", RuntimeSessionRecord.State.RELEASED);
        when(sessionRepository.findHistoricalByIds(eq("tenant"), eq("hs"), anyList()))
                .thenReturn(List.of(released));
        assertThat(inventory.activeRuntimeSessionIds("hs", "tenant"))
                .containsExactly("sB");
    }

    @Test
    void aNonReleasedHistoricalSessionStillHolds() {
        when(executionRepository.findHoldRowsByHarnessSession(eq("hs"), isNull(), eq(100)))
                .thenReturn(List.of(row("e1", "sA")));
        RuntimeSessionRecord live = session("sA", RuntimeSessionRecord.State.READY);
        when(sessionRepository.findHistoricalByIds(eq("tenant"), eq("hs"), anyList()))
                .thenReturn(List.of(live));
        assertThat(inventory.activeRuntimeSessionIds("hs", "tenant"))
                .containsExactly("sA");
    }

    @Test
    void paginationFollowsTheLastCallIdCursor() {
        List<ToolHoldRow> first = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            first.add(row("e" + i, "s" + i));
        }
        when(executionRepository.findHoldRowsByHarnessSession(eq("hs"), isNull(), eq(100)))
                .thenReturn(first);
        when(executionRepository.findHoldRowsByHarnessSession(eq("hs"), eq("e99"), eq(100)))
                .thenReturn(List.of(row("e100", "s100")));
        when(sessionRepository.findHistoricalByIds(eq("tenant"), eq("hs"), anyList()))
                .thenReturn(List.of());
        List<String> held = inventory.activeRuntimeSessionIds("hs", "tenant");
        assertThat(held).hasSize(101).contains("s0", "s99", "s100");
        verify(executionRepository).findHoldRowsByHarnessSession("hs", null, 100);
        verify(executionRepository).findHoldRowsByHarnessSession("hs", "e99", 100);
    }

    @Test
    void duplicateHoldRowsCollapseToOneSession() {
        when(executionRepository.findHoldRowsByHarnessSession(eq("hs"), isNull(), eq(100)))
                .thenReturn(List.of(row("e1", "sA"), row("e2", "sA")));
        when(sessionRepository.findHistoricalByIds(eq("tenant"), eq("hs"), anyList()))
                .thenReturn(List.of());
        assertThat(inventory.activeRuntimeSessionIds("hs", "tenant"))
                .containsExactly("sA");
    }
}
