package com.alibaba.qwen.code.managedagent.service;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

class RuntimeRecoveryCoordinatorTest {
    @Test
    void anErrorReleasesTheScanLatchAndStillEscapes() {
        var bindings = mock(RuntimeBindingRepository.class);
        var service = mock(RuntimeBrokerService.class);
        var coordinator = new RuntimeRecoveryCoordinator(service, bindings);
        when(bindings.findRecoveryCandidates("local-process", null, 8))
                .thenThrow(new OutOfMemoryError("probe"))
                .thenReturn(List.of());

        assertThrows(OutOfMemoryError.class, coordinator::scan);
        coordinator.scan();
        verify(bindings, times(2)).findRecoveryCandidates("local-process", null, 8);
        coordinator.close();
    }

    @Test
    void blockedFirstPageCannotStarveLaterBindingsAndBatchesNeverOverlap() {
        var bindings = mock(RuntimeBindingRepository.class);
        var service = mock(RuntimeBrokerService.class);
        var first = new ArrayList<RuntimeBindingRecord>();
        var held = new CompletableFuture<RuntimeBindingRecord>();
        for (int index = 0; index < 8; index++) {
            var binding = mock(RuntimeBindingRecord.class);
            when(binding.getBindingId()).thenReturn("binding-" + index);
            when(binding.getGeneration()).thenReturn(1L);
            first.add(binding);
            when(service.recoverBinding(binding.getBindingId(), 1L))
                    .thenReturn(index == 0 ? held : CompletableFuture.completedFuture(binding));
        }
        when(bindings.findRecoveryCandidates("local-process", null, 8)).thenReturn(first);
        var last = mock(RuntimeBindingRecord.class);
        when(last.getBindingId()).thenReturn("last");
        when(last.getGeneration()).thenReturn(2L);
        when(bindings.findRecoveryCandidates("local-process", "binding-7", 8)).thenReturn(List.of(last));
        when(service.recoverBinding("last", 2L)).thenReturn(CompletableFuture.completedFuture(last));
        var coordinator = new RuntimeRecoveryCoordinator(service, bindings);
        coordinator.scan();
        coordinator.scan();
        verify(bindings, times(1)).findRecoveryCandidates("local-process", null, 8);
        held.completeExceptionally(new IllegalStateException("original record remains uncertain"));
        coordinator.scan();
        verify(service).recoverBinding("last", 2L);
        coordinator.scan();
        verify(bindings, times(2)).findRecoveryCandidates("local-process", null, 8);
        coordinator.close();
        coordinator.scan();
        verify(bindings, times(2)).findRecoveryCandidates("local-process", null, 8);
    }
}
