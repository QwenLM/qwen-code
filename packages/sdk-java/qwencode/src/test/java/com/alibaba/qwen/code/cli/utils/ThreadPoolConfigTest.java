package com.alibaba.qwen.code.cli.utils;

import com.alibaba.qwen.code.cli.example.ThreadPoolConfigurationExample;
import java.util.concurrent.ThreadPoolExecutor;
import org.junit.jupiter.api.Test;

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
        ThreadPoolConfigurationExample.runCustomSupplierExample();
        ThreadPoolExecutor first = (ThreadPoolExecutor) ThreadPoolConfig.getExecutor();
        ThreadPoolExecutor second = (ThreadPoolExecutor) ThreadPoolConfig.getExecutor();

        try {
            assertSame(first, second);
            assertTrue(first.getThreadFactory().newThread(() -> {
            }).isDaemon());
        } finally {
            ThreadPoolConfig.setExecutorSupplier(null);
        }
    }
}
