package com.alibaba.qwen.code.daemon;

/** The retained title after a durable fence retired a managed rename revision. */
public final class SessionTitleRetirement {
    private final String title;

    SessionTitleRetirement(String title) {
        this.title = title;
    }

    public String getTitle() {
        return title;
    }
}
