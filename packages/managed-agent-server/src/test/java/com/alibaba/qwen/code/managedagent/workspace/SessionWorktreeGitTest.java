package com.alibaba.qwen.code.managedagent.workspace;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore;
import com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore.Plan;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class SessionWorktreeGitTest {
    @TempDir
    Path root;
    private Path repository;
    private SessionWorktreeGit git;

    @BeforeEach
    void setup() throws Exception {
        root = root.toRealPath();
        repository = Files.createDirectory(root.resolve("project"));
        run(repository, "init", "-b", "main");
        Files.writeString(repository.resolve("file.txt"), "committed\n");
        Files.createDirectory(repository.resolve("src"));
        Files.writeString(repository.resolve("src/module.txt"), "module\n");
        run(repository, "add", ".");
        run(repository, "commit", "-m", "initial");
        git = new SessionWorktreeGit(new ChildWorktreeGit("git", Duration.ofSeconds(10)));
    }

    @AfterEach
    void close() {
        if (git != null) {
            git.close();
        }
    }

    @Test
    void repositoryAtStorageRootSupportsSessionWorktrees() throws Exception {
        root = repository;
        Plan plan = plan(".", null);
        String identity = git.prepare(plan);
        assertThat(Files.readString(target(plan).resolve("file.txt"))).isEqualTo("committed\n");
        assertThat(SessionWorktreeGit.verify(plan, identity)).isEqualTo(identity);
        git.cleanup(plan, identity);
        assertThat(Files.exists(target(plan))).isFalse();
    }

    @Test
    void closedSessionRecordsACompletedPreparationWithoutRestartingRuntime() throws Exception {
        Plan plan = plan("project", null);
        String identity = git.prepare(plan);
        Files.writeString(target(plan).resolve("file.txt"), "preserved after interruption\n");
        var store = mock(SessionWorktreeStore.class);
        var execution = mock(WorkspaceExecutionStore.class);
        var coordinator = mock(HarnessCoordinator.class);
        var row = new SessionWorktreeStore.Row("tenant", "session", "workspace",
                plan.worktreeId(), "PREPARING", plan, null, "operation", null, 1, null, "PREPARING", 0, 1, null, "actor");
        when(store.claim(eq(row), anyString(),
                anyLong())).thenReturn(row);
        var service = new SessionWorktreeService(store, execution,
                new ManagedAgentProperties(),
                mock(ManagedAgentStore.class), coordinator);
        try {
            service.drive(row);
            verify(store).complete(eq(row), anyString(),
                    eq("READY"), eq(identity), isNull());
            verifyNoInteractions(execution, coordinator);
            assertThat(Files.readString(target(plan).resolve("file.txt"))).isEqualTo("preserved after interruption\n");
        } finally {
            service.stop();
        }
    }

    @Test
    void preparationFreezesCommittedContentsWithoutChangingDirtySourceOrIndex() throws Exception {
        Plan plan = plan("project", null);
        Files.writeString(repository.resolve("file.txt"), "staged\n");
        run(repository, "add", "file.txt");
        Files.writeString(repository.resolve("file.txt"), "unstaged\n");
        Files.writeString(repository.resolve("untracked.txt"), "untracked\n");
        String sourceStatus = run(repository, "status", "--porcelain=v1");
        String index = run(repository, "show", ":file.txt");
        String identity = git.prepare(plan);
        assertThat(Files.readString(target(plan).resolve("file.txt"))).isEqualTo("committed\n");
        assertThat(Files.exists(target(plan).resolve("untracked.txt"))).isFalse();
        assertThat(run(repository, "status", "--porcelain=v1")).isEqualTo(sourceStatus);
        assertThat(run(repository, "show", ":file.txt")).isEqualTo(index);
        assertThat(SessionWorktreeGit.verify(plan, identity)).isEqualTo(identity);
    }

    @Test
    void retryNeverResetsUserEditsOrRenamedBranch() throws Exception {
        Plan plan = plan("project", null);
        String identity = git.prepare(plan);
        run(target(plan), "branch", "-m", "renamed-work");
        Files.writeString(target(plan).resolve("file.txt"), "keep me\n");
        assertThat(git.prepare(plan)).isEqualTo(identity);
        assertThat(Files.readString(target(plan).resolve("file.txt"))).isEqualTo("keep me\n");
        assertThat(run(target(plan), "branch", "--show-current").strip()).isEqualTo("renamed-work");
        assertThat(SessionWorktreeGit.currentBranch(SessionWorktreeGit.verify(plan, identity))).isEqualTo("renamed-work");
    }

    @Test
    void separateSessionsPreserveSubdirectoryAndFrozenBaseAfterHeadMoves() throws Exception {
        Plan first = plan("project/src", null);
        Files.writeString(repository.resolve("file.txt"), "new main\n");
        run(repository, "add", ".");
        run(repository, "commit", "-m", "advance");
        Plan second = plan("project", null);
        git.prepare(first);
        git.prepare(second);
        assertThat(Files.readString(target(first).resolve("file.txt"))).isEqualTo("committed\n");
        assertThat(Files.readString(target(second).resolve("file.txt"))).isEqualTo("new main\n");
        assertThat(Files.isDirectory(root.resolve(first.cwdRelative()))).isTrue();
        Files.writeString(target(first).resolve("file.txt"), "first\n");
        Files.writeString(target(second).resolve("file.txt"), "second\n");
        assertThat(Files.readString(repository.resolve("file.txt"))).isEqualTo("new main\n");
        assertThat(first.branch()).isNotEqualTo(second.branch());
    }

    @Test
    void cleanupRetainsCommittedBranchAndIsIdempotent() throws Exception {
        Plan plan = plan("project", null);
        String identity = git.prepare(plan);
        Files.writeString(target(plan).resolve("file.txt"), "result\n");
        run(target(plan), "add", ".");
        run(target(plan), "commit", "-m", "result");
        String result = run(target(plan), "rev-parse", "HEAD").strip();
        assertThat(git.cleanupBlocker(plan, identity)).isNull();
        git.cleanup(plan, identity);
        git.cleanup(plan, identity);
        assertThat(Files.exists(target(plan))).isFalse();
        assertThat(run(repository, "rev-parse", plan.branch()).strip()).isEqualTo(result);
        assertThat(run(repository, "show", plan.branch() + ":file.txt")).isEqualTo("result\n");
    }

    @Test
    void cleanupRefusesIgnoredAndUntrackedContents() throws Exception {
        Plan plan = plan("project", null);
        String identity = git.prepare(plan);
        Files.writeString(target(plan).resolve("untracked.txt"), "valuable\n");
        assertThat(git.cleanupBlocker(plan, identity)).isEqualTo("worktree_dirty");
        Files.delete(target(plan).resolve("untracked.txt"));
        Files.writeString(Path.of(plan.commonDirectory()).resolve("info/exclude"), "private.env\n");
        Files.writeString(target(plan).resolve("private.env"), "valuable\n");
        assertThat(git.cleanupBlocker(plan, identity)).isEqualTo("worktree_dirty");
        assertThatThrownBy(() -> git.cleanup(plan, identity)).isInstanceOf(ManagedAgentException.class);
        assertThat(Files.readString(target(plan).resolve("private.env"))).isEqualTo("valuable\n");
    }

    @Test
    void cleanupRefusesHiddenTrackedChanges() throws Exception {
        Plan plan = plan("project", null);
        String identity = git.prepare(plan);
        run(target(plan), "update-index", "--assume-unchanged", "file.txt");
        Files.writeString(target(plan).resolve("file.txt"), "hidden work\n");
        assertThat(run(target(plan), "status", "--porcelain=v1")).isEmpty();
        assertThat(git.cleanupBlocker(plan, identity)).isEqualTo("worktree_index_flags");
        assertThatThrownBy(() -> git.cleanup(plan, identity)).isInstanceOf(ManagedAgentException.class);
        assertThat(Files.readString(target(plan).resolve("file.txt"))).isEqualTo("hidden work\n");
        run(target(plan), "update-index", "--no-assume-unchanged", "file.txt");
        run(target(plan), "update-index", "--skip-worktree", "file.txt");
        assertThat(git.cleanupBlocker(plan, identity)).isEqualTo("worktree_index_flags");
    }

    @Test
    void cleanupProtectsDetachedCommitWithoutRetainedRef() throws Exception {
        Plan plan = plan("project", null);
        String identity = git.prepare(plan);
        run(target(plan), "checkout", "--detach");
        Files.writeString(target(plan).resolve("file.txt"), "detached\n");
        run(target(plan), "add", ".");
        run(target(plan), "commit", "-m", "detached");
        assertThat(git.cleanupBlocker(plan, identity)).isEqualTo("worktree_unretained_commit");
        run(target(plan), "tag", "saved-result");
        assertThat(git.cleanupBlocker(plan, identity)).isNull();
    }

    @Test
    void replacedDirectoryAndForeignBranchAreNeverAdopted() throws Exception {
        Plan plan = plan("project", null);
        run(repository, "branch", plan.branch());
        assertThatThrownBy(() -> git.prepare(plan)).isInstanceOf(ManagedAgentException.class)
                .hasMessageContaining("already exists");
        assertThat(Files.exists(target(plan))).isFalse();
        Plan other = plan("project", null);
        String identity = git.prepare(other);
        Files.move(target(other), target(other).resolveSibling("saved-original"));
        Files.createDirectory(target(other));
        assertThatThrownBy(() -> SessionWorktreeGit.verify(other, identity)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> git.prepare(other)).isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void sourceLinkedCheckoutCanDisappearAfterPreparation() throws Exception {
        Path source = root.resolve("source-linked");
        run(repository, "worktree", "add", "--detach", source.toString());
        Plan plan = plan("source-linked", null);
        String identity = git.prepare(plan);
        run(repository, "worktree", "remove", source.toString());
        assertThat(SessionWorktreeGit.verify(plan, identity)).isEqualTo(identity);
        git.cleanup(plan, identity);
        assertThat(Files.exists(target(plan))).isFalse();
    }

    @Test
    void rejectsCommonDirectoryOutsideStorageAndMissingBaseDirectory() throws Exception {
        Path smallStorage = Files.createDirectory(root.resolve("small-storage"));
        Path linked = smallStorage.resolve("linked");
        run(repository, "worktree", "add", "--detach", linked.toString());
        assertThatThrownBy(() -> git.source(smallStorage, "linked", null)).isInstanceOf(ChildWorkspaceException.class);
        run(repository, "checkout", "--orphan", "empty");
        run(repository, "rm", "-rf", ".");
        Files.writeString(repository.resolve("only.txt"), "empty\n");
        run(repository, "add", ".");
        run(repository, "commit", "-m", "empty");
        assertThatThrownBy(() -> git.source(root, "project/src", "empty")).isInstanceOf(RuntimeException.class);
    }

    private Plan plan(String cwd, String ref) {
        var source = git.source(root, cwd, ref);
        String id = UUID.randomUUID().toString().replace("-", "");
        String directory = SessionWorktreeGit.CONTAINER + "/" + id;
        return new Plan("tenant", "workspace", 1, "storage", cwd, "config", 1, root.toString(),
                SessionWorktreeGit.identity(root), source.repositoryRelative(), source.offset(), source.commonDirectory(),
                source.commonIdentity(), ref, source.commit(), id, directory,
                ".".equals(source.offset()) ? directory : directory + "/" + source.offset(), "worktree-managed-" + id);
    }

    private Path target(Plan plan) {
        return root.resolve(plan.worktreeRoot());
    }

    private static String run(Path directory, String... args) throws Exception {
        List<String> command = new ArrayList<>(List.of("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                "-c", "core.hooksPath=/dev/null", "-C", directory.toString()));
        command.addAll(List.of(args));
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
        String output = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        assertThat(process.exitValue()).as(output).isZero();
        return output;
    }
}
