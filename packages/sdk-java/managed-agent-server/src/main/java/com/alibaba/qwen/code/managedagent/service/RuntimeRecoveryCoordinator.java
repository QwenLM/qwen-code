package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Bounded maintenance of saved local bindings, independent of product Session authorization. */
final class RuntimeRecoveryCoordinator implements AutoCloseable {
    private static final Logger LOG = LoggerFactory.getLogger(RuntimeRecoveryCoordinator.class);
    private static final int BATCH_SIZE = 8;
    private final RuntimeBrokerService service;
    private final RuntimeBindingRepository bindings;
    private final AtomicBoolean running = new AtomicBoolean();
    private volatile boolean closed;
    private String cursor;

    RuntimeRecoveryCoordinator(RuntimeBrokerService service, RuntimeBindingRepository bindings) {
        this.service = service;
        this.bindings = bindings;
    }

    void scan() {
        if (closed || !running.compareAndSet(false, true)) {
            return;
        }
        try {
            var candidates = bindings.findRecoveryCandidates("local-process", cursor, BATCH_SIZE);
            cursor = candidates.size() < BATCH_SIZE ? null : candidates.getLast().getBindingId();
            CompletableFuture<?>[] operations = candidates.stream().map(binding -> {
                try {
                    return service.recoverBinding(binding.getBindingId(), binding.getGeneration())
                            .exceptionally(error -> null).toCompletableFuture();
                } catch (RuntimeException error) {
                    return CompletableFuture.completedFuture(null);
                }
            }).toArray(CompletableFuture<?>[]::new);
            CompletableFuture.allOf(operations).whenComplete((ignored, error) -> running.set(false));
        } catch (RuntimeException error) {
            running.set(false);
            LOG.warn("Saved Runtime recovery scan could not read its next batch", error);
        } catch (Error error) {
            // An Error must never leave the latch stuck; release it, then rethrow.
            running.set(false);
            throw error;
        }
    }

    @Override
    public void close() {
        closed = true;
    }
}
