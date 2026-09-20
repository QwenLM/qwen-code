package com.alibaba.qwen.code.runtimebroker;

/** Exact resource identity used for conditional drain and release. */
public final class RuntimeResourceContext {
    private final RuntimeProvisionRequest request;
    private final RuntimeProvisionSeed seed;
    private final RuntimeResourceHandle handle;
    private final RuntimeLease lease;

    public RuntimeResourceContext(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
            RuntimeLease lease) {
        if (request == null || seed == null || handle == null) {
            throw new IllegalArgumentException(
                    "request, seed, and handle are required");
        }
        this.request = request;
        this.seed = seed;
        this.handle = handle;
        this.lease = lease;
    }

    public RuntimeProvisionRequest getRequest() {
        return request;
    }

    public RuntimeProvisionSeed getSeed() {
        return seed;
    }

    public RuntimeResourceHandle getHandle() {
        return handle;
    }

    public RuntimeLease getLease() {
        return lease;
    }
}
