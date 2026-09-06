package com.alibaba.qwen.code.cli.utils;

import com.alibaba.qwen.code.cli.example.ThreadPoolConfigurationExample;
import java.util.concurrent.ThreadPoolExecutor;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ThreadPoolConfigTest {

    @Test
    void defaultExecutorCreatesDaemonThreads() {
        Thread thread = ThreadPoolConfig.getDefaultExecutor()
                .getThreadFactory()
                .newThread(() -> {
                });

        assertTrue(thread.isDaemon());
    }

    @Test
    void customSupplierExampleReusesDaemonExecutor() {
        ThreadPoolExecutor defaultExecutor = ThreadPoolConfig.getDefaultExecutor();
        ThreadPoolConfigurationExample.runCustomSupplierExample();
        ThreadPoolExecutor first = (ThreadPoolExecutor) ThreadPoolConfig.getExecutor();
        ThreadPoolExecutor second = (ThreadPoolExecutor) ThreadPoolConfig.getExecutor();

        try {
            assertNotSame(defaultExecutor, first);
            assertSame(first, second);
            assertTrue(first.getThreadFactory().newThread(() -> {
            }).isDaemon());
        } finally {
            ThreadPoolConfig.setExecutorSupplier(null);
        }
    }
}
