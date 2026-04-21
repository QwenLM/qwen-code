package com.alibaba.qwen.code.cli.utils;

import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * Configuration for the thread pool used by the SDK.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class ThreadPoolConfig {
    private static final ThreadPoolExecutor defaultExecutor = new ThreadPoolExecutor(
            30, 100, 60L, TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(300),
            new ThreadFactory() {
                private final AtomicInteger threadNumber = new AtomicInteger(1);

                @Override
                public Thread newThread(Runnable r) {
                    Thread t = new Thread(r, "qwen_code_cli-pool-" + threadNumber.getAndIncrement());
                    t.setDaemon(false);
                    return t;
                }
            },
            new ThreadPoolExecutor.CallerRunsPolicy()  // 拒绝策略
    );

    private static Supplier<ThreadPoolExecutor> executorSupplier;

    /**
     * Sets the supplier for the executor.
     *
     * @param executorSupplier The supplier for the executor
     */
    public static void setExecutorSupplier(Supplier<ThreadPoolExecutor> executorSupplier) {
        ThreadPoolConfig.executorSupplier = executorSupplier;
    }

    /**
     * Gets the default executor.
     *
     * @return The default executor
     */
    public static ThreadPoolExecutor getDefaultExecutor() {
        return defaultExecutor;
    }

    static ExecutorService getExecutor() {
        return Optional.ofNullable(executorSupplier).map(s -> {
            try {
                return s.get();
            } catch (Exception e) {
                return defaultExecutor;
            }
        }).orElse(defaultExecutor);
    }
}
