package com.alibaba.qwen.code.managedagent.workspace;

import com.alibaba.qwen.code.managedagent.adapters.workspace.ChildWorktreeGit;
import com.alibaba.qwen.code.managedagent.adapters.workspace.SessionWorktreeGit;
import com.alibaba.qwen.code.managedagent.api.SessionWorktreeController;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.workspace.ChildWorkspaceException;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.SessionWorktreeStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.ResolvedBinding;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
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
    void storageRootRepositoryKeepsCurrentModeButRefusesNewNestedCheckouts() throws Exception {
        root = repository;
        assertThat(git.currentBranch(root, ".")).isEqualTo("main");
        assertThatThrownBy(() -> git.source(root, ".", null))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("worktree_layout_unsupported"));
        Plan plan = storageRootPlan();
        assertThatThrownBy(() -> git.prepare(plan))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("worktree_layout_unsupported"));
        assertThat(Files.exists(root.resolve(SessionWorktreeGit.CONTAINER))).isFalse();
        assertThat(run(root, "status", "--porcelain=v1")).isEmpty();
        assertThat(run(root, "branch", "--list", plan.branch())).isEmpty();
        assertThat(run(root, "branch", "--show-current").strip()).isEqualTo("main");
    }

    @Test
    void persistedStorageRootCheckoutCanStillBeVerifiedAndSafelyCleaned() throws Exception {
        root = repository;
        Plan plan = storageRootPlan();
        Path container = Files.createDirectory(root.resolve(SessionWorktreeGit.CONTAINER));
        var mapper = new ObjectMapper();
        Files.writeString(container.resolve(plan.worktreeId() + ".json"), mapper.writeValueAsString(plan));
        run(root, "worktree", "add", "-b", plan.branch(), "--", target(plan).toString(), plan.baseCommit());
        Path gitfile = target(plan).resolve(".git");
        Path gitdir = Path.of(run(target(plan), "rev-parse", "--absolute-git-dir").strip());
        String identity = mapper.writeValueAsString(java.util.Map.of(
                "target", SessionWorktreeGit.identity(target(plan)), "gitfile", SessionWorktreeGit.identity(gitfile),
                "gitdir", gitdir.toString(), "gitdirIdentity", SessionWorktreeGit.identity(gitdir)));
        Files.writeString(container.resolve(plan.worktreeId() + ".ready"), identity);
        assertThat(SessionWorktreeGit.verify(plan, identity)).isEqualTo(identity);
        Files.writeString(target(plan).resolve("file.txt"), "valuable\n");
        assertThat(git.cleanupBlocker(plan, identity)).isEqualTo("worktree_dirty");
        assertThatThrownBy(() -> git.cleanup(plan, identity)).isInstanceOf(ManagedAgentException.class);
        assertThat(Files.readString(target(plan).resolve("file.txt"))).isEqualTo("valuable\n");
        Files.writeString(target(plan).resolve("file.txt"), "committed\n");
        git.cleanup(plan, identity);
        assertThat(Files.exists(target(plan))).isFalse();
        assertThat(Files.readString(root.resolve("file.txt"))).isEqualTo("committed\n");
        assertThat(run(root, "branch", "--show-current").strip()).isEqualTo("main");
    }

    @Test
    void optionsKeepCurrentBranchIndependentOfBaseAndExposeBothApiNames() throws Exception {
        run(repository, "branch", "topic");
        run(repository, "tag", "start");
        String commit = run(repository, "rev-parse", "HEAD").strip();
        var store = mock(SessionWorktreeStore.class);
        var selection = new WorkspaceSelection("workspace", "project");
        var binding = new ContextBinding("tenant", "workspace", 1, "storage", "project", "config", 1);
        when(store.source("tenant", "actor", selection)).thenReturn(new SessionWorktreeStore.SourceLocation(
                new ResolvedBinding(binding, "config", "policy"), root, null));
        var properties = new ManagedAgentProperties();
        var broker = properties.getRuntimeBroker();
        broker.setEnabled(true);
        broker.setSessionWorktreesEnabled(true);
        broker.setDurableLocalProcess(true);
        broker.setProvisioner("local-process");
        broker.setBoundSessionIsolationClass("session");
        var service = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new SessionWorktreeService(store, mock(WorkspaceExecutionStore.class), properties,
                mock(ManagedAgentStore.class), mock(HarnessCoordinator.class)));
        try {
            for (String ref : List.of("topic", "start", commit, "missing", "../invalid")) {
                var options = service.options("tenant", "actor", selection, ref);
                assertThat(options.currentBranch()).isEqualTo("main");
                assertThat(options.supported()).isEqualTo(!List.of("missing", "../invalid").contains(ref));
                assertThat(new ObjectMapper().valueToTree(options).path("currentBranch").asText()).isEqualTo("main");
            }
            var tenant = mock(TenantContext.class);
            when(tenant.tenantId()).thenReturn("tenant");
            when(tenant.requireActorId()).thenReturn("actor");
            assertThat(new SessionWorktreeController(service).publicOptions(tenant, "workspace", "project", "topic")
                    .getBody()).containsEntry("current_branch", "main");
            run(repository, "checkout", "topic");
            assertThat(service.options("tenant", "actor", selection, null).currentBranch()).isEqualTo("topic");
            run(repository, "checkout", "--detach", commit);
            assertThat(service.options("tenant", "actor", selection, null).currentBranch()).isEqualTo("HEAD");
            broker.setSessionWorktreesEnabled(false);
            assertThat(service.options("tenant", "actor", selection, null).currentBranch()).isNull();
        } finally {
            service.stop();
        }
    }

    @Test
    void currentBranchHandlesNestedAndUnbornReposAndRefusesPrivateOrNonGitPaths() throws Exception {
        assertThat(git.currentBranch(root, "project/src")).isEqualTo("main");
        Path unborn = Files.createDirectory(root.resolve("unborn"));
        run(unborn, "init", "-b", "new-branch");
        assertThat(git.currentBranch(root, "unborn")).isEqualTo("new-branch");
        Files.createDirectory(root.resolve("not-git"));
        assertThatThrownBy(() -> git.currentBranch(root, "not-git"))
                .hasFieldOrPropertyWithValue("code", "worktree_not_git");
        assertThatThrownBy(() -> git.currentBranch(root, SessionWorktreeGit.CONTAINER + "/private"))
                .hasFieldOrPropertyWithValue("code", "worktree_source_private");
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
        var service = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new SessionWorktreeService(store, execution,
                new ManagedAgentProperties(),
                mock(ManagedAgentStore.class), coordinator));
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
    void interruptedInitialCheckoutIsNeverAdoptedOnReentry() throws Exception {
        Path bulk = Files.createDirectory(repository.resolve("bulk"));
        for (int i = 0; i < 10000; i++) {
            Files.writeString(bulk.resolve(String.format("%05d.txt", i)), "committed\n");
        }
        run(repository, "add", ".");
        run(repository, "commit", "--quiet", "-m", "many files");
        Plan plan = plan("project", null);
        Path container = Files.createDirectory(root.resolve(SessionWorktreeGit.CONTAINER));
        Files.write(container.resolve(plan.worktreeId() + ".json"), new ObjectMapper().writeValueAsBytes(plan));
        Process checkout = new ProcessBuilder("git", "-c", "core.hooksPath=/dev/null", "-C", repository.toString(),
                "worktree", "add", "-b", plan.branch(), "--", target(plan).toString(), plan.baseCommit())
                .redirectErrorStream(true).redirectOutput(root.resolve("checkout.log").toFile()).start();
        List<ProcessHandle> descendants = List.of();
        try {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (checkout.isAlive() && !Files.exists(target(plan).resolve("bulk/00000.txt"))
                    && System.nanoTime() < deadline) {
                Thread.sleep(1);
            }
            descendants = checkout.descendants().toList();
        } finally {
            checkout.destroyForcibly();
            descendants.forEach(ProcessHandle::destroyForcibly);
            assertThat(checkout.waitFor(5, TimeUnit.SECONDS)).isTrue();
            for (ProcessHandle child : descendants) {
                child.onExit().get(5, TimeUnit.SECONDS);
            }
        }
        long checkedOut;
        try (var files = Files.list(target(plan).resolve("bulk"))) {
            checkedOut = files.count();
        }
        assertThat(checkedOut).isBetween(1L, 9999L);
        Files.writeString(target(plan).resolve("user.txt"), "preserve me\n");
        assertThatThrownBy(() -> git.prepare(plan)).isInstanceOf(ManagedAgentException.class)
                .hasMessageContaining("checkout completion");
        assertThatThrownBy(() -> SessionWorktreeGit.verify(plan, null)).isInstanceOf(ManagedAgentException.class);
        assertThat(Files.readString(target(plan).resolve("user.txt"))).isEqualTo("preserve me\n");
        try (var files = Files.list(target(plan).resolve("bulk"))) {
            assertThat(files.count()).isEqualTo(checkedOut);
        }
    }

    @Test
    void missingOrPartialCompletionRecordBlocksEvenACompletedCheckout() throws Exception {
        Plan plan = plan("project", null);
        String identity = git.prepare(plan);
        Path completion = root.resolve(SessionWorktreeGit.CONTAINER).resolve(plan.worktreeId() + ".ready");
        Files.delete(completion);
        assertThatThrownBy(() -> git.prepare(plan)).isInstanceOf(ManagedAgentException.class);
        Files.writeString(completion, "{");
        assertThatThrownBy(() -> SessionWorktreeGit.verify(plan, identity)).isInstanceOf(ManagedAgentException.class);
        assertThat(Files.readString(target(plan).resolve("file.txt"))).isEqualTo("committed\n");
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

    private Plan storageRootPlan() throws Exception {
        String id = UUID.randomUUID().toString().replace("-", "");
        String directory = SessionWorktreeGit.CONTAINER + "/" + id;
        Path common = root.resolve(".git");
        return new Plan("tenant", "workspace", 1, "storage", ".", "config", 1, root.toString(),
                SessionWorktreeGit.identity(root), ".", ".", common.toString(), SessionWorktreeGit.identity(common),
                null, run(root, "rev-parse", "HEAD").strip(), id, directory, directory, "worktree-managed-" + id);
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
