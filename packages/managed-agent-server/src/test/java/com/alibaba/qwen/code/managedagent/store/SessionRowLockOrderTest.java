package com.alibaba.qwen.code.managedagent.store;

import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.BlockTree;
import com.sun.source.tree.CaseTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.CompoundAssignmentTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.ParenthesizedTree;
import com.sun.source.tree.StatementTree;
import com.sun.source.tree.SwitchExpressionTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TypeCastTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.tree.YieldTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;

import javax.lang.model.element.Modifier;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;

import java.io.IOException;
import java.lang.reflect.Method;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

// recordAdmission's inline comment fixes the lock order that keeps InnoDB
// from deadlocking concurrent Turn admissions: the session row FOR UPDATE
// first, then the turn row, in one transaction, for every writer that locks
// both rows. The order lives only in that prose, so this source-level
// canary pins it. The audit reads the JDK compiler's own parse tree and
// keeps its resolution rules small enough to state exactly:
//
// - Members are keyed by (enclosing type, name, parameter type text) and
//   nested types are harvested recursively, so an overload can neither hide
//   behind its sibling's lock nor credit a lock its own body never takes,
//   and a helper moved into a nested type stays visible.
// - A call resolves to exactly one member: through the caller's enclosing
//   type chain for a bare or this. call, through the named type for a
//   Type. call. A reference the audit cannot resolve to one member — an
//   overload set tied on name and arity, a call on a receiver whose type
//   the parse cannot see, a method reference whose arity is not spelled —
//   is never guessed: when every candidate provably reaches neither the
//   session lock nor the turn row the reference is skipped and pinned in
//   an exactly-asserted exemption set, and otherwise the audit throws.
// - SQL spellings are read from literals, their concatenations, switch
//   expressions, class constants and String locals — a local scores where
//   it is used, not where it is declared, because the declaration does
//   not run the statement. Comments never reach the tree, so they can
//   never spoof a needle. Both sides credit every branch of a conditional
//   or switch: a lock taken on only some runs still orders the runs that
//   take it, exactly like a turn access that executes under a flag. Calls
//   embedded in a spelling expression still resolve as calls, and score
//   ahead of the spelling itself, because the operands evaluate before
//   the statement's own SQL takes effect.
// - A session-row lock is counted only from a spelling that names the
//   session table — a FOR UPDATE on another table in the same body is not
//   the lock — and the implicit row lock of an INSERT or UPDATE on the
//   session table counts, which is what admits the create path: it writes
//   the session row before the turn row.
// - Calls that leave the file are outside the audit; the sibling
//   boundary below pins which files lock the session row or touch the
//   turn row at all. A lambda handed straight into a call folds there —
//   its body runs within the call — while a lambda in any other position,
//   or an anonymous-class method body, runs where it is invoked, which
//   the parse cannot see: such a body is held aside and fails closed when
//   it reaches a side instead of folding at its declaration. A nested
//   held body propagates to the enclosing member's held set, and a
//   literal an embedded expression cannot resolve still joins the
//   statement's spelling.
//   Transactionality is runtime wiring — a Spring proxy, or a
//   TransactionTemplate in another file's caller — not a spelling a
//   same-file parse can see, so the audit pins the order, not the
//   annotation.
class SessionRowLockOrderTest {
    private static final Path STORE_PACKAGE = Path.of("src", "main", "java",
            "com", "alibaba", "qwen", "code", "managedagent", "store");
    private static final String MANAGED_AGENT_STORE = "ManagedAgentStore.java";
    private static final String SESSION_TABLE = "ma_session";
    private static final String TURN_TABLE = "ma_turn";
    private static final String LOCK_MODE = "FOR UPDATE";
    // ma_session is a prefix of ma_session_head, ma_session_record and
    // ma_session_journal_tx, none of which is the session row, so its
    // needle refuses a trailing underscore. Nothing else bounds it: a
    // spelling flattens its branches without a separator.
    private static final Pattern SESSION_WRITE = Pattern.compile(
            "(?:insert into|update) " + SESSION_TABLE + "(?!_)");
    private static final Pattern SESSION_NAMED = Pattern.compile(
            SESSION_TABLE + "(?!_)");

    // Sibling stores whose session-row lock the audit can see today,
    // conditional locks included: a lock taken on only some runs still
    // orders the runs that take it. None writes the turn row, so the
    // session-first order has nothing to bite on there; the ones that
    // also read it are order-audited below. A new sibling locker — or a
    // new sibling turn-row access — fails here instead of passing
    // unaudited.
    private static final Set<String> SIBLING_SESSION_LOCKERS = Set.of(
            "ManagedActionStore.java", "ManagedExtensionRecordStore.java",
            "ManagedLegacySessionGuard.java",
            "ManagedProjectionResourceCollector.java",
            "ManagedRuntimeRetentionGuard.java",
            "ManagedSessionRetirementStore.java", "ManagedSessionStore.java",
            "ManagedSnapshotStore.java", "ManagedToolResultStore.java",
            "ResidentWorkspaces.java",
            "ToolPublicationRetentionStore.java",
            "WorkspaceLifecycleStore.java", "WorkspaceRecoveryStore.java");
    private static final Set<String> SIBLING_TURN_READERS = Set.of(
            "AutomationLedgerStore.java", "ChildResultRelayStore.java",
            "ManagedActionStore.java", "ManagedToolResultProjector.java",
            "WorkspaceExecutionStore.java", "WorkspaceMigrationStore.java",
            "WorkspaceRecoveryStore.java");

    // The package's unresolvable-but-benign references, pinned exactly per
    // file: calls on receivers whose type the parse cannot see (a
    // JsonNode's path, a lambda's row, a field of a nested type) whose
    // name and arity collide with same-file members, and overload sets
    // tied on name and arity. Every candidate of every pinned reference
    // provably reaches neither the session lock nor the turn row — a
    // candidate that starts reaching a side throws instead of exempting,
    // save a lock-only candidate in a file with no turn access at all,
    // ToolPublicationRetentionStore.open/4 since the 32-table baseline —
    // and the pin is asserted exactly, so a new unresolvable reference or
    // a stale entry fails the sibling boundary test. The staged-placement
    // lockStagedPlacement/2 delegator names only itself and is delegation
    // only. Main's private CSI work (#13996) adds the same shapes:
    // data-source probes, the publication-placement lock delegator and the
    // runtime-access record's accessors, none of which reaches either side.
    // SSH storage adds same-name verify/1 and storageKey/2 references;
    // their SQL touches only storage ownership and migration history.
    // Its physicalKey/1 delegates to the pure local identity hash.
    // The child Workspace row's snapshot/0 (#13753 I3) is a record accessor
    // over its mode: it reaches no JDBC call and takes no lock.
    private static final Map<String, Set<String>> AMBIGUITY_EXEMPTIONS =
            Map.ofEntries(
                    Map.entry("ChildResultRelayStore.java",
                            Set.of("ChildResultRelayStore.readTree/1")),
                    Map.entry("ChildWorkspaceStore.java",
                            Set.of("ChildWorkspaceStore.find/3",
                                    "ChildWorkspaceStore.row/2",
                                    "Row.snapshot/0")),
                    Map.entry("JdbcChannelRouteRepository.java",
                            Set.of("JdbcChannelRouteRepository.row/2")),
                    Map.entry("ManagedAgentDefinitionStore.java",
                            Set.of("ManagedAgentDefinitionStore.notFound/0",
                                    "ManagedAgentDefinitionStore.row/2",
                                    "ManagedAgentDefinitionStore.update/7")),
                    Map.entry("ManagedArtifactReader.java",
                            Set.of("ManagedArtifactReader.open/1",
                                    "ManagedArtifactReader.readRange/3",
                                    "ManagedArtifactReader.readRange/5")),
                    Map.entry("ManagedExtensionRecordStore.java",
                            Set.of("ManagedExtensionRecordStore.sha256/1",
                                    "ManagedExtensionRecordStore.storedRow/2")),
                    Map.entry("ManagedExtensionRecords.java",
                            Set.of("ManagedExtensionRecords.require/2")),
                    Map.entry("ManagedSchemaJdbcTemplate.java",
                            Set.of("ManagedSchemaJdbcTemplate.getSingleColumnRowMapper/1")),
                    Map.entry("ManagedSessionStore.java",
                            Set.of("ManagedSessionStore.storedTransaction/1",
                                    "ManagedSessionStore.usesDataSource/1")),
                    Map.entry("ManagedSnapshotStore.java",
                            Set.of("ItemReader.read/3",
                                    "ManagedSnapshotStore.decode/1",
                                    "SnapshotReadLease.check/0",
                                    "SnapshotReadLease.close/0")),
                    Map.entry("ManagedTaskEventStore.java",
                            Set.of("ManagedTaskEventStore.eventRow/2")),
                    Map.entry("ManagedToolResultProjector.java",
                            Set.of("ManagedToolResultProjector.require/2")),
                    Map.entry("ManagedToolResultStore.java",
                            Set.of("ManagedToolResultStore.artifact/2",
                                    "Source.sessionKey/0")),
                    Map.entry("ManagedWorkspaceRegistry.java",
                            Set.of("ManagedWorkspaceRegistry.findReadable/3")),
                    Map.entry("SessionMessageRelayStore.java",
                            Set.of("SessionMessageRelayStore.pending/2")),
                    Map.entry("SessionResourceCollectionCollector.java",
                            Set.of("SessionResourceCollectionCollector.runOnce/0")),
                    // D7-2's parked registration asks its record whether it
                    // reserved, through a record accessor the parse cannot
                    // resolve.
                    Map.entry("SshWorkspaceStore.java",
                            Set.of("Parked.reserved/0",
                                    "SshWorkspaceStore.physicalKey/1")),
                    Map.entry("ToolPublicationAdmissionStore.java",
                            Set.of("AcknowledgementBundle.captureIdentity/0",
                                    "AcknowledgementBundle.finished/0",
                                    "AcknowledgementBundle.outcomeRef/0",
                                    "ToolPublicationAdmissionStore.usesDataSource/1")),
                    Map.entry("ToolPublicationContract.java",
                            Set.of("ToolPublicationContract.id/1")),
                    Map.entry("ToolPublicationDataStore.java",
                            Set.of("ToolPublicationDataStore.hash/1",
                                    "ToolPublicationDataStore.lockOriginalSettledResult/3",
                                    "ToolPublicationDataStore.lockPublicationPlacement/2",
                                    "ToolPublicationDataStore.lockStagedPlacement/2",
                                    "ToolPublicationDataStore.requireStagedCall/2",
                                    "ToolPublicationDataStore.usesDataSource/1",
                                    "VerificationBudget.timeout/2",
                                    "VerifiedAcknowledgement.catalog/0",
                                    "VerifiedAcknowledgement.finished/0",
                                    "VerifiedStream.readRange/3",
                                    "VerifiedStream.size/0")),
                    Map.entry("ToolPublicationRetentionStore.java",
                            Set.of("ReadLease.check/0",
                                    "ReadLease.close/0",
                                    "ToolPublicationRetentionStore.open/4")),
                    Map.entry("ToolPublicationStore.java",
                            Set.of("HeadActivation.current/5",
                                    "Original.csi/0",
                                    "Row.withState/2",
                                    "ToolPublicationStore.usesDataSource/1")),
                    Map.entry("WorkspaceCreationStore.java",
                            Set.of("WorkspaceCreationStore.enabled/0")),
                    Map.entry("WorkspaceExecutionStore.java",
                            Set.of("WorkspaceExecutionStore.createdStorageRoot/2",
                                    "WorkspaceExecutionStore.storageKey/2")),
                    Map.entry("WorkspaceCsiCheckpointSnapshotStore.java",
                            Set.of("WorkspaceCsiCheckpointSnapshotStore.hash/1",
                                    "WorkspaceCsiCheckpointSnapshotStore.scope/1")),
                    // Text dispatch and environment delegation share local
                    // method names without adding session/turn SQL.
                    Map.entry("WorkspaceCsiHostedMain.java",
                            Set.of("WorkspaceCsiHostedMain.required/1")),
                    Map.entry("WorkspaceCsiRuntimeAccess.java",
                            Set.of("WorkspaceCsiRuntimeAccess.attest/3",
                                    "WorkspaceCsiRuntimeAccess.request/0",
                                    "WorkspaceCsiRuntimeAccess.unavailable/0")),
                    Map.entry("WorkspaceCsiRuntimeMain.java",
                            Set.of("WorkspaceCsiRuntimeMain.run/1")),
                    Map.entry("WorkspaceCsiWorkerAckStore.java",
                            Set.of("WorkspaceCsiWorkerAckStore.decode/1",
                                    "WorkspaceCsiWorkerAckStore.hash/1")),
                    Map.entry("WorkspaceMigrationStore.java",
                            Set.of("WorkspaceMigrationStore.inspect/0",
                                    "WorkspaceMigrationStore.path/1")),
                    Map.entry("WorkspaceOperations.java",
                            Set.of("WorkspaceOperations.key/3")),
                    Map.entry("WorkspaceOperatorRecoveryStore.java",
                            Set.of("WorkspaceOperatorRecoveryStore.blocked/0",
                                    "WorkspaceOperatorRecoveryStore.digest/1",
                                    "WorkspaceOperatorRecoveryStore.operation/1")),
                    Map.entry("WorkspaceProfileLifecycleVerifier.java",
                            Set.of("WorkspaceProfileLifecycleVerifier.digest/0",
                                    "WorkspaceProfileLifecycleVerifier.source/1")),
                    Map.entry("WorkspaceRecoveryStore.java",
                            Set.of("WorkspaceRecoveryStore.digest/0",
                                    "WorkspaceRecoveryStore.hash/1",
                                    "WorkspaceRecoveryStore.parse/1")),
                    Map.entry("WorkspaceStorageGuard.java",
                            Set.of("IdentityReader.read/1",
                                    "WorkspaceStorageGuard.verify/1")));

    // Held bodies whose invocation the parse cannot see but whose
    // transaction it can: ManagedSnapshotStore.afterCommit registers a
    // post-commit synchronization, and the build it runs opens its own
    // REQUIRES_NEW transaction, so that body's session lock can never
    // order against a row its registering caller touched. A deferred body
    // is dropped rather than folded at its declaration, and the set is
    // asserted exactly per file, so a new held body reaching a side still
    // fails closed.
    private static final Set<String> DEFERRED_BODIES = Set.of(
            "ManagedSnapshotStore.afterCommit/2");

    private record Key(String owner, String name, List<String> paramTypes) {
        int arity() {
            return paramTypes.size();
        }

        String ownerSimpleName() {
            return owner.substring(owner.lastIndexOf('.') + 1);
        }

        // The pin-able identity of an ambiguous reference: owner, name and
        // arity — the parameter types are exactly what the candidates
        // cannot be told apart by.
        String handle() {
            return ownerSimpleName() + "." + name + "/" + arity();
        }
    }

    // One ordered step in a member body: a SQL spelling (callee == null,
    // lock/turn flag what the text bears) or a call to a same-file member
    // (callee set, flags unused).
    private record Event(boolean lock, boolean turn, Key callee) { }

    // A call or method reference the audit could not resolve to one member.
    private record Ambiguous(Key caller, String handle,
            List<Key> candidates) { }

    private record Audit(List<String> members, Set<String> lockers,
            List<String> violations, Set<String> lockersWithoutTurnAccess,
            Set<String> turnRowAccessors, Set<String> exemptions,
            Set<String> deferredBodies, boolean locksSessionRow,
            boolean touchesTurnRow) { }

    @Test
    void mutationEntriesAcquireTheSessionRowLockBeforeAnyTurnRowAccess()
            throws IOException {
        Audit audit = audit(Files.readString(STORE_PACKAGE.resolve(
                MANAGED_AGENT_STORE)));
        assertThat(audit.violations()).isEmpty();
        // The derivation is only evidence if it accounts for every writer
        // that takes the session-row lock, so the set is asserted exactly:
        // a locker this list does not name fails here instead of passing
        // unaudited. It includes the writers the deadlock was reported on,
        // recordAdmission's raw-SQL turn-row access, the raw FOR UPDATE
        // lockers no helper name would find, and the create entries, whose
        // session-row INSERT is the lock.
        assertThat(audit.lockers()).containsExactlyInAnyOrder(
                "insertTurnCommand", "insertCancelCommand", "changeSessionModel", "changeSessionApproval",
                "insertSessionCommand", "insertWorkspaceSessionCommand",
                "insertChildSessionCommand",
                "insertInternalTeamLeadSessionCommand",
                "beginSessionMutation",
                "beginTaskCancelOperation", "completeSessionMutation",
                "beginOperation",
                "beginWorkspaceClose", "beginWorkspaceLifecycle",
                "unarchiveWorkspaceSession", "beginCwdChangeOperation",
                "completeCwdChangeOperation", "completeOperation",
                "advanceReplayFloor", "materializeNextBatch", "bindHarness",
                "bindRecoveredHarness", "recordAdmission",
                "recordRecoveryAdmission", "retractContinuationOutput",
                "retractHarnessTurnOutput", "recordHarnessEvents",
                "cancelUnadmittedTurn", "cancelBeforeAdmission", "failTurn",
                "failRecoveryBlockedTurn",
                "appendPublicEventIfAbsent", "appendLiveSessionEventIfAbsent",
                // Main's rename-delivery family (#13682): each takes the
                // session-row FOR UPDATE before its delivery-row work.
                "beginSessionRename", "completeSessionRename",
                "abandonSessionRename", "claimRename",
                // D7-2's parked-title settle locks the session row before
                // its delivery row, as the late reply it races does.
                "settleParkedRename",
                // Main's internal child close (#14069) locks the child's
                // session row before its operation-row work.
                "beginChildClose",
                // Main's private CSI Session entries (#13996) lock the
                // session row through the legacy-guarded helper or their
                // own creation INSERT.
                "insertCsiSessionCommand", "replayChildSessionCommand",
                "requireCsiRequest");
        // The comparison population is pinned as exactly as the locker set:
        // a locker that loses its turn-row access must shrink this set
        // loudly instead of silently dropping out of the ordering
        // comparison.
        assertThat(audit.lockersWithoutTurnAccess())
                .containsExactlyInAnyOrder(
                        "appendLiveSessionEventIfAbsent",
                        "appendPublicEventIfAbsent", "beginSessionMutation",
                        "beginTaskCancelOperation", "completeOperation",
                        "completeSessionMutation", "unarchiveWorkspaceSession",
                        "beginSessionRename", "completeSessionRename",
                        "abandonSessionRename", "claimRename",
                        "settleParkedRename",
                        "replayChildSessionCommand", "requireCsiRequest");
        // The turn-row population, pinned exactly like the locker set: a
        // member that reaches the turn row without taking the session lock
        // never enters `lockers`, so this assertion — not the violation
        // check — is what fails loudly when one appears.
        assertThat(audit.turnRowAccessors())
                .containsExactlyInAnyOrder("advanceReplayFloor",
                        "beginChildClose", "beginCwdChangeOperation",
                        "beginLifecycle", "beginOperation",
                        "beginWorkspaceClose", "beginWorkspaceLifecycle",
                        "bindHarness", "bindRecoveredHarness",
                        "cancelBeforeAdmission", "changeSessionModel", "changeSessionApproval", "claimTurn",
                        "completeCwdChangeOperation", "completeHarnessTurn",
                        "deferTurnRetry", "failTurn", "failRecoveryBlockedTurn",
                        "settleFailedTurn", "findActiveTurns",
                        "findDispatchable", "findLatestTurns",
                        "findReplayFloorTargets", "findTurn", "findTurnModelSelection", "findTurnApprovalSelection",
                        "findTurnSummary", "hasActiveTurn",
                        // #14387's lifecycle gate counts live Turns under
                        // its caller's session-row lock. Its recovery-blocked
                        // verdict can take the session-row lock through the
                        // cross-file legacy guard before the Turn update, a
                        // lock this same-file parse cannot see; both pin here
                        // as Turn-row accessors, not lockers.
                        "hasLiveTurn",
                        "insertCancelCommand", "insertChildSession",
                        "insertChildSessionCommand", "insertCsiSessionCommand",
                        "insertInternalTeamLeadSessionCommand",
                        "insertSession", "insertSessionCommand", "insertTurn",
                        "insertTurnCommand", "insertWorkspaceSessionCommand",
                        "listTurns", "markSubmissionAttempted",
                        "markTurnRecoveryBlocked",
                        "materializeEvent", "materializeInput",
                        "materializeNextBatch", "recordAdmission",
                        "recordHarnessEvents", "recordRecoveryAdmission",
                        "releaseTurnLease", "renewTurn", "requireTurn",
                        "requireTurnForUpdate", "requireIdlePolicyChange", "retractContinuationOutput",
                        "retractHarnessTurnOutput", "scheduleTurnRetry",
                        "settleTurnCommands",
                        // D7-2's journal evidence for a parked input reads
                        // its Turn and takes no lock.
                        "turnInputAcceptance",
                        "updateHarnessCursor", "validateOperationStart",
                        "withdrawSubmissionAttempted", "cancelUnadmittedTurn");
        // The references the parse cannot resolve to one member —
        // ItemRow.toRecord behind the lambda parameter at the item read,
        // and main's this::renameDelivery RowMapper references (#13682),
        // whose arity a method reference never spells — are pinned exactly:
        // a new unresolvable reference fails here, and an entry goes stale
        // the day the call is typed or moved.
        assertThat(audit.exemptions())
                .containsExactly("ItemRow.toRecord/0",
                        "ManagedAgentStore.renameDelivery/2");
        // The harvest is asserted against the bytecode's own enumeration,
        // recursively over nested types and as a multiset: a member the
        // parse dropped — including one of two overloads sharing a
        // name/arity key — would let a writer pass unaudited.
        assertThat(audit.members())
                .as("the parse must see every compiled member")
                .isEqualTo(compiledMembers(ManagedAgentStore.class,
                        audit.members()));
    }

    // The pinned order is load-bearing only inside one transaction: the
    // audit reads spellings, not runtime wiring, so a dropped
    // @Transactional would reopen the deadlock window with every spelling
    // assertion still green. Pin the boundary on the R2 entry points.
    @Test
    void theOrderPinnedEntriesKeepTheirTransactionalBoundary() {
        for (String name : List.of("recordAdmission", "failTurn", "failRecoveryBlockedTurn",
                "cancelUnadmittedTurn", "cancelBeforeAdmission")) {
            List<Method> entries = Arrays.stream(ManagedAgentStore.class
                    .getDeclaredMethods())
                    .filter(method -> method.getName().equals(name))
                    .toList();
            assertThat(entries).as("%s exists", name).isNotEmpty();
            assertThat(entries).as("%s keeps @Transactional", name)
                    .allMatch(entry -> entry.isAnnotationPresent(
                            Transactional.class));
        }
    }

    // The session-first order is audited on every store whose writers lock
    // the session row and touch the turn row — the audited population is
    // derived from the computed locker/reader sets, never named, so a
    // sibling that starts doing both lands in it without an edit here. The
    // boundary itself is pinned exactly, so the audit's universe cannot
    // drift either: a sibling that starts locking the session row or
    // reading the turn row fails the set assertions.
    @Test
    void siblingStoresKeepTheSessionTurnBoundaryPinned() throws IOException {
        Set<String> sessionLockers = new TreeSet<>();
        Set<String> turnReaders = new TreeSet<>();
        List<Path> sources;
        try (var paths = Files.list(STORE_PACKAGE)) {
            sources = paths.filter(path -> path.getFileName().toString()
                    .endsWith(".java")).sorted().toList();
        }
        Map<String, Audit> audits = new LinkedHashMap<>();
        for (Path source : sources) {
            String name = source.getFileName().toString();
            if (MANAGED_AGENT_STORE.equals(name)) {
                continue;
            }
            Audit audit = audit(Files.readString(source));
            audits.put(name, audit);
            if (audit.locksSessionRow()) {
                sessionLockers.add(name);
            }
            if (audit.touchesTurnRow()) {
                turnReaders.add(name);
            }
        }
        assertThat(sessionLockers).isEqualTo(SIBLING_SESSION_LOCKERS);
        assertThat(turnReaders).isEqualTo(SIBLING_TURN_READERS);
        // A tripwire over the derivation, not its source: the audited set
        // is whatever the locker/reader intersection computed.
        Set<String> orderAudited = new TreeSet<>(sessionLockers);
        orderAudited.retainAll(turnReaders);
        assertThat(orderAudited).containsExactly("ManagedActionStore.java",
                "WorkspaceRecoveryStore.java");
        // ManagedActionStore.admit takes the tenant lock before the
        // session row and never touches the turn row — the file's single
        // turn read lives in a locker-less query method — and
        // WorkspaceRecoveryStore's conditional source lock precedes its
        // turn count, so both stay violation-free under the same order
        // audit the main file gets.
        for (String name : orderAudited) {
            assertThat(audits.get(name).violations())
                    .as("%s keeps the session-first order", name).isEmpty();
        }
        Map<String, Set<String>> exemptions = new TreeMap<>();
        for (Map.Entry<String, Audit> entry : audits.entrySet()) {
            if (!entry.getValue().exemptions().isEmpty()) {
                exemptions.put(entry.getKey(), entry.getValue().exemptions());
            }
        }
        assertThat(exemptions).isEqualTo(AMBIGUITY_EXEMPTIONS);
        Map<String, Set<String>> deferred = new TreeMap<>();
        for (Map.Entry<String, Audit> entry : audits.entrySet()) {
            if (!entry.getValue().deferredBodies().isEmpty()) {
                deferred.put(entry.getKey(),
                        entry.getValue().deferredBodies());
            }
        }
        assertThat(deferred).isEqualTo(Map.of("ManagedSnapshotStore.java",
                DEFERRED_BODIES));
    }

    // The derivation must report a writer that reaches the turn row through
    // a private helper before taking the session-row lock — the shape that
    // passed unaudited when selection and access were by helper name.
    @Test
    void theAuditReportsATurnRowAccessBeforeTheSessionLock() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void badWriter(String tenantId, String sessionId) {
                        deferTurnRetry(tenantId, sessionId);
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void deferTurnRetry(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "badWriter");
    }

    // SQL keywords are case-insensitive: a lowercase `for update` takes the
    // same session-row lock, so the writer that reaches the turn row first
    // violates and enters the locker set — the spelling the audit once
    // passed unaudited.
    @Test
    void theAuditReadsALowercaseForUpdateAsTheSessionLock() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void newWriter(String tenantId, String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'RUNNING'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session for update");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).containsExactly("newWriter");
        assertThat(audit.lockers()).containsExactly("newWriter");
    }

    // A member that reaches the turn row without taking the session lock
    // never enters the locker set — violations and lockers are identical to
    // the baseline without it — so the turn-row population is what reports
    // it: the synthetic writer lands there, and on the real store the exact
    // pin fails loudly.
    @Test
    void theAuditPlacesATurnOnlyWriterInTheTurnRowPopulation() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void existingWriter(String tenantId,
                            String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'RUNNING'");
                    }

                    @Transactional
                    public void turnOnlyWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).isEmpty();
        assertThat(audit.lockers()).containsExactly("existingWriter");
        assertThat(audit.turnRowAccessors()).containsExactlyInAnyOrder(
                "existingWriter", "turnOnlyWriter");
    }

    // A comment that names the lock helper is prose, not a lock: comments
    // never reach the parse tree, so the real lock call comes after the
    // turn-row write and the writer violates.
    @Test
    void aCommentMentioningTheLockHelperIsNotALock() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void proseWriter(String tenantId,
                            String sessionId) {
                        // ordering mirrors requireSessionForUpdate
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "proseWriter");
    }

    // A lock taken one helper hop deep is still a lock: the writer lands in
    // the exact locker set, and the helper call's position is what the
    // ordering is checked against.
    @Test
    void theAuditCountsALockTakenThroughAPrivateHelper() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void helperLockWriter(String tenantId,
                            String sessionId) {
                        lockSession(tenantId, sessionId);
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'RUNNING'");
                    }

                    private void lockSession(String tenantId,
                            String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).isEmpty();
        assertThat(audit.lockers()).containsExactly("helperLockWriter");
    }

    // A comment line above a declaration cannot hide the member: the audit
    // reads the parse tree, where no comment survives.
    @Test
    void aCommentLineAboveADeclarationDoesNotHideIt() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    // ordering note
                    public void badWriter(String tenantId, String sessionId) {
                        deferTurnRetry(tenantId, sessionId);
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void deferTurnRetry(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "badWriter");
    }

    // The lock's position is its FOR UPDATE, not the table's first mention:
    // a writer that reads the session row, writes the turn row and only then
    // locks mentions the session table long before it locks, and scoring the
    // lock at that mention would pass the inversion this canary exists to
    // catch.
    @Test
    void theAuditScoresTheLockAtTheForUpdateStatement() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void lateLockWriter(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session WHERE session_id"
                                + " = ?");
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "lateLockWriter");
    }

    // A FOR UPDATE on another table is not the session lock: the lock side
    // must not score it, or the real session lock below the turn-row write
    // would pass with the inversion this canary exists to catch.
    @Test
    void theAuditScoresOnlyTheSessionRowsForUpdate() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void mixedLockWriter(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT operation_id FROM"
                                + " ma_operation WHERE"
                                + " operation_id = ? FOR UPDATE");
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "mixedLockWriter");
    }

    // The turn side resolves transitively: a writer that reaches the turn
    // row through a two-hop chain before taking the lock is the inversion
    // this canary exists to catch, and one-hop resolution audited it as no
    // access — the ordering was never compared.
    @Test
    void theAuditFollowsTheTurnRowThroughTransitiveCalls() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void deepWriter(String tenantId,
                            String sessionId) {
                        writeTurnRow(tenantId, sessionId);
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void writeTurnRow(String tenantId,
                            String sessionId) {
                        markTurn(tenantId, sessionId);
                    }

                    private void markTurn(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "deepWriter");
    }

    // The lock side resolves transitively too: a writer whose session-row
    // lock sits two helper hops down is still a locker, and its ordering is
    // compared — a one-hop lock side never selected it at all.
    @Test
    void theAuditFollowsTheLockThroughTransitiveCalls() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void deepLockWriter(String tenantId,
                            String sessionId) {
                        writeTurnRow(tenantId, sessionId);
                        lockSession(tenantId, sessionId);
                    }

                    private void writeTurnRow(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void lockSession(String tenantId,
                            String sessionId) {
                        guardSession(tenantId, sessionId);
                    }

                    private void guardSession(String tenantId,
                            String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).containsExactly("deepLockWriter");
        assertThat(audit.lockers()).containsExactly("deepLockWriter");
    }

    // A lock delegated to a nested type in the same file is the harvest's
    // business too: the writer calls the nested helper by its type name,
    // the edge resolves, and the inversion is reported — the shape a
    // nested-type harvest miss used to hide entirely.
    @Test
    void theAuditFollowsTheLockIntoANestedType() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void inlineWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    @Transactional
                    public void nestedLockWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        Nested.lockSession(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }

                    static class Nested {
                        static void lockSession(String tenantId,
                                String sessionId) {
                            jdbc.queryForMap("SELECT session_id FROM"
                                    + " ma_session FOR UPDATE");
                        }
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).containsExactlyInAnyOrder(
                "inlineWriter", "nestedLockWriter");
        assertThat(audit.lockers()).containsExactlyInAnyOrder(
                "inlineWriter", "nestedLockWriter", "lockSession");
    }

    // A nested type reached through an instance is the same member: the
    // receiver's type is not spelled at the call, so the audit refuses to
    // guess — the helper reaches the session lock, and the unresolvable
    // call throws instead of passing unaudited.
    @Test
    void theAuditThrowsOnANestedLockBehindAnUntypedReceiver() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void fieldLockWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        nested.lockSession(tenantId, sessionId);
                    }

                    static class Nested {
                        void lockSession(String tenantId,
                                String sessionId) {
                            jdbc.queryForMap("SELECT session_id FROM"
                                    + " ma_session FOR UPDATE");
                        }
                    }
                }
                """;
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("lockSession")
                .hasMessageContaining("fieldLockWriter");
    }

    // Two overloads tied on name and arity collapse under a (name, arity)
    // key, so a call to either is never attributed: when one candidate
    // reaches the session lock the audit throws, because attributing the
    // call to a chosen member would hide or invent an order.
    @Test
    void theAuditThrowsOnAnAmbiguousCallReachingALock() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void writer(String tenantId, String sessionId) {
                        helper(tenantId);
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void helper(String tenantId) {
                        requireSessionForUpdate(tenantId, tenantId);
                    }

                    private void helper(Integer sequence) {
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("helper/1")
                .hasMessageContaining("writer");
    }

    // The same ambiguity is exempt — and pinned — when every candidate
    // provably reaches neither side: the call is skipped because any
    // resolution answers the same audit. The pin is asserted exactly, so a
    // candidate that starts reaching a side turns the exemption into a
    // throw instead of silently absorbing it.
    @Test
    void theAuditExemptsABenignAmbiguousCall() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void writer(String tenantId, String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                        format(tenantId);
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'RUNNING'");
                    }

                    private void format(String tenantId) {
                    }

                    private void format(Integer sequence) {
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).isEmpty();
        assertThat(audit.lockers()).containsExactly("writer");
        assertThat(audit.exemptions())
                .containsExactly("SyntheticStore.format/1");
    }

    // A method reference is a call whose arity is not spelled: it is never
    // resolved silently. A reference to a member that reaches the turn row
    // throws, because crediting it at the reference site would order the
    // invocation where it is mentioned, not where it runs.
    @Test
    void theAuditThrowsOnAMethodReferenceReachingTheTurnRow() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void writer(String tenantId, String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                        Runnable later = this::writeTurnRow;
                    }

                    private void writeTurnRow() {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("writeTurnRow")
                .hasMessageContaining("writer");
    }

    // A lock that rides only one branch of a conditional still orders the
    // runs that take it — the either-branch rule the turn side always had:
    // WorkspaceRecoveryStore's `lockSources ? " FOR UPDATE" : ""` shape is
    // a locker, and stays violation-free only because its conditional lock
    // precedes the turn write.
    @Test
    void theAuditCreditsAConditionalLockOnEitherBranch() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void conditionalLockWriter(String tenantId,
                            String sessionId, boolean locking) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session WHERE session_id"
                                + " = ?" + (locking ? " FOR UPDATE" : ""));
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.lockers()).containsExactly("conditionalLockWriter");
        assertThat(audit.violations()).isEmpty();
        assertThat(audit.touchesTurnRow()).isTrue();
    }

    // The turn side scores either branch: a turn access that executes only
    // under a flag still inverts the order on the runs that take that
    // branch, so a writer whose conditional turn read precedes the
    // unconditional lock violates.
    @Test
    void theAuditCreditsATurnAccessOnEitherBranch() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void conditionalTurnWriter(String tenantId,
                            String sessionId, boolean counting) {
                        jdbc.queryForMap(counting
                                ? "SELECT COUNT(*) FROM ma_turn"
                                : "SELECT COUNT(*) FROM ma_public_event");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "conditionalTurnWriter");
    }

    // A call embedded in a SQL concatenation is still a call: the spelling
    // is scored from the flattened text and the invocation is followed, so
    // a helper hop inside the string cannot hide the helper's own turn-row
    // access — the writer's statement names neither table, and only the
    // followed edge puts the turn write ahead of the lock.
    @Test
    void theAuditFollowsACallEmbeddedInASqlConcatenation() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void embeddingWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_public_event SET note = '"
                                + auditTrail() + "'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private String auditTrail() {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        return "m";
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "embeddingWriter");
    }

    // A table name handed to a helper inside the SQL's own concatenation
    // is still the statement's text: the partial flatten cannot resolve
    // the call, but the literal it carries joins the spelling, so the
    // turn-row read ahead of the lock violates exactly like the inline
    // spelling.
    @Test
    void theAuditReadsALiteralInsideAnUnresolvableCallOperand() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void concatReader(String tenantId,
                            String sessionId) {
                        jdbc.query("SELECT * FROM "
                                + jdbcSupport.tableName("ma_turn"));
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).containsExactly("concatReader");
        assertThat(audit.turnRowAccessors())
                .containsExactlyInAnyOrder("concatReader");
    }

    // A call embedded in the SQL's own concatenation evaluates before the
    // statement runs: scoring the spelling first would pass a writer whose
    // embedded helper writes the turn row ahead of the lock the outer
    // statement takes — the evaluation-order inversion a spelling-first
    // audit certified as clean.
    @Test
    void theAuditScoresAnEmbeddedCallBeforeTheStatementsSpelling() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void embeddingLockWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_session SET note"
                                + " = '" + turnDigest() + "'");
                    }

                    private String turnDigest() {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        return "m";
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "embeddingLockWriter");
    }

    // A switch expression in text position contributes every branch to the
    // spelling: a turn write spelled only inside a switch branch is still
    // a turn write, so the writer whose lock follows it violates.
    @Test
    void theAuditReadsSqlFromASwitchExpression() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void switchWriter(String tenantId,
                            String sessionId, int kind) {
                        jdbc.update("UPDATE ma_" + switch (kind) {
                            case 1 -> "turn SET status = 'FAILED'";
                            default -> "event SET note = 'm'";
                        } + " WHERE session_id = ?");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "switchWriter");
    }

    // A lambda assigned to a variable runs where it is invoked, which the
    // parse cannot see: a body reaching a side fails closed instead of
    // folding its lock at the declaration, where it would order the
    // inversion this canary exists to catch as clean.
    @Test
    void theAuditFailsClosedOnAnAssignedLambdaReachingASide() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void lambdaWriter(String tenantId,
                            String sessionId) {
                        Runnable lock = () -> lockSession(tenantId,
                                sessionId);
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        lock.run();
                    }

                    private void lockSession(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("lambdaWriter");
    }

    // A held lambda's own held lambdas run no closer to the declaration:
    // the grandchild's events must propagate to the enclosing member's
    // held set, or a turn-row write one nesting level down is dropped and
    // the inversion is certified clean.
    @Test
    void theAuditFailsClosedOnANestedHeldLambdaReachingASide() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void nestedLambdaWriter(String tenantId,
                            String sessionId) {
                        Runnable outer = () -> {
                            Runnable inner = () -> jdbc.update("UPDATE"
                                    + " ma_turn SET status"
                                    + " = 'FAILED'");
                            inner.run();
                        };
                        outer.run();
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("nestedLambdaWriter");
    }

    // An anonymous-class body's methods run where they are invoked, which
    // the parse cannot see — exactly like a held lambda: folding the body
    // at the declaration would order a lock the body takes before a
    // turn-row write that runs first, so the body is held aside and fails
    // closed when it reaches a side.
    @Test
    void theAuditFailsClosedOnAnAnonymousClassBodyReachingASide() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void anonLocker(String tenantId,
                            String sessionId) {
                        Runnable lock = new Runnable() {
                            public void run() {
                                lockSession(tenantId, sessionId);
                            }
                        };
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        lock.run();
                    }

                    private void lockSession(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("anonLocker");
    }

    // A mutually-recursive delegate pair cannot be ranked without
    // deciding which member runs first, so the descent re-entry is
    // undecidable and fails closed exactly like the audit's other
    // undecidable shapes; deleting the recursion is the only way the two
    // violations (each writes the turn row before its session lock)
    // surface at all.
    @Test
    void theAuditFailsClosedOnAMutuallyRecursiveDelegate() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void writerA(String tenantId, String sessionId) {
                        writerB(tenantId, sessionId);
                    }

                    @Transactional
                    public void writerB(String tenantId, String sessionId) {
                        writerA(tenantId, sessionId);
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("recursive");
    }

    // The String-local overlay must follow reassignment, not only the
    // declaration: below, the declaration spells the session lock, the
    // reassignment spells the turn row, and the later use runs the turn
    // row spelling. Scoring the declaration's stale text at the use —
    // and at the assignment itself, as [stale, new] — would read the
    // inversion as lock-before-turn and let the writer off.
    @Test
    void theAuditTracksAStringLocalThroughReassignment() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void reassignedLocalWriter(String tenantId,
                            String sessionId) {
                        String sql = "SELECT session_id FROM"
                                + " ma_session FOR UPDATE";
                        sql = "UPDATE ma_turn SET status"
                                + " = 'FAILED'";
                        jdbc.update(sql);
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "reassignedLocalWriter");
    }

    // A local class declared inside a member body runs its methods where
    // they are invoked — after the turn-row write below — so its body
    // reaching the session lock fails closed exactly like an
    // anonymous-class body or a held lambda; folding it inline at the
    // declaration would put the lock before the write and certify the
    // inversion.
    @Test
    void theAuditFailsClosedOnALocalClassHoldingTheSessionLock() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void localClassWriter(String tenantId,
                            String sessionId) {
                        class HeldLocker {
                            void run() {
                                jdbc.queryForMap("SELECT session_id FROM"
                                        + " ma_session"
                                        + " FOR UPDATE");
                            }
                        }
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        new HeldLocker().run();
                    }
                }
                """;
        assertThatThrownBy(() -> audit(synthetic))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("localClassWriter");
    }

    // A merged conditional spelling that carries both needles — the
    // false-branch turn-row write and the other branch's session lock —
    // is not a statement any run executes, so it cannot certify the
    // member on its own; the walk must look past it, where the second
    // turn-row write lands before the required locking call, and the
    // either-branch rule for a lock-only spelling still certifies the
    // runs that take it.
    @Test
    void theAuditDoesNotCertifyAMergedConditionalBranchCarryingBothSides() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void conditionalWriter(String tenantId,
                            String sessionId, boolean chooseLock) {
                        jdbc.queryForMap(chooseLock
                                ? "SELECT session_id FROM"
                                        + " ma_session"
                                        + " FOR UPDATE"
                                : "UPDATE ma_turn SET status"
                                        + " = 'FAILED'");
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'BROKEN'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "conditionalWriter");
    }

    // A lambda handed straight into a call runs within it, so its body
    // folds at that position: the writer that locks first stays clean.
    @Test
    void theAuditFoldsADirectArgumentLambda() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void callbackWriter(String tenantId,
                            String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                        runInTransaction(() -> jdbc.update("UPDATE"
                                + " ma_turn SET status"
                                + " = 'FAILED'"));
                    }

                    private void runInTransaction(Runnable body) {
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).isEmpty();
        assertThat(audit.lockers()).containsExactly("callbackWriter");
    }

    // A String local's spelling scores where the variable is used: the
    // declaration runs no statement, so a writer that locks before running
    // its stored SQL keeps its order.
    @Test
    void theAuditScoresALocalStringAtItsUseSite() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void localSqlWriter(String tenantId,
                            String sessionId) {
                        String failTurn = "UPDATE ma_turn SET"
                                + " status = 'FAILED'";
                        requireSessionForUpdate(tenantId, sessionId);
                        jdbc.update(failTurn, tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).isEmpty();
        assertThat(audit.lockers()).containsExactly("localSqlWriter");
        assertThat(audit.turnRowAccessors())
                .containsExactlyInAnyOrder("localSqlWriter");
    }

    // A pure delegator's lock and turn sides resolve to the same call
    // site, so a strict comparison of its own body can never fire: the
    // helper it delegates to reads the session row, writes the turn row
    // and only then locks, and the descent must report the delegator for
    // the inversion its helper commits.
    @Test
    void theAuditDescendsIntoASameSiteDelegate() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void lateLockWriter(String tenantId,
                            String sessionId) {
                        beginLifecycle(tenantId, sessionId);
                    }

                    private void beginLifecycle(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session WHERE session_id"
                                + " = ?");
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "lateLockWriter");
    }

    // A protected writer is an entry point a visibility-anchored matcher
    // used to skip entirely: it never entered the audited set, so the same
    // inversion passed unaudited.
    @Test
    void theAuditAuditsAProtectedWriter() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    protected void protectedWriter(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "protectedWriter");
    }

    // A package-private overload is a member like any other: beside a
    // public same-named sibling it must neither hide from the harvest nor
    // borrow the sibling's clean verdict.
    @Test
    void theAuditAuditsAPackagePrivateOverload() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void beginWorkspaceLifecycle(String tenantId,
                            String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                        writeTurnRow(tenantId, sessionId);
                    }

                    @Transactional
                    void beginWorkspaceLifecycle(String tenantId) {
                        writeTurnRow(tenantId, tenantId);
                        requireSessionForUpdate(tenantId, tenantId);
                    }

                    private void writeTurnRow(String tenantId,
                            String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        Audit audit = audit(synthetic);
        assertThat(audit.violations()).containsExactly(
                "beginWorkspaceLifecycle");
        assertThat(audit.lockers()).containsExactly(
                "beginWorkspaceLifecycle");
    }

    // Member identity carries the parameter types: a call to the
    // non-locking overload must not inherit the lock position only its
    // locking sibling takes.
    @Test
    void theAuditResolvesOverloadsByArity() {
        String synthetic = """
                class SyntheticStore {
                    @Transactional
                    public void lateLockWriter(String tenantId,
                            String sessionId) {
                        helper(tenantId);
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void helper(String tenantId) {
                        jdbc.update("UPDATE ma_operation SET"
                                + " state = 'DONE'");
                    }

                    private void helper(String tenantId, String sessionId) {
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "lateLockWriter");
    }

    // SQL extracted into a class constant is still SQL: the constant's
    // initializer feeds the needle set, so a writer whose turn-row write
    // hides behind a named constant is audited exactly like inline SQL.
    @Test
    void theAuditReadsTheTurnRowSqlFromAClassConstant() {
        String synthetic = """
                class SyntheticStore {
                    private static final String FAIL_TURN = "UPDATE"
                            + " ma_turn SET status = 'FAILED'";

                    @Transactional
                    public void constantWriter(String tenantId,
                            String sessionId) {
                        jdbc.update(FAIL_TURN, tenantId, sessionId);
                        requireSessionForUpdate(tenantId, sessionId);
                    }

                    private void requireSessionForUpdate(String tenantId,
                            String sessionId) {
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(synthetic).violations()).containsExactly(
                "constantWriter");
    }

    // The audit machinery is not tied to the main store: a sibling store's
    // writer is audited by the same walk the boundary guard applies to
    // every source in the package.
    @Test
    void aSiblingStoreWriterIsAudited() {
        String sibling = """
                class SiblingStore {
                    @Transactional
                    public void badWriter(String tenantId, String sessionId) {
                        jdbc.update("UPDATE ma_turn SET status"
                                + " = 'FAILED'");
                        jdbc.queryForMap("SELECT session_id FROM"
                                + " ma_session FOR UPDATE");
                    }
                }
                """;
        assertThat(audit(sibling).violations()).containsExactly(
                "badWriter");
    }

    // Runs the audit over one parsed compilation unit and answers the
    // violation list alongside the pinned populations.
    private static Audit audit(String source) {
        CompilationUnitTree unit = parse(source);
        Map<Key, MethodTree> methods = new LinkedHashMap<>();
        Map<String, String> constants = new HashMap<>();
        for (Tree declaration : unit.getTypeDecls()) {
            if (declaration instanceof ClassTree type) {
                harvest(type, "", methods, constants);
            }
        }
        // A call through a type the file imports leaves the file: no
        // same-file member can share an imported type's simple name.
        Set<String> importedTypes = unit.getImports().stream()
                .filter(declaration -> !declaration.isStatic())
                .map(declaration -> declaration.getQualifiedIdentifier()
                        .toString())
                .filter(name -> !name.endsWith(".*"))
                .map(name -> name.substring(name.lastIndexOf('.') + 1))
                .collect(Collectors.toSet());
        List<Ambiguous> ambiguous = new ArrayList<>();
        Map<Key, List<Event>> events = new LinkedHashMap<>();
        Map<Key, List<List<Event>>> heldLambdas = new LinkedHashMap<>();
        for (Map.Entry<Key, MethodTree> member : methods.entrySet()) {
            MemberScan scan = eventsOf(member.getValue(), member.getKey(),
                    methods, constants, importedTypes, ambiguous);
            events.put(member.getKey(), scan.events());
            heldLambdas.put(member.getKey(), scan.heldLambdas());
        }
        Set<Key> lockReaching = reaching(events, true);
        Set<Key> turnReaching = reaching(events, false);
        Set<String> deferredBodies = new TreeSet<>();
        // A held lambda or anonymous-class body is benign only while
        // every event it carries provably reaches neither side — like an
        // ambiguous reference; the moment one does, the audit fails closed
        // instead of folding the body at its declaration, a position its
        // invocation may never share.
        for (Map.Entry<Key, List<List<Event>>> member
                : heldLambdas.entrySet()) {
            for (List<Event> held : member.getValue()) {
                boolean sideReaching = held.stream().anyMatch(event ->
                        event.callee() == null
                                ? event.lock() || event.turn()
                                : lockReaching.contains(event.callee())
                                        || turnReaching.contains(
                                                event.callee()));
                if (sideReaching && DEFERRED_BODIES.contains(
                        member.getKey().handle())) {
                    deferredBodies.add(member.getKey().handle());
                    continue;
                }
                if (sideReaching) {
                    throw new IllegalStateException("a lambda,"
                            + " anonymous-class or local-class body in "
                            + member.getKey().handle() + " reaches the"
                            + " session lock or the turn row, and its"
                            + " invocation site is invisible to the audit");
                }
                events.get(member.getKey()).addAll(held);
            }
        }
        // An unresolvable reference is exempt only while every candidate
        // provably reaches neither side; the moment one does, the audit
        // fails closed instead of guessing an attribution. The one
        // exception is a file no member of which reaches the turn row:
        // there an attribution can move only the session lock, and a lock
        // with no turn access anywhere in the file orders nothing.
        Set<String> exemptions = new TreeSet<>();
        for (Ambiguous reference : ambiguous) {
            boolean sideReaching = reference.candidates().stream()
                    .anyMatch(candidate -> turnReaching.contains(candidate)
                            || (lockReaching.contains(candidate)
                                    && !turnReaching.isEmpty()));
            if (sideReaching) {
                throw new IllegalStateException("cannot resolve the '"
                        + reference.handle() + "' reference in "
                        + reference.caller().handle() + " to one member — "
                        + "a candidate reaches the session lock or the turn"
                        + " row, so the call must be disambiguated by arity"
                        + " or renamed");
            }
            exemptions.add(reference.handle());
        }
        // The turn-row population, pinned as exactly as the locker set: a
        // member that reaches the turn row without taking the session lock
        // never enters `lockers`, so only this set fails loudly when one
        // appears.
        Set<String> turnRowAccessors = turnReaching.stream()
                .map(Key::name)
                .collect(Collectors.toCollection(TreeSet::new));
        Set<String> lockers = new TreeSet<>();
        Set<String> lockersWithoutTurnAccess = new TreeSet<>();
        List<String> violations = new ArrayList<>();
        for (Map.Entry<Key, MethodTree> member : methods.entrySet()) {
            Key key = member.getKey();
            MethodTree method = member.getValue();
            // A private member enters the audit as a callee of the entry
            // points; the descent compares it in its own body.
            if (method.getModifiers().getFlags().contains(Modifier.PRIVATE)
                    || !lockReaching.contains(key)) {
                continue;
            }
            // Overloads audit as separate members but name one locker.
            lockers.add(key.name());
            if (!turnReaching.contains(key)) {
                lockersWithoutTurnAccess.add(key.name());
                continue;
            }
            if (lockAfterTurn(key, events, lockReaching, turnReaching,
                    new HashSet<>())) {
                violations.add(key.name());
            }
        }
        List<String> members = methods.keySet().stream()
                .map(key -> key.ownerSimpleName() + "#" + key.name() + "/"
                        + key.arity())
                .sorted().collect(Collectors.toCollection(ArrayList::new));
        return new Audit(members, lockers, violations,
                lockersWithoutTurnAccess, turnRowAccessors, exemptions,
                deferredBodies, events.values().stream().flatMap(List::stream)
                        .anyMatch(Event::lock),
                events.values().stream().flatMap(List::stream)
                        .anyMatch(Event::turn));
    }

    // The members of one type, recursively through its nested types, keyed
    // by (enclosing type, name, parameter type text): same-name overloads
    // that share an arity stay distinct members, and a nested type's
    // member is harvested exactly like a top-level one. Constants answer
    // their flattened initializer, so a conditional lock clause in a
    // constant scores exactly like the inline spelling.
    private static void harvest(ClassTree type, String ownerPath,
            Map<Key, MethodTree> methods, Map<String, String> constants) {
        String path = ownerPath.isEmpty() ? type.getSimpleName().toString()
                : ownerPath + "." + type.getSimpleName();
        for (Tree member : type.getMembers()) {
            if (member instanceof MethodTree method
                    && !method.getName().contentEquals("<init>")) {
                List<String> paramTypes = new ArrayList<>();
                for (VariableTree parameter : method.getParameters()) {
                    paramTypes.add(String.valueOf(parameter.getType()));
                }
                methods.put(new Key(path, method.getName().toString(),
                        paramTypes), method);
            } else if (member instanceof VariableTree field
                    && field.getModifiers().getFlags()
                            .contains(Modifier.STATIC)
                    && field.getModifiers().getFlags()
                            .contains(Modifier.FINAL)
                    && field.getInitializer() != null
                    && "String".equals(String.valueOf(field.getType()))) {
                constants.put(field.getName().toString(),
                        flatten(field.getInitializer(), constants));
            } else if (member instanceof ClassTree nested) {
                harvest(nested, path, methods, constants);
            }
        }
    }

    // The ordering comparison for one member, over its events in tree
    // order: the session-row lock must precede the first turn-row access.
    // A call reaching both sides is the delegator shape — the two events
    // sit on the same call site — so the comparison descends into the
    // callee, whose own order is what the site answers. A descent that
    // revisits a member on its own stack is undecidable — a
    // mutually-recursive delegate chain — and fails closed like every
    // other undecidable shape in this audit, never rated clean by
    // accident.
    private static boolean lockAfterTurn(Key method,
            Map<Key, List<Event>> events, Set<Key> lockReaching,
            Set<Key> turnReaching, Set<Key> visiting) {
        if (!visiting.add(method)) {
            // A delegate cycle reaches this member again while it is still
            // on the descent stack: the walk cannot rank a recursive chain
            // any more than it can rank the other undecidable shapes in
            // this file, so it fails closed the same way instead of
            // awarding the recursion an unearned clean answer.
            throw new IllegalStateException("a mutually-recursive delegate"
                    + " chain revisits " + method.handle()
                    + " — the walk cannot rank it");
        }
        for (Event event : events.getOrDefault(method, List.of())) {
            if (event.callee() != null) {
                boolean lock = lockReaching.contains(event.callee());
                boolean turn = turnReaching.contains(event.callee());
                if (lock && turn) {
                    return lockAfterTurn(event.callee(), events,
                            lockReaching, turnReaching, visiting);
                }
                if (lock) {
                    return false;
                }
                if (turn) {
                    return true;
                }
                continue;
            }
            // A merged conditional/switch spelling that carries both
            // needles is not a statement any run executes: it must not
            // certify the member clean by its lock flag alone, so the
            // walk keeps looking past it to the statement that actually
            // precedes the lock. A statement whose SQL locks the session
            // row on its own takes the write lock it declares.
            if (event.lock() && event.turn()) {
                continue;
            }
            if (event.lock()) {
                return false;
            }
            return true;
        }
        return false;
    }

    // The members reaching a side, as a fixpoint: a member qualifies when
    // its own body bears the spelling or calls a member already in the
    // set. One-hop resolution audited create's two-hop lock as no lock at
    // all — the writers left the asserted set instead of failing it.
    private static Set<Key> reaching(Map<Key, List<Event>> events,
            boolean lockSide) {
        Set<Key> reaching = new HashSet<>();
        for (boolean grew = true; grew;) {
            grew = false;
            for (Map.Entry<Key, List<Event>> member : events.entrySet()) {
                if (reaching.contains(member.getKey())) {
                    continue;
                }
                for (Event event : member.getValue()) {
                    boolean hit = event.callee() != null
                            ? reaching.contains(event.callee())
                            : lockSide ? event.lock() : event.turn();
                    if (hit) {
                        reaching.add(member.getKey());
                        grew = true;
                        break;
                    }
                }
            }
        }
        return reaching;
    }

    // One member's ordered events plus the lambda and anonymous-class
    // bodies held aside: SQL spellings and calls to same-file members, in
    // evaluation order. A
    // spelling is the flattened static text of the expression that carries
    // it — a split literal cannot hide a table name, and every branch of a
    // conditional or switch is credited — scored after the calls the
    // expression embeds, because the operands evaluate before the
    // statement's own SQL takes effect.
    private static MemberScan eventsOf(MethodTree method, Key caller,
            Map<Key, MethodTree> methods, Map<String, String> constants,
            Set<String> importedTypes, List<Ambiguous> ambiguous) {
        EventScanner scanner = new EventScanner(new ArrayList<>(), caller,
                methods, new HashMap<>(constants), importedTypes, ambiguous);
        if (method.getBody() != null) {
            scanner.scan(method.getBody(), null);
        }
        return new MemberScan(scanner.events, scanner.heldLambdas);
    }

    private record MemberScan(List<Event> events,
            List<List<Event>> heldLambdas) { }

    // The statement walk over one body. The constants map is the member's
    // own overlay of the file's class constants: the String locals the
    // walk records land in it, so a local's spelling scores at its uses.
    // Lambdas not passed straight into a call — and anonymous-class
    // method bodies — are held aside for the reachability check in
    // audit(): their invocation site is invisible to the parse, so a body
    // that reaches a side fails closed there instead of folding at its
    // declaration.
    private static final class EventScanner extends TreeScanner<Void, Void> {
        private final List<Event> events;
        private final List<List<Event>> heldLambdas = new ArrayList<>();
        private final Key caller;
        private final Map<Key, MethodTree> methods;
        private final Map<String, String> constants;
        private final Set<String> importedTypes;
        private final List<Ambiguous> ambiguous;
        // The lambda nodes passed straight into a call, marked at the call
        // site: only their bodies fold into the enclosing member.
        private final Set<Tree> directArgumentLambdas =
                Collections.newSetFromMap(new IdentityHashMap<>());

        EventScanner(List<Event> events, Key caller,
                Map<Key, MethodTree> methods, Map<String, String> constants,
                Set<String> importedTypes, List<Ambiguous> ambiguous) {
            this.events = events;
            this.caller = caller;
            this.methods = methods;
            this.constants = constants;
            this.importedTypes = importedTypes;
            this.ambiguous = ambiguous;
        }

        @Override
        public Void visitMethodInvocation(MethodInvocationTree node,
                Void unused) {
            addCall(node);
            for (Tree argument : node.getArguments()) {
                Tree unwrapped = argument;
                for (;;) {
                    if (unwrapped instanceof ParenthesizedTree parens) {
                        unwrapped = parens.getExpression();
                    } else if (unwrapped instanceof TypeCastTree cast) {
                        unwrapped = cast.getExpression();
                    } else {
                        break;
                    }
                }
                if (unwrapped instanceof LambdaExpressionTree lambda) {
                    directArgumentLambdas.add(lambda);
                }
            }
            return super.visitMethodInvocation(node, unused);
        }

        @Override
        public Void visitMemberReference(MemberReferenceTree node,
                Void unused) {
            addReference(node);
            return super.visitMemberReference(node, unused);
        }

        @Override
        public Void visitBinary(BinaryTree node, Void unused) {
            if (node.getKind() == Tree.Kind.PLUS) {
                String text = flatten(node, constants);
                if (!text.isEmpty()) {
                    scanCalls(node);
                    addSpelling(text, events);
                    return null;
                }
            }
            return super.visitBinary(node, unused);
        }

        @Override
        public Void visitConditionalExpression(
                ConditionalExpressionTree node, Void unused) {
            String text = flatten(node, constants);
            if (!text.isEmpty()) {
                scanCalls(node);
                addSpelling(text, events);
                return null;
            }
            return super.visitConditionalExpression(node, unused);
        }

        @Override
        public Void visitSwitchExpression(SwitchExpressionTree node,
                Void unused) {
            String text = flatten(node, constants);
            if (!text.isEmpty()) {
                scanCalls(node);
                addSpelling(text, events);
                return null;
            }
            return super.visitSwitchExpression(node, unused);
        }

        @Override
        public Void visitVariable(VariableTree node, Void unused) {
            // A String local's spelling scores where the variable is used:
            // the declaration runs no statement. Calls in the initializer
            // still evaluate here.
            if (node.getInitializer() != null
                    && "String".equals(String.valueOf(node.getType()))) {
                String text = flatten(node.getInitializer(), constants);
                if (!text.isEmpty()) {
                    constants.put(node.getName().toString(), text);
                    scanCalls(node.getInitializer());
                    return null;
                }
            }
            return super.visitVariable(node, unused);
        }

        @Override
        public Void visitAssignment(AssignmentTree node, Void unused) {
            // The overlay must follow the reassignment: without it a local
            // re-aimed at the turn row keeps scoring the declaration's
            // stale lock spelling at every later use. The overlay updates
            // before the walk scores the assigned expression, so the
            // statement itself reads in evaluation order.
            if (node.getVariable() instanceof IdentifierTree identifier) {
                constants.put(identifier.getName().toString(),
                        flatten(node.getExpression(), constants));
            }
            return super.visitAssignment(node, unused);
        }

        @Override
        public Void visitCompoundAssignment(CompoundAssignmentTree node,
                Void unused) {
            // `sql += "..."`: the overlay gains the appended text instead
            // of forgetting the spelling reached so far.
            if (node.getVariable() instanceof IdentifierTree identifier) {
                String name = identifier.getName().toString();
                constants.put(name, constants.getOrDefault(name, "")
                        + flatten(node.getExpression(), constants));
            }
            return super.visitCompoundAssignment(node, unused);
        }

        @Override
        public Void visitLambdaExpression(LambdaExpressionTree node,
                Void unused) {
            if (directArgumentLambdas.contains(node)) {
                return super.visitLambdaExpression(node, unused);
            }
            // A lambda in any other position runs where it is invoked,
            // which the parse cannot see: its events are held aside, and
            // audit() folds the provably benign ones and fails closed on
            // any that reach a side.
            EventScanner held = new EventScanner(new ArrayList<>(), caller,
                    methods, constants, importedTypes, ambiguous);
            held.scan(node.getBody(), null);
            heldLambdas.add(held.events);
            heldLambdas.addAll(held.heldLambdas);
            return null;
        }

        @Override
        public Void visitNewClass(NewClassTree node, Void unused) {
            if (node.getClassBody() == null) {
                return super.visitNewClass(node, unused);
            }
            // An anonymous-class method body runs where it is invoked,
            // which the parse cannot see — hold it aside exactly like a
            // held lambda. Field initializers and initializer blocks run
            // at construction, so they still fold at this position, as do
            // the construction's own arguments.
            scan(node.getEnclosingExpression(), null);
            scan(node.getIdentifier(), null);
            scan(node.getTypeArguments(), null);
            scan(node.getArguments(), null);
            EventScanner held = new EventScanner(new ArrayList<>(), caller,
                    methods, constants, importedTypes, ambiguous);
            for (Tree member : node.getClassBody().getMembers()) {
                if (member instanceof MethodTree method) {
                    if (method.getBody() != null) {
                        held.scan(method.getBody(), null);
                    }
                } else {
                    scan(member, null);
                }
            }
            heldLambdas.add(held.events);
            heldLambdas.addAll(held.heldLambdas);
            return null;
        }

        @Override
        public Void visitClass(ClassTree node, Void unused) {
            // A local class declared inside a member body runs its methods
            // where new Locker().method() is invoked — never at the class
            // declaration — so its bodies must be held aside exactly like
            // an anonymous-class body; folding them inline would score the
            // session lock the body takes where it never runs.
            EventScanner held = new EventScanner(new ArrayList<>(), caller,
                    methods, constants, importedTypes, ambiguous);
            for (Tree member : node.getMembers()) {
                if (member instanceof MethodTree method
                        && method.getBody() != null
                        && !method.getName().contentEquals("<init>")) {
                    held.scan(method.getBody(), null);
                }
            }
            heldLambdas.add(held.events);
            heldLambdas.addAll(held.heldLambdas);
            return null;
        }

        @Override
        public Void visitLiteral(LiteralTree node, Void unused) {
            if (node.getValue() instanceof String text) {
                addSpelling(text, events);
            }
            return null;
        }

        @Override
        public Void visitIdentifier(IdentifierTree node, Void unused) {
            String text = constants.get(node.getName().toString());
            if (text != null) {
                addSpelling(text, events);
            }
            return null;
        }

        // The calls and references inside an expression whose spelling was
        // already scored: the SQL text is flattened once, but the member
        // calls it embeds keep their own audit edges.
        private void scanCalls(Tree node) {
            new TreeScanner<Void, Void>() {
                @Override
                public Void visitMethodInvocation(MethodInvocationTree call,
                        Void unused) {
                    addCall(call);
                    return super.visitMethodInvocation(call, unused);
                }

                @Override
                public Void visitMemberReference(
                        MemberReferenceTree reference, Void unused) {
                    addReference(reference);
                    return super.visitMemberReference(reference, unused);
                }
            }.scan(node, null);
        }

        private void addCall(MethodInvocationTree node) {
            resolve(node.getMethodSelect(), node.getArguments().size(),
                    caller, methods, importedTypes, ambiguous).forEach(key ->
                    events.add(new Event(false, false, key)));
        }

        // A method reference is an invocation whose argument count is not
        // spelled, so it can never resolve to one member: it is exempt when
        // every same-named member is benign and throws otherwise.
        private void addReference(MemberReferenceTree node) {
            if (node.getName().contentEquals("<init>")) {
                return;
            }
            List<Key> candidates = methods.keySet().stream()
                    .filter(key -> key.name()
                            .contentEquals(node.getName().toString()))
                    .toList();
            if (!candidates.isEmpty()) {
                ambiguous.add(new Ambiguous(caller, handle(candidates),
                        candidates));
            }
        }
    }

    // The same-file member an invocation resolves to, or the reference
    // recorded as ambiguous. A bare or this. call searches the caller's
    // enclosing type chain innermost first; a Type. call searches the
    // named type. Any other receiver hides its type from the parse, so the
    // call is never resolved — it is exempt when every same-named member
    // is benign and throws otherwise.
    private static List<Key> resolve(Tree select, int argCount, Key caller,
            Map<Key, MethodTree> methods, Set<String> importedTypes,
            List<Ambiguous> ambiguous) {
        if (select instanceof IdentifierTree identifier) {
            return resolveInOwnerChain(identifier.getName().toString(),
                    argCount, caller, methods, ambiguous);
        }
        if (select instanceof MemberSelectTree memberSelect) {
            String name = memberSelect.getIdentifier().toString();
            if (memberSelect.getExpression() instanceof IdentifierTree base) {
                if (base.getName().contentEquals("this")) {
                    return resolveInOwnerChain(name, argCount, caller,
                            methods, ambiguous);
                }
                List<Key> inType = methods.keySet().stream()
                        .filter(key -> key.ownerSimpleName()
                                .contentEquals(base.getName().toString())
                                && key.name().contentEquals(name)
                                && key.arity() == argCount)
                        .toList();
                if (inType.size() == 1) {
                    return List.of(inType.getFirst());
                }
                if (!inType.isEmpty()) {
                    ambiguous.add(new Ambiguous(caller,
                            inType.getFirst().handle(), inType));
                    return List.of();
                }
                if (importedTypes.contains(base.getName().toString())) {
                    return List.of();
                }
            }
            List<Key> any = methods.keySet().stream()
                    .filter(key -> key.name().contentEquals(name)
                            && key.arity() == argCount)
                    .toList();
            if (!any.isEmpty()) {
                ambiguous.add(new Ambiguous(caller, handle(any), any));
            }
        }
        return List.of();
    }

    private static List<Key> resolveInOwnerChain(String name, int argCount,
            Key caller, Map<Key, MethodTree> methods,
            List<Ambiguous> ambiguous) {
        for (String owner = caller.owner(); owner != null;
                owner = owner.lastIndexOf('.') < 0 ? null
                        : owner.substring(0, owner.lastIndexOf('.'))) {
            String scope = owner;
            List<Key> candidates = methods.keySet().stream()
                    .filter(key -> key.owner().equals(scope)
                            && key.name().contentEquals(name)
                            && key.arity() == argCount)
                    .toList();
            if (candidates.size() == 1) {
                return List.of(candidates.getFirst());
            }
            if (!candidates.isEmpty()) {
                ambiguous.add(new Ambiguous(caller,
                        candidates.getFirst().handle(), candidates));
                return List.of();
            }
        }
        return List.of();
    }

    private static String handle(List<Key> candidates) {
        return candidates.stream().map(Key::handle).distinct().sorted()
                .collect(Collectors.joining("|"));
    }

    private static void addSpelling(String text, List<Event> events) {
        // SQL keywords are case-insensitive, so the spelling and the
        // needles fold once before matching: a lowercase `for update`
        // takes the same lock the canary exists to order.
        String folded = text.toLowerCase(Locale.ROOT);
        boolean lock = SESSION_WRITE.matcher(folded).find()
                || (SESSION_NAMED.matcher(folded).find()
                        && folded.contains(
                                LOCK_MODE.toLowerCase(Locale.ROOT)));
        boolean turn = folded.contains(TURN_TABLE);
        if (lock || turn) {
            events.add(new Event(lock, turn, null));
        }
    }

    // The static text an expression can carry: string literals, their
    // concatenations, constants and every branch of a conditional or
    // switch expression. Both sides take every branch — a lock taken on
    // only some runs still orders the runs that take it, exactly like a
    // turn access that executes under a flag. Dynamic parts contribute
    // nothing, and a needle split across a literal boundary still lands in
    // the joined text.
    private static String flatten(Tree node, Map<String, String> constants) {
        if (node instanceof LiteralTree literal
                && literal.getValue() instanceof String text) {
            return text;
        }
        if (node instanceof BinaryTree binary
                && binary.getKind() == Tree.Kind.PLUS) {
            return flatten(binary.getLeftOperand(), constants)
                    + flatten(binary.getRightOperand(), constants);
        }
        if (node instanceof ParenthesizedTree parenthesized) {
            return flatten(parenthesized.getExpression(), constants);
        }
        if (node instanceof ConditionalExpressionTree conditional) {
            return flatten(conditional.getTrueExpression(), constants)
                    + flatten(conditional.getFalseExpression(), constants);
        }
        if (node instanceof SwitchExpressionTree switchExpression) {
            StringBuilder text = new StringBuilder();
            for (CaseTree branch : switchExpression.getCases()) {
                Tree body = branch.getBody();
                List<? extends StatementTree> statements =
                        body instanceof BlockTree block
                                ? block.getStatements()
                                : branch.getStatements();
                if (statements != null) {
                    for (StatementTree statement : statements) {
                        if (statement instanceof YieldTree yield) {
                            text.append(flatten(yield.getValue(), constants));
                        }
                    }
                } else if (body != null) {
                    text.append(flatten(body, constants));
                }
            }
            return text.toString();
        }
        if (node instanceof IdentifierTree identifier) {
            return constants.getOrDefault(identifier.getName().toString(),
                    "");
        }
        if (node instanceof MemberSelectTree select) {
            return constants.getOrDefault(select.getIdentifier().toString(),
                    "");
        }
        // An expression the walk cannot resolve still carries its string
        // literals — a table name handed to a helper inside the SQL's own
        // concatenation is part of the text the statement runs, so it
        // joins the spelling rather than dropping out with the call.
        StringBuilder text = new StringBuilder();
        new TreeScanner<Void, Void>() {
            @Override
            public Void visitLiteral(LiteralTree literal, Void unused) {
                if (literal.getValue() instanceof String value) {
                    text.append(value);
                }
                return null;
            }
        }.scan(node, null);
        return text.toString();
    }

    // The bytecode's own member enumeration, recursively over the named
    // nested types and projected to owner#name/arity, for the harvest
    // cross-check. Anonymous classes are skipped: their methods answer
    // only through the implemented interface and never enter the
    // parse-side harvest. Compiler-generated record members — the
    // component accessors and toString/equals/hashCode — are absent from
    // the parse tree unless the record declares them, so only the
    // undeclared ones are filtered.
    private static List<String> compiledMembers(Class<?> type,
            List<String> parsed) {
        List<String> compiled = new ArrayList<>();
        collectCompiled(type, parsed, compiled);
        compiled.sort(null);
        return compiled;
    }

    private static void collectCompiled(Class<?> type, List<String> parsed,
            List<String> compiled) {
        if (type.getSimpleName().isEmpty()) {
            return;
        }
        Set<String> generated = new HashSet<>();
        if (type.isRecord()) {
            for (var component : type.getRecordComponents()) {
                generated.add(component.getName() + "/0");
            }
            generated.add("toString/0");
            generated.add("hashCode/0");
            generated.add("equals/1");
        }
        for (Method method : type.getDeclaredMethods()) {
            if (method.isSynthetic()) {
                continue;
            }
            String member = type.getSimpleName() + "#" + method.getName()
                    + "/" + method.getParameterCount();
            if (generated.contains(method.getName() + "/"
                    + method.getParameterCount())
                    && !parsed.contains(member)) {
                continue;
            }
            compiled.add(member);
        }
        for (Class<?> nested : type.getDeclaredClasses()) {
            collectCompiled(nested, parsed, compiled);
        }
    }

    private static CompilationUnitTree parse(String source) {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        JavaFileObject file = new SimpleJavaFileObject(
                URI.create("memory:///SyntheticStore.java"),
                JavaFileObject.Kind.SOURCE) {
            @Override
            public CharSequence getCharContent(boolean ignoreErrors) {
                return source;
            }
        };
        JavacTask task = (JavacTask) compiler.getTask(null, null, null, null,
                null, List.of(file));
        try {
            return task.parse().iterator().next();
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }
}
