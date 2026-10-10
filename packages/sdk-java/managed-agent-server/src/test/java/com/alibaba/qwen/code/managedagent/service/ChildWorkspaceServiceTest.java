package com.alibaba.qwen.code.managedagent.service;

import static com.alibaba.qwen.code.managedagent.service.ChildWorktreeGitTest.plain;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore;
import com.alibaba.qwen.code.managedagent.store.ChildWorkspaceStore.Row;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The child Workspace state machine (#13753 I1) against H2 in MySQL mode
 * and real repositories: preparation, the isolated child binding, both
 * finishes, the finish rules, claim fencing, the maintenance hold, crash
 * resumption and bounded retries
 * (docs/design/2026-10-09-managed-child-workspace.md).
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:child-workspace;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        // The context's own scan judges claims by the real clock, while
        // these tests drive their own service on a fake one.
        "qwen.managed-agent.child-workspace.scan-delay=1h"
})
@DisabledOnOs(value = OS.WINDOWS, disabledReason = "Child Workspaces are not supported on Windows")
class ChildWorkspaceServiceTest {
    private static ChildWorktreeGit git;
    private static String unavailable;

    @Autowired
    private ManagedAgentStore sessions;
    @Autowired
    private ChildWorkspaceStore store;
    @Autowired
    private WorkspaceExecutionStore leases;
    @Autowired
    private JdbcTemplate jdbc;
    @TempDir
    Path temp;

    private Path root;
    private Path project;
    private final AtomicLong clock = new AtomicLong(1_000_000);
    private final StubWarmer warmer = new StubWarmer();
    /** The tenants this test created: the one database is shared by every test of the class. */
    private final Set<String> tenants = ConcurrentHashMap.newKeySet();
    private ChildWorkspaceService service;

    @BeforeAll
    static void probeGit() {
        git = new ChildWorktreeGit("git", Duration.ofSeconds(60));
        unavailable = ChildWorktreeGitTest.unusableGit(git);
    }

    @AfterAll
    static void closeGit() {
        git.close();
    }

    @BeforeEach
    void setUp() throws Exception {
        assumeTrue(unavailable == null, () -> "Git 2.40 or later is unavailable: " + unavailable);
        root = Files.createDirectory(temp.toRealPath().resolve("root"));
        project = Files.createDirectory(root.resolve("project"));
        plain(project, "init", "-q", "-b", "main");
        Files.writeString(project.resolve("f.txt"), "a\nb\nc\nd\ne\n");
        Files.writeString(project.resolve("keep.txt"), "keep\n");
        plain(project, "add", "-A");
        plain(project, "commit", "-q", "-m", "init");
        warmer.provider = provider(root);
        service = worker("worker-a");
    }

    /** Parks whatever this test left owing, so no later scan drives it. */
    @AfterEach
    void parkLeftovers() {
        for (String tenant : tenants) {
            jdbc.update("UPDATE qwen_managed_child_workspace SET finish_request = NULL, claimed_until = ?,"
                    + " next_retry_at = ? WHERE tenant_id = ?", Long.MAX_VALUE, Long.MAX_VALUE, tenant);
        }
    }

    @Test
    void preparesBindsAndMergesAChildWorkspace() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");

        assertThat(ready.state()).isEqualTo(ChildWorkspaceStore.READY);
        assertThat(ready.repositoryRelative()).isEqualTo("project");
        assertThat(ready.childCwdRelative()).isEqualTo(ChildWorktreeGit.childCwd(ready.childWorkspaceId(), "."));
        assertThat(ready.childWorkspaceId()).isEqualTo(ChildWorkspaceStore.childWorkspaceId(
                parent.tenantId(), parent.sessionId(), "run-1"));
        Path child = root.resolve(ready.childCwdRelative());
        assertThat(plain(child, "rev-parse", "HEAD")).isEqualTo(ready.baseCommit());
        assertThat(service.prepare(parent.tenantId(), parent.sessionId(), "run-1")).isEqualTo(ready);

        String childSession = bindChild(parent, "run-1", ready.childCwdRelative());
        var bound = sessions.findSessionById(childSession).orElseThrow().workspace();
        assertThat(bound.getCwdRelative()).isEqualTo(ready.childCwdRelative());
        assertThat(bound.getStorageId()).isEqualTo(parent.workspace().getStorageId());
        assertThat(bound.getWorkspaceId()).isEqualTo(parent.workspace().getWorkspaceId());
        // #13753 I2: the merge is recorded while the child runs and waits,
        // at no cost, for its close; nothing touches the running worktree.
        Row waiting = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE);
        assertThat(waiting.state()).isEqualTo(ChildWorkspaceStore.READY);
        assertThat(waiting.finishRequest()).isEqualTo(ChildWorkspaceStore.MERGE);
        assertThat(waiting.attempts()).isZero();
        assertThat(waiting.nextRetryAt()).isEqualTo(clock.get() + ChildWorkspaceService.CHILD_CLOSE_DELAY_MS);
        assertThat(waiting.lastError()).isEqualTo("The child Session bound to this Workspace is not closed.");
        assertThat(child).isDirectory();
        jdbc.update("UPDATE managed_agent_session SET status = 'CLOSING' WHERE session_id = ?", childSession);
        clock.addAndGet(ChildWorkspaceService.CHILD_CLOSE_DELAY_MS);
        assertThat(service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE).state())
                .isEqualTo(ChildWorkspaceStore.READY);

        Files.writeString(child.resolve("f.txt"), "a\nb\nc\nd\nCHILD\n");
        Files.writeString(child.resolve("new.txt"), "new\n");
        Files.writeString(project.resolve("f.txt"), "PARENT\nb\nc\nd\ne\n");
        assertThat(project.resolve("new.txt")).doesNotExist();
        close(childSession);
        clock.addAndGet(ChildWorkspaceService.CHILD_CLOSE_DELAY_MS);
        Row merged = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE);

        assertThat(merged.state()).isEqualTo(ChildWorkspaceStore.MERGED);
        assertThat(merged.outcomeCode()).isEqualTo("merged");
        assertThat(merged.lastError()).isNull();
        assertThat(project.resolve("f.txt")).hasContent("PARENT\nb\nc\nd\nCHILD");
        assertThat(project.resolve("new.txt")).hasContent("new");
        assertThat(root.resolve(ChildWorktreeGit.childDirectory(ready.childWorkspaceId()))).doesNotExist();
        assertThat(jdbc.queryForList("SELECT holder_key FROM managed_workspace_execution_lease"
                + " WHERE storage_key = ?", String.class, storageKey(parent.workspace()))).containsOnlyNulls();
        assertPinsGone(ready);
        assertThat(service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE))
                .isEqualTo(merged);
        assertApi(() -> service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD),
                "child_workspace_conflict");
    }

    @Test
    void siblingRunsFromOneParentStateGetBasesOfTheirOwn() throws Exception {
        var parent = createSession("project");
        Row first = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Row second = service.prepare(parent.tenantId(), parent.sessionId(), "run-2");

        assertThat(first.baseCommit()).isNotEqualTo(second.baseCommit());
        assertThat(plain(project, "rev-parse", first.baseCommit() + "^{tree}"))
                .isEqualTo(plain(project, "rev-parse", second.baseCommit() + "^{tree}"));
    }

    @Test
    void aConflictEndsConflictedAndTheDiscardKeepsTheChildsWork() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Path child = root.resolve(ready.childCwdRelative());
        Files.writeString(child.resolve("f.txt"), "CHILD\nb\nc\nd\ne\n");
        Files.writeString(project.resolve("f.txt"), "PARENT\nb\nc\nd\ne\n");

        Row conflicted = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE);

        assertThat(conflicted.state()).isEqualTo(ChildWorkspaceStore.CONFLICTED);
        assertThat(conflicted.outcomeCode()).isEqualTo("conflicted");
        assertThat(conflicted.conflictPaths()).containsExactly("f.txt");
        assertThat(project.resolve("f.txt")).hasContent("PARENT\nb\nc\nd\ne");
        assertThat(child).doesNotExist();
        String pin = ChildWorktreeGit.PIN_PREFIX + ready.childWorkspaceId() + "/result";
        assertThat(plain(project, "rev-parse", pin)).isEqualTo(conflicted.resultCommit());

        Row discarded = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD);
        assertThat(discarded.state()).isEqualTo(ChildWorkspaceStore.DISCARDED);
        assertThat(discarded.outcomeCode()).isEqualTo("conflicted");
        assertThat(plain(project, "show", pin + ":f.txt")).isEqualTo("CHILD\nb\nc\nd\ne");
        assertThat(service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD))
                .isEqualTo(discarded);
    }

    @Test
    void aConflictRecordsAtMostTheCappedPathsInMergeOrder() throws Exception {
        int count = ChildWorktreeGit.MAX_CONFLICT_PATHS + 1;
        for (int file = 0; file < count; file++) {
            Files.writeString(project.resolve(String.format("g%03d.txt", file)), "line\n");
        }
        plain(project, "add", "-A");
        plain(project, "commit", "-q", "-m", "many");
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Path child = root.resolve(ready.childCwdRelative());
        for (int file = 0; file < count; file++) {
            String name = String.format("g%03d.txt", file);
            Files.writeString(child.resolve(name), "child\n");
            Files.writeString(project.resolve(name), "parent\n");
        }

        Row conflicted = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE);

        assertThat(conflicted.state()).isEqualTo(ChildWorkspaceStore.CONFLICTED);
        assertThat(conflicted.conflictPaths()).hasSize(ChildWorktreeGit.MAX_CONFLICT_PATHS);
        assertThat(conflicted.conflictPaths().getFirst()).isEqualTo("g000.txt");
        assertThat(conflicted.conflictPaths().getLast())
                .isEqualTo(String.format("g%03d.txt", ChildWorktreeGit.MAX_CONFLICT_PATHS - 1));
    }

    @Test
    void aMergedPathTheParentNowIgnoresEndsMerged() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Files.createDirectories(root.resolve(ready.childCwdRelative()).resolve("gen"));
        Files.writeString(root.resolve(ready.childCwdRelative()).resolve("gen/x.txt"), "generated\n");
        Files.writeString(project.resolve(".gitignore"), "gen/\n");

        Row merged = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE);

        assertThat(merged.state()).isEqualTo(ChildWorkspaceStore.MERGED);
        assertThat(project.resolve("gen/x.txt")).hasContent("generated");
        assertThat(root.resolve(ChildWorktreeGit.childDirectory(ready.childWorkspaceId()))).doesNotExist();
    }

    @Test
    void aRefusedLayoutEndsFailedCreatingNothing() throws Exception {
        Files.createDirectory(root.resolve("plain"));
        var parent = createSession("plain");

        Row failed = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");

        assertThat(failed.state()).isEqualTo(ChildWorkspaceStore.FAILED);
        assertThat(failed.outcomeCode()).isEqualTo(ChildWorkspaceException.LAYOUT);
        assertThat(failed.baseCommit()).isNull();
        assertThat(root.resolve(ChildWorktreeGit.CONTAINER)).doesNotExist();
        assertApi(() -> service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE),
                "child_workspace_not_ready");
        assertThat(service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD).state())
                .isEqualTo(ChildWorkspaceStore.DISCARDED);
    }

    @Test
    void aParentDirectoryTheSnapshotDoesNotCarryIsALayoutRefusal() throws Exception {
        Files.createDirectory(project.resolve("empty"));
        Files.createDirectories(project.resolve("build/out"));
        Files.writeString(project.resolve(".gitignore"), "build/\n");
        Files.writeString(project.resolve("build/out/a.bin"), "built\n");
        for (String cwd : List.of("project/empty", "project/build")) {
            var parent = createSession(cwd);

            Row failed = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");

            assertThat(failed.state()).as(cwd).isEqualTo(ChildWorkspaceStore.FAILED);
            assertThat(failed.outcomeCode()).as(cwd).isEqualTo(ChildWorkspaceException.LAYOUT);
            assertThat(failed.baseCommit()).as(cwd).isNull();
            assertThat(root.resolve(ChildWorktreeGit.CONTAINER)).as(cwd).doesNotExist();
        }
    }

    @Test
    void aHostWithoutTheCapabilityAdmitsNothing() throws Exception {
        var parent = createSession("project");
        warmer.provider = null;
        assertApi(() -> service.prepare(parent.tenantId(), parent.sessionId(), "run-1"),
                "child_workspace_unsupported");
        assertThat(store.find(parent.tenantId(), parent.sessionId(), "run-1")).isNull();
    }

    @Test
    void finishRequestsFollowDecisionEight() throws Exception {
        var parent = createSession("project");
        service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        warmer.provider = null;
        Row owed = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE);
        assertThat(owed.state()).isEqualTo(ChildWorkspaceStore.READY);
        assertThat(owed.finishRequest()).isEqualTo(ChildWorkspaceStore.MERGE);
        // #13753 I2: a discard replaces a merge that has not started, and
        // the merge it replaced can no longer come back.
        assertThat(service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD)
                .finishRequest()).isEqualTo(ChildWorkspaceStore.DISCARD);
        assertApi(() -> service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE),
                "child_workspace_conflict");
        warmer.provider = provider(root);
        service.scan();
        assertThat(service.find(parent.tenantId(), parent.sessionId(), "run-1").state())
                .isEqualTo(ChildWorkspaceStore.DISCARDED);

        service.prepare(parent.tenantId(), parent.sessionId(), "run-2");
        Row discarded = service.finish(parent.tenantId(), parent.sessionId(), "run-2", ChildWorkspaceStore.DISCARD);
        assertThat(discarded.state()).isEqualTo(ChildWorkspaceStore.DISCARDED);
        assertApi(() -> service.finish(parent.tenantId(), parent.sessionId(), "run-2", ChildWorkspaceStore.MERGE),
                "child_workspace_conflict");
        assertApi(() -> service.finish(parent.tenantId(), parent.sessionId(), "run-3", ChildWorkspaceStore.MERGE),
                "child_workspace_not_found");

        // Once a merge started it runs to its end: a discard is refused.
        service.prepare(parent.tenantId(), parent.sessionId(), "run-4");
        for (String started : List.of(ChildWorkspaceStore.MERGING, ChildWorkspaceStore.APPLYING,
                ChildWorkspaceStore.APPLIED)) {
            jdbc.update("UPDATE qwen_managed_child_workspace SET state = ?, finish_request = 'merge'"
                    + " WHERE tenant_id = ? AND child_run_id = 'run-4'", started, parent.tenantId());
            assertApi(() -> service.finish(parent.tenantId(), parent.sessionId(), "run-4",
                    ChildWorkspaceStore.DISCARD), "child_workspace_finishing");
        }
    }

    // The same race through the service: the discard lands while the step
    // that leaves ready is deciding, and the merge it replaced never runs.
    @Test
    void aDiscardLandingAsTheMergeStartsWinsAtTheService() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Files.writeString(root.resolve(ready.childCwdRelative()).resolve("new.txt"), "child\n");
        store.requestFinish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE, clock.get());
        ChildWorkspaceStore racing = org.mockito.Mockito.spy(new ChildWorkspaceStore(jdbc,
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource())));
        org.mockito.Mockito.doAnswer(call -> {
            store.requestFinish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD,
                    clock.get());
            return call.callRealMethod();
        }).when(racing).childSessionsClosed(org.mockito.ArgumentMatchers.any());
        var worker = new ChildWorkspaceService(sessions, racing, leases, warmer, clock::get, "worker-race", 20);

        Row finished = worker.drive(store.find(parent.tenantId(), parent.sessionId(), "run-1"));

        assertThat(finished.state()).isEqualTo(ChildWorkspaceStore.DISCARDED);
        assertThat(finished.outcomeCode()).isEqualTo("discarded");
        assertThat(project.resolve("new.txt")).doesNotExist();
        assertThat(finished.attempts()).isZero();
    }

    @Test
    void aStartedFinishNeverRunsTheMergeADiscardReplaced() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        store.requestFinish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE, clock.get());
        Row claimed = store.claim(store.find(parent.tenantId(), parent.sessionId(), "run-1"), "worker",
                clock.get(), 60_000);
        // The discard lands between the claim and the start of the merge.
        store.requestFinish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD, clock.get());
        assertThat(store.startFinish(claimed, "worker", ChildWorkspaceStore.MERGING, ChildWorkspaceStore.MERGE,
                clock.get())).isFalse();
        assertThat(store.find(parent.tenantId(), parent.sessionId(), "run-1").state())
                .isEqualTo(ChildWorkspaceStore.READY);
        assertThat(store.startFinish(claimed, "worker", ChildWorkspaceStore.DISCARDING,
                ChildWorkspaceStore.DISCARD, clock.get())).isTrue();
        assertThat(ready.childWorkspaceId()).isNotNull();
    }

    @Test
    void anIsolatedChildBindsOnlyToItsReadyUnfinishedWorkspace() throws Exception {
        var parent = createSession("project");
        store.admit(parent.tenantId(), parent.sessionId(), "run-1", parent.workspace(), clock.get());
        assertApi(() -> bindChild(parent, "run-1", ".qwen-child-workspaces/x"), "child_workspace_not_ready");

        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        assertApi(() -> bindChild(parent, "run-1", ready.childCwdRelative() + "/elsewhere"),
                "child_workspace_not_ready");
        for (String moved : List.of("storage_id = 'moved'", "workspace_id = 'moved'", "workspace_generation = 2")) {
            jdbc.update("UPDATE qwen_managed_child_workspace SET " + moved + " WHERE child_workspace_id = ?",
                    ready.childWorkspaceId());
            assertApi(() -> bindChild(parent, "run-1", ready.childCwdRelative()), "child_workspace_not_ready");
            jdbc.update("UPDATE qwen_managed_child_workspace SET storage_id = ?, workspace_id = ?,"
                    + " workspace_generation = ? WHERE child_workspace_id = ?", parent.workspace().getStorageId(),
                    parent.workspace().getWorkspaceId(), parent.workspace().getWorkspaceGeneration(),
                    ready.childWorkspaceId());
        }
        jdbc.update("UPDATE qwen_managed_child_workspace SET finish_request = 'discard'"
                + " WHERE child_workspace_id = ?", ready.childWorkspaceId());
        assertApi(() -> bindChild(parent, "run-1", ready.childCwdRelative()), "child_workspace_not_ready");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_session WHERE parent_session_id = ?",
                Integer.class, parent.sessionId())).isZero();
    }

    @Test
    void aBusyStorageParksTheStepWithoutSpendingAnAttempt() throws Exception {
        var parent = createSession("project");
        String key = storageKey(parent.workspace());
        jdbc.update("INSERT INTO managed_workspace_execution_lease (storage_key, storage_kind, holder_key)"
                + " VALUES (?, 'LOCAL', 'a-tool-turn')", key);

        Row parked = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        assertThat(parked.state()).isEqualTo(ChildWorkspaceStore.PREPARING);
        assertThat(parked.attempts()).isZero();
        assertThat(parked.nextRetryAt()).isEqualTo(clock.get() + ChildWorkspaceService.BUSY_DELAY_MS);
        assertThat(parked.lastError()).contains("held by another tool turn");
        assertThat(root.resolve(ChildWorktreeGit.CONTAINER)).doesNotExist();

        service.scan();
        assertThat(service.find(parent.tenantId(), parent.sessionId(), "run-1").state())
                .isEqualTo(ChildWorkspaceStore.PREPARING);
        jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = NULL WHERE storage_key = ?", key);
        clock.addAndGet(ChildWorkspaceService.BUSY_DELAY_MS);
        service.scan();
        assertThat(service.find(parent.tenantId(), parent.sessionId(), "run-1").state())
                .isEqualTo(ChildWorkspaceStore.READY);
    }

    @Test
    void theMaintenanceHoldBelongsToOneClaim() throws Exception {
        var parent = createSession("project");
        ContextBinding storage = parent.workspace();
        Row row = store.admit(parent.tenantId(), parent.sessionId(), "run-1", storage, clock.get());
        Row other = store.admit(parent.tenantId(), parent.sessionId(), "run-2", storage, clock.get());
        Row first = store.claim(row, "a", clock.get(), 1_000);
        Row rival = store.claim(other, "a", clock.get(), 1_000);

        leases.holdForMaintenance(storage, first.childWorkspaceId(), first.claimGeneration());
        assertBroker(() -> leases.holdForMaintenance(storage, rival.childWorkspaceId(), rival.claimGeneration()),
                "workspace_busy");
        clock.addAndGet(1_001);
        Row second = store.claim(row, "b", clock.get(), 1_000);
        assertBroker(() -> leases.holdForMaintenance(storage, first.childWorkspaceId(), first.claimGeneration()),
                "workspace_unavailable");
        leases.holdForMaintenance(storage, second.childWorkspaceId(), second.claimGeneration());
        leases.releaseMaintenance(storage, first.childWorkspaceId(), first.claimGeneration());
        assertThat(holder(storage)).isEqualTo(maintenanceHolder(second));
        leases.releaseMaintenance(storage, second.childWorkspaceId(), second.claimGeneration());
        assertThat(holder(storage)).isNull();
        // An expired claim still of the current generation may take the
        // hold; the scan frees it once nothing renews that claim.
        assertThat(rival.claimedUntil()).isLessThan(clock.get());
        leases.holdForMaintenance(storage, rival.childWorkspaceId(), rival.claimGeneration());
        assertThat(holder(storage)).isEqualTo(maintenanceHolder(rival));
        leases.releaseMaintenance(storage, rival.childWorkspaceId(), rival.claimGeneration());
        assertThat(holder(storage)).isNull();
    }

    @Test
    void anExpiredClaimYieldsToAnotherWorkerAndCannotCommit() throws Exception {
        var parent = createSession("project");
        Row row = store.admit(parent.tenantId(), parent.sessionId(), "run-1", parent.workspace(), clock.get());
        Row stalled = store.claim(row, "worker-a", clock.get(), ChildWorkspaceService.LEASE_MS);
        ChildWorkspaceService other = worker("worker-b");

        other.scan();
        assertThat(other.find(parent.tenantId(), parent.sessionId(), "run-1").state())
                .isEqualTo(ChildWorkspaceStore.PREPARING);
        clock.addAndGet(ChildWorkspaceService.LEASE_MS + 1);
        other.scan();
        assertThat(other.find(parent.tenantId(), parent.sessionId(), "run-1").state())
                .isEqualTo(ChildWorkspaceStore.READY);

        assertThat(store.transition(stalled, "worker-a", ChildWorkspaceStore.FAILED,
                ChildWorkspaceStore.columns(), clock.get())).isFalse();

        // Same state, newer claim: only the claim generation tells them apart.
        Row second = store.admit(parent.tenantId(), parent.sessionId(), "run-2", parent.workspace(), clock.get());
        Row first = store.claim(second, "worker-a", clock.get(), ChildWorkspaceService.LEASE_MS);
        clock.addAndGet(ChildWorkspaceService.LEASE_MS + 1);
        Row taken = store.claim(second, "worker-a", clock.get(), ChildWorkspaceService.LEASE_MS);
        assertThat(taken.state()).isEqualTo(first.state());
        assertThat(store.transition(first, "worker-a", ChildWorkspaceStore.FAILED,
                ChildWorkspaceStore.columns(), clock.get())).isFalse();
        assertThat(store.transition(taken, "worker-a", ChildWorkspaceStore.FAILED,
                ChildWorkspaceStore.columns(), clock.get())).isTrue();
        assertBroker(() -> leases.holdForMaintenance(parent.workspace(), stalled.childWorkspaceId(),
                stalled.claimGeneration()), "workspace_unavailable");
    }

    @Test
    void aCrashBetweenRecordingTheBaseAndCreatingTheWorktreeResumesFromTheBase() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Path child = root.resolve(ready.childCwdRelative());
        plain(project, "worktree", "remove", "--force", child.toString());
        jdbc.update("UPDATE qwen_managed_child_workspace SET state = 'preparing' WHERE child_workspace_id = ?",
                ready.childWorkspaceId());
        Files.writeString(project.resolve("f.txt"), "changed after the base\n");

        service.scan();

        Row resumed = service.find(parent.tenantId(), parent.sessionId(), "run-1");
        assertThat(resumed.state()).isEqualTo(ChildWorkspaceStore.READY);
        assertThat(resumed.baseCommit()).isEqualTo(ready.baseCommit());
        assertThat(plain(child, "rev-parse", "HEAD")).isEqualTo(ready.baseCommit());
        assertThat(child.resolve("f.txt")).hasContent("a\nb\nc\nd\ne");
    }

    @Test
    void theMergeAndItsWriteShareOneHold() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Files.writeString(root.resolve(ready.childCwdRelative()).resolve("keep.txt"), "child\n");
        // One storage root resolution is one maintenance hold: a second
        // would find the storage busy and park the row in applying.
        warmer.provider = provider(root, 1);

        Row merged = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE);

        assertThat(merged.state()).isEqualTo(ChildWorkspaceStore.MERGED);
        assertThat(project.resolve("keep.txt")).hasContent("child");
    }

    @Test
    void aCrashAfterTheWriteLandedResumesToMerged() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Path child = root.resolve(ready.childCwdRelative());
        Files.writeString(child.resolve("keep.txt"), "child\n");
        Files.writeString(child.resolve("f.txt"), "a\nb\nc\nd\nCHILD\n");
        var repository = git.open(root, "project");
        String result = git.result(root, repository, ready.childWorkspaceId(), ready.baseCommit());
        git.pin(root, repository, ready.childWorkspaceId(), "result", result);
        var merge = git.merge(root, repository, ready.baseCommit(), result);
        // The write landed and was recorded, then the worker died before
        // committing merged; the storage was free since, and the parent
        // edited a merged path.
        git.apply(root, repository, merge.parentTree(), merge.mergedTree());
        jdbc.update("UPDATE qwen_managed_child_workspace SET state = 'applied', finish_request = 'merge',"
                + " result_commit = ?, parent_tree = ?, merged_tree = ? WHERE child_workspace_id = ?",
                result, merge.parentTree(), merge.mergedTree(), ready.childWorkspaceId());
        Files.writeString(project.resolve("keep.txt"), "the parent's later edit\n");

        service.scan();

        Row merged = service.find(parent.tenantId(), parent.sessionId(), "run-1");
        assertThat(merged.state()).isEqualTo(ChildWorkspaceStore.MERGED);
        assertThat(merged.outcomeCode()).isEqualTo("merged");
        assertThat(project.resolve("keep.txt")).hasContent("the parent's later edit");
        assertThat(project.resolve("f.txt")).hasContent("a\nb\nc\nd\nCHILD");
        assertThat(child).doesNotExist();
        assertPinsGone(ready);
    }

    @Test
    void aCrashBeforeTheLandedWriteWasRecordedResumesItsWrite() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Path child = root.resolve(ready.childCwdRelative());
        Files.writeString(child.resolve("keep.txt"), "child\n");
        var repository = git.open(root, "project");
        String result = git.result(root, repository, ready.childWorkspaceId(), ready.baseCommit());
        git.pin(root, repository, ready.childWorkspaceId(), "result", result);
        var merge = git.merge(root, repository, ready.baseCommit(), result);
        jdbc.update("UPDATE qwen_managed_child_workspace SET state = 'applying', finish_request = 'merge',"
                + " result_commit = ?, parent_tree = ?, merged_tree = ? WHERE child_workspace_id = ?",
                result, merge.parentTree(), merge.mergedTree(), ready.childWorkspaceId());
        git.apply(root, repository, merge.parentTree(), merge.mergedTree());

        service.scan();

        Row merged = service.find(parent.tenantId(), parent.sessionId(), "run-1");
        assertThat(merged.state()).isEqualTo(ChildWorkspaceStore.MERGED);
        assertThat(project.resolve("keep.txt")).hasContent("child");
        assertThat(child).doesNotExist();
        assertPinsGone(ready);
    }

    @Test
    void aMergeRecordsItsLandedWriteBeforeTheCleanup() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Files.writeString(root.resolve(ready.childCwdRelative()).resolve("keep.txt"), "child\n");
        // The cleanup's unpin fails; the write before it does not.
        Path failing = temp.resolve("unpin-fails-git");
        Files.writeString(failing, "#!/bin/sh\ncase \" $* \" in *\" update-ref \"*\" -d \"*) exit 1;; esac\n"
                + "exec git \"$@\"\n");
        assumeTrue(failing.toFile().setExecutable(true));
        ChildWorktreeGit failingGit = new ChildWorktreeGit(failing.toString(), Duration.ofSeconds(60));
        try {
            warmer.provider = provider(root, Integer.MAX_VALUE, failingGit);

            Row parked = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE);

            assertThat(parked.state()).isEqualTo(ChildWorkspaceStore.APPLIED);
            assertThat(parked.attempts()).isEqualTo(1);
            assertThat(project.resolve("keep.txt")).hasContent("child");
        } finally {
            failingGit.close();
        }
        warmer.provider = provider(root);
        Files.writeString(project.resolve("keep.txt"), "the parent's later edit\n");
        clock.addAndGet(ChildWorkspaceService.LEASE_MS);
        service.scan();
        Row merged = service.find(parent.tenantId(), parent.sessionId(), "run-1");
        assertThat(merged.state()).isEqualTo(ChildWorkspaceStore.MERGED);
        assertThat(project.resolve("keep.txt")).hasContent("the parent's later edit");
        assertPinsGone(ready);
    }

    @Test
    void aLandedMergeWhoseCleanupCannotFinishStaysMerged() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Files.writeString(root.resolve(ready.childCwdRelative()).resolve("keep.txt"), "child\n");
        var repository = git.open(root, "project");
        String result = git.result(root, repository, ready.childWorkspaceId(), ready.baseCommit());
        git.pin(root, repository, ready.childWorkspaceId(), "result", result);
        var merge = git.merge(root, repository, ready.baseCommit(), result);
        git.apply(root, repository, merge.parentTree(), merge.mergedTree());
        jdbc.update("UPDATE qwen_managed_child_workspace SET state = 'applied', finish_request = 'merge',"
                + " result_commit = ?, parent_tree = ?, merged_tree = ? WHERE child_workspace_id = ?",
                result, merge.parentTree(), merge.mergedTree(), ready.childWorkspaceId());
        plain(project, "config", "filter.evil.clean", "cat");

        service.scan();

        Row blocked = service.find(parent.tenantId(), parent.sessionId(), "run-1");
        assertThat(blocked.state()).isEqualTo(ChildWorkspaceStore.BLOCKED);
        assertThat(blocked.outcomeCode()).isEqualTo("merged");
        assertThat(blocked.lastError()).contains("filter.evil.clean");
        // A discard that fails too keeps the outcome: the merge landed.
        Row still = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD);
        assertThat(still.state()).isEqualTo(ChildWorkspaceStore.BLOCKED);
        assertThat(still.outcomeCode()).isEqualTo("merged");
        plain(project, "config", "--unset", "filter.evil.clean");
        Row discarded = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD);
        assertThat(discarded.state()).isEqualTo(ChildWorkspaceStore.DISCARDED);
        assertThat(discarded.outcomeCode()).isEqualTo("merged");
        assertThat(project.resolve("keep.txt")).hasContent("child");
        assertPinsGone(ready);
    }

    @Test
    void retriesAreBoundedAndEndBlocked() throws Exception {
        var parent = createSession("project");
        warmer.provider = new ChildWorkspaceProvider() {
            @Override
            public Path storageRoot(ContextBinding binding) {
                throw WorkspaceExecutionStore.unavailable();
            }

            @Override
            public ChildWorktreeGit git() {
                return git;
            }
        };
        Row row = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        assertThat(row.attempts()).isEqualTo(1);
        for (int attempt = 0; attempt < ChildWorkspaceService.MAX_ATTEMPTS
                && !ChildWorkspaceStore.BLOCKED.equals(row.state()); attempt++) {
            clock.addAndGet(120_000);
            service.scan();
            row = service.find(parent.tenantId(), parent.sessionId(), "run-1");
        }
        assertThat(row.state()).isEqualTo(ChildWorkspaceStore.BLOCKED);
        assertThat(row.outcomeCode()).isEqualTo("workspace_unavailable");
        warmer.provider = provider(root);
        assertThat(service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD).state())
                .isEqualTo(ChildWorkspaceStore.DISCARDED);
    }

    @Test
    void aLiveClaimIsNeverTakenTwiceEvenByItsOwnWorker() throws Exception {
        var parent = createSession("project");
        Row row = store.admit(parent.tenantId(), parent.sessionId(), "run-1", parent.workspace(), clock.get());
        assertThat(store.claim(row, "worker-a", clock.get(), ChildWorkspaceService.LEASE_MS)).isNotNull();
        assertThat(store.claim(row, "worker-a", clock.get(), ChildWorkspaceService.LEASE_MS)).isNull();
        assertThat(store.findDue(clock.get(), 10)).noneMatch(due -> due.childRunId().equals("run-1")
                && due.parentSessionId().equals(parent.sessionId()));
        service.scan();
        assertThat(service.find(parent.tenantId(), parent.sessionId(), "run-1").state())
                .isEqualTo(ChildWorkspaceStore.PREPARING);
    }

    @Test
    void aRunningStepRenewsItsClaim() throws Exception {
        var parent = createSession("project");
        AtomicLong renewedUntil = new AtomicLong();
        ChildWorkspaceProvider slow = provider(root);
        warmer.provider = new ChildWorkspaceProvider() {
            @Override
            public Path storageRoot(ContextBinding binding) {
                long started = clock.addAndGet(1_000);
                for (int wait = 0; wait < 200 && renewedUntil.get() != started + ChildWorkspaceService.LEASE_MS;
                        wait++) {
                    sleep(10);
                    renewedUntil.set(jdbc.queryForObject("SELECT claimed_until FROM qwen_managed_child_workspace"
                            + " WHERE parent_session_id = ?", Long.class, parent.sessionId()));
                }
                return slow.storageRoot(binding);
            }

            @Override
            public ChildWorktreeGit git() {
                return git;
            }
        };

        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");

        assertThat(ready.state()).isEqualTo(ChildWorkspaceStore.READY);
        assertThat(renewedUntil.get()).isEqualTo(clock.get() + ChildWorkspaceService.LEASE_MS);
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(error);
        }
    }

    // #13753 I2: a result's receipt reports an ended merge, so a later
    // discard that cannot finish must leave that outcome, its paths and its
    // result alone, as I1 already did for `merged`.
    @Test
    void anEndedMergeKeepsItsOutcomeThroughADiscardThatCannotFinish() throws Exception {
        var parent = createSession("project");
        Row ready = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Path child = root.resolve(ready.childCwdRelative());
        Files.writeString(child.resolve("f.txt"), "CHILD\nb\nc\nd\ne\n");
        Files.writeString(project.resolve("f.txt"), "PARENT\nb\nc\nd\ne\n");
        Row conflicted = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.MERGE);
        assertThat(conflicted.state()).isEqualTo(ChildWorkspaceStore.CONFLICTED);
        Path container = root.resolve(ChildWorktreeGit.CONTAINER);
        Files.createDirectories(container);
        Path moved = temp.toRealPath().resolve("moved");
        Files.move(container, moved);
        Files.createSymbolicLink(container, moved);

        Row blocked = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD);

        assertThat(blocked.state()).isEqualTo(ChildWorkspaceStore.BLOCKED);
        assertThat(blocked.outcomeCode()).isEqualTo("conflicted");
        assertThat(blocked.conflictPaths()).containsExactly("f.txt");
        assertThat(blocked.resultCommit()).isEqualTo(conflicted.resultCommit());
        assertThat(blocked.lastError()).isNotNull();
    }

    @Test
    void aDiscardThatCannotFinishEndsBlockedUntilAskedAgain() throws Exception {
        var parent = createSession("project");
        service.prepare(parent.tenantId(), parent.sessionId(), "run-1");
        Path container = root.resolve(ChildWorktreeGit.CONTAINER);
        Path moved = temp.toRealPath().resolve("moved");
        Files.move(container, moved);
        Files.createSymbolicLink(container, moved);

        Row blocked = service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD);

        assertThat(blocked.state()).isEqualTo(ChildWorkspaceStore.BLOCKED);
        assertThat(blocked.outcomeCode()).isEqualTo(ChildWorkspaceException.DIVERGED);
        assertThat(blocked.finishRequest()).isNull();
        clock.addAndGet(120_000);
        service.scan();
        assertThat(service.find(parent.tenantId(), parent.sessionId(), "run-1")).isEqualTo(blocked);

        Files.delete(container);
        Files.move(moved, container);
        assertThat(service.finish(parent.tenantId(), parent.sessionId(), "run-1", ChildWorkspaceStore.DISCARD).state())
                .isEqualTo(ChildWorkspaceStore.DISCARDED);
    }

    @Test
    void theScanReleasesAHoldNoStepOwns() throws Exception {
        var parent = createSession("project");
        Row row = store.admit(parent.tenantId(), parent.sessionId(), "run-1", parent.workspace(), clock.get());
        Row dead = store.claim(row, "dead-worker", clock.get(), 1_000);
        leases.holdForMaintenance(parent.workspace(), dead.childWorkspaceId(), dead.claimGeneration());
        // The worker committed its last state, then died before releasing.
        jdbc.update("UPDATE qwen_managed_child_workspace SET state = 'merged' WHERE child_workspace_id = ?",
                dead.childWorkspaceId());

        service.scan();
        assertThat(holder(parent.workspace())).isEqualTo(maintenanceHolder(dead));
        clock.addAndGet(1_001);
        service.scan();
        assertThat(holder(parent.workspace())).isNull();
        assertThat(jdbc.queryForList("SELECT holder_key FROM managed_workspace_execution_lease"
                + " WHERE storage_key = ?", String.class, storageKey(parent.workspace()))).containsOnlyNulls();
    }

    @Test
    void aCrashedStepsHoldPassesToItsResumedStepWithoutAGap() throws Exception {
        for (String state : List.of(ChildWorkspaceStore.PREPARING, ChildWorkspaceStore.MERGING,
                ChildWorkspaceStore.APPLYING, ChildWorkspaceStore.APPLIED, ChildWorkspaceStore.DISCARDING)) {
            var parent = createSession("project");
            Row row = store.admit(parent.tenantId(), parent.sessionId(), "run-1", parent.workspace(), clock.get());
            jdbc.update("UPDATE qwen_managed_child_workspace SET state = ? WHERE child_workspace_id = ?", state,
                    row.childWorkspaceId());
            Row dead = store.claim(store.find(parent.tenantId(), parent.sessionId(), "run-1"), "dead-worker",
                    clock.get(), 1_000);
            leases.holdForMaintenance(parent.workspace(), dead.childWorkspaceId(), dead.claimGeneration());
            List<String> heldWhenResumed = new java.util.concurrent.CopyOnWriteArrayList<>();
            ChildWorkspaceProvider real = provider(root);
            warmer.provider = new ChildWorkspaceProvider() {
                @Override
                public Path storageRoot(ContextBinding binding) {
                    if (heldWhenResumed.isEmpty()) {
                        heldWhenResumed.add(String.valueOf(jdbc.queryForObject("SELECT maintenance_id FROM"
                                + " managed_workspace_execution_lease WHERE storage_key = ?", String.class,
                                storageKeyOf(binding))));
                    }
                    return real.storageRoot(binding);
                }

                @Override
                public ChildWorktreeGit git() {
                    return git;
                }
            };
            clock.addAndGet(1_001);

            service.scan();

            // The resumed step may fail on this bare row; what matters is
            // that it found the hold still standing, and freed it after.
            assertThat(heldWhenResumed).as(state).containsExactly(dead.childWorkspaceId());
            assertThat(holder(parent.workspace())).as(state).isNull();
            parkLeftovers();
        }
    }

    @Test
    void aStrandedHoldIsReleasedEvenWithTheCapabilityOff() throws Exception {
        var parent = createSession("project");
        Row row = store.admit(parent.tenantId(), parent.sessionId(), "run-1", parent.workspace(), clock.get());
        Row dead = store.claim(row, "dead-worker", clock.get(), 1_000);
        leases.holdForMaintenance(parent.workspace(), dead.childWorkspaceId(), dead.claimGeneration());
        warmer.provider = null;
        clock.addAndGet(1_001);

        // A step's row: a host that runs steps may resume it, so this one
        // waits a grace period, then frees the storage anyway.
        service.scan();
        assertThat(holder(parent.workspace())).isEqualTo(maintenanceHolder(dead));
        clock.addAndGet(ChildWorkspaceService.RESUMABLE_GRACE_MS);
        service.scan();

        assertThat(holder(parent.workspace())).isNull();
    }

    @Test
    void aScanStopsDrivingRowsOnceItsBudgetIsSpent() throws Exception {
        var parent = createSession("project");
        ChildWorkspaceProvider slow = provider(root);
        warmer.provider = new ChildWorkspaceProvider() {
            @Override
            public Path storageRoot(ContextBinding binding) {
                clock.addAndGet(ChildWorkspaceService.SCAN_BUDGET_MS);
                return slow.storageRoot(binding);
            }

            @Override
            public ChildWorktreeGit git() {
                return git;
            }
        };
        store.admit(parent.tenantId(), parent.sessionId(), "run-1", parent.workspace(), clock.get());
        clock.addAndGet(1);
        store.admit(parent.tenantId(), parent.sessionId(), "run-2", parent.workspace(), clock.get());
        Row dead = store.claim(store.admit(parent.tenantId(), parent.sessionId(), "run-3", parent.workspace(),
                clock.get()), "dead-worker", clock.get(), 1);
        jdbc.update("UPDATE qwen_managed_child_workspace SET state = 'merged' WHERE child_workspace_id = ?",
                dead.childWorkspaceId());
        leases.holdForMaintenance(parent.workspace(), dead.childWorkspaceId(), dead.claimGeneration());
        clock.addAndGet(2);

        service.scan();

        assertThat(service.find(parent.tenantId(), parent.sessionId(), "run-1").state())
                .isEqualTo(ChildWorkspaceStore.READY);
        Row waiting = service.find(parent.tenantId(), parent.sessionId(), "run-2");
        assertThat(waiting.state()).isEqualTo(ChildWorkspaceStore.PREPARING);
        assertThat(waiting.attempts()).isZero();
        assertThat(waiting.claimGeneration()).isZero();
    }

    @Test
    void aStepWhoseClaimMovesOnStopsItsGit() throws Exception {
        Path gate = Files.createFile(temp.resolve("gate"));
        Path pid = temp.resolve("gated-pid");
        Path gated = temp.resolve("gated-git");
        Files.writeString(gated, "#!/bin/sh\necho $$ > '" + pid + "'\nwhile [ -f '" + gate
                + "' ]; do sleep 0.05; done\nexec git \"$@\"\n");
        assumeTrue(gated.toFile().setExecutable(true));
        ChildWorktreeGit gatedGit = new ChildWorktreeGit(gated.toString(), Duration.ofSeconds(60));
        warmer.provider = provider(root, Integer.MAX_VALUE, gatedGit);
        var parent = createSession("project");
        Row row = store.admit(parent.tenantId(), parent.sessionId(), "run-1", parent.workspace(), clock.get());
        try {
            CompletableFuture<Row> step = CompletableFuture.supplyAsync(() -> service.drive(row));
            String key = storageKey(parent.workspace());
            // The step holds the storage and its first Git command waits at
            // the gate.
            for (int wait = 0; wait < 500 && !Files.exists(pid); wait++) {
                sleep(10);
            }
            assertThat(jdbc.queryForList("SELECT maintenance_id FROM managed_workspace_execution_lease"
                    + " WHERE storage_key = ? AND maintenance_id IS NOT NULL", String.class, key)).hasSize(1);
            // Another worker takes the row over. Done in SQL, not by waiting
            // out the claim, which the running step keeps renewing.
            assertThat(jdbc.update("UPDATE qwen_managed_child_workspace SET claimed_by = 'thief',"
                    + " claim_generation = claim_generation + 1 WHERE child_workspace_id = ?",
                    row.childWorkspaceId())).isEqualTo(1);

            Row after = step.get(10, java.util.concurrent.TimeUnit.SECONDS);

            assertThat(after.claimedBy()).isEqualTo("thief");
            assertThat(after.state()).isEqualTo(ChildWorkspaceStore.PREPARING);
            assertThat(root.resolve(ChildWorktreeGit.CONTAINER)).doesNotExist();
            // The worker that gave up its claim still freed the storage it
            // held, though its generation is no longer the row's.
            assertThat(jdbc.queryForList("SELECT holder_key FROM managed_workspace_execution_lease"
                    + " WHERE storage_key = ?", String.class, key)).containsOnlyNulls();
            long blocked = Long.parseLong(Files.readString(pid).strip());
            for (int wait = 0; wait < 100 && ProcessHandle.of(blocked).map(ProcessHandle::isAlive).orElse(false);
                    wait++) {
                sleep(20);
            }
            assertThat(ProcessHandle.of(blocked).map(ProcessHandle::isAlive).orElse(false)).isFalse();
        } finally {
            Files.deleteIfExists(gate);
            gatedGit.close();
        }
    }

    @Test
    void theScanTheMigrationGateAndTheHoldSweepReadThroughIndexes() {
        // None of the three tables is pruned: each read must key on what it
        // filters, not scan the accumulated history.
        assertThat(indexColumns("qwen_managed_child_workspace", "idx_child_workspace_poll"))
                .containsExactly("state", "finish_request", "next_retry_at");
        assertThat(indexColumns("qwen_managed_child_workspace", "idx_child_workspace_storage"))
                .containsExactly("tenant_id", "storage_id", "state");
        assertThat(indexColumns("managed_workspace_execution_lease", "idx_execution_lease_maintenance"))
                .containsExactly("maintenance_id");
    }

    private List<String> indexColumns(String table, String index) {
        return jdbc.queryForList("SELECT LOWER(column_name) FROM information_schema.index_columns"
                + " WHERE LOWER(table_name) = ? AND LOWER(index_name) = ? ORDER BY ordinal_position",
                String.class, table, index);
    }

    @Test
    void aChildDirectoryPastTheSessionRuleIsALayoutRefusal() {
        String id = "0".repeat(32);
        String offset = "d".repeat(200) + "/" + "e".repeat(200) + "/" + "f".repeat(200) + "/" + "g".repeat(200)
                + "/" + "h".repeat(200);
        assertThat(ChildWorkspaceService.childCwd(id, ".")).isEqualTo(ChildWorktreeGit.childDirectory(id));
        assertThatThrownBy(() -> ChildWorkspaceService.childCwd(id, offset))
                .isInstanceOfSatisfying(ChildWorkspaceException.class,
                        error -> assertThat(error.code()).isEqualTo(ChildWorkspaceException.LAYOUT));
        assertThat(ChildWorkspaceService.childCwd(id, offset.substring(0, 900))).endsWith(offset.substring(0, 900));
    }

    @Test
    void anUnforeseenFaultSpendsAnAttempt() throws Exception {
        var parent = createSession("project");
        warmer.provider = new ChildWorkspaceProvider() {
            @Override
            public Path storageRoot(ContextBinding binding) {
                throw new IllegalStateException("unforeseen");
            }

            @Override
            public ChildWorktreeGit git() {
                return git;
            }
        };

        Row row = service.prepare(parent.tenantId(), parent.sessionId(), "run-1");

        assertThat(row.state()).isEqualTo(ChildWorkspaceStore.PREPARING);
        assertThat(row.attempts()).isEqualTo(1);
        assertThat(row.lastError()).isEqualTo("unforeseen");
        assertThat(row.claimedBy()).isNull();
    }

    private ChildWorkspaceService worker(String owner) {
        return new ChildWorkspaceService(sessions, store, leases, warmer, clock::get, owner, 20);
    }

    private String bindChild(StoreModels.SessionRecord parent, String run, String cwd) {
        return sessions.insertChildSessionCommand(parent.tenantId(), parent.sessionId(),
                ManagedAgentService.childCreationKey(parent.sessionId(), run), "digest-" + cwd,
                "child", List.of(), null,
                new StoreModels.SessionLineage(parent.sessionId(), parent.sessionId(), run, 1), cwd)
                .sessionId();
    }

    private void close(String sessionId) {
        jdbc.update("UPDATE managed_agent_session SET status = 'CLOSED' WHERE session_id = ?", sessionId);
    }

    private StoreModels.SessionRecord createSession(String cwd) {
        String tenant = "tenant-" + UUID.randomUUID();
        tenants.add(tenant);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1,"
                + " 'storage', 'Workspace', ?, ?, 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES (?, 'workspace', ?, 'OPERATOR')", tenant, "actor".getBytes(StandardCharsets.UTF_8));
        var created = sessions.insertWorkspaceSessionCommand(tenant, "actor", "create", "sha256:" + "a".repeat(64),
                "qwen-code", null, null, List.of(), null, new WorkspaceSelection("workspace", cwd));
        return sessions.findSessionById(created.sessionId()).orElseThrow();
    }

    private ChildWorkspaceProvider provider(Path storageRoot) {
        return provider(storageRoot, Integer.MAX_VALUE);
    }

    /** A provider whose storage root answers {@code budget} times, then the storage is busy. */
    private ChildWorkspaceProvider provider(Path storageRoot, int budget) {
        return provider(storageRoot, budget, git);
    }

    private ChildWorkspaceProvider provider(Path storageRoot, int budget, ChildWorktreeGit runner) {
        AtomicInteger calls = new AtomicInteger();
        return new ChildWorkspaceProvider() {
            @Override
            public Path storageRoot(ContextBinding binding) {
                // Another test's row must never reach this test's repository.
                if (!tenants.contains(binding.getTenantId())) {
                    throw new IllegalStateException("foreign storage " + binding.getTenantId());
                }
                if (calls.incrementAndGet() > budget) {
                    throw new RuntimeBrokerException(409, "workspace_busy",
                            "Workspace storage is held by another tool turn.", true);
                }
                return storageRoot;
            }

            @Override
            public ChildWorktreeGit git() {
                return runner;
            }
        };
    }

    private void assertPinsGone(Row row) {
        var repository = git.open(root, "project");
        assertThat(git.pinned(root, repository, row.childWorkspaceId(), "base")).isNull();
        assertThat(git.pinned(root, repository, row.childWorkspaceId(), "result")).isNull();
    }

    /** The holder of the storage's lease when a maintenance hold holds it, else null. */
    private String holder(ContextBinding storage) throws Exception {
        List<String> holders = jdbc.queryForList("SELECT holder_key FROM managed_workspace_execution_lease"
                + " WHERE storage_key = ? AND maintenance_id IS NOT NULL", String.class, storageKey(storage));
        return holders.isEmpty() ? null : holders.getFirst();
    }

    private static String maintenanceHolder(Row claimed) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(("child-workspace\u0000"
                + claimed.childWorkspaceId() + "\u0000" + claimed.claimGeneration())
                .getBytes(StandardCharsets.UTF_8)));
    }

    private static String storageKeyOf(ContextBinding binding) {
        try {
            return storageKey(binding);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private static String storageKey(ContextBinding binding) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                (binding.getTenantId() + "\u0000" + binding.getStorageId()).getBytes(StandardCharsets.UTF_8)));
    }

    private static void assertApi(Runnable call, String code) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(ApiException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }

    private static void assertBroker(Runnable call, String code) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }

    private static final class StubWarmer implements RuntimeWarmer {
        volatile ChildWorkspaceProvider provider;

        @Override
        public boolean isEnabled() {
            return false;
        }

        @Override
        public CompletionStage<Void> warm(String sessionId) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Void> drain(String sessionId) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public ChildWorkspaceProvider childWorkspaces() {
            return provider;
        }
    }
}
