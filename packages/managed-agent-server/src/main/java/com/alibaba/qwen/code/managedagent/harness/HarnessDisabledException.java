package com.alibaba.qwen.code.managedagent.harness;

// Signals a Harness disabled by configuration rather than a transient
// failure, so the coordinator can hold the Turn instead of burning its
// retry budget. A type, not a message literal, so the throw site and the
// recognizer cannot drift apart.
public class HarnessDisabledException extends IllegalStateException {
    public HarnessDisabledException(String message) {
        super(message);
    }
}
