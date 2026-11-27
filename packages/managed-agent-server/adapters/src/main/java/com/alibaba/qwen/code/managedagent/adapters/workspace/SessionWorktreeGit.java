package com.alibaba.qwen.code.managedagent.adapters.workspace;

import com.alibaba.qwen.code.managedagent.contracts.workspace.ChildWorkspaceException;
import com.alibaba.qwen.code.managedagent.contracts.workspace.SessionWorktreeOperations;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;
import com.alibaba.qwen.code.runtimebroker.host.MacOsHostIdentity;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

public final class SessionWorktreeGit implements SessionWorktreeOperations {
    public static final String CONTAINER = ".qwen-managed-worktrees";
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(DeserializationFeature.USE_LONG_FOR_INTS);
    private final ChildWorktreeGit git;

    public SessionWorktreeGit(ChildWorktreeGit git) {
        this.git = git;
        git.requireSupportedVersion();
    }

    public Source source(Path root, String cwd, String baseRef) {
        if (cwd.split("/")[0].equals(CONTAINER)) {
            throw error("worktree_source_private", "Select the original project directory.");
        }
        String ref = baseRef == null ? "HEAD" : baseRef;
        if (ref.isBlank() || ref.length() > 1024 || ref.startsWith("-") || ref.contains("..")
                || ref.codePoints().anyMatch(value -> Character.isISOControl(value) || "~^:@{\\".indexOf(value) >= 0)) {
            throw error("worktree_invalid_ref", "Choose an existing local branch, tag or commit.");
        }
        var layout = sourceLayout(root, cwd);
        requireSeparateRepository(root, layout.repositoryRelative());
        var repository = git.sessionOpen(root, layout.repositoryRelative());
        String commit;
        try {
            commit = command(repository.top(), root, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}").strip();
        } catch (ChildWorkspaceException exception) {
            throw error("worktree_invalid_ref", "Choose an existing local branch, tag or commit.");
        }
        if (!commit.matches("[a-f0-9]{40}|[a-f0-9]{64}")) {
            throw error("worktree_invalid_ref", "The selected ref is not a commit.");
        }
        if (!".".equals(layout.offset())
                && !"tree".equals(command(repository.top(), root, "cat-file", "-t", commit + ":" + layout.offset()).strip())) {
            throw error("worktree_directory_missing", "The selected directory does not exist at that commit.");
        }
        if (command(repository.top(), root, "ls-tree", "-r", commit).lines().anyMatch(line -> line.startsWith("160000 "))) {
            throw error("worktree_submodule_unsupported", "Session worktrees do not support submodules yet.");
        }
        List<String> branches = command(repository.top(), root, "for-each-ref", "--format=%(refname:short)", "refs/heads")
                .lines().limit(200).toList();
        return new Source(layout.repositoryRelative(), layout.offset(), repository.commonDir().toString(),
                identity(repository.commonDir()), commit, branches);
    }

    public String currentBranch(Path root, String cwd) {
        if (cwd.split("/")[0].equals(CONTAINER)) {
            throw error("worktree_source_private", "Select the original project directory.");
        }
        var layout = sourceLayout(root, cwd);
        var repository = git.sessionOpen(root, layout.repositoryRelative());
        String branch = command(repository.top(), root, "branch", "--show-current").strip();
        return branch.isEmpty() ? "HEAD" : branch;
    }

    private ChildWorktreeGit.Layout sourceLayout(Path root, String cwd) {
        try {
            return git.sessionLayout(root, cwd);
        } catch (ChildWorkspaceException exception) {
            if (exception.getMessage().contains("not in a Git repository")) {
                throw error("worktree_not_git", "Select a Git project directory.");
            }
            throw exception;
        }
    }

    public String prepare(Plan plan) {
        Path root = Path.of(plan.root());
        requireRoot(plan);
        requireSeparateRepository(root, plan.repositoryRelative());
        Path container = root.resolve(CONTAINER);
        try {
            if (!Files.exists(container, LinkOption.NOFOLLOW_LINKS)) {
                Files.createDirectory(container);
            }
            requireDirectory(container);
            Path marker = marker(plan);
            Path target = root.resolve(plan.worktreeRoot());
            byte[] expected = JSON.writeValueAsBytes(plan);
            if (!Files.exists(marker, LinkOption.NOFOLLOW_LINKS)) {
                if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                    throw error("worktree_path_conflict", "The allocated directory already exists and was preserved.");
                }
                writeRecord(marker, expected);
            }
            requireMarker(plan);
            if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                if (Files.exists(completion(plan), LinkOption.NOFOLLOW_LINKS)) {
                    throw error("worktree_identity_conflict", "The completed worktree is missing; its record was preserved.");
                }
                var repository = git.sessionOpen(root, plan.repositoryRelative());
                if (!repository.commonDir().toString().equals(plan.commonDirectory())) {
                    throw error("worktree_identity_conflict", "The source Git repository changed.");
                }
                String existing = command(repository.top(), root, "for-each-ref", "--format=%(refname)", "refs/heads/" + plan.branch());
                if (!existing.isBlank()) {
                    throw error("worktree_branch_conflict", "The allocated branch already exists; its contents were preserved.");
                }
                command(repository.top(), root, "worktree", "add", "-b", plan.branch(), "--", target.toString(), plan.baseCommit());
                requireDirectory(root.resolve(plan.cwdRelative()));
                writeRecord(completion(plan), captureIdentity(plan, null).getBytes(StandardCharsets.UTF_8));
            }
            requireDirectory(root.resolve(plan.cwdRelative()));
            return verify(plan, null);
        } catch (IOException exception) {
            throw error("worktree_identity_conflict", "The worktree ownership record is unavailable.");
        }
    }

    public String cleanupBlocker(Plan plan, String savedIdentity) {
        if (absent(plan)) {
            return null;
        }
        verify(plan, savedIdentity);
        Path root = Path.of(plan.root());
        Path target = root.resolve(plan.worktreeRoot());
        var repository = git.sessionOpen(root, plan.worktreeRoot());
        for (String name : List.of("index.lock", "HEAD.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD",
                "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer")) {
            if (Files.exists(repository.gitDir().resolve(name), LinkOption.NOFOLLOW_LINKS)) {
                return "worktree_git_busy";
            }
        }
        for (String file : command(target, root, "ls-files", "-v", "-z").split("\0")) {
            if (!file.isEmpty() && (file.charAt(0) == 'S' || Character.isLowerCase(file.charAt(0)))) {
                return "worktree_index_flags";
            }
        }
        if (!command(target, root, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching").isEmpty()) {
            return "worktree_dirty";
        }
        if (command(target, root, "ls-files", "--stage").lines().anyMatch(line -> line.startsWith("160000 "))) {
            return "worktree_submodule_unsupported";
        }
        try (var paths = Files.walk(target)) {
            if (paths.anyMatch(path -> !path.equals(target.resolve(".git")) && path.getFileName().toString().equals(".git"))) {
                return "worktree_nested_repository";
            }
        } catch (IOException exception) {
            return "worktree_identity_conflict";
        }
        if (command(target, root, "for-each-ref", "--contains=HEAD", "--format=%(refname)",
                "refs/heads", "refs/tags", "refs/remotes").isBlank()) {
            return "worktree_unretained_commit";
        }
        return null;
    }

    public void cleanup(Plan plan, String savedIdentity) {
        String blocker = cleanupBlocker(plan, savedIdentity);
        if (blocker != null) {
            throw error(blocker, "The worktree cannot be cleaned while it contains protected work or Git activity.");
        }
        if (absent(plan)) {
            return;
        }
        Path root = Path.of(plan.root());
        command(Path.of(plan.commonDirectory()), root, "--git-dir=" + plan.commonDirectory(),
                "worktree", "remove", "--", root.resolve(plan.worktreeRoot()).toString());
    }

    public static String verify(Plan plan, String savedIdentity) {
        String actual = captureIdentity(plan, savedIdentity);
        try {
            if (!JSON.readTree(actual).equals(JSON.readTree(regularText(completion(plan))))) {
                throw new IOException("Checkout completion identity changed");
            }
            return actual;
        } catch (IOException exception) {
            throw error("worktree_identity_conflict", "Initial checkout completion cannot be verified; the directory was preserved.");
        }
    }

    private static String captureIdentity(Plan plan, String savedIdentity) {
        requireRoot(plan);
        requireMarker(plan);
        try {
            JsonNode expected = savedIdentity == null
                    ? Files.exists(completion(plan), LinkOption.NOFOLLOW_LINKS)
                            ? JSON.readTree(regularText(completion(plan))) : null
                    : JSON.readTree(savedIdentity);
            String actual = captureGitIdentity(plan, expected);
            if (savedIdentity != null && !JSON.readTree(actual).equals(expected)) {
                throw new IOException("Worktree identity changed");
            }
            return actual;
        } catch (IOException exception) {
            throw error("worktree_identity_conflict", "The original worktree identity is unavailable.");
        }
    }

    private static String captureGitIdentity(Plan plan, JsonNode expected) {
        Path root = Path.of(plan.root());
        Path target = root.resolve(plan.worktreeRoot());
        try {
            requireDirectory(target);
            Path gitfile = target.resolve(".git");
            String pointer = regularText(gitfile);
            if (!pointer.startsWith("gitdir: ")) {
                throw new IOException("Invalid gitfile");
            }
            Path gitdir = target.resolve(pointer.substring(8).strip()).normalize().toRealPath();
            Path common = gitdir.resolve(regularText(gitdir.resolve("commondir")).strip()).normalize().toRealPath();
            if (!common.toString().equals(plan.commonDirectory()) || !gitdir.getParent().equals(common.resolve("worktrees"))
                    || !gitdir.resolve(regularText(gitdir.resolve("gitdir")).strip()).normalize().toRealPath().equals(gitfile.toRealPath())) {
                throw new IOException("Git registration changed");
            }
            return JSON.writeValueAsString(Map.of("target", identity(target, expected, "target"),
                    "gitfile", identity(gitfile, expected, "gitfile"), "gitdir", gitdir.toString(),
                    "gitdirIdentity", identity(gitdir, expected, "gitdirIdentity")));
        } catch (IOException exception) {
            throw error("worktree_identity_conflict", "The original worktree is missing or its Git identity changed.");
        }
    }

    public static void requireRoot(Plan plan) {
        if (!identity(Path.of(plan.root()), plan.rootIdentity()).equals(plan.rootIdentity())
                || !identity(Path.of(plan.commonDirectory()), plan.commonIdentity()).equals(plan.commonIdentity())) {
            throw error("worktree_identity_conflict", "The original storage or Git directory changed.");
        }
    }

    public static String currentBranch(String verifiedIdentity) {
        try {
            String head = regularText(Path.of(JSON.readTree(verifiedIdentity).get("gitdir").asText()).resolve("HEAD")).strip();
            return head.startsWith("ref: refs/heads/") ? head.substring("ref: refs/heads/".length()) : "HEAD";
        } catch (IOException exception) {
            throw error("worktree_identity_conflict", "The worktree HEAD cannot be read.");
        }
    }

    public static String identity(Path path) {
        return identity(path, (String) null);
    }

    private static String identity(Path path, JsonNode expected, String field) {
        return identity(path, expected == null ? null : expected.path(field).asText());
    }

    private static String identity(Path path, String expected) {
        try {
            BasicFileAttributes stat = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (stat.isSymbolicLink() || !path.toRealPath().equals(path) || stat.fileKey() == null) {
                throw new IOException("Unverified path");
            }
            return "Mac OS X".equals(System.getProperty("os.name"))
                    && (expected == null || !expected.startsWith("(dev="))
                            ? MacOsHostIdentity.fileIdentity(path) : stat.fileKey() + ":" + stat.creationTime();
        } catch (IOException exception) {
            throw error("worktree_identity_conflict", "The original filesystem identity is unavailable.");
        }
    }

    public static Map<String, String> reattest(Plan plan, String savedIdentity, String volumeUuid) {
        if (!"Mac OS X".equals(System.getProperty("os.name")) || !volumeUuid.matches("[0-9a-f]{32}")) {
            throw error("worktree_identity_conflict", "Offline re-attestation requires a verified macOS volume.");
        }
        requireMarker(plan);
        requireLegacyAnchor(Path.of(plan.root()), plan.rootIdentity(), volumeUuid);
        requireLegacyAnchor(Path.of(plan.commonDirectory()), plan.commonIdentity(), volumeUuid);
        try {
            JsonNode saved = JSON.readTree(savedIdentity);
            if (!saved.equals(JSON.readTree(regularText(completion(plan))))) {
                throw new IOException("Original checkout completion changed");
            }
            var fields = new TreeMap<String, String>();
            JSON.readTree(captureGitIdentity(plan, null)).properties().forEach(entry -> fields.put(entry.getKey(), entry.getValue().asText()));
            String actual = JSON.writeValueAsString(fields);
            JsonNode current = JSON.readTree(actual);
            if (!saved.path("gitdir").equals(current.path("gitdir"))) {
                throw new IOException("Original Git registration changed");
            }
            Path target = Path.of(plan.root()).resolve(plan.worktreeRoot());
            // A PREPARING checkout interrupted across the upgrade keeps its legacy
            // plan but already captured a stable completion; verify those anchors
            // in place instead of requiring the legacy shape.
            requireAttestedAnchor(target, saved.path("target").asText(), volumeUuid);
            requireAttestedAnchor(target.resolve(".git"), saved.path("gitfile").asText(), volumeUuid);
            requireAttestedAnchor(Path.of(saved.path("gitdir").asText()), saved.path("gitdirIdentity").asText(), volumeUuid);
            var upgraded = JSON.valueToTree(plan);
            ((ObjectNode) upgraded)
                    .put("rootIdentity", identity(Path.of(plan.root())))
                    .put("commonIdentity", identity(Path.of(plan.commonDirectory())));
            boolean stableCompletion = saved.path("target").asText().startsWith("macos-volume/1:")
                    && saved.path("gitfile").asText().startsWith("macos-volume/1:")
                    && saved.path("gitdirIdentity").asText().startsWith("macos-volume/1:");
            return Map.of("plan", JSON.writeValueAsString(upgraded), "identity", stableCompletion ? savedIdentity : actual);
        } catch (IOException exception) {
            throw error("worktree_identity_conflict", "The original worktree cannot be re-attested.");
        }
    }

    private static void requireAttestedAnchor(Path path, String saved, String volumeUuid) {
        if (saved.startsWith("macos-volume/1:")) {
            if (!saved.startsWith("macos-volume/1:" + volumeUuid + ":") || !saved.equals(identity(path))) {
                throw error("worktree_identity_conflict", "An original inode, creation time or attested volume changed.");
            }
            return;
        }
        requireLegacyAnchor(path, saved, volumeUuid);
    }

    private static void requireLegacyAnchor(Path path, String saved, String volumeUuid) {
        String legacy = identity(path, "(dev=");
        if (!saved.matches("\\(dev=[0-9a-f]+,ino=[0-9]+\\):.+")
                || !saved.replaceFirst("^\\(dev=[0-9a-f]+,", "(dev=,")
                        .equals(legacy.replaceFirst("^\\(dev=[0-9a-f]+,", "(dev=,"))
                || !identity(path).startsWith("macos-volume/1:" + volumeUuid + ":")) {
            throw error("worktree_identity_conflict", "An original inode, creation time or attested volume changed.");
        }
    }

    private static void requireDirectory(Path path) throws IOException {
        if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) || !path.toRealPath().equals(path)) {
            throw new IOException("Not a real directory");
        }
    }

    private static void requireSeparateRepository(Path root, String repositoryRelative) {
        if (root.resolve(repositoryRelative).normalize().equals(root)) {
            throw error("worktree_layout_unsupported", "Select a project below the storage root so Session worktrees stay outside its repository.");
        }
    }

    private static Path marker(Plan plan) {
        return Path.of(plan.root()).resolve(CONTAINER).resolve(plan.worktreeId() + ".json");
    }

    private static Path completion(Plan plan) {
        return Path.of(plan.root()).resolve(CONTAINER).resolve(plan.worktreeId() + ".ready");
    }

    private static void writeRecord(Path path, byte[] content) throws IOException {
        try (FileChannel channel = FileChannel.open(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            ByteBuffer bytes = ByteBuffer.wrap(content);
            while (bytes.hasRemaining()) {
                channel.write(bytes);
            }
            channel.force(true);
        }
    }

    private boolean absent(Plan plan) {
        requireRoot(plan);
        Path target = Path.of(plan.root()).resolve(plan.worktreeRoot());
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            return false;
        }
        if (Files.exists(marker(plan), LinkOption.NOFOLLOW_LINKS)) {
            requireMarker(plan);
        }
        String registered = command(Path.of(plan.commonDirectory()), Path.of(plan.root()),
                "--git-dir=" + plan.commonDirectory(), "worktree", "list", "--porcelain", "-z");
        if (List.of(registered.split("\u0000")).contains("worktree " + target)) {
            throw error("worktree_registration_incomplete", "The missing worktree still has a Git registration.");
        }
        return true;
    }

    private static void requireMarker(Plan plan) {
        try {
            if (!JSON.readTree(regularText(marker(plan))).equals(JSON.valueToTree(plan))) {
                throw new IOException("Owner changed");
            }
        } catch (IOException exception) {
            throw error("worktree_identity_conflict", "The worktree ownership record changed.");
        }
    }

    private static String regularText(Path path) throws IOException {
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) > 64 * 1024) {
            throw new IOException("Not a small regular file");
        }
        return Files.readString(path);
    }

    private String command(Path directory, Path root, String... args) {
        return new String(git.sessionCommand(directory, root, List.of(args)), StandardCharsets.UTF_8);
    }

    public static ManagedAgentException error(String code, String message) {
        return new ManagedAgentException(409, code, message);
    }

    @Override
    public void close() {
        git.close();
    }
    public <T> T runWhileLive(BooleanSupplier live, Supplier<T> work) { return git.runWhileLive(live, work); }
}
