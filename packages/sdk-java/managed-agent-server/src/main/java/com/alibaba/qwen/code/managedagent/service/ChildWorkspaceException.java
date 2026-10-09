package com.alibaba.qwen.code.managedagent.service;

/**
 * A child Workspace step that could not complete (#13753 I1). A terminal
 * failure is evidence the step cannot change by retrying: the row ends
 * {@code failed} before anything was created, or {@code blocked} after. A
 * retryable one is a momentary fault, retried with backoff.
 */
public final class ChildWorkspaceException extends RuntimeException {
    /** The layout of decision 2 is not met; nothing was created. */
    public static final String LAYOUT = "child_workspace_layout";
    /** The repository config names a program or redirects Git. */
    public static final String UNSAFE_CONFIG = "child_workspace_unsafe_config";
    /** The tree holds content the recorded evidence cannot explain. */
    public static final String DIVERGED = "child_workspace_diverged";
    /** The recorded repository is gone: no Git directory at its top level. */
    public static final String GONE = "child_workspace_repository_gone";
    /** The child's worktree is gone, so there is no result to merge. */
    public static final String MISSING = "child_workspace_missing";
    /** A Git command failed or timed out. */
    public static final String GIT = "child_workspace_git";

    private final String code;
    private final boolean retryable;

    public ChildWorkspaceException(String code, boolean retryable, String message) {
        super(message);
        this.code = code;
        this.retryable = retryable;
    }

    public ChildWorkspaceException(String code, boolean retryable, String message,
            Throwable cause) {
        super(message, cause);
        this.code = code;
        this.retryable = retryable;
    }

    public String code() {
        return code;
    }

    public boolean retryable() {
        return retryable;
    }

    static ChildWorkspaceException layout(String message) {
        return new ChildWorkspaceException(LAYOUT, false, message);
    }

    static ChildWorkspaceException diverged(String message) {
        return new ChildWorkspaceException(DIVERGED, false, message);
    }
}
