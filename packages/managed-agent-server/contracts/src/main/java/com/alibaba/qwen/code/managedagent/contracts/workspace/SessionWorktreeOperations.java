package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;

import java.nio.file.Path;

public interface SessionWorktreeOperations extends AutoCloseable {
    String CONTAINER = ".qwen-managed-worktrees";
    public record Source(String repositoryRelative, String offset, String commonDirectory,
            String commonIdentity, String commit, java.util.List<String> branches) { }
    public interface Factory {
        public SessionWorktreeOperations create(String git, java.time.Duration timeout);
    }
    public <T> T runWhileLive(java.util.function.BooleanSupplier live, java.util.function.Supplier<T> work);
    public static com.alibaba.qwen.code.managedagent.exception.ManagedAgentException error(String code, String message) {
        return new com.alibaba.qwen.code.managedagent.exception.ManagedAgentException(409, code, message);
    }

    public Source source(Path root, String cwd, String baseRef);

    public String currentBranch(Path root, String cwd);

    public String prepare(Plan plan);

    public String cleanupBlocker(Plan plan, String savedIdentity);

    public void cleanup(Plan plan, String savedIdentity);

    public void close();
}
