package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Clock;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ContextCompressionCoordinatorTest {
    @Test
    void submittedWithoutNativeEvidenceNeverResends() {
        var fixture = new Fixture("HARNESS_SUBMITTED");
        when(fixture.records.findRecord(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(Optional.empty());
        fixture.coordinator.dispatch("tenant", "session", "operation");
        verify(fixture.harness, never()).runContextCompression(anyString(), anyString(), any());
        verify(fixture.store).awaitContextCompression(eq(fixture.operation), anyString(), eq(false), eq(null), anyLong());
    }

    @Test
    void acceptedWorkIsResumedByReadAndSettlesOnlyFromItsNativeOutcome() throws Exception {
        var fixture = new Fixture("HARNESS_ACCEPTED");
        var json = new ObjectMapper();
        var candidate = json.readTree("{\"phase\":\"candidate\"}");
        var terminal = json.readTree("{\"phase\":\"settled\",\"outcome\":\"compressed\",\"compactionRevision\":42,\"failureCode\":null}");
        when(fixture.records.findRecord(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(Optional.of(candidate), Optional.of(terminal));
        when(fixture.harness.readContextCompression("tenant", "session", "operation"))
                .thenReturn(Map.of("status", "failed", "failureCode", "untrusted_reply"));
        fixture.coordinator.dispatch("tenant", "session", "operation");
        verify(fixture.harness, never()).runContextCompression(anyString(), anyString(), any());
        verify(fixture.harness).readContextCompression("tenant", "session", "operation");
        verify(fixture.store).settleContextCompression(eq(fixture.operation), anyString(), eq("compressed"), eq(42L), eq(null));
    }

    @Test
    void localPreparationFailureDoesNotBecomeUnknownWireAcceptance() {
        var fixture = new Fixture("JAVA_DURABLE");
        when(fixture.records.findRecord(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(Optional.empty());
        when(fixture.harness.prepareContextCompression(anyString(), anyString(), any()))
                .thenThrow(new IllegalStateException("attachment temporarily unavailable"));
        fixture.coordinator.dispatch("tenant", "session", "operation");
        verify(fixture.store, never()).markContextCompressionSubmitted(any(), anyString());
        verify(fixture.harness, never()).runContextCompression(anyString(), anyString(), any());
        verify(fixture.store).retryContextCompressionPreparation(eq(fixture.operation), anyString(), anyLong());
    }

    @Test
    void nativeRecoveryBlockRemainsVisibleAsAcceptedRecoveryBlocked() throws Exception {
        var fixture = new Fixture("HARNESS_ACCEPTED");
        var blocked = new ObjectMapper().readTree("{\"phase\":\"candidate\",\"run\":{\"state\":\"recovery_blocked\"}}");
        when(fixture.records.findRecord(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(Optional.of(blocked));
        fixture.coordinator.dispatch("tenant", "session", "operation");
        verify(fixture.store).awaitContextCompression(eq(fixture.operation), anyString(), eq(true),
                eq("context_compression_recovery_blocked"), anyLong());
    }

    @Test
    void aDefinitiveBusyRefusalFailsTheOperationAndReleasesItsBarrier() {
        var fixture = new Fixture("JAVA_DURABLE");
        when(fixture.records.findRecord(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(Optional.empty());
        when(fixture.store.markContextCompressionSubmitted(eq(fixture.operation), anyString())).thenReturn(true);
        when(fixture.store.contextCompressionRequest("tenant", "session", "operation")).thenReturn(Map.of());
        var refusal = mock(com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure.class);
        when(refusal.getStatusCode()).thenReturn(409);
        when(refusal.getErrorCode()).thenReturn("session_context_busy");
        when(fixture.harness.runContextCompression(eq("tenant"), eq("session"), any())).thenThrow(refusal);
        fixture.coordinator.dispatch("tenant", "session", "operation");
        verify(fixture.store).settleContextCompression(eq(fixture.operation), anyString(), eq("failed"),
                eq(null), eq("session_context_busy"));
        verify(fixture.store, never()).awaitContextCompression(any(), anyString(), anyBoolean(), any(), anyLong());
    }

    @Test
    void freshDispatchPersistsSubmissionBeforeTheWireSend() {
        var fixture = new Fixture("JAVA_DURABLE");
        when(fixture.records.findRecord(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(Optional.empty());
        when(fixture.store.markContextCompressionSubmitted(eq(fixture.operation), anyString())).thenReturn(true);
        when(fixture.store.contextCompressionRequest("tenant", "session", "operation"))
                .thenReturn(Map.of("operationId", "operation", "expectedCompactionRevision", 0));
        fixture.coordinator.dispatch("tenant", "session", "operation");
        var order = org.mockito.Mockito.inOrder(fixture.store, fixture.harness);
        order.verify(fixture.store).markContextCompressionSubmitted(eq(fixture.operation), anyString());
        order.verify(fixture.harness).runContextCompression(eq("tenant"), eq("session"), any());
        var accepted = ArgumentCaptor.forClass(Boolean.class);
        verify(fixture.store).awaitContextCompression(eq(fixture.operation), anyString(), accepted.capture(), eq(null), anyLong());
        assertThat(accepted.getValue()).isFalse();
    }

    private static final class Fixture {
        private final AgentStateStore store = mock(AgentStateStore.class);
        private final ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
        private final HarnessConnector harness = mock(HarnessConnector.class);
        private final OperationRecord operation;
        private final ContextCompressionCoordinator coordinator;

        Fixture(String stage) {
            operation = new OperationRecord("tenant", "session", "operation", OperationKind.CONTEXT_COMPRESSION,
                    "digest", "RUNNING", stage, "LEASED", "ACTIVE", null, "owner", 1, 1);
            when(store.claimContextCompression(anyString(), anyString(), anyString(), anyString(), any()))
                    .thenReturn(Optional.of(operation));
            when(harness.prepareContextCompression(anyString(), anyString(), any())).thenAnswer(invocation ->
                    (HarnessConnector.ContextCompressionSubmission) () -> harness.runContextCompression(
                            invocation.getArgument(0), invocation.getArgument(1), invocation.getArgument(2)));
            ExecutorService executor = mock(ExecutorService.class);
            doAnswer(invocation -> {
                invocation.<Runnable>getArgument(0).run();
                return null;
            }).when(executor).execute(any());
            coordinator = new ContextCompressionCoordinator(store, records, harness, executor, Clock.systemUTC(),
                    new ManagedAgentProperties());
        }
    }
}
