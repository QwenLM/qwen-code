package com.alibaba.qwen.code.managedagent.service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The physical steps of a child Workspace (#13753 I1): a Git linked
 * worktree inside the parent's storage, prepared from a snapshot of the
 * parent's working tree, and finished by a three-way merge back into that
 * tree or by a discard. Every step is idempotent and reconciles from the
 * disk and the recorded ids, so a resumed step either finds its work done
 * or finishes it. The model can write the repository, so every command
 * runs with a cleared environment and hooks off, and only after the
 * repository's own config was read as data and found free of keys that
 * name a program (docs/design/2026-10-09-managed-child-workspace.md).
 */
public final class ChildWorktreeGit {
    /** The reserved directory below the storage root that holds every child Workspace. */
    public static final String CONTAINER = ".qwen-child-workspaces";
    static final String PIN_PREFIX = "refs/qwen/child-workspaces/";
    static final int MAX_CONFLICT_PATHS = 100;
    private static final int MIN_MAJOR = 2;
    private static final int MIN_MINOR = 40;
    private static final String GITLINK = "160000";
    private static final long MAX_OUTPUT_BYTES = 256L * 1024 * 1024;
    private static final int MAX_ERROR_CHARS = 512;
    private static final Pattern VERSION = Pattern.compile("git version (\\d+)\\.(\\d+)");
    private static final Pattern OBJECT_ID = Pattern.compile("[0-9a-f]{40}|[0-9a-f]{64}");
    /**
     * Sections whose every key is refused: filter drivers run on add,
     * checkout and apply, and an include hides keys this check cannot see.
     */
    private static final Set<String> DENIED_SECTIONS = Set.of("filter", "include", "includeif");

    /** Whether the step this thread runs still owns its claim (decision 9). */
    private static final ThreadLocal<BooleanSupplier> LIVE = ThreadLocal.withInitial(() -> () -> true);
    private static final long LIVENESS_POLL_MS = 200;

    private final String executable;
    private final Duration timeout;
    private final Path home;
    private final Path hooks;
    private final Path globalConfig;
    private final Path scratch;

    public ChildWorktreeGit(String executable, Duration timeout) {
        if (executable == null || executable.isBlank() || timeout == null
                || timeout.isNegative() || timeout.isZero()) {
            throw new IllegalArgumentException("Child Workspace Git needs an executable and a timeout");
        }
        this.executable = executable;
        this.timeout = timeout;
        try {
            Path root = Files.createTempDirectory("qwen-child-workspace-git");
            this.home = Files.createDirectory(root.resolve("home"));
            this.hooks = Files.createDirectory(root.resolve("hooks"));
            this.globalConfig = Files.createFile(root.resolve("gitconfig"));
            this.scratch = Files.createDirectory(root.resolve("scratch"));
        } catch (IOException error) {
            throw new IllegalStateException("Child Workspace Git scratch is unavailable", error);
        }
    }

    /** The located repository a step works in, every path real and inside the storage root. */
    public record Repository(Path top, Path gitDir, Path commonDir) {
    }

    /** Where the parent's repository lies, relative to the storage root and to its own top. */
    public record Layout(String repositoryRelative, String offset) {
    }

    /** The three-way merge of decision 5: a clean tree, or the conflicting paths. */
    public record Merge(String parentTree, String mergedTree, List<String> conflicts) {
        public boolean clean() {
            return conflicts.isEmpty();
        }
    }

    /**
     * The Git version, refused below 2.40, the first release whose
     * merge-tree takes an explicit merge base.
     */
    public String requireSupportedVersion() {
        String version;
        try {
            version = new String(run(scratch, null, null, List.of("--version")).out,
                    StandardCharsets.UTF_8).trim();
        } catch (ChildWorkspaceException error) {
            throw new IllegalStateException("Child Workspaces need Git, which is unavailable", error);
        }
        Matcher matcher = VERSION.matcher(version);
        if (!matcher.find()) {
            throw new IllegalStateException("Child Workspaces need Git 2.40 or later: " + version);
        }
        int major = Integer.parseInt(matcher.group(1));
        int minor = Integer.parseInt(matcher.group(2));
        if (major < MIN_MAJOR || major == MIN_MAJOR && minor < MIN_MINOR) {
            throw new IllegalStateException("Child Workspaces need Git 2.40 or later: " + version);
        }
        return version;
    }

    /**
     * Runs {@code work} on this thread with every Git command bound to
     * {@code live}: a command does not start once the step lost its claim,
     * and a running one is killed, so a worker whose claim moved on never
     * keeps writing beside the worker that took the row over.
     */
    public static <T> T whileLive(BooleanSupplier live, Supplier<T> work) {
        BooleanSupplier previous = LIVE.get();
        LIVE.set(live);
        try {
            return work.get();
        } finally {
            LIVE.set(previous);
        }
    }

    /** The child Workspace's directory, relative to the storage root. */
    public static String childDirectory(String childWorkspaceId) {
        return CONTAINER + "/" + childWorkspaceId;
    }

    /** The child Session's working directory, relative to the storage root. */
    public static String childCwd(String childWorkspaceId, String offset) {
        return ".".equals(offset) ? childDirectory(childWorkspaceId)
                : childDirectory(childWorkspaceId) + "/" + offset;
    }

    /**
     * Locates the repository of the parent's working directory and checks
     * the layout of decision 2: its top level strictly inside the storage
     * root and outside the reserved directory, its Git directories inside
     * the root, a non-bare and non-sparse checkout, and a safe config.
     */
    public Layout layout(Path root, String parentCwdRelative) {
        Path directory = root.resolve(parentCwdRelative).normalize();
        try {
            if (!directory.startsWith(root) || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)
                    || !directory.toRealPath().equals(directory)) {
                throw ChildWorkspaceException.layout("The parent's working directory is not a real directory");
            }
        } catch (IOException error) {
            throw ChildWorkspaceException.layout("The parent's working directory is unreadable");
        }
        Result located = run(directory, root, null, List.of("rev-parse", "--path-format=absolute",
                "--show-toplevel"));
        if (located.exit != 0) {
            throw ChildWorkspaceException.layout("The parent's working directory is not in a Git repository");
        }
        Path top = Path.of(firstLine(located.out));
        Repository repository = open(root, root.relativize(top).toString());
        String offset = repository.top().relativize(directory).toString().replace('\\', '/');
        return new Layout(relative(root, repository.top()), offset.isEmpty() ? "." : offset);
    }

    /**
     * Opens the recorded repository again for a later step and re-checks
     * everything the layout check proved, so a step never trusts a
     * repository the model may have rearranged since.
     */
    public Repository open(Path root, String repositoryRelative) {
        Path top = root.resolve(repositoryRelative).normalize();
        if (!top.startsWith(root) || top.equals(root)
                || top.startsWith(root.resolve(CONTAINER))) {
            throw ChildWorkspaceException.layout(
                    "The repository must lie strictly inside the storage root, outside " + CONTAINER);
        }
        Result result = run(top, root, null, List.of("rev-parse", "--path-format=absolute",
                "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--is-bare-repository"));
        if (result.exit != 0) {
            if (!Files.exists(top.resolve(".git"), LinkOption.NOFOLLOW_LINKS)) {
                throw new ChildWorkspaceException(ChildWorkspaceException.GONE, false,
                        "The recorded repository is gone");
            }
            throw ChildWorkspaceException.layout("The recorded repository cannot be opened");
        }
        List<String> lines = lines(result.out);
        if (lines.size() != 4 || !"false".equals(lines.get(3))) {
            throw ChildWorkspaceException.layout("A bare repository has no working tree");
        }
        Path gitDir;
        Path commonDir;
        try {
            if (!Path.of(lines.get(0)).toRealPath().equals(top)) {
                throw ChildWorkspaceException.layout("The recorded repository is not a repository top level");
            }
            gitDir = Path.of(lines.get(1)).toRealPath();
            commonDir = Path.of(lines.get(2)).toRealPath();
        } catch (IOException error) {
            throw ChildWorkspaceException.layout("The repository's Git directory is unreadable");
        }
        if (!gitDir.startsWith(root) || !commonDir.startsWith(root)) {
            throw ChildWorkspaceException.layout("The repository's Git directory is outside the storage root");
        }
        Repository repository = new Repository(top, gitDir, commonDir);
        requireSafeConfig(root, repository);
        return repository;
    }

    /**
     * The snapshot commit of decision 3: the working tree's committed,
     * staged, modified and untracked non-ignored content, committed on top
     * of {@code parent} (HEAD when null) through a private index, so the
     * repository's own index, HEAD and working tree are never touched. The
     * fixed identity and dates make a recomputation over the same content
     * name the same commit.
     */
    public String snapshot(Path root, Repository repository, Path directory, String parent) {
        String tree = snapshotTree(root, directory);
        String base = parent != null ? parent : head(root, directory);
        List<String> args = new ArrayList<>(List.of("commit-tree", "--no-gpg-sign", tree));
        if (base != null) {
            args.add("-p");
            args.add(base);
        }
        args.add("-m");
        args.add("qwen child workspace snapshot");
        return objectId(git(repository.top(), root, null, args));
    }

    /** Whether {@code offset} is a directory of {@code commit}; "." always is. */
    public boolean hasDirectory(Path root, Repository repository, String commit, String offset) {
        if (".".equals(offset)) {
            return true;
        }
        Result result = run(repository.top(), root, null,
                List.of("cat-file", "-t", commit + ":" + offset));
        return result.exit == 0 && "tree".equals(firstLine(result.out));
    }

    /**
     * Creates the child's worktree detached at {@code base}, or recognizes
     * the one an earlier attempt created. A registered worktree whose
     * content is not the base (an interrupted checkout) is rebuilt; an
     * unregistered non-empty directory is evidence nothing explains.
     */
    public void create(Path root, Repository repository, String childWorkspaceId, String base) {
        Path container = container(root, true);
        Path path = container.resolve(childWorkspaceId);
        if (Files.isSymbolicLink(path)) {
            delete(path);
        }
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
                throw ChildWorkspaceException.diverged("The child Workspace path is not a directory");
            }
            if (registered(root, repository, path)) {
                if (intact(root, repository, path, base)) {
                    pin(root, repository, childWorkspaceId, "base", base);
                    return;
                }
                removeWorktree(root, repository, path);
            } else if (!isEmptyDirectory(path)) {
                throw ChildWorkspaceException.diverged(
                        "An unregistered directory occupies the child Workspace path");
            }
        }
        git(repository.top(), root, null, List.of("worktree", "add", "--detach", path.toString(), base));
        pin(root, repository, childWorkspaceId, "base", base);
    }

    /**
     * Whether an earlier attempt's worktree holds exactly the base. Its own
     * config is checked before any command runs inside it; any other
     * failure to read it means the checkout is to be rebuilt.
     */
    private boolean intact(Path root, Repository repository, Path path, String base) {
        try {
            openWorktree(root, path, repository);
            return base.equals(head(root, path))
                    && snapshotTree(root, path).equals(treeOf(root, repository, base));
        } catch (ChildWorkspaceException error) {
            if (ChildWorkspaceException.UNSAFE_CONFIG.equals(error.code())) {
                throw error;
            }
            return false;
        }
    }

    /**
     * The child's result of decision 5: the worktree's content committed
     * on top of the base, whatever the child committed in it.
     */
    public String result(Path root, Repository repository, String childWorkspaceId, String base) {
        Path path = container(root, false).resolve(childWorkspaceId);
        if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) || !registered(root, repository, path)) {
            throw new ChildWorkspaceException(ChildWorkspaceException.MISSING, false,
                    "The child Workspace's worktree is gone");
        }
        Repository child = openWorktree(root, path, repository);
        return snapshot(root, child, path, base);
    }

    /**
     * The three-way merge of decision 5, computed without touching any
     * working tree or index: the parent's current state against the
     * child's result over the recorded base.
     */
    public Merge merge(Path root, Repository repository, String base, String result) {
        String parent = snapshot(root, repository, repository.top(), null);
        Result merged = run(repository.top(), root, null, List.of("merge-tree", "--write-tree",
                "--merge-base=" + base, "--name-only", "--no-messages", "-z", parent, result));
        if (merged.exit != 0 && merged.exit != 1) {
            throw failure("merge-tree", merged);
        }
        List<String> tokens = tokens(merged.out);
        if (tokens.isEmpty() || !OBJECT_ID.matcher(tokens.getFirst()).matches()) {
            throw failure("merge-tree", merged);
        }
        String parentTree = treeOf(root, repository, parent);
        if (merged.exit == 0) {
            return new Merge(parentTree, tokens.getFirst(), List.of());
        }
        Set<String> conflicts = new LinkedHashSet<>();
        for (String path : tokens.subList(1, tokens.size())) {
            if (!path.isEmpty()) {
                conflicts.add(path);
            }
        }
        if (conflicts.isEmpty()) {
            throw failure("merge-tree", merged);
        }
        return new Merge(parentTree, null, List.copyOf(conflicts));
    }

    /**
     * Writes the merged tree into the parent's working tree (decision 6):
     * only the paths that differ between the recorded parent tree and the
     * merged tree, and only while each still holds its parent or merged
     * version. A path holding anything else was changed outside the lease
     * and is never overwritten. Resuming after an interruption writes only
     * what is still owed; the index and HEAD are never touched.
     */
    public void apply(Path root, Repository repository, String parentTree, String mergedTree) {
        Map<String, Entry> owed = changes(root, repository, parentTree, mergedTree);
        if (owed.isEmpty()) {
            return;
        }
        String working = snapshotTree(root, repository.top());
        Set<String> changedSinceParent = changes(root, repository, parentTree, working).keySet();
        Set<String> differsFromMerged = changes(root, repository, working, mergedTree).keySet();
        Map<String, Entry> toWrite = new LinkedHashMap<>();
        for (Map.Entry<String, Entry> change : owed.entrySet()) {
            String path = change.getKey();
            if (!changedSinceParent.contains(path)) {
                toWrite.put(path, change.getValue());
            } else if (differsFromMerged.contains(path)) {
                throw ChildWorkspaceException.diverged("The parent's tree changed outside the lease at " + path);
            }
        }
        if (!toWrite.isEmpty()) {
            write(root, repository, working, toWrite);
        }
        String written = snapshotTree(root, repository.top());
        Set<String> left = changes(root, repository, written, mergedTree).keySet();
        for (String path : owed.keySet()) {
            if (left.contains(path)) {
                throw ChildWorkspaceException.diverged("The merge did not land at " + path);
            }
        }
    }

    /**
     * Removes the child's worktree and its base pin (decision 7), keeping
     * the result pin when asked. A symbolic link at the reserved path is
     * removed as a link, never followed. When the recorded repository is
     * gone, only the directory is removed.
     */
    public void discard(Path root, String repositoryRelative, String childWorkspaceId, boolean keepResult) {
        Path container = root.resolve(CONTAINER);
        Path path = container.resolve(childWorkspaceId);
        Repository repository = null;
        if (repositoryRelative != null) {
            try {
                repository = open(root, repositoryRelative);
            } catch (ChildWorkspaceException error) {
                // Only a repository proven gone lets the discard go on
                // without Git; anything else (an unsafe config, a changed
                // layout, a momentary fault) must not skip the prune and
                // the pins.
                if (!ChildWorkspaceException.GONE.equals(error.code())) {
                    throw error;
                }
            }
        }
        if (Files.isSymbolicLink(container)) {
            throw ChildWorkspaceException.diverged(CONTAINER + " is a symbolic link");
        }
        if (Files.isSymbolicLink(path)) {
            delete(path);
        } else if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            if (repository != null && Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)
                    && registered(root, repository, path)) {
                removeWorktree(root, repository, path);
            }
            if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
                deleteTree(path);
            }
        }
        if (repository != null) {
            git(repository.top(), root, null, List.of("worktree", "prune"));
            unpin(root, repository, childWorkspaceId, "base");
            if (!keepResult) {
                unpin(root, repository, childWorkspaceId, "result");
            }
        }
    }

    /** Pins a commit under {@code refs/qwen/child-workspaces/<id>/<name>} (decision 4). */
    public void pin(Path root, Repository repository, String childWorkspaceId, String name, String commit) {
        git(repository.top(), root, null, List.of("update-ref", PIN_PREFIX + childWorkspaceId + "/" + name, commit));
    }

    /** The commit a pin names, or null. */
    public String pinned(Path root, Repository repository, String childWorkspaceId, String name) {
        Result result = run(repository.top(), root, null, List.of("rev-parse", "--verify", "-q",
                PIN_PREFIX + childWorkspaceId + "/" + name));
        return result.exit == 0 ? objectId(result.out) : null;
    }

    private void unpin(Path root, Repository repository, String childWorkspaceId, String name) {
        git(repository.top(), root, null, List.of("update-ref", "-d", PIN_PREFIX + childWorkspaceId + "/" + name));
    }

    private Repository openWorktree(Path root, Path path, Repository parent) {
        Result result = run(path, root, null, List.of("rev-parse", "--path-format=absolute",
                "--show-toplevel", "--absolute-git-dir", "--git-common-dir"));
        List<String> lines = lines(result.out);
        try {
            if (result.exit != 0 || lines.size() != 3 || !Path.of(lines.get(0)).toRealPath().equals(path)
                    || !Path.of(lines.get(2)).toRealPath().equals(parent.commonDir())) {
                throw ChildWorkspaceException.diverged("The child Workspace is not a worktree of the parent's repository");
            }
            Path gitDir = Path.of(lines.get(1)).toRealPath();
            if (!gitDir.startsWith(parent.commonDir())) {
                throw ChildWorkspaceException.diverged("The child Workspace's Git directory moved");
            }
            Repository child = new Repository(path, gitDir, parent.commonDir());
            requireSafeConfig(root, child);
            return child;
        } catch (IOException error) {
            throw ChildWorkspaceException.diverged("The child Workspace's Git directory is unreadable");
        }
    }

    private String snapshotTree(Path root, Path directory) {
        Path index = tempFile("index");
        try {
            Files.delete(index);
            String head = head(root, directory);
            Map<String, String> env = Map.of("GIT_INDEX_FILE", index.toString());
            git(directory, root, env, head == null ? List.of("read-tree", "--empty") : List.of("read-tree", head));
            git(directory, root, env, List.of("add", "-A"));
            return objectId(git(directory, root, env, List.of("write-tree")));
        } catch (IOException error) {
            throw new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                    "The private index is unavailable", error);
        } finally {
            deleteQuietly(index);
        }
    }

    private String head(Path root, Path directory) {
        Result result = run(directory, root, null, List.of("rev-parse", "--verify", "-q", "HEAD^{commit}"));
        if (result.exit == 0) {
            return objectId(result.out);
        }
        if (result.exit == 1) {
            return null;
        }
        throw failure("rev-parse HEAD", result);
    }

    private String treeOf(Path root, Repository repository, String commit) {
        return objectId(git(repository.top(), root, null, List.of("rev-parse", "--verify", commit + "^{tree}")));
    }

    private record Entry(String mode, String objectId) {
    }

    /** The non-gitlink paths that differ between two trees, with their {@code to} entries. */
    private Map<String, Entry> changes(Path root, Repository repository, String from, String to) {
        List<String> tokens = tokens(git(repository.top(), root, null, List.of("diff-tree", "-r", "-z",
                "--no-renames", "--no-ext-diff", "--no-textconv", from, to)));
        Map<String, Entry> changes = new LinkedHashMap<>();
        for (int index = 0; index + 1 < tokens.size(); index += 2) {
            String[] fields = tokens.get(index).split(" ");
            if (fields.length != 5 || !fields[0].startsWith(":")) {
                throw new ChildWorkspaceException(ChildWorkspaceException.GIT, false,
                        "diff-tree answered an unexpected record");
            }
            String fromMode = fields[0].substring(1);
            if (GITLINK.equals(fromMode) || GITLINK.equals(fields[1])) {
                continue;
            }
            changes.put(tokens.get(index + 1), new Entry(fields[1], fields[3]));
        }
        return changes;
    }

    /**
     * Writes the owed paths: a private index of the working tree with
     * those paths replaced builds the target tree, and one tree-to-tree
     * patch applies the difference to the working tree only.
     */
    private void write(Path root, Repository repository, String working, Map<String, Entry> toWrite) {
        Path index = tempFile("index");
        Path info = tempFile("info");
        Path patch = tempFile("patch");
        try {
            Files.delete(index);
            Map<String, String> env = Map.of("GIT_INDEX_FILE", index.toString());
            git(repository.top(), root, env, List.of("read-tree", working));
            StringBuilder lines = new StringBuilder();
            for (Map.Entry<String, Entry> owed : toWrite.entrySet()) {
                Entry entry = owed.getValue();
                lines.append(entry.mode().chars().allMatch(c -> c == '0') ? "0" : entry.mode())
                        .append(' ').append(entry.objectId()).append('\t').append(owed.getKey()).append('\0');
            }
            Files.writeString(info, lines, StandardCharsets.UTF_8);
            git(repository.top(), root, env, info, List.of("update-index", "-z", "--index-info"));
            String target = objectId(git(repository.top(), root, env, List.of("write-tree")));
            Files.write(patch, git(repository.top(), root, null, List.of("diff", "--binary", "--full-index",
                    "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/",
                    working, target)));
            Result applied = run(repository.top(), root, null, List.of("apply", "--whitespace=nowarn",
                    patch.toString()));
            if (applied.exit != 0) {
                throw ChildWorkspaceException.diverged("The merge could not be written: " + summary(applied.err));
            }
        } catch (IOException error) {
            throw new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                    "The merge scratch is unavailable", error);
        } finally {
            deleteQuietly(index);
            deleteQuietly(info);
            deleteQuietly(patch);
        }
    }

    private boolean registered(Path root, Repository repository, Path path) {
        List<String> tokens = tokens(git(repository.top(), root, null,
                List.of("worktree", "list", "--porcelain", "-z")));
        for (String token : tokens) {
            if (token.startsWith("worktree ") && Path.of(token.substring("worktree ".length()))
                    .normalize().equals(path)) {
                return true;
            }
        }
        return false;
    }

    private void removeWorktree(Path root, Repository repository, Path path) {
        // A worktree whose gitfile the model removed fails git's validation;
        // the directory is still the control plane's, so it goes anyway.
        run(repository.top(), root, null, List.of("worktree", "remove", "--force", "--force", path.toString()));
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            deleteTree(path);
        }
        git(repository.top(), root, null, List.of("worktree", "prune"));
    }

    private Path container(Path root, boolean create) {
        Path container = root.resolve(CONTAINER);
        try {
            if (Files.isSymbolicLink(container)) {
                throw ChildWorkspaceException.diverged(CONTAINER + " is a symbolic link");
            }
            if (create && !Files.exists(container, LinkOption.NOFOLLOW_LINKS)) {
                Files.createDirectory(container);
            }
            if (Files.exists(container, LinkOption.NOFOLLOW_LINKS)
                    && (!Files.isDirectory(container, LinkOption.NOFOLLOW_LINKS)
                            || !container.toRealPath().equals(container))) {
                throw ChildWorkspaceException.diverged(CONTAINER + " is not a real directory");
            }
            return container;
        } catch (IOException error) {
            throw new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                    CONTAINER + " is unavailable", error);
        }
    }

    /**
     * Decision 11: reads the repository's own config files as data, with
     * includes off, and refuses any key that names a program or redirects
     * Git, or a sparse checkout, whose private-index snapshot would read
     * every file outside the sparse cone as deleted.
     */
    private void requireSafeConfig(Path root, Repository repository) {
        List<String[]> entries = new ArrayList<>(configEntries(root, repository.commonDir().resolve("config")));
        boolean worktreeConfig = entries.stream().anyMatch(entry ->
                "extensions.worktreeconfig".equals(entry[0]) && truthy(entry[1]));
        if (worktreeConfig) {
            entries.addAll(configEntries(root, repository.gitDir().resolve("config.worktree")));
        }
        for (String[] entry : entries) {
            String key = entry[0];
            if (denied(key)) {
                throw new ChildWorkspaceException(ChildWorkspaceException.UNSAFE_CONFIG, false,
                        "The repository config sets " + key + ", which names a program or redirects Git");
            }
            if (("core.sparsecheckout".equals(key) || "core.bare".equals(key)) && truthy(entry[1])) {
                throw ChildWorkspaceException.layout("The repository config sets " + key);
            }
        }
    }

    /**
     * The keys these commands can reach that name a program or redirect
     * Git. {@code core.hooksPath} and {@code core.fsmonitor} are not among
     * them: every command overrides both. A promisor remote is refused,
     * because a lazy fetch would reach a transport program; beyond it,
     * editor, pager, signing and transport programs are never reached:
     * nothing here opens an editor or a terminal, signs, or (with lazy
     * fetches and every protocol disabled) talks to a remote.
     */
    static boolean denied(String key) {
        String lower = key.toLowerCase(Locale.ROOT);
        int first = lower.indexOf('.');
        int last = lower.lastIndexOf('.');
        if (first <= 0 || last == lower.length() - 1) {
            return true;
        }
        String section = lower.substring(0, first);
        String name = lower.substring(last + 1);
        boolean subsection = first != last;
        if (DENIED_SECTIONS.contains(section)) {
            return true;
        }
        return switch (section) {
            case "core" -> !subsection && "worktree".equals(name);
            // A promisor remote is fetched lazily by any command that meets
            // a missing object, and the fetch runs the remote's programs.
            case "extensions" -> !subsection && "partialclone".equals(name);
            case "remote" -> subsection && "promisor".equals(name);
            case "diff" -> !subsection && "external".equals(name)
                    || subsection && ("command".equals(name) || "textconv".equals(name));
            case "merge" -> subsection && "driver".equals(name);
            default -> false;
        };
    }

    private List<String[]> configEntries(Path root, Path file) {
        if (!Files.exists(file)) {
            return List.of();
        }
        Result result = run(root, root, null, List.of("config", "--file", file.toString(),
                "--no-includes", "--list", "-z"));
        if (result.exit != 0) {
            throw new ChildWorkspaceException(ChildWorkspaceException.UNSAFE_CONFIG, false,
                    "The repository config is unreadable");
        }
        List<String[]> entries = new ArrayList<>();
        for (String token : tokens(result.out)) {
            if (token.isEmpty()) {
                continue;
            }
            int newline = token.indexOf('\n');
            entries.add(newline < 0 ? new String[] {token.toLowerCase(Locale.ROOT), null}
                    : new String[] {token.substring(0, newline).toLowerCase(Locale.ROOT),
                            token.substring(newline + 1)});
        }
        return entries;
    }

    private static boolean truthy(String value) {
        return value == null || Set.of("true", "yes", "on", "1").contains(value.trim().toLowerCase(Locale.ROOT));
    }

    private record Result(int exit, byte[] out, String err) {
    }

    private byte[] git(Path directory, Path root, Map<String, String> env, List<String> args) {
        return git(directory, root, env, null, args);
    }

    private byte[] git(Path directory, Path root, Map<String, String> env, Path input, List<String> args) {
        Result result = run(directory, root, env, input, args);
        if (result.exit != 0) {
            throw failure(args.getFirst(), result);
        }
        return result.out;
    }

    private Result run(Path directory, Path root, Map<String, String> env, List<String> args) {
        return run(directory, root, env, null, args);
    }

    /**
     * One Git command with a cleared environment: discovery never climbs
     * above the storage root, system and global config are off, hooks
     * point at an empty directory, fsmonitor is emptied and nothing
     * prompts, pages, locks optionally or follows replace refs.
     */
    private Result run(Path directory, Path root, Map<String, String> env, Path input, List<String> args) {
        List<String> command = new ArrayList<>(List.of(executable,
                "-c", "core.hooksPath=" + hooks,
                "-c", "core.fsmonitor=",
                "-c", "log.showSignature=false",
                "-c", "gc.auto=0",
                "-c", "maintenance.auto=false",
                "-C", directory.toString()));
        command.addAll(args);
        ProcessBuilder builder = new ProcessBuilder(command);
        Map<String, String> environment = builder.environment();
        environment.clear();
        for (String name : List.of("PATH", "SystemRoot")) {
            String value = System.getenv(name);
            if (value != null) {
                environment.put(name, value);
            }
        }
        environment.put("HOME", home.toString());
        environment.put("XDG_CONFIG_HOME", home.resolve(".config").toString());
        environment.put("GIT_CONFIG_NOSYSTEM", "1");
        environment.put("GIT_CONFIG_GLOBAL", globalConfig.toString());
        environment.put("GIT_ATTR_NOSYSTEM", "1");
        environment.put("GIT_TERMINAL_PROMPT", "0");
        environment.put("GIT_OPTIONAL_LOCKS", "0");
        environment.put("GIT_NO_REPLACE_OBJECTS", "1");
        // Defense in depth behind the promisor refusal: no lazy fetch
        // (Git 2.45 and later) and no transport protocol at all.
        environment.put("GIT_NO_LAZY_FETCH", "1");
        environment.put("GIT_ALLOW_PROTOCOL", "none");
        environment.put("GIT_PAGER", "cat");
        environment.put("LC_ALL", "C");
        environment.put("GIT_AUTHOR_NAME", "Qwen Code");
        environment.put("GIT_AUTHOR_EMAIL", "child-workspace@qwen-code.invalid");
        environment.put("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z");
        environment.put("GIT_COMMITTER_NAME", "Qwen Code");
        environment.put("GIT_COMMITTER_EMAIL", "child-workspace@qwen-code.invalid");
        environment.put("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z");
        if (root != null) {
            environment.put("GIT_CEILING_DIRECTORIES", root.toString());
        }
        if (env != null) {
            environment.putAll(env);
        }
        Path out = tempFile("out");
        Path err = tempFile("err");
        Path in = input;
        try {
            if (in == null) {
                in = tempFile("in");
            }
            builder.redirectInput(in.toFile());
            builder.redirectOutput(out.toFile());
            builder.redirectError(err.toFile());
            BooleanSupplier live = LIVE.get();
            if (!live.getAsBoolean()) {
                throw claimLost(args);
            }
            Process process = builder.start();
            long deadline = System.nanoTime() + timeout.toNanos();
            try {
                while (!process.waitFor(Math.min(LIVENESS_POLL_MS,
                        Math.max(1, (deadline - System.nanoTime()) / 1_000_000)), TimeUnit.MILLISECONDS)) {
                    if (!live.getAsBoolean()) {
                        process.destroyForcibly();
                        throw claimLost(args);
                    }
                    if (System.nanoTime() >= deadline) {
                        process.destroyForcibly();
                        throw new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                                "git " + args.getFirst() + " timed out");
                    }
                }
            } catch (InterruptedException error) {
                process.destroyForcibly();
                throw error;
            }
            if (Files.size(out) > MAX_OUTPUT_BYTES) {
                throw new ChildWorkspaceException(ChildWorkspaceException.GIT, false,
                        "git " + args.getFirst() + " answered more than the output bound");
            }
            return new Result(process.exitValue(), Files.readAllBytes(out),
                    readBounded(err));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                    "git " + args.getFirst() + " was interrupted", error);
        } catch (IOException error) {
            throw new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                    "git " + args.getFirst() + " could not run", error);
        } finally {
            deleteQuietly(out);
            deleteQuietly(err);
            if (input == null && in != null) {
                deleteQuietly(in);
            }
        }
    }

    private static ChildWorkspaceException claimLost(List<String> args) {
        return new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                "git " + args.getFirst() + " stopped: the step lost its claim");
    }

    private Path tempFile(String prefix) {
        try {
            return Files.createTempFile(scratch, prefix, null);
        } catch (IOException error) {
            throw new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                    "The Git scratch is unavailable", error);
        }
    }

    private static String readBounded(Path file) throws IOException {
        byte[] bytes = Files.readAllBytes(file);
        String text = new String(bytes, StandardCharsets.UTF_8);
        return text.length() > MAX_ERROR_CHARS ? text.substring(0, MAX_ERROR_CHARS) : text;
    }

    private static ChildWorkspaceException failure(String command, Result result) {
        return new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                "git " + command + " exited " + result.exit + ": " + summary(result.err));
    }

    private static String summary(String text) {
        String line = text.strip().replace('\n', ' ');
        return line.length() > MAX_ERROR_CHARS ? line.substring(0, MAX_ERROR_CHARS) : line;
    }

    private static String objectId(byte[] out) {
        String id = firstLine(out);
        if (!OBJECT_ID.matcher(id).matches()) {
            throw new ChildWorkspaceException(ChildWorkspaceException.GIT, false,
                    "Git answered an unexpected object id");
        }
        return id;
    }

    private static String firstLine(byte[] out) {
        List<String> lines = lines(out);
        return lines.isEmpty() ? "" : lines.getFirst();
    }

    private static List<String> lines(byte[] out) {
        String text = new String(out, StandardCharsets.UTF_8);
        List<String> lines = new ArrayList<>();
        for (String line : text.split("\n")) {
            if (!line.isEmpty()) {
                lines.add(line);
            }
        }
        return lines;
    }

    private static List<String> tokens(byte[] out) {
        String text = new String(out, StandardCharsets.UTF_8);
        if (text.isEmpty()) {
            return List.of();
        }
        List<String> tokens = new ArrayList<>(List.of(text.split("\0", -1)));
        if (!tokens.isEmpty() && tokens.getLast().isEmpty()) {
            tokens.removeLast();
        }
        return tokens;
    }

    private static String relative(Path root, Path path) {
        String relative = root.relativize(path).toString().replace('\\', '/');
        return relative.isEmpty() ? "." : relative;
    }

    private static boolean isEmptyDirectory(Path directory) {
        try (var entries = Files.list(directory)) {
            return entries.findAny().isEmpty();
        } catch (IOException error) {
            return false;
        }
    }

    private static void delete(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (DirectoryNotEmptyException error) {
            deleteTree(path);
        } catch (IOException error) {
            throw new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                    "The child Workspace path could not be removed", error);
        }
    }

    /** Deletes a directory tree without following any symbolic link in it. */
    private static void deleteTree(Path directory) {
        try {
            Files.walkFileTree(directory, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                    Files.delete(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, IOException error) throws IOException {
                    if (error != null) {
                        throw error;
                    }
                    Files.delete(dir);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (NoSuchFileException error) {
            // Already gone.
        } catch (IOException error) {
            throw new ChildWorkspaceException(ChildWorkspaceException.GIT, true,
                    "The child Workspace directory could not be removed", error);
        }
    }

    private static void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
            // Scratch only.
        }
    }
}
