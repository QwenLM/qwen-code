package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.core.annotation.AnnotationUtils;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Repository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedStoreDecompositionTest {
    private static final Set<Class<?>> COMPONENTS = Set.of(
            AgentStoreRows.class,
            AgentEventJournal.class,
            AgentSessionQueries.class,
            AgentMessageProjection.class,
            AgentSessionPolicies.class,
            AgentSessionCommands.class,
            SessionRenameDeliveries.class,
            AgentLifecycleOperations.class,
            AgentSessionAdmissions.class,
            ChildSessionAdmissions.class,
            AgentTurnExecution.class,
            AgentExecutionOperations.class,
            JournalStoreRows.class,
            JournalFencing.class,
            JournalHistoryQueries.class,
            JournalLifecycleAuthorization.class,
            JournalResourceReads.class,
            JournalResourceWrites.class,
            JournalWriterLifecycle.class,
            JournalCommit.class,
            ManagedStoreAssembly.class);

    @Test
    void collaboratorsAreImmutableOrdinaryObjectsWithAcyclicDependencies() {
        for (Class<?> component : COMPONENTS) {
            assertThat(Modifier.isFinal(component.getModifiers())).as(component.getSimpleName()).isTrue();
            assertThat(Modifier.isPublic(component.getModifiers())).isFalse();
            assertThat(component.getInterfaces()).isEmpty();
            assertNoSpringComponent(component);
            for (var field : component.getDeclaredFields()) {
                assertThat(Modifier.isFinal(field.getModifiers())).as(field.toString()).isTrue();
                assertThat(field.getType()).isNotIn(ManagedAgentStore.class, JdbcManagedSessionStore.class);
            }
            assertThat(Arrays.stream(component.getDeclaredMethods()))
                    .noneMatch(method -> method.isAnnotationPresent(Transactional.class));
            requireAcyclic(component, new HashSet<>());
        }
    }

    @Test
    void componentGuardRejectsDirectAndComposedStereotypes() {
        @Component
        final class DirectComponent {}
        @Service
        final class ServiceComponent {}
        @Repository
        final class RepositoryComponent {}

        for (Class<?> component : List.of(DirectComponent.class, ServiceComponent.class, RepositoryComponent.class)) {
            assertThatThrownBy(() -> assertNoSpringComponent(component))
                    .isInstanceOf(AssertionError.class).hasMessageContaining("Spring component");
        }
    }

    private static void assertNoSpringComponent(Class<?> component) {
        assertThat(AnnotationUtils.findAnnotation(component, Component.class))
                .as("%s must not be a Spring component", component.getSimpleName()).isNull();
    }

    private static void requireAcyclic(Class<?> component, Set<Class<?>> visiting) {
        assertThat(visiting.add(component)).as("dependency cycle at %s", component.getSimpleName()).isTrue();
        for (var field : component.getDeclaredFields()) {
            if (!Modifier.isStatic(field.getModifiers()) && COMPONENTS.contains(field.getType())) {
                requireAcyclic(field.getType(), visiting);
            }
        }
        visiting.remove(component);
    }

    @Test
    void facadesKeepTheExistingEntryAndTransactionPopulation() {
        // Issue #16605: the six principal mutation entries are declared
        // TWICE on purpose — the bodies stay in ManagedAgentPrincipalEntries
        // and the facade redeclares them with @Transactional, because an
        // inherited annotated entry reaches Spring as an annotation-less
        // bridge and loses its boundary. The population pin therefore
        // counts each of those six once more; the permanent witness is
        // PrincipalEntryTransactionBoundaryTest.
        assertEntries(ManagedAgentStore.class, """
                findControlEvents/3:- findTranscriptEvents/4:- findSessionWorktree/2:- findSessionWorktrees/2:- findChildWorkspaceCwd/3:-
                findChildLineage/2:- findTurnSummary/3:- findReplayWindow/2:- completedWorkspaceCloses/2:- findLatestEnvironmentEvents/2:-
                appendPublicEventIfAbsent/7::REQUIRED:DEFAULT:false appendLiveSessionEventIfAbsent/5::REQUIRED:DEFAULT:false
                hasCompletedWorkspaceClose/2:- hasExecutionRegistryFacts/2:- findMessageCoveredSequences/2:- findMaterializationTargets/1:-
                deferMaterializationTarget/2::REQUIRED:DEFAULT:false workspaceSessionOptions/2::REQUIRED:DEFAULT:false
                requireMcpSettingsCommit/3::MANDATORY:DEFAULT:false requireExtensionManagement/5::REQUIRED:DEFAULT:false
                requireConfigurationCommit/4::MANDATORY:DEFAULT:false completeSessionMutation/7::REQUIRED:DEFAULT:false
                beginWorkspaceLifecycle/9::REQUIRED:DEFAULT:false beginWorkspaceLifecycle/8::REQUIRED:DEFAULT:false
                unarchiveWorkspaceSession/5::REQUIRED:DEFAULT:false findDeliverableOperations/2:- renewLifecycleOperation/6::REQUIRED:DEFAULT:false
                blockLifecycleOperation/8::REQUIRED:DEFAULT:false blockLifecycleOperation/7::REQUIRED:DEFAULT:false findEvents/4:- listTurns/5:-
                hasMcpServers/1:- claimRename/3::REQUIRED:DEFAULT:false retryRename/3::REQUIRED:DEFAULT:false findOperation/3:-
                beginOperation/6::REQUIRED:DEFAULT:false claimOperation/5::REQUIRED:DEFAULT:false failOperation/6::REQUIRED:DEFAULT:false
                retryOperation/7::REQUIRED:DEFAULT:false retryOperation/6::REQUIRED:DEFAULT:false
                findMessagePage/5:managedAgentTransactionManager:REQUIRED:REPEATABLE_READ:true
                findMessagePage/6:managedAgentTransactionManager:REQUIRED:REPEATABLE_READ:true findReplayFloorTargets/1:-
                advanceReplayFloor/3::REQUIRED:DEFAULT:false materializeNextBatch/3::REQUIRED:DEFAULT:false workspaceFilesEnabled/0:-
                workspaceShellEnabled/0:- supportsPlanMode/1:- requireMcpManagement/4::REQUIRED:DEFAULT:false canApplyExtensions/1:-
                changeSessionModel/8::REQUIRED:DEFAULT:false changeSessionApproval/11::REQUIRED:DEFAULT:false
                changeSessionApproval/9::REQUIRED:DEFAULT:false changeSessionApproval/12::REQUIRED:DEFAULT:false
                changeSessionApproval/15::REQUIRED:DEFAULT:false insertTurnCommand/8::REQUIRED:DEFAULT:false
                insertTurnCommand/7::REQUIRED:DEFAULT:false insertTurnCommand/8::REQUIRED:DEFAULT:false insertCancelCommand/7::REQUIRED:DEFAULT:false
                insertCancelCommand/6::REQUIRED:DEFAULT:false insertCancelCommand/7::REQUIRED:DEFAULT:false
                beginSessionRename/5::REQUIRED:DEFAULT:false beginSessionRename/7::REQUIRED:DEFAULT:false beginSessionRename/6::REQUIRED:DEFAULT:false
                beginSessionMutation/7::REQUIRED:DEFAULT:false beginSessionMutation/8::REQUIRED:DEFAULT:false
                beginSessionMutation/6::REQUIRED:DEFAULT:false abandonSessionMutation/4::REQUIRED:DEFAULT:false
                completeSessionRename/6::REQUIRED:DEFAULT:false completeSessionRename/3::REQUIRED:DEFAULT:false
                abandonSessionRename/5::REQUIRED:DEFAULT:false bindSessionHarness/3::REQUIRED:DEFAULT:false
                deliverableRenames/1::REQUIRED:DEFAULT:false markRenameSubmitted/2:- beginWorkspaceClose/7::REQUIRED:DEFAULT:false
                beginChildClose/8::REQUIRED:DEFAULT:false completeOperation/6::REQUIRED:DEFAULT:false markOperationAnswered/5::REQUIRED:DEFAULT:false
                insertSessionCommand/10::REQUIRED:DEFAULT:false insertSessionCommand/9::REQUIRED:DEFAULT:false
                insertSessionCommand/10::REQUIRED:DEFAULT:false insertSessionCommand/12::REQUIRED:DEFAULT:false
                insertSessionCommand/11::REQUIRED:DEFAULT:false insertSessionCommand/11::REQUIRED:DEFAULT:false
                insertSessionCommand/12::REQUIRED:DEFAULT:false requireCsiRequest/2:- scheduleTurnRetry/6::REQUIRED:DEFAULT:false
                cancelBeforeAdmission/4::REQUIRED:DEFAULT:false findDispatchable/2:- releaseTurnLease/4::REQUIRED:DEFAULT:false
                requestRecoveryRecheck/3::REQUIRED:DEFAULT:false bindRecoveredHarness/6::REQUIRED:DEFAULT:false
                recordAdmission/6::REQUIRED:DEFAULT:false recordHarnessEvents/6::REQUIRED:DEFAULT:false cancelUnadmittedTurn/4::REQUIRED:DEFAULT:false
                insertChildSessionCommand/9::REQUIRED:DEFAULT:false insertChildSessionCommand/8::REQUIRED:DEFAULT:false
                insertWorkspaceSessionCommand/1::REQUIRED:DEFAULT:false findWorkspaceCreateReplay/4:-
                replayWorkspaceSessionCommand/4::REQUIRED:DEFAULT:false insertCsiSessionCommand/7:-
                replayChildSessionCommand/4::REQUIRED:DEFAULT:false withdrawSubmissionAttempted/4::REQUIRED:DEFAULT:false
                findRuntimeRecoveryParked/2:- markTurnRecoveryBlocked/6::REQUIRED:DEFAULT:false markTurnFailureRecovery/5::REQUIRED:DEFAULT:false
                parkTurnForRuntimeRecovery/6::REQUIRED:DEFAULT:false markSubmissionAttempted/4::REQUIRED:DEFAULT:false
                recordRecoveryAdmission/8::REQUIRED:DEFAULT:false retractContinuationOutput/6::REQUIRED:DEFAULT:false
                retractHarnessTurnOutput/7::REQUIRED:DEFAULT:false retractHarnessTurnOutput/10::REQUIRED:DEFAULT:false
                failWorktreeInitialTurns/3::REQUIRED:DEFAULT:false failRecoveryBlockedTurn/5::REQUIRED:DEFAULT:false contextCompressionState/2:-
                settleContextCompression/5::REQUIRED:DEFAULT:false beginContextCompression/8::REQUIRED:DEFAULT:false contextCompressionStates/2:-
                contextCompressionRequest/3:- findContextCompressions/1:- claimContextCompression/5::REQUIRED:DEFAULT:false
                awaitContextCompression/5::REQUIRED:DEFAULT:false completeCwdChangeOperation/5::REQUIRED:DEFAULT:false
                beginTaskCancelOperation/6::REQUIRED:DEFAULT:false findDeliverableTaskCancels/1:- claimTurn/5::REQUIRED:DEFAULT:false
                renewTurn/5::REQUIRED:DEFAULT:false deferTurnRetry/5::REQUIRED:DEFAULT:false bindHarness/5::REQUIRED:DEFAULT:false
                failTurn/6::REQUIRED:DEFAULT:false failCwdChangeOperation/6::REQUIRED:DEFAULT:false findParkedOperations/1:-
                settleParkedOperation/3::REQUIRED:DEFAULT:false turnInputAcceptance/3:- renameAcceptance/1:-
                settleParkedRename/3::REQUIRED:DEFAULT:false settleTaskCancel/7::REQUIRED:DEFAULT:false readBinding/1:- requireSession/2:-
                retryContextCompressionPreparation/3::REQUIRED:DEFAULT:false sessionsWithExecutionRegistryFacts/2:-
                findLastVisibleStatusBeforeDelete/2:- insertPublicChildSessionCommand/9::REQUIRED:DEFAULT:false
                insertInternalTeamLeadSessionCommand/6::REQUIRED:DEFAULT:false requireContextCompressionCommit/3:-
                markContextCompressionSubmitted/2::REQUIRED:DEFAULT:false findModelContexts/2:- findSessionById/1:- findActiveTurns/2:-
                findLatestTurns/2:- findModelSelections/2:- findTurnModelSelection/3:- findApprovalSelections/2:- findApprovalOwners/3:-
                findLatestLifecycleOperations/2:- findTurnApprovalSelection/3:- listSessions/5:- listSessions/6:- listSessions/7:- modelOptions/0:-
                findCommand/3:- replayCommand/4:- findSession/2:- findTurn/3:- listOwnedSessions/7:- listSessions/7:-
                insertTurnCommand/8::REQUIRED:DEFAULT:false insertCancelCommand/7::REQUIRED:DEFAULT:false beginSessionRename/7::REQUIRED:DEFAULT:false
                beginSessionMutation/8::REQUIRED:DEFAULT:false insertSessionCommand/12::REQUIRED:DEFAULT:false
                insertSessionCommand/10::REQUIRED:DEFAULT:false insertSessionCommand/11::REQUIRED:DEFAULT:false requireSessionOwnership/3:-
                requireSessionAuthority/3:- requireSessionReadAuthority/3:- requireSessionReadAuthority/3:- ownsSession/3:-
                """);
        assertEntries(JdbcManagedSessionStore.class, """
                lockBounded/1:- requireCsiHistoricalCredential/5:- hasPristineInitialJournal/3::NOT_SUPPORTED:DEFAULT:true
                publishAgentInstructions/4::REQUIRED:DEFAULT:false validateCsiTerminalBytes/1:- commandKeyHash/2:-
                transactions/6::REQUIRED:DEFAULT:true journalCorrupt/0:- usesDataSource/1:- skipContended/2:- restore/4::REQUIRED:DEFAULT:true
                readResource/5:- acquireWriter/5::NOT_SUPPORTED:DEFAULT:false acquireWriter/4::NOT_SUPPORTED:DEFAULT:false
                renewWriter/5::REQUIRED:DEFAULT:false renewWriter/4::REQUIRED:DEFAULT:false sealWriter/4::REQUIRED:DEFAULT:false
                sealWriter/5::REQUIRED:DEFAULT:false blockRecovery/4::REQUIRED:DEFAULT:false hasLiveWriter/2::REQUIRED:DEFAULT:false
                toolResultLimit/1:- lockBoundedResult/1:- namedRootDeadlock/1:- lockCsiOriginal/2:- recentTransactions/7::REQUIRED:READ_COMMITTED:true
                commandTransaction/7::REQUIRED:READ_COMMITTED:true authorizeOrdinary/4::REQUIRED:DEFAULT:false
                authorizeLifecycle/5::REQUIRED:DEFAULT:false approvalSelection/4::REQUIRED:DEFAULT:false readSnapshotResource/5:-
                readOwnerResource/5:- publishAgentSkills/4::REQUIRED:DEFAULT:false publishToolResult/5::REQUIRED:DEFAULT:false
                publishToolResult/4::REQUIRED:DEFAULT:false lockPublicationWriter/6:- lockPublicationWriter/8:- lockSnapshotWriter/4:-
                quiesceOwnership/4::REQUIRED:DEFAULT:false releaseOwnership/4::REQUIRED:DEFAULT:false preflightCsiTerminal/5:- commitCsiTerminal/5:-
                requireCsiApplicationCredential/3:- publishInheritedExtensionResource/4::REQUIRED:DEFAULT:false commit/4::REQUIRED:DEFAULT:false
                commit/5::REQUIRED:DEFAULT:false
                """);
    }

    private static void assertEntries(Class<?> facade, String expected) {
        assertThat(facade.getAnnotation(Qualifier.class).value()).isEqualTo("managedAgentTransactionManager");
        // The facade may inherit an entry arm from a package-private
        // superclass; the population pin covers the whole hierarchy, so a
        // move between facade and superclass keeps the same contract.
        List<String> actual = new java.util.ArrayList<>();
        for (Class<?> type = facade; type != null && type != Object.class; type = type.getSuperclass()) {
            Arrays.stream(type.getDeclaredMethods())
                    .filter(method -> !Modifier.isPrivate(method.getModifiers()) && !method.isSynthetic())
                    .map(method -> {
                        var tx = method.getAnnotation(Transactional.class);
                        String attributes = tx == null ? "-" : tx.transactionManager() + ":" + tx.propagation()
                                + ":" + tx.isolation() + ":" + tx.readOnly();
                        return method.getName() + "/" + method.getParameterCount() + ":" + attributes;
                    }).forEach(actual::add);
        }
        assertThat(actual).containsExactlyInAnyOrderElementsOf(List.of(expected.trim().split("\\s+")));
    }

    @Test
    void principalEntriesLiveInTheFacadeSuperclass() {
        // Issue #16605: the read arm pure-moved into ManagedAgentReadEntries
        // to make ratchet headroom for the facade's principal mutation
        // overrides, so the chain is now facade -> read arm -> principal
        // arm. Both arms keep the same package-private, non-Spring,
        // immutable-field shape.
        Class<?> readArm = ManagedAgentStore.class.getSuperclass();
        assertThat(readArm).isEqualTo(ManagedAgentReadEntries.class);
        Class<?> superclass = readArm.getSuperclass();
        assertThat(superclass).isEqualTo(ManagedAgentPrincipalEntries.class);
        for (Class<?> arm : List.of(readArm, superclass)) {
            assertThat(Modifier.isPublic(arm.getModifiers())).isFalse();
            assertThat(Modifier.isFinal(arm.getModifiers())).isFalse();
            assertNoSpringComponent(arm);
            for (var field : arm.getDeclaredFields()) {
                assertThat(Modifier.isFinal(field.getModifiers())).as(field.toString()).isTrue();
                assertThat(field.getType()).isIn(AgentSessionAdmissions.class, AgentSessionCommands.class,
                        AgentSessionQueries.class);
            }
        }
        assertThat(entryPopulation(readArm)).containsExactlyInAnyOrderElementsOf(List.of(
                "replayCommand/4:-", "findCommand/3:-", "findSession/2:-", "findSessionById/1:-",
                "listSessions/5:-", "listSessions/6:-", "listSessions/7:-",
                "findLatestLifecycleOperations/2:-", "findTurn/3:-", "findActiveTurns/2:-",
                "findLatestTurns/2:-", "findModelContexts/2:-", "modelOptions/0:-",
                "findModelSelections/2:-", "findTurnModelSelection/3:-",
                "findApprovalSelections/2:-", "findApprovalOwners/3:-", "findTurnApprovalSelection/3:-"));
        assertThat(entryPopulation(superclass)).containsExactlyInAnyOrderElementsOf(List.of(
                "insertSessionCommand/10::REQUIRED:DEFAULT:false",
                "insertSessionCommand/11::REQUIRED:DEFAULT:false",
                "insertSessionCommand/12::REQUIRED:DEFAULT:false",
                "requireSessionOwnership/3:-",
                "requireSessionAuthority/3:-",
                "requireSessionReadAuthority/3:-",
                "requireSessionReadAuthority/3:-",
                "ownsSession/3:-",
                "insertTurnCommand/8::REQUIRED:DEFAULT:false",
                "insertCancelCommand/7::REQUIRED:DEFAULT:false",
                "beginSessionRename/7::REQUIRED:DEFAULT:false",
                "beginSessionMutation/8::REQUIRED:DEFAULT:false",
                "listSessions/7:-",
                "listOwnedSessions/7:-"));
    }

    private static List<String> entryPopulation(Class<?> type) {
        return Arrays.stream(type.getDeclaredMethods())
                .filter(method -> !Modifier.isPrivate(method.getModifiers()) && !method.isSynthetic())
                .map(method -> {
                    var tx = method.getAnnotation(Transactional.class);
                    String attributes = tx == null ? "-" : tx.transactionManager() + ":" + tx.propagation()
                            + ":" + tx.isolation() + ":" + tx.readOnly();
                    return method.getName() + "/" + method.getParameterCount() + ":" + attributes;
                }).toList();
    }

    @Test
    void facadeSourcesContainNoBusinessSql() throws Exception {
        Path sources = Path.of("..", "persistence", "src", "main", "java")
                .resolve(ManagedAgentStore.class.getPackageName().replace('.', '/'));
        for (String name : List.of("ManagedAgentStore", "ManagedAgentPrincipalEntries", "ManagedAgentReadEntries",
                "ManagedStoreAssembly", "JdbcManagedSessionStore")) {
            assertNoBusinessSql(Files.readString(sources.resolve(name + ".java")));
        }
    }

    @Test
    void sqlGuardRejectsLowerAndMixedCaseStatements() {
        for (String sql : List.of("select * from ma_session", "iNsErT iNtO ma_session values (?)",
                "Update ma_session set title = ?", "delete from ma_session")) {
            assertThatThrownBy(() -> assertNoBusinessSql(sql)).isInstanceOf(AssertionError.class);
        }
    }

    private static void assertNoBusinessSql(String source) {
        assertThat(source.toUpperCase(Locale.ROOT))
                .doesNotContain("SELECT ", "INSERT INTO ", "UPDATE MA_", "DELETE FROM ");
    }
}
