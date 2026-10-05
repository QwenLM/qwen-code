package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

// Pins CarrierCount's base-10 read of the scheduler property: the JDK
// parses jdk.virtualThreadScheduler.parallelism base-10 while
// Integer.getInteger resolves through Integer.decode, so "0100" must
// read as 100 — an under-read fleet is the one error direction no
// pinning witness can detect. The property is restored after each test
// because surefire reuses one fork for the module and the witnesses size
// their fleets from CarrierCount.resolve() at call time.
final class CarrierCountTest {
    private static final String KEY =
            "jdk.virtualThreadScheduler.parallelism";
    private String saved;

    @BeforeEach
    void save() {
        saved = System.getProperty(KEY);
    }

    @AfterEach
    void restore() {
        if (saved == null) {
            System.clearProperty(KEY);
        } else {
            System.setProperty(KEY, saved);
        }
    }

    @Test
    void readsTheSchedulerPropertyBaseTen() {
        System.setProperty(KEY, "0100");
        // Integer.getInteger would decode this as octal 64.
        assertEquals(100, CarrierCount.resolve());
    }

    @Test
    void trimsBeforeParsing() {
        System.setProperty(KEY, " 8 ");
        assertEquals(8, CarrierCount.resolve());
    }

    @Test
    void fallsBackToTheProcessorCount() {
        int fallback =
                Math.max(1, Runtime.getRuntime().availableProcessors());
        System.setProperty(KEY, "abc");
        assertEquals(fallback, CarrierCount.resolve());
        System.clearProperty(KEY);
        assertEquals(fallback, CarrierCount.resolve());
    }
}
