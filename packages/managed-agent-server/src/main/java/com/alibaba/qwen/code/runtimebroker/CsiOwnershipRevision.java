package com.alibaba.qwen.code.runtimebroker;

public final class CsiOwnershipRevision {
    private static final long MAXIMUM = 9_007_199_254_740_990L;

    private CsiOwnershipRevision() {
    }

    public static boolean released(long revision) {
        return revision >= 0 && revision <= MAXIMUM && revision % 3 == 0;
    }

    public static boolean reserved(long revision) {
        return revision > 0 && revision <= MAXIMUM && revision % 3 == 1;
    }

    public static boolean draining(long revision) {
        return revision > 0 && revision <= MAXIMUM && revision % 3 == 2;
    }

    public static long next(long revision) {
        if (revision < 0 || revision >= MAXIMUM) {
            throw new IllegalArgumentException("CSI ownership revision is exhausted or invalid.");
        }
        return Math.addExact(revision, 1);
    }
}
