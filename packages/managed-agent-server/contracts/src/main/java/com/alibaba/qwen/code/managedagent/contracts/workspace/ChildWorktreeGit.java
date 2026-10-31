package com.alibaba.qwen.code.managedagent.contracts.workspace;

import java.nio.file.Path;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

public interface ChildWorktreeGit {
    public static final String CONTAINER = ".qwen-child-workspaces";

    public static final String PIN_PREFIX = "refs/qwen/child-workspaces/";

    public static final int MAX_CONFLICT_PATHS = 100;

    public record Repository(Path top, Path gitDir, Path commonDir) {
    }

    public record Layout(String repositoryRelative, String offset) {
    }

    public record Merge(String parentTree, String mergedTree, List<String> conflicts) {
        public boolean clean() {
            return conflicts.isEmpty();
        }
    }

    public String requireSupportedVersion();

    public byte[] sessionCommand(Path directory, Path root, List<String> arguments);

    public void close();

    public static String childDirectory(String childWorkspaceId) {
        return CONTAINER + "/" + childWorkspaceId;
    }

    public static String childCwd(String childWorkspaceId, String offset) {
        return ".".equals(offset) ? childDirectory(childWorkspaceId)
                : childDirectory(childWorkspaceId) + "/" + offset;
    }

    public Layout layout(Path root, String parentCwdRelative);

    public Layout sessionLayout(Path root, String cwdRelative);

    public Repository open(Path root, String repositoryRelative);

    public Repository sessionOpen(Path root, String repositoryRelative);

    public String snapshot(Path root, Repository repository, Path directory, String parent);

    public String base(Path root, Repository repository, String childWorkspaceId);

    public boolean hasDirectory(Path root, Repository repository, String commit, String offset);

    public void create(Path root, Repository repository, String childWorkspaceId, String base);

    public String result(Path root, Repository repository, String childWorkspaceId, String base);

    public Merge merge(Path root, Repository repository, String base, String result);

    public void apply(Path root, Repository repository, String parentTree, String mergedTree);

    public void discard(Path root, String repositoryRelative, String childWorkspaceId, boolean keepResult);

    public void pin(Path root, Repository repository, String childWorkspaceId, String name, String commit);

    public String pinned(Path root, Repository repository, String childWorkspaceId, String name);

    public <T> T runWhileLive(BooleanSupplier live, Supplier<T> work);
}
