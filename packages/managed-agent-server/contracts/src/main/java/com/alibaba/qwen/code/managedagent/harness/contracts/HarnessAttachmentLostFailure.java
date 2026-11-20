package com.alibaba.qwen.code.managedagent.harness.contracts;

/** A refused admission whose stale reference was invalidated, before any work began. */
public class HarnessAttachmentLostFailure extends HarnessFailure {
    public HarnessAttachmentLostFailure(Throwable cause) {
        super("Hosted Harness admission needs a fresh attachment", cause);
    }
}
