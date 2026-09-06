package com.alibaba.acp.sdk.utils;

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
