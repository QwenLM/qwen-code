package com.alibaba.qwen.code.runtimebroker;

/**
 * Resolves the virtual-thread scheduler's carrier count from the JDK's
 * parallelism read: {@code jdk.virtualThreadScheduler.parallelism} parsed
 * base-10, falling back to the processor count. {@code Integer.getInteger}
 * resolves through {@code Integer.decode}, so a value like {@code 0100}
 * would read as 64 while the JVM builds 100 carriers — every pinning
 * witness must size its fleet from this one read or a misspelled property
 * falsifies it. This models the parallelism read alone: the JDK also
 * clamps it down to {@code jdk.virtualThreadScheduler.maxPoolSize} when
 * that is set, so an externally capped pool makes this read too high.
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
        // The JDK's own read of parallelism is a bare Integer.parseInt,
        // once, in VirtualThread.createDefaultScheduler: no trim, no
        // catch. A malformed value kills scheduler init there before any
        // witness can run, so leniency here would only mis-size fleets in
        // a JVM that cannot start a virtual thread at all. This models
        // parallelism alone: the JDK also clamps it down to
        // jdk.virtualThreadScheduler.maxPoolSize when that is set, so an
        // externally capped pool makes this read too high.
        return Integer.parseInt(configured);
    }
}
