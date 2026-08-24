package com.alibaba.qwen.code.cli.utils;

import org.junit.jupiter.api.Test;

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
}
