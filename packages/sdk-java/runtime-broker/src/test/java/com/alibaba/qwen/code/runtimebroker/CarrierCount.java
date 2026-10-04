package com.alibaba.qwen.code.runtimebroker;

/**
 * Resolves the virtual-thread scheduler's carrier count the way the JDK
 * does: {@code jdk.virtualThreadScheduler.parallelism} parsed base-10,
 * falling back to the processor count. {@code Integer.getInteger} resolves
 * through {@code Integer.decode}, so a value like {@code 0100} would read
 * as 64 while the JVM builds 100 carriers — every pinning witness must
 * size its fleet from this one read or a misspelled property falsifies it.
 */
final class CarrierCount {
    private CarrierCount() {
    }

    static int resolve() {
        String configured =
                System.getProperty("jdk.virtualThreadScheduler.parallelism");
        if (configured != null) {
            try {
                return Math.max(1, Integer.parseInt(configured.trim()));
            } catch (NumberFormatException ignored) {
                // Fall through to the processor-count default.
            }
        }
        return Math.max(1, Runtime.getRuntime().availableProcessors());
    }
}
