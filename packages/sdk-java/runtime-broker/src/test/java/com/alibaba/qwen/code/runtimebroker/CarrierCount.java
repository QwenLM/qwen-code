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
        if (configured == null) {
            return Runtime.getRuntime().availableProcessors();
        }
        // The JDK's own read is a bare Integer.parseInt, once, in
        // VirtualThread.createDefaultScheduler: no trim, no catch, no
        // clamp. A malformed value kills scheduler init there before any
        // witness can run, so leniency here would only mis-size fleets in
        // a JVM that cannot start a virtual thread at all.
        return Integer.parseInt(configured);
    }
}
