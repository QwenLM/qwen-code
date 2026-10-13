package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.AfterAll;
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
@DisabledOnOs(value = OS.WINDOWS, disabledReason = "Child Workspaces are not supported on Windows")
class ChildWorktreeGitTest {
    private static ChildWorktreeGit git;
    private static String unavailable;

    @TempDir
    Path temp;
    private Path root;
    private Path project;

    @BeforeAll
    static void probeGit() {
        git = new ChildWorktreeGit("git", Duration.ofSeconds(60));
        unavailable = unusableGit(git);
    }

    /**
     * Null when the runner accepts the host's Git, or the reason to skip
     * when the host has no Git 2.40. A runner refusing a Git the host's own
     * plain Git reports as 2.40 or later fails instead: a broken probe must
     * not pass for an absent Git.
     */
    static String unusableGit(ChildWorktreeGit runner) {
        try {
            runner.requireSupportedVersion();
            return null;
        } catch (IllegalStateException error) {
            String host;
            try {
                host = plain(Path.of("."), "--version");
            } catch (Exception absent) {
                return error.getMessage();
            }
            java.util.regex.Matcher version = java.util.regex.Pattern.compile("git version (\\d+)\\.(\\d+)")
                    .matcher(host);
            if (version.find() && (Integer.parseInt(version.group(1)) > 2
                    || Integer.parseInt(version.group(1)) == 2 && Integer.parseInt(version.group(2)) >= 40)) {
                throw new AssertionError("The runner refuses the host's " + host, error);
            }
            return error.getMessage();
        }
    }

    @AfterAll
    static void closeGit() {
        git.close();
    }

    @BeforeEach
    void repository() throws Exception {
        // Per test, so a host without a usable Git reports every case
        // skipped instead of an empty class.
        assumeTrue(unavailable == null, () -> "Git 2.40 or later is unavailable: " + unavailable);
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
    void snapshotCarriesTheWorkingTreeWhateverTheParentsIndexSays() throws Exception {
        write(project, "hidden.txt", "h0\n");
        write(project, "assumed.txt", "a0\n");
        plain(project, "add", "-A");
        plain(project, "commit", "-q", "-m", "more");
        plain(project, "update-index", "--skip-worktree", "hidden.txt");
        plain(project, "update-index", "--assume-unchanged", "assumed.txt");
        write(project, "hidden.txt", "h1\n");
        write(project, "assumed.txt", "a1\n");
        write(project, "f.txt", "staged\n");
        plain(project, "add", "f.txt");
        write(project, "f.txt", "worktree\n");
        assertThat(plain(project, "status", "--porcelain")).doesNotContain("hidden.txt").doesNotContain("assumed.txt");

        String snapshot = git.snapshot(root, git.open(root, "project"), project, null);

        // The private index starts from HEAD, never from the parent's index
        // and its bits, so the snapshot holds what is on disk.
        assertThat(plain(project, "show", snapshot + ":hidden.txt")).isEqualTo("h1");
        assertThat(plain(project, "show", snapshot + ":assumed.txt")).isEqualTo("a1");
        assertThat(plain(project, "show", snapshot + ":f.txt")).isEqualTo("worktree");
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
        plain(project, "config", "core.sparseCheckout", "2");
        assertCode(() -> git.layout(root, "project"), ChildWorkspaceException.LAYOUT);
        plain(project, "config", "--unset", "core.sparseCheckout");
        // Git reads a valueless key as true and an empty value as false.
        Files.writeString(project.resolve(".git/config"), "[core]\n\tsparseCheckout\n", StandardOpenOption.APPEND);
        assertCode(() -> git.layout(root, "project"), ChildWorkspaceException.LAYOUT);
        plain(project, "config", "--unset", "core.sparseCheckout");
        Files.writeString(project.resolve(".git/config"), "[core]\n\tsparseCheckout =\n", StandardOpenOption.APPEND);
        assertThat(git.layout(root, "project")).isEqualTo(new ChildWorktreeGit.Layout("project", "."));
    }

    @Test
    void configBooleansAreReadAsGitReadsThem() {
        for (String value : new String[] {null, "true", "Yes", "ON", "1", "2", "-1", "100", "1k", "0x10", "garbage"}) {
            assertThat(ChildWorktreeGit.truthy(value)).as(String.valueOf(value)).isTrue();
        }
        for (String value : new String[] {"", "false", "No", "off", "0", "00", "-0", "0x0", "0k", " 0 "}) {
            assertThat(ChildWorktreeGit.truthy(value)).as(value).isFalse();
        }
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
        plain(project, "config", "--unset", "include.path");

        // A worktree config switched on by any spelling Git reads as true
        // is read too: an integer, or a key with no value at all.
        plain(project, "config", "core.repositoryFormatVersion", "1");
        Files.writeString(project.resolve(".git/config.worktree"), "[filter \"evil\"]\n\tclean = touch "
                + marker + "; cat\n");
        plain(project, "config", "extensions.worktreeConfig", "2");
        assertCode(() -> git.layout(root, "project"), ChildWorkspaceException.UNSAFE_CONFIG);
        plain(project, "config", "--unset", "extensions.worktreeConfig");
        Files.writeString(project.resolve(".git/config"), "[extensions]\n\tworktreeConfig\n",
                StandardOpenOption.APPEND);
        assertCode(() -> git.layout(root, "project"), ChildWorkspaceException.UNSAFE_CONFIG);
        assertThat(marker).doesNotExist();
    }

    @Test
    void anFsmonitorTheRepositoryNamesNeverRuns() throws Exception {
        Path marker = temp.resolve("fsmonitor-ran");
        Path monitor = temp.resolve("fsmonitor");
        Files.writeString(monitor, "#!/bin/sh\ntouch " + marker + "\nexit 1\n");
        assumeTrue(monitor.toFile().setExecutable(true));
        plain(project, "config", "core.fsmonitor", monitor.toString());
        write(project, "f.txt", "changed\n");

        var repository = git.open(root, "project");
        String snapshot = git.snapshot(root, repository, project, null);

        assertThat(plain(project, "show", snapshot + ":f.txt")).isEqualTo("changed");
        assertThat(marker).doesNotExist();
    }

    @Test
    void everyCommandRunsWithAPrivateHomeAndNoSystemOrGlobalConfig() throws Exception {
        Path dump = temp.resolve("env");
        Path wrapper = temp.resolve("env-git");
        Files.writeString(wrapper, "#!/bin/sh\n[ -f '" + dump + "' ] || env > '" + dump + "'\nexec git \"$@\"\n");
        assumeTrue(wrapper.toFile().setExecutable(true));
        var dumping = new ChildWorktreeGit(wrapper.toString(), Duration.ofSeconds(60));
        try {
            dumping.open(root, "project");
        } finally {
            dumping.close();
        }

        Map<String, String> env = new HashMap<>();
        for (String line : Files.readAllLines(dump)) {
            int equals = line.indexOf('=');
            if (equals > 0) {
                env.put(line.substring(0, equals), line.substring(equals + 1));
            }
        }
        // The shell adds its own bookkeeping; everything else is the runner's.
        env.keySet().removeAll(Set.of("PWD", "OLDPWD", "SHLVL", "_"));
        assertThat(env.keySet()).containsExactlyInAnyOrder("PATH", "HOME", "XDG_CONFIG_HOME",
                "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_ATTR_NOSYSTEM", "GIT_TERMINAL_PROMPT",
                "GIT_OPTIONAL_LOCKS", "GIT_NO_REPLACE_OBJECTS", "GIT_NO_LAZY_FETCH", "GIT_ALLOW_PROTOCOL",
                "GIT_PAGER", "LC_ALL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
                "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE", "GIT_CEILING_DIRECTORIES");
        assertThat(env).containsEntry("GIT_CONFIG_NOSYSTEM", "1").containsEntry("GIT_ATTR_NOSYSTEM", "1")
                .containsEntry("GIT_ALLOW_PROTOCOL", "none").containsEntry("GIT_NO_LAZY_FETCH", "1")
                .containsEntry("GIT_CEILING_DIRECTORIES", root.toString());
        assertThat(env.get("HOME")).isNotEqualTo(System.getenv("HOME"));
        assertThat(env.get("XDG_CONFIG_HOME")).startsWith(env.get("HOME"));
        assertThat(env.get("GIT_CONFIG_GLOBAL")).doesNotStartWith(env.get("HOME"));
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

        assertCode(() -> {
            var layout = git.layout(root, "project");
            var repository = git.open(root, layout.repositoryRelative());
            git.create(root, repository, "c1", git.snapshot(root, repository, project, null));
        }, ChildWorkspaceException.UNSAFE_CONFIG);
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
    void aChildWorktreePointedAtAnotherRepositoryIsRefused() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        String gitFile = Files.readString(child.resolve(".git"));
        for (Path elsewhere : List.of(Files.createDirectory(root.resolve("other")),
                Files.createDirectory(temp.toRealPath().resolve("outside")))) {
            plain(elsewhere, "init", "-q");
            write(elsewhere, "f.txt", "foreign\n");
            plain(elsewhere, "add", "-A");
            plain(elsewhere, "commit", "-q", "-m", "foreign");
            Files.writeString(child.resolve(".git"), "gitdir: " + elsewhere.resolve(".git") + "\n");

            assertCode(() -> git.result(root, repository, "c1", base), ChildWorkspaceException.DIVERGED);
        }
        // A Git directory inside the parent's that shares another
        // repository's objects and refs is not a worktree of the parent.
        Path fake = Files.createDirectories(project.resolve(".git/worktrees/fake"));
        Files.writeString(fake.resolve("commondir"), temp.toRealPath().resolve("outside/.git") + "\n");
        Files.writeString(fake.resolve("HEAD"), base + "\n");
        Files.writeString(fake.resolve("gitdir"), child.resolve(".git") + "\n");
        Files.writeString(child.resolve(".git"), "gitdir: " + fake + "\n");
        assertCode(() -> git.result(root, repository, "c1", base), ChildWorkspaceException.DIVERGED);
        Files.writeString(child.resolve(".git"), gitFile);
        assertThat(git.result(root, repository, "c1", base)).isNotNull();
        assertThat(project.resolve("f.txt")).hasContent("a\nb\nc\nd\ne");
    }

    @Test
    void repositoryHooksNeverRunBecauseEveryCommandOverridesTheirPath() throws Exception {
        Path hooks = Files.createDirectory(project.resolve(".husky"));
        Path marker = temp.resolve("hook-ran");
        Path hook = hooks.resolve("post-checkout");
        Files.writeString(hook, "#!/bin/sh\ntouch " + marker + "\n");
        assumeTrue(hook.toFile().setExecutable(true));
        plain(project, "config", "core.hooksPath", ".husky");

        // The default hooks directory needs no config key at all, and
        // every ref update fires reference-transaction.
        Path defaults = project.resolve(".git/hooks");
        Files.createDirectories(defaults);
        for (String name : List.of("post-checkout", "reference-transaction")) {
            Path fallback = defaults.resolve(name);
            Files.writeString(fallback, "#!/bin/sh\ntouch " + temp.resolve("default-" + name + "-ran") + "\n");
            assumeTrue(fallback.toFile().setExecutable(true));
        }

        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        assertThat(root.resolve(ChildWorktreeGit.CONTAINER + "/c1/f.txt")).exists();
        assertThat(marker).doesNotExist();

        plain(project, "config", "--unset", "core.hooksPath");
        git.create(root, repository, "c2", base);
        git.pin(root, repository, "c2", "result", base);
        git.discard(root, "project", "c2", false);
        assertThat(temp.resolve("default-post-checkout-ran")).doesNotExist();
        assertThat(temp.resolve("default-reference-transaction-ran")).doesNotExist();
    }

    @Test
    void aCleanMergeLandsAsUncommittedChangesAndRemovesTheWorktree() throws Exception {
        write(project, "untracked.txt", "u\n");
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        assertThat(child.resolve("untracked.txt")).hasContent("u");
        plain(project, "branch", "before-the-child");
        plain(child, "checkout", "-qb", "child-branch");
        write(child, "f.txt", "a\nb\nc\nd\nCHILD\n");
        write(child, "new.txt", "new\n");
        Files.delete(child.resolve("keep.txt"));
        plain(child, "add", "-A");
        plain(child, "commit", "-qm", "child commits are content, never history");
        plain(child, "tag", "child-tag");
        plain(project, "branch", "during-the-child");
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
        // The child's refs go with its worktree; the parent's stay.
        assertThat(plain(project, "for-each-ref", "--format=%(refname)").lines().toList())
                .containsExactlyInAnyOrder("refs/heads/main", "refs/heads/before-the-child",
                        "refs/heads/during-the-child");
        assertThat(root.resolve(ChildWorktreeGit.CONTAINER + "/c1.refs")).doesNotExist();
    }

    @Test
    void theRefSweepDeletesSymbolicRefsThemselvesAndKeepsTheStashes() throws Exception {
        var repository = git.open(root, "project");
        String base = git.base(root, repository, "c1");
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        write(child, "f.txt", "child\n");
        plain(child, "commit", "-qam", "child");
        String result = git.result(root, repository, "c1", base);
        git.pin(root, repository, "c1", "result", result);
        // One stash ref holds the parent's stashes and the child's alike.
        write(project, "keep.txt", "parent wip\n");
        plain(project, "stash", "-q");
        write(child, "f.txt", "child wip\n");
        plain(child, "stash", "-q");
        // Even with the child's HEAD on the stash commit, the stash stays.
        plain(child, "checkout", "-q", "--detach", "refs/stash");
        // Symbolic refs go themselves, never their targets: one at the pin,
        // one at a branch the sweep deletes too.
        plain(child, "symbolic-ref", "refs/heads/at-the-pin", ChildWorktreeGit.PIN_PREFIX + "c1/result");
        plain(child, "branch", "feature", "HEAD");
        plain(child, "symbolic-ref", "refs/heads/at-feature", "refs/heads/feature");

        git.discard(root, "project", "c1", true);

        // The symbolic ref at the pin is off the child's line, so it stays.
        assertThat(plain(project, "for-each-ref", "--format=%(refname)").lines().toList())
                .contains(ChildWorktreeGit.PIN_PREFIX + "c1/result", "refs/stash", "refs/heads/at-the-pin")
                .doesNotContain("refs/heads/feature", "refs/heads/at-feature");
        assertThat(git.pinned(root, repository, "c1", "result")).isEqualTo(result);
        assertThat(plain(project, "stash", "list").lines()).hasSize(2);
    }

    @Test
    void theRefSweepStandsDownOnceTheBaseReachesAnotherHistory() throws Exception {
        var repository = git.open(root, "project");
        plain(project, "branch", "parents");
        Path other = temp.toRealPath().resolve("other-worktree");
        List<String> ways = List.of("moves a branch the parent had", "has a worktree check out its branch",
                "is merged into the parent's branch", "is the base of a sibling", "is the parent's detached HEAD");
        for (int way = 0; way < ways.size(); way++) {
            String id = "c" + way;
            String base = git.base(root, repository, id);
            git.create(root, repository, id, base);
            Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/" + id);
            plain(child, "checkout", "-qb", id + "-work");
            write(child, "f.txt", id + "\n");
            plain(child, "commit", "-qam", id);
            plain(child, "checkout", "-q", "--detach");
            git.pin(root, repository, id, "result", git.result(root, repository, id, base));
            switch (way) {
                case 0 -> plain(child, "branch", "-f", "parents", "HEAD");
                case 1 -> plain(project, "worktree", "add", "-q", other.toString(), id + "-work");
                case 2 -> {
                    plain(project, "merge", "-q", "--ff-only", id + "-work");
                    plain(project, "branch", "release");
                }
                case 3 -> {
                    String before = plain(project, "rev-parse", "HEAD");
                    plain(project, "merge", "-q", "--ff-only", id + "-work");
                    git.create(root, repository, "sibling", git.base(root, repository, "sibling"));
                    plain(project, "reset", "-q", "--hard", before);
                }
                default -> {
                    plain(project, "checkout", "-q", "--detach", id + "-work");
                    plain(project, "branch", "release-" + id);
                }
            }

            git.discard(root, "project", id, false);

            assertThat(plain(project, "for-each-ref", "--format=%(refname)")).as(ways.get(way))
                    .contains("refs/heads/" + id + "-work");
            if (way == 2 || way == 4) {
                assertThat(plain(project, "for-each-ref", "--format=%(refname)"))
                        .contains(way == 2 ? "refs/heads/release" : "refs/heads/release-" + id);
            }
        }
    }

    @Test
    void aDiscardSurvivesAFileAtTheContainersName() throws Exception {
        write(root, ChildWorktreeGit.CONTAINER, "not a directory\n");

        git.discard(root, "project", "c1", false);
        git.discard(root, null, "c1", false);

        assertThat(root.resolve(ChildWorktreeGit.CONTAINER)).hasContent("not a directory");
    }

    @Test
    void whateverStandsAtTheRecordsNameGoesWithTheDiscard() throws Exception {
        var repository = git.open(root, "project");
        git.create(root, repository, "c1", git.base(root, repository, "c1"));
        Path record = root.resolve(ChildWorktreeGit.CONTAINER + "/c1.refs");
        Files.delete(record);
        write(record, "squatter.txt", "?\n");

        git.discard(root, "project", "c1", false);

        assertThat(record).doesNotExist();
        assertThat(root.resolve(ChildWorktreeGit.CONTAINER + "/c1")).doesNotExist();
    }

    @Test
    void theSweepTakesOnlyTheChildsCheckedOutLineAndOnlyWithAResult() throws Exception {
        var repository = git.open(root, "project");
        String base = git.base(root, repository, "c1");
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        plain(child, "checkout", "-qb", "side");
        write(child, "side.txt", "side work\n");
        plain(child, "add", "-A");
        plain(child, "commit", "-qm", "side");
        String side = plain(child, "rev-parse", "HEAD");
        plain(child, "checkout", "-q", "--detach", base);
        plain(child, "checkout", "-qb", "line");
        write(child, "f.txt", "line\n");
        plain(child, "commit", "-qam", "line");
        git.pin(root, repository, "c1", "result", git.result(root, repository, "c1", base));

        git.discard(root, "project", "c1", true);

        // The side branch's commit is in no result: it stays.
        assertThat(plain(project, "for-each-ref", "--format=%(refname)").lines().toList())
                .contains("refs/heads/side").doesNotContain("refs/heads/line");
        assertThat(plain(project, "rev-parse", "refs/heads/side")).isEqualTo(side);

        // No result holds the work, or the worktree is gone: nothing goes.
        for (String id : List.of("c2", "c3")) {
            String own = git.base(root, repository, id);
            git.create(root, repository, id, own);
            Path work = root.resolve(ChildWorktreeGit.CONTAINER + "/" + id);
            plain(work, "checkout", "-qb", id + "-work");
            write(work, "f.txt", id + "\n");
            plain(work, "commit", "-qam", id);
            if ("c3".equals(id)) {
                git.pin(root, repository, id, "result", git.result(root, repository, id, own));
                deleteTree(work);
            }

            git.discard(root, "project", id, false);

            assertThat(plain(project, "for-each-ref", "--format=%(refname)")).as(id).contains("refs/heads/" + id + "-work");
        }
    }

    @Test
    void siblingsFromOneParentStateHaveBasesAndSweepsOfTheirOwn() throws Exception {
        var repository = git.open(root, "project");
        String first = git.base(root, repository, "c1");
        String second = git.base(root, repository, "c2");
        assertThat(first).isNotEqualTo(second);
        assertThat(git.base(root, repository, "c1")).isEqualTo(first);
        assertThat(plain(project, "rev-parse", first + "^{tree}")).isEqualTo(plain(project, "rev-parse",
                second + "^{tree}"));
        git.create(root, repository, "c1", first);
        git.create(root, repository, "c2", second);
        Path running = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        plain(running, "tag", "c1-milestone");
        plain(running, "checkout", "-qb", "c1-experiment");
        write(running, "f.txt", "experiment\n");
        plain(running, "commit", "-qam", "experiment");
        plain(running, "checkout", "-q", "--detach");
        git.pin(root, repository, "c2", "result", git.result(root, repository, "c2", second));

        git.discard(root, "project", "c2", false);

        assertThat(plain(project, "for-each-ref", "--format=%(refname)").lines().toList())
                .contains("refs/tags/c1-milestone", "refs/heads/c1-experiment");
    }

    @Test
    void aRefRecordTooLargeToReadSweepsNothing() throws Exception {
        var repository = git.open(root, "project");
        String base = git.base(root, repository, "c1");
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        plain(child, "checkout", "-qb", "child-branch");
        git.pin(root, repository, "c1", "result", git.result(root, repository, "c1", base));
        Path record = root.resolve(ChildWorktreeGit.CONTAINER + "/c1.refs");
        // Sparse: no disk, but no array could hold it.
        try (var file = new java.io.RandomAccessFile(record.toFile(), "rw")) {
            file.setLength(3L * 1024 * 1024 * 1024);
        }

        git.discard(root, "project", "c1", false);

        assertThat(child).doesNotExist();
        assertThat(record).doesNotExist();
        assertThat(plain(project, "for-each-ref", "--format=%(refname)")).contains("refs/heads/child-branch");
    }

    @Test
    void lineEndingChecksNeitherRefuseNorFloodTheSnapshot() throws Exception {
        plain(project, "config", "core.safecrlf", "true");
        write(project, ".gitattributes", "* text=auto\n");
        write(project, "crlf.txt", "one\r\ntwo\r\n");

        String snapshot = git.snapshot(root, git.open(root, "project"), project, null);

        assertThat(plain(project, "show", snapshot + ":crlf.txt")).isEqualTo("one\ntwo");
    }

    @Test
    void aMergedPathTheParentIgnoresLandsAndResumes() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        write(child, "gen/x.txt", "child generated\n");
        // The parent starts ignoring that directory while the child runs.
        write(project, ".gitignore", "ignored/\ngen/\n");
        String index = plain(project, "ls-files", "-s");
        String result = git.result(root, repository, "c1", base);
        var merge = git.merge(root, repository, base, result);
        assertThat(merge.clean()).isTrue();

        git.apply(root, repository, merge.parentTree(), merge.mergedTree());
        git.apply(root, repository, merge.parentTree(), merge.mergedTree());

        assertThat(project.resolve("gen/x.txt")).hasContent("child generated");
        assertThat(plain(project, "ls-files", "-s")).isEqualTo(index);
    }

    @Test
    void aMergeThatWouldOverwriteAnIgnoredFileIsAConflict() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        write(child, "ignored/out.bin", "child build\n");
        plain(child, "add", "-f", "ignored/out.bin");
        plain(child, "commit", "-qm", "force-added");
        write(project, "ignored/out.bin", "parent build\n");

        var merge = git.merge(root, repository, base, git.result(root, repository, "c1", base));

        assertThat(merge.clean()).isFalse();
        assertThat(merge.conflicts()).containsExactly("ignored/out.bin");
        assertThat(project.resolve("ignored/out.bin")).hasContent("parent build");
    }

    @Test
    void aTrackedFileTheMergeTurnsIntoADirectoryLands() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        Files.delete(child.resolve("keep.txt"));
        write(child, "keep.txt/inner.txt", "inner\n");

        var merge = git.merge(root, repository, base, git.result(root, repository, "c1", base));
        assertThat(merge.clean()).isTrue();
        git.apply(root, repository, merge.parentTree(), merge.mergedTree());

        assertThat(project.resolve("keep.txt/inner.txt")).hasContent("inner");
    }

    @Test
    void anIgnoredFileWhereAMergedPathNeedsADirectoryIsAConflict() throws Exception {
        write(project, ".gitignore", "ignored/\nout\n");
        plain(project, "commit", "-qam", "ignore out");
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        write(child, "out/report.txt", "report\n");
        plain(child, "add", "-f", "out/report.txt");
        plain(child, "commit", "-qm", "report");
        write(project, "out", "the parent's ignored file\n");

        var merge = git.merge(root, repository, base, git.result(root, repository, "c1", base));

        assertThat(merge.clean()).isFalse();
        assertThat(merge.conflicts()).containsExactly("out/report.txt");
        assertThat(project.resolve("out")).hasContent("the parent's ignored file");
    }

    @Test
    void namesBeyondAsciiMergeAndANameThatIsNotUtf8IsAConflict() throws Exception {
        write(project, "中文.txt", "parent\n");
        plain(project, "add", "-A");
        plain(project, "commit", "-qm", "unicode");
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        write(child, "café.txt", "child\n");
        write(child, "中文.txt", "child\n");

        var merge = git.merge(root, repository, base, git.result(root, repository, "c1", base));
        assertThat(merge.clean()).isTrue();
        git.apply(root, repository, merge.parentTree(), merge.mergedTree());
        assertThat(project.resolve("café.txt")).hasContent("child");
        assertThat(project.resolve("中文.txt")).hasContent("child");

        git.create(root, repository, "c2", git.snapshot(root, repository, project, null));
        Path second = root.resolve(ChildWorktreeGit.CONTAINER + "/c2");
        Process bytes = new ProcessBuilder("sh", "-c", "printf child > \"$(printf '\\377')\".txt")
                .directory(second.toFile()).start();
        assertThat(bytes.waitFor()).isZero();
        String secondBase = plain(second, "rev-parse", "HEAD");

        var refused = git.merge(root, repository, secondBase, git.result(root, repository, "c2", secondBase));

        assertThat(refused.clean()).isFalse();
        assertThat(refused.conflicts()).singleElement().asString().contains("\uFFFD");
    }

    @Test
    void aSymbolicRefAtAPinsNameIsReplacedNeverFollowed() throws Exception {
        String main = plain(project, "rev-parse", "refs/heads/main");
        var repository = git.open(root, "project");
        String base = git.base(root, repository, "c1");
        git.create(root, repository, "c1", base);
        plain(project, "symbolic-ref", ChildWorktreeGit.PIN_PREFIX + "c1/result", "refs/heads/main");
        assertThat(git.pinned(root, repository, "c1", "result")).isNull();

        git.pin(root, repository, "c1", "result", base);
        assertThat(plain(project, "rev-parse", "refs/heads/main")).isEqualTo(main);
        assertThat(git.pinned(root, repository, "c1", "result")).isEqualTo(base);

        plain(project, "update-ref", "-d", ChildWorktreeGit.PIN_PREFIX + "c1/base");
        plain(project, "symbolic-ref", ChildWorktreeGit.PIN_PREFIX + "c1/base", "refs/heads/main");
        git.discard(root, "project", "c1", false);
        assertThat(plain(project, "rev-parse", "refs/heads/main")).isEqualTo(main);
        assertThat(plain(project, "for-each-ref", "--format=%(refname)", ChildWorktreeGit.PIN_PREFIX)).isEmpty();
    }

    @Test
    void aMovedSubmodulePointerIsAConflictNotASilentMerge() throws Exception {
        String v1 = "1".repeat(40);
        String v2 = "2".repeat(40);
        Files.createDirectory(project.resolve("sub"));
        plain(project, "update-index", "--add", "--cacheinfo", "160000," + v1 + ",sub");
        plain(project, "commit", "-q", "-m", "submodule");
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        write(child, "f.txt", "a\nb\nc\nd\nCHILD\n");
        plain(child, "update-index", "--cacheinfo", "160000," + v2 + ",sub");
        plain(child, "commit", "-qam", "moves the submodule");

        String result = git.result(root, repository, "c1", base);
        var merge = git.merge(root, repository, base, result);

        assertThat(merge.clean()).isFalse();
        assertThat(merge.conflicts()).containsExactly("sub");
        assertThat(project.resolve("f.txt")).hasContent("a\nb\nc\nd\ne");
        // The write refuses a recorded gitlink change too, writing nothing.
        String baseTree = plain(project, "rev-parse", base + "^{tree}");
        String resultTree = plain(project, "rev-parse", result + "^{tree}");
        assertCode(() -> git.apply(root, repository, baseTree, resultTree), ChildWorkspaceException.DIVERGED);
        assertThat(project.resolve("f.txt")).hasContent("a\nb\nc\nd\ne");
    }

    @Test
    void theRepositorysDiffConfigCannotSpoilTheWrite() throws Exception {
        write(project, "f.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
        plain(project, "commit", "-qam", "lines");
        plain(project, "config", "color.ui", "always");
        plain(project, "config", "color.diff", "always");
        plain(project, "config", "diff.context", "0");
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        write(child, "f.txt", "1\n2\n3\n4\nCHILD\n5\n6\n7\n8\n9\n");
        write(project, "f.txt", "1\n2\n3\n4\n5\n6\n7\n8\nPARENT\n");

        var merge = git.merge(root, repository, base, git.result(root, repository, "c1", base));
        assertThat(merge.clean()).isTrue();
        git.apply(root, repository, merge.parentTree(), merge.mergedTree());

        assertThat(project.resolve("f.txt")).hasContent("1\n2\n3\n4\nCHILD\n5\n6\n7\n8\nPARENT");
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
    void aLinkedWorktreesDirectoryIsRefusedAndNothingOutsideIsTouched() throws Exception {
        Path outside = Files.createDirectory(temp.toRealPath().resolve("outside"));
        write(outside, "important/data.txt", "precious\n");
        Path admin = project.resolve(".git/worktrees");
        Files.createSymbolicLink(admin, outside);
        assertCode(() -> git.open(root, "project"), ChildWorkspaceException.LAYOUT);
        assertCode(() -> git.discard(root, "project", "c1", false), ChildWorkspaceException.LAYOUT);

        Files.delete(admin);
        Files.createDirectory(admin);
        Files.createSymbolicLink(admin.resolve("planted"), outside);
        assertCode(() -> git.open(root, "project"), ChildWorkspaceException.LAYOUT);
        assertCode(() -> git.discard(root, "project", "c1", false), ChildWorkspaceException.LAYOUT);

        assertThat(outside.resolve("important/data.txt")).hasContent("precious");
    }

    @Test
    void aLinkWhereGitWritesRefsLogsOrObjectsIsRefused() throws Exception {
        Path outside = Files.createDirectory(temp.toRealPath().resolve("outside"));
        write(outside, "victim.txt", "precious\n");
        var repository = git.open(root, "project");
        String base = git.base(root, repository, "c1");
        git.create(root, repository, "c1", base);
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        plain(child, "branch", "victim.txt");
        git.pin(root, repository, "c1", "result", git.result(root, repository, "c1", base));
        Path heads = project.resolve(".git/logs/refs/heads");
        Path aside = temp.toRealPath().resolve("heads-aside");
        Files.move(heads, aside);
        // Deleting refs/heads/victim.txt would unlink its log through the link.
        Files.createSymbolicLink(heads, outside);
        assertCode(() -> git.open(root, "project"), ChildWorkspaceException.LAYOUT);
        assertCode(() -> git.discard(root, "project", "c1", true), ChildWorkspaceException.LAYOUT);
        Files.delete(heads);
        Files.move(aside, heads);

        // A hex pair like ff collides with the fanout directory Git creates
        // for an object of that prefix; zz is never one.
        for (String planted : List.of(".git/refs/qwen-elsewhere", ".git/objects/zz", ".git/worktrees/elsewhere",
                ".git/packed-refs")) {
            Path link = project.resolve(planted);
            Files.createDirectories(link.getParent());
            Files.createSymbolicLink(link, outside);
            assertCode(() -> git.open(root, "project"), ChildWorkspaceException.LAYOUT);
            Files.delete(link);
        }
        assertThat(outside.resolve("victim.txt")).hasContent("precious");
        git.discard(root, "project", "c1", true);
    }

    @Test
    void aDiscardForgetsOnlyItsOwnWorktree() throws Exception {
        Path elsewhere = temp.toRealPath().resolve("parents-other-worktree");
        plain(project, "worktree", "add", "-q", "--detach", elsewhere.toString());
        deleteTree(elsewhere);
        var repository = git.open(root, "project");
        git.create(root, repository, "c1", git.base(root, repository, "c1"));
        Path child = root.resolve(ChildWorktreeGit.CONTAINER + "/c1");
        // The model removed its directory, so Git cannot remove it itself.
        deleteTree(child);

        git.discard(root, "project", "c1", false);

        try (var entries = Files.list(project.resolve(".git/worktrees"))) {
            assertThat(entries.map(entry -> entry.getFileName().toString()).toList())
                    .containsExactly("parents-other-worktree");
        }
        assertThat(plain(project, "worktree", "list", "--porcelain")).doesNotContain(child.toString());
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
        broken.close();

        assertThat(root.resolve(ChildWorktreeGit.CONTAINER + "/c1/f.txt")).exists();
        assertThat(git.pinned(root, repository, "c1", "base")).isEqualTo(base);
    }

    @Test
    void aDiscardOfARepositoryThatTurnedUnsafeKeepsEverything() throws Exception {
        var repository = git.open(root, "project");
        String base = git.snapshot(root, repository, project, null);
        git.create(root, repository, "c1", base);
        plain(project, "config", "filter.evil.clean", "cat");

        assertCode(() -> git.discard(root, "project", "c1", false), ChildWorkspaceException.UNSAFE_CONFIG);

        assertThat(root.resolve(ChildWorktreeGit.CONTAINER + "/c1/f.txt")).exists();
        plain(project, "config", "--unset", "filter.evil.clean");
        assertThat(git.pinned(root, repository, "c1", "base")).isEqualTo(base);
    }

    @Test
    void aStepThatLostItsClaimStartsNoGitAndStopsTheRunningOne() throws Exception {
        var repository = git.open(root, "project");
        assertCode(() -> ChildWorktreeGit.whileLive(() -> false,
                () -> git.snapshot(root, repository, project, null)), ChildWorkspaceException.GIT);

        Path pid = temp.resolve("slow-pid");
        Path kid = temp.resolve("slow-kid");
        // The command runs a child of its own, as worktree add runs a
        // checkout: both must stop.
        Path slow = script("slow-git", "echo $$ > '" + pid + "'\nsleep 30 &\necho $! > '" + kid + "'\nwait\n"
                + "exec git \"$@\"");
        var slowGit = new ChildWorktreeGit(slow.toString(), Duration.ofSeconds(60));
        java.util.concurrent.atomic.AtomicBoolean live = new java.util.concurrent.atomic.AtomicBoolean(true);
        Thread flip = new Thread(() -> {
            try {
                for (int wait = 0; wait < 500 && !Files.exists(kid); wait++) {
                    Thread.sleep(10);
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            live.set(false);
        });
        long started = System.nanoTime();
        flip.start();
        try {
            assertCode(() -> ChildWorktreeGit.whileLive(live::get, () -> slowGit.open(root, "project")),
                    ChildWorkspaceException.GIT);
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(10));
            flip.join();
            assertStopped(pid);
            assertStopped(kid);
        } finally {
            slowGit.close();
        }
    }

    @Test
    void aCommandPastItsTimeBoundIsStopped() throws Exception {
        Path pid = temp.resolve("hung-pid");
        Path kid = temp.resolve("hung-kid");
        Path hung = script("hung-git", "echo $$ > '" + pid + "'\nsleep 30 &\necho $! > '" + kid + "'\nwait\n"
                + "exec git \"$@\"");
        var hungGit = new ChildWorktreeGit(hung.toString(), Duration.ofMillis(500));
        long started = System.nanoTime();
        try {
            assertThatThrownBy(() -> hungGit.open(root, "project")).isInstanceOfSatisfying(
                    ChildWorkspaceException.class, error -> {
                        assertThat(error.code()).isEqualTo(ChildWorkspaceException.GIT);
                        assertThat(error.retryable()).isTrue();
                        assertThat(error.getMessage()).contains("timed out");
                    });
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(10));
            assertStopped(pid);
            assertStopped(kid);
        } finally {
            hungGit.close();
        }
    }

    @Test
    void outputPastItsBoundIsRefusedWhileTheCommandRuns() throws Exception {
        // A slow, endless writer: it never exits, so only the bound checked
        // while it runs can stop it before the time bound does.
        for (String stream : List.of("", " >&2")) {
            Path flood = script("flood-git" + stream.length(), "while :; do echo flood" + stream + "; done");
            var bounded = new ChildWorktreeGit(flood.toString(), Duration.ofSeconds(30), 64 * 1024);
            long started = System.nanoTime();
            try {
                assertThatThrownBy(() -> bounded.open(root, "project")).as(stream).isInstanceOfSatisfying(
                        ChildWorkspaceException.class, error -> {
                            assertThat(error.code()).isEqualTo(ChildWorkspaceException.GIT);
                            assertThat(error.retryable()).isFalse();
                            assertThat(error.getMessage()).contains("output bound");
                        });
                assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(10));
            } finally {
                bounded.close();
            }
        }
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

    private Path script(String name, String body) throws IOException {
        Path script = temp.resolve(name);
        Files.writeString(script, "#!/bin/sh\n" + body + "\n");
        assumeTrue(script.toFile().setExecutable(true));
        return script;
    }

    /**
     * The process whose pid the file names was killed, not left running
     * beside the step that gave up on it. No file means it never started.
     */
    private static void assertStopped(Path pidFile) throws Exception {
        if (Files.exists(pidFile)) {
            String pid = Files.readString(pidFile).strip();
            if (!pid.isEmpty()) {
                assertStopped(Long.parseLong(pid));
            }
        }
    }

    private static void assertStopped(long pid) throws InterruptedException {
        for (int wait = 0; wait < 100 && ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false); wait++) {
            Thread.sleep(20);
        }
        assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).as("pid %d alive", pid)
                .isFalse();
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
