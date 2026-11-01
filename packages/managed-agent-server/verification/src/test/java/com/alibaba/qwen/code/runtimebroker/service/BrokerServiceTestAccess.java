package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;

import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

public final class BrokerServiceTestAccess {
    private BrokerServiceTestAccess() { }

    public static RuntimeBrokerService create(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration,
            RuntimePublicationVerifier publicationVerifier,
            Duration v3ResultWindow) {
        return new RuntimeBrokerService(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId, operationLeaseDuration,
                dispatchLeaseDuration, publicationVerifier, v3ResultWindow);
    }

    public static RuntimeBrokerService create(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration, Clock clock,
            Supplier<String> executionIdSupplier) {
        return new RuntimeBrokerService(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId, operationLeaseDuration,
                dispatchLeaseDuration, clock, executionIdSupplier);
    }

    static RuntimeBindingRegistry registry(RuntimeBrokerService service) throws ReflectiveOperationException {
        var field = RuntimeBrokerService.class.getDeclaredField("bindingRegistry");
        field.setAccessible(true);
        return (RuntimeBindingRegistry) field.get(service);
    }

    public static void installSession(RuntimeBrokerService service, RuntimeSession session,
            RuntimeBindingRecord binding, RuntimeLease lease) throws ReflectiveOperationException {
        registry(service).registerSession(session.getRuntimeSessionId(), CompletableFuture.completedFuture(
                new RuntimeBindingRegistry.SessionContext(session, binding, lease)));
    }

    public static long pollDelay(int attempt) { return RuntimeBrokerService.v3PollDelayMillis(attempt); }
    public static final java.time.Duration UNKNOWN_LOOKUP_COOLDOWN = ExecutionObservationCooldown.WINDOW;
}
