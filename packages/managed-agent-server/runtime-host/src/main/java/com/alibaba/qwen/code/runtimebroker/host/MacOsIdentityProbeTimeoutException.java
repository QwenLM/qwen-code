package com.alibaba.qwen.code.runtimebroker.host;

import java.io.IOException;

/** The native identity command did not finish before its deadline. */
public final class MacOsIdentityProbeTimeoutException extends IOException {
    public MacOsIdentityProbeTimeoutException(String message) {
        super(message);
    }
}
