package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

/**
 * The physical steps of a child Workspace against real repositories
 * (#13753 I1, docs/design/2026-10-09-managed-child-workspace.md). Every
 * assertion reads the disk through a separate plain Git, never through the
 * runner under test.
 */
@DisabledOnOs(value = OS.WINDOWS, disabledReason = "Child Workspaces run on the local-process provider")
class ChildWorktreeGitTest {
    private static ChildWorktreeGit git;

    @TempDir
    Path temp;
    private Path root;
    private Path project;

    @BeforeAll
    static void requireGit() {
        git = new ChildWorktreeGit("git", Duration.ofSeconds(60));
        try {
            git.requireSupportedVersion();
        } catch (IllegalStateException error) {
            assumeTrue(false, "Git 2.40 or later is unavailable: " + error.getMessage());
        }
    }

    @BeforeEach
    void repository() throws Exception {
        root = Files.createDirectory(temp.toRealPath().resolve("root"));
        project = Files.createDirectory(root.resolve("project"));
        plain(project, "init", "-q", "-b", "main");
        write(project, "f.txt", "a\nb\nc\nd\ne\n");
        write(project, "keep.txt", "keep\n");
        write(project, ".gitignore", "ignored/\n");
        plain(project, "add", "-A");
        plain(project, "commit", "-q", "-m", "init");
    }

    @Test
    void snapshotCarriesTheDirtyTreeAndLeavesTheParentUntouched() throws Exception {
        write(project, "f.txt", "A\nb\nc\nd\ne\n");
        write(project, "untracked.txt", "u\n");
        write(project, "ignored/out.bin", "build\n");
        plain(project, "add", "keep.txt");
        byte[] index = Files.readAllBytes(project.resolve(".git/index"));
        String head = plain(project, "rev-parse", "HEAD");
        String status = plain(project, "status", "--porcelain");

        var repository = git.open(root, "project");
        String snapshot = git.snapshot(root, repository, project, null);

        assertThat(plain(project, "show", snapshot + ":f.txt")).isEqualTo("A\nb\nc\nd\ne");
        assertThat(plain(project, "show", snapshot + ":untracked.txt")).isEqualTo("u");
        assertThat(plain(project, "ls-tree", "-r", "--name-only", snapshot)).doesNotContain("ignored/out.bin");
        assertThat(plain(project, "rev-parse", snapshot + "^")).isEqualTo(head);
        assertThat(Files.readAllBytes(project.resolve(".git/index"))).isEqualTo(index);
        assertThat(plain(project, "rev-parse", "HEAD")).isEqualTo(head);
        assertThat(plain(project, "status", "--porcelain")).isEqualTo(status);
        assertThat(git.snapshot(root, repository, project, null)).isEqualTo(snapshot);
    }

    @Test
    void layoutNamesTheRepositoryAndTheOffsetInsideIt() throws Exception {
        Files.createDirectories(project.resolve("pkg/a"));
        write(project, "pkg/a/x.txt", "x\n");
        assertThat(git.layout(root, "project")).isEqualTo(new ChildWorktreeGit.Layout("project", "."));
        assertThat(git.layout(root, "project/pkg/a")).isEqualTo(new ChildWorktreeGit.Layout("project", "pkg/a"));
    }

    @Test
    void layoutRefusesEveryShapeDecisionTwoRulesOut() throws Exception {
        Files.createDirectory(root.resolve("plain"));
        assertCode(() -> git.layout(root, "plain"), ChildWorkspaceException.LAYOUT);
        assertCode(() -> git.layout(root, "missing"), ChildWorkspaceException.LAYOUT);

        Files.createDirectories(root.resolve(ChildWorktreeGit.CONTAINER + "/nested"));
        plain(root.resolve(ChildWorktreeGit.CONTAINER + "/nested"), "init", "-q");
        assertCode(() -> git.layout(root, ChildWorktreeGit.CONTAINER + "/nested"), ChildWorkspaceException.LAYOUT);

        Path outside = Files.createDirectory(temp.toRealPath().resolve("outside"));
        plain(outside, "init", "-q", "--separate-git-dir", outside.resolve("gitdir").toString(),
                root.resolve("linked").toString());
        assertCode(() -> git.layout(root, "linked"), ChildWorkspaceException.LAYOUT);

        plain(project, "config", "core.sparseCheckout", "true");
        assertCode(() -> git.layout(root, "project"), ChildWorkspaceException.LAYOUT);
    }

    @Test
    void aStorageRootInsideARepositoryIsRefused() throws Exception {
        plain(root, "init", "-q");
        assertCode(() -> git.layout(root, "."), ChildWorkspaceException.LAYOUT);
        assertCode(() -> git.open(root, "."), ChildWorkspaceException.LAYOUT);
    }

    @Test
    void anUnsafeConfigIsRefusedAndItsProgramNeverRuns() throws Exception {
        Path marker = temp.resolve("filter-ran");
        plain(project, "config", "filter.evil.clean", "touch " + marker + "; cat");
        write(project, ".gitattributes", "* filter=evil\n");
        assertCode(() -> git.layout(root, "project"), ChildWorkspaceException.UNSAFE_CONFIG);
        assertThat(marker).doesNotExist();

        plain(project, "config", "--unset", "filter.evil.clean");
        plain(project, "config", "include.path", temp.resolve("elsewhere").toString());
        assertCode(() -> git.layout(root, "project"), ChildWorkspaceException.UNSAFE_CONFIG);
    }

    @Test
    void aPromisorRemoteNeverRunsItsProgram() throws Exception {
        Path marker = temp.resolve("upload-pack-ran");
        Path remote = Files.createDirectory(temp.toRealPath().resolve("remote"));
        plain(remote, "init", "-q", "--bare");
        plain(project, "config", "core.repositoryFormatVersion", "1");
        plain(project, "config", "extensions.partialClone", "origin");
        plain(project, "config", "remote.origin.promisor", "true");
        plain(project, "config", "remote.origin.url", remote.toString());
        plain(project, "config", "remote.origin.uploadpack", "touch " + marker + "; git-upload-pack");
        // A missing tree makes the snapshot's read of HEAD fetch it lazily.
        write(project, "sub/x.txt", "x\n");
        plain(project, "add", "-A");
        plain(project, "commit", "-q", "-m", "sub");
        String tree = plain(project, "rev-parse", "HEAD:sub");
        Files.delete(project.resolve(".git/objects/" + tree.substring(0, 2) + "/" + tree.substring(2)));

        assertThatThrownBy(() -> {
            var layout = git.layout(root, "project");
            var repository = git.open(root, layout.repositoryRelative());
            git.create(root, repository, "c1", git.snapshot(root, repository, project, null));
        }).isInstanceOf(ChildWorkspaceException.class);
        assertThat(marker).doesNotExist();
    }

    @Test
    void theRefusedKeysAreTheOnesTheseCommandsReach() {
        for (String key : List.of("filter.lfs.clean", "filter.x.process", "include.path",
                "includeIf.gitdir:/x.path", "merge.ours.driver", "diff.external", "diff.pdf.textconv",
                "diff.pdf.command", "core.worktree", "FILTER.X.SMUDGE", "extensions.partialClone",
                "remote.origin.promisor")) {
            assertThat(ChildWorktreeGit.denied(key)).as(key).isTrue();
        }
        for (String key : List.of("core.hookspath", "core.fsmonitor", "core.editor", "credential.helper",
                "gpg.program", "remote.origin.url", "user.name", "merge.ours.name", "diff.pdf.binary",
                "core.autocrlf", "extensions.worktreeconfig")) {
            assertThat(ChildWorktreeGit.denied(key)).as(key).isFalse();
        }
    }

    @Test
    void aChildsOwnWorktreeConfigIsCheckedBeforeAnyCommandRunsInIt() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        Path marker = temp.resolve("child-filter-ran");
        plain(project, "config", "core.repositoryFormatVersion", "1");
        plain(project, "config", "extensions.worktreeConfig", "true");
        plain(child, "config", "--worktree", "filter.evil.clean", "touch " + marker + "; cat");
        write(child, ".gitattributes", "* filter=evil\n");
        Files.delete(child.resolve("f.txt"));

        assertCode(() -> git.create(root, repository, "c1", base), ChildWorkspaceException.UNSAFE_CONFIG);
        assertCode(() -> git.result(root, repository, "c1", base), ChildWorkspaceException.UNSAFE_CONFIG);
        assertThat(marker).doesNotExist();
        assertThat(child).exists();
    }

    @Test
    void repositoryHooksNeverRunBecauseEveryCommandOverridesTheirPath() throws Exception {
        Path hooks = Files.createDirectory(project.resolve(".husky"));
        Path marker = temp.resolve("hook-ran");
        Path hook = hooks.resolve("post-checkout");
        Files.writeString(hook, "#!/bin/sh\ntouch " + marker + "\n");
        assumeTrue(hook.toFile().setExecutable(true));
        plain(project, "config", "core.hooksPath", ".husky");

        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);

        assertThat(root.resolve(ChildWorktreeGit.CONTAINER + "/c1/f.txt")).exists();
        assertThat(marker).doesNotExist();
    }

    @Test
    void aCleanMergeLandsAsUncommittedChangesAndRemovesTheWorktree() throws Exception {
        write(project, "untracked.txt", "u\n");
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        assertThat(child.resolve("untracked.txt")).hasContent("u");
        write(child, "f.txt", "a\nb\nc\nd\nCHILD\n");
        write(child, "new.txt", "new\n");
        Files.delete(child.resolve("keep.txt"));
        plain(child, "commit", "-qam", "child commits are content, never history");
        write(project, "f.txt", "PARENT\nb\nc\nd\ne\n");
        String head = plain(project, "rev-parse", "HEAD");

        String result = git.result(root, repository, "c1", base);
        assertThat(plain(project, "rev-parse", result + "^")).isEqualTo(base);
        git.pin(root, repository, "c1", "result", result);
        var merge = git.merge(root, repository, base, result);
        assertThat(merge.clean()).isTrue();
        assertThat(project.resolve("f.txt")).hasContent("PARENT\nb\nc\nd\ne");
        git.apply(root, repository, merge.parentTree(), merge.mergedTree());
        git.discard(root, "project", "c1", false);

        assertThat(project.resolve("f.txt")).hasContent("PARENT\nb\nc\nd\nCHILD");
        assertThat(project.resolve("new.txt")).hasContent("new");
        assertThat(project.resolve("keep.txt")).doesNotExist();
        assertThat(project.resolve("untracked.txt")).hasContent("u");
        assertThat(plain(project, "rev-parse", "HEAD")).isEqualTo(head);
        assertThat(plain(project, "diff", "--cached", "--name-only")).isEmpty();
        assertThat(child).doesNotExist();
        assertThat(plain(project, "worktree", "list", "--porcelain")).doesNotContain(child.toString());
        assertThat(git.pinned(root, repository, "c1", "base")).isNull();
        assertThat(git.pinned(root, repository, "c1", "result")).isNull();
    }

    @Test
    void aConflictNamesItsPathsAndWritesNothing() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        write(child, "f.txt", "CHILD\nb\nc\nd\ne\n");
        write(child, "keep.txt", "child keep\n");
        write(project, "f.txt", "PARENT\nb\nc\nd\ne\n");

        String result = git.result(root, repository, "c1", base);
        var merge = git.merge(root, repository, base, result);

        assertThat(merge.clean()).isFalse();
        assertThat(merge.mergedTree()).isNull();
        assertThat(merge.conflicts()).containsExactly("f.txt");
        assertThat(project.resolve("f.txt")).hasContent("PARENT\nb\nc\nd\ne");
        assertThat(project.resolve("keep.txt")).hasContent("keep");
        assertThat(plain(project, "diff", "--cached", "--name-only")).isEmpty();
    }

    @Test
    void applyResumesFromAHalfWrittenTree() throws Exception {
        var merge = mergeTwoFiles();
        write(project, "f.txt", "a\nb\nc\nd\nCHILD\n");

        git.apply(root, git.open(root, "project"), merge.parentTree(), merge.mergedTree());

        assertThat(project.resolve("f.txt")).hasContent("a\nb\nc\nd\nCHILD");
        assertThat(project.resolve("keep.txt")).hasContent("child keep");
        git.apply(root, git.open(root, "project"), merge.parentTree(), merge.mergedTree());
        assertThat(project.resolve("keep.txt")).hasContent("child keep");
    }

    @Test
    void applyNeverOverwritesAPathChangedOutsideTheLease() throws Exception {
        var merge = mergeTwoFiles();
        write(project, "keep.txt", "someone else\n");

        assertCode(() -> git.apply(root, git.open(root, "project"), merge.parentTree(), merge.mergedTree()),
                ChildWorkspaceException.DIVERGED);

        assertThat(project.resolve("keep.txt")).hasContent("someone else");
        assertThat(project.resolve("f.txt")).hasContent("a\nb\nc\nd\ne");
    }

    @Test
    void createIsIdempotentAndRebuildsAnInterruptedCheckout() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        git.create(root, repository, "c1", base);
        assertThat(child.resolve("f.txt")).exists();

        Files.delete(child.resolve("f.txt"));
        git.create(root, repository, "c1", base);
        assertThat(child.resolve("f.txt")).hasContent("a\nb\nc\nd\ne");
        assertThat(git.pinned(root, repository, "c1", "base")).isEqualTo(base);

        Path stray = Files.createDirectories(root.resolve(ChildWorktreeGit.CONTAINER + "/c2"));
        write(stray, "unknown.txt", "?\n");
        assertCode(() -> git.create(root, repository, "c2", base), ChildWorkspaceException.DIVERGED);
        assertThat(stray.resolve("unknown.txt")).exists();
    }

    @Test
    void aLinkAtTheReservedPathIsRemovedAndNeverFollowed() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        Path outside = Files.createDirectory(temp.toRealPath().resolve("outside"));
        write(outside, "precious.txt", "precious\n");
        Files.createDirectory(root.resolve(ChildWorktreeGit.CONTAINER));
        Path link = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        Files.createSymbolicLink(link, outside);

        git.discard(root, "project", "c1", false);
        assertThat(link).doesNotExist();
        assertThat(outside.resolve("precious.txt")).hasContent("precious");

        Files.createSymbolicLink(link, outside);
        git.create(root, repository, "c1", base);
        assertThat(Files.isSymbolicLink(link)).isFalse();
        assertThat(link.resolve("f.txt")).exists();
        assertThat(outside.resolve("precious.txt")).hasContent("precious");
        assertThat(outside.resolve("f.txt")).doesNotExist();
    }

    @Test
    void aLinkedContainerIsRefused() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        Path outside = Files.createDirectory(temp.toRealPath().resolve("outside"));
        Files.createSymbolicLink(root.resolve(ChildWorktreeGit.CONTAINER), outside);

        assertCode(() -> git.create(root, repository, "c1", base), ChildWorkspaceException.DIVERGED);
        assertCode(() -> git.discard(root, "project", "c1", false), ChildWorkspaceException.DIVERGED);
        try (var entries = Files.list(outside)) {
            assertThat(entries).isEmpty();
        }
    }

    @Test
    void discardKeepsTheResultPinWhenAskedAndSurvivesAGoneRepository() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        write(root.resolve(ChildWorktreeGit.CONTAINER + "/c1"), "f.txt", "child\n");
        String result = git.result(root, repository, "c1", base);
        git.pin(root, repository, "c1", "result", result);

        git.discard(root, "project", "c1", true);
        assertThat(root.resolve(ChildWorktreeGit.CONTAINER + "/c1")).doesNotExist();
        assertThat(git.pinned(root, repository, "c1", "base")).isNull();
        assertThat(git.pinned(root, repository, "c1", "result")).isEqualTo(result);
        assertThat(plain(project, "show", result + ":f.txt")).isEqualTo("child");

        git.create(root, repository, "c2", base);
        deleteTree(project);
        git.discard(root, "project", "c2", false);
        assertThat(root.resolve(ChildWorktreeGit.CONTAINER + "/c2")).doesNotExist();
    }

    @Test
    void aDiscardThatCannotRunGitKeepsTheWorktree() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        var broken = new ChildWorktreeGit("qwen-no-such-git", Duration.ofSeconds(5));

        assertCode(() -> broken.discard(root, "project", "c1", false), ChildWorkspaceException.GIT);

        assertThat(root.resolve(ChildWorktreeGit.CONTAINER + "/c1/f.txt")).exists();
        assertThat(git.pinned(root, repository, "c1", "base")).isEqualTo(base);
    }

    @Test
    void aStepThatLostItsClaimStartsNoGitAndStopsTheRunningOne() throws Exception {
        var repository = git.open(root, "project");
        assertCode(() -> ChildWorktreeGit.whileLive(() -> false,
                () -> git.snapshot(root, repository, project, null)), ChildWorkspaceException.GIT);

        Path slow = temp.resolve("slow-git");
        Files.writeString(slow, "#!/bin/sh\nsleep 30\nexec git \"$@\"\n");
        assumeTrue(slow.toFile().setExecutable(true));
        var slowGit = new ChildWorktreeGit(slow.toString(), Duration.ofSeconds(60));
        java.util.concurrent.atomic.AtomicBoolean live = new java.util.concurrent.atomic.AtomicBoolean(true);
        Thread flip = new Thread(() -> {
            try {
                Thread.sleep(300);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            live.set(false);
        });
        long started = System.nanoTime();
        flip.start();
        assertCode(() -> ChildWorktreeGit.whileLive(live::get, () -> slowGit.open(root, "project")),
                ChildWorkspaceException.GIT);
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(10));
        flip.join();
    }

    @Test
    void aGoneRepositoryIsToldApartFromAChangedOne() throws Exception {
        plain(project, "config", "core.bare", "true");
        assertCode(() -> git.open(root, "project"), ChildWorkspaceException.LAYOUT);
        plain(project, "config", "core.bare", "false");
        deleteTree(project.resolve(".git"));
        assertCode(() -> git.open(root, "project"), ChildWorkspaceException.GONE);
    }

    @Test
    void theResultOfAGoneWorktreeIsMissing() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        assertCode(() -> git.result(root, repository, "c1", base), ChildWorkspaceException.MISSING);
    }

    private ChildWorktreeGit.Merge mergeTwoFiles() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        write(child, "f.txt", "a\nb\nc\nd\nCHILD\n");
        write(child, "keep.txt", "child keep\n");
        String result = git.result(root, repository, "c1", base);
        git.pin(root, repository, "c1", "result", result);
        var merge = git.merge(root, repository, base, result);
        assertThat(merge.clean()).isTrue();
        return merge;
    }

    private static void assertCode(Runnable step, String code) {
        assertThatThrownBy(step::run).isInstanceOfSatisfying(ChildWorkspaceException.class,
                error -> assertThat(error.code()).isEqualTo(code));
    }

    private static void write(Path directory, String name, String content) throws IOException {
        Path file = directory.resolve(name);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content, StandardCharsets.UTF_8);
    }

    private static void deleteTree(Path directory) throws IOException {
        try (var walk = Files.walk(directory)) {
            for (Path path : walk.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.delete(path);
            }
        }
    }

    /** A plain Git of the test's own, independent of the runner under test. */
    static String plain(Path directory, String... args) throws Exception {
        List<String> command = new ArrayList<>(List.of("git", "-C", directory.toString()));
        command.addAll(List.of(args));
        ProcessBuilder builder = new ProcessBuilder(command).redirectErrorStream(true);
        builder.environment().put("GIT_CONFIG_NOSYSTEM", "1");
        builder.environment().put("GIT_CONFIG_GLOBAL", "/dev/null");
        builder.environment().put("GIT_AUTHOR_NAME", "test");
        builder.environment().put("GIT_AUTHOR_EMAIL", "test@example.invalid");
        builder.environment().put("GIT_COMMITTER_NAME", "test");
        builder.environment().put("GIT_COMMITTER_EMAIL", "test@example.invalid");
        Process process = builder.start();
        String out = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        if (process.waitFor() != 0) {
            throw new IllegalStateException("git " + String.join(" ", args) + ": " + out);
        }
        return out.strip();
    }
}
