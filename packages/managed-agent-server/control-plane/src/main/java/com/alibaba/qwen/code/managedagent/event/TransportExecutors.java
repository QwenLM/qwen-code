package com.alibaba.qwen.code.managedagent.event;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * The transport roles' off-thread work: a fixed pool over a bounded queue that
 * refuses, never blocks, when full — each caller logs what it dropped and SQL
 * recovers it.
 */
final class TransportExecutors {
    private TransportExecutors() {
    }

    static ExecutorService bounded(ThreadFactory threads, int size,
            int queue) {
        return new ThreadPoolExecutor(size, size, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(queue), threads,
                new ThreadPoolExecutor.AbortPolicy());
    }

    /**
     * Shuts a pool down, waiting briefly for work in flight; a plain
     * {@link Executor} (a test's synchronous one) has nothing to stop.
     */
    static void close(Executor executor) {
        if (executor instanceof ExecutorService service) {
            service.shutdown();
            try {
                service.awaitTermination(2, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }
}
