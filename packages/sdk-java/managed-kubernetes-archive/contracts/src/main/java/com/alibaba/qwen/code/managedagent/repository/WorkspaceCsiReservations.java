package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
public interface WorkspaceCsiReservations {
    String PROVISIONER_KIND = "kubernetes-workspace";
    public record Reservation(String phase, long revision, String reservationId,
            String registrationKey, Long registrationRevision, String bindingId,
            Long runtimeGeneration, String provisionRequestId) {
    }

    Reservation inspect(WorkspaceCsiRegistration registration);
    Reservation reserve(WorkspaceCsiRegistration registration, RuntimeBindingRepository bindings,
            RuntimeBindingRecord original, String reservationId);
    boolean usesSameDataSource(RuntimeBindingRepository bindings);
    void requireRegistration(ResidentWorkspace selected);
}
