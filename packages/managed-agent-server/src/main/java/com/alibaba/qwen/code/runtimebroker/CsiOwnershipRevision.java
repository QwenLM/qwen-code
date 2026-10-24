package com.alibaba.qwen.code.runtimebroker;

public final class CsiOwnershipRevision {
    private CsiOwnershipRevision() {
    }

    public static boolean released(long revision) {
        return revision == 0;
    }

    public static boolean reserved(long revision) {
        return revision == 1;
    }

    public static boolean draining(long revision) {
        return revision == 2;
    }

    public static long next(long revision) {
        if (revision < 0 || revision > 1) {
            throw new IllegalArgumentException("Only the original CSI ownership transition is available.");
        }
        return Math.addExact(revision, 1);
    }
}
