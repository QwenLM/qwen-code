package com.alibaba.qwen.code.managedagent.store;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;

/** Database-backed verification uses a separate, bounded pool from retention. */
public final class ToolPublicationVerifier implements AutoCloseable {
    private static final Logger LOG = LoggerFactory.getLogger(ToolPublicationVerifier.class);
    private final ToolPublicationDataStore data;
    private final ThreadPoolExecutor executor;
    private final Semaphore slots;
    private final int concurrency;
    private volatile boolean closed;

    public ToolPublicationVerifier(ToolPublicationDataStore data, int concurrency) {
        ToolPublicationContract.require(concurrency > 0, "Invalid verification concurrency");
        this.data = data;
        this.concurrency = concurrency;
        slots = new Semaphore(concurrency);
        executor = new ThreadPoolExecutor(concurrency, concurrency, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(concurrency), Thread.ofPlatform()
                        .name("managed-tool-verification-", 0).factory());
        data.setVerificationWakeup(this::wake);
    }

    @Scheduled(fixedDelay = 1000, scheduler = "managedToolVerificationScheduler")
    public void wake() {
        for (int i = 0; i < concurrency && !closed && slots.tryAcquire(); i++) {
            try {
                executor.execute(() -> {
                    try {
                        while (!closed && runOnce()) {
                            // Drain immediately instead of delaying each sequential upload by a tick.
                        }
                    } finally {
                        slots.release();
                    }
                });
            } catch (java.util.concurrent.RejectedExecutionException error) {
                slots.release();
                if (!closed) {
                    throw error;
                }
            }
        }
    }

    public boolean runOnce() {
        try {
            return data.verifyNextOperation();
        } catch (RuntimeException error) {
            LOG.warn("Tool publication verification will retry failure={}", error.getClass().getSimpleName());
            return false;
        }
    }

    @Override
    public void close() {
        closed = true;
        data.setVerificationWakeup(() -> {});
        executor.shutdownNow();
    }
}
