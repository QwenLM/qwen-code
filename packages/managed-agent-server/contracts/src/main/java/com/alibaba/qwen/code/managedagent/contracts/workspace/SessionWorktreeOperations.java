package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

public interface SessionWorktreeOperations extends AutoCloseable {
    String CONTAINER = ".qwen-managed-worktrees";
    public record Source(String repositoryRelative, String offset, String commonDirectory,
            String commonIdentity, String commit, List<String> branches) { }
    public interface Factory {
        public SessionWorktreeOperations create(String git, Duration timeout);
    }
    public <T> T runWhileLive(BooleanSupplier live, Supplier<T> work);
    public static ManagedAgentException error(String code, String message) {
        return new ManagedAgentException(409, code, message);
    }

    public Source source(Path root, String cwd, String baseRef);

    public String currentBranch(Path root, String cwd);

    public String prepare(Plan plan);

    public String cleanupBlocker(Plan plan, String savedIdentity);

    public void cleanup(Plan plan, String savedIdentity);

    @Override
    public void close();
}
