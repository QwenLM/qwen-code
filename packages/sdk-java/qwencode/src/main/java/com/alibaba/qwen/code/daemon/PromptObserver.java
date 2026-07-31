package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** Sequential callbacks for events correlated with one admitted prompt. */
public interface PromptObserver {
    PromptObserver NOOP = new PromptObserver() {
    };

    default void onText(String text, DaemonEvent event) {
    }

    default void onThought(String thought, DaemonEvent event) {
    }

    default void onTool(Map<String, Object> update, DaemonEvent event) {
    }

    default void onUsage(Map<String, Object> usage, DaemonEvent event) {
    }

    default void onPermission(PermissionRequest request, DaemonEvent event) {
    }

    default void onEvent(DaemonEvent event) {
    }
}
