package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class HttpSupportTest {
    @Test
    void errorReaderLeavesStreamClosureToItsOwner() {
        AtomicInteger closes = new AtomicInteger();
        ByteArrayInputStream input = new ByteArrayInputStream(
                "error".getBytes(StandardCharsets.UTF_8)) {
            @Override
            public void close() {
                closes.incrementAndGet();
            }
        };

        assertEquals("error", HttpSupport.readError(input, "test"));
        assertEquals(0, closes.get());
    }
}
