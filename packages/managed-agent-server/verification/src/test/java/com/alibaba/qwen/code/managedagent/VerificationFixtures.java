package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.*;

import java.nio.file.Path;

public final class VerificationFixtures {
    private VerificationFixtures() { }

    public static Path moduleRoot() {
        return Path.of(System.getProperty("managed.module.root", "..")).toAbsolutePath().normalize();
    }

    public static Path repositoryRoot() {
        return moduleRoot().resolve("../..").normalize();
    }

    public static ManagedAgentStore configure(ManagedAgentStore store) {
        store.configureWorktreeFiles(
                new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles());
        return store;
    }

    public static ManagedSessionStore configure(ManagedSessionStore store) {
        store.configureHarnessRules(
                new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        store.configureReaderVersion(
                new com.alibaba.qwen.code.managedagent.config.ManagedSessionReaderVersion());
        return store;
    }

    public static SessionWorktreeStore configure(SessionWorktreeStore store) {
        store.configureWorktreeFiles(
                new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles());
        return store;
    }

    public static WorkspaceFileStore configure(WorkspaceFileStore store) {
        store.configureWorktreeFiles(
                new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles());
        store.configureLocalFiles(
                new com.alibaba.qwen.code.runtimebroker.provisioning.WorkspaceFileProcess());
        return store;
    }

    public static WorkspaceFileUploadStore configure(WorkspaceFileUploadStore store) {
        store.configureLocalFiles(
                new com.alibaba.qwen.code.runtimebroker.provisioning.WorkspaceFileProcess());
        return store;
    }

    public static ManagedUserMessageStore configure(ManagedUserMessageStore store) {
        store.configureWorktreeFiles(
                new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles());
        return store;
    }

    public static WorkspaceExecutionStore configure(WorkspaceExecutionStore store) {
        store.configureWorktreeFiles(
                new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles());
        return store;
    }

    public static com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeService configure(com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeService service) {
        service.configureWorktreeFiles(new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(),
                (git, timeout) -> new com.alibaba.qwen.code.managedagent.adapters.workspace.SessionWorktreeGit(new com.alibaba.qwen.code.managedagent.adapters.workspace.ChildWorktreeGit(git, timeout)));
        return service;
    }
}
