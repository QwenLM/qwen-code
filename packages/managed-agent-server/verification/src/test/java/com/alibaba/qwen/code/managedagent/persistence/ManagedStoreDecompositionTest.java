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
            AgentLifecycleOperations.class,
            AgentSessionAdmissions.class,
            AgentTurnExecution.class,
            AgentExecutionOperations.class,
            JournalStoreRows.class,
            JournalFencing.class,
            JournalHistoryQueries.class,
            JournalLifecycleAuthorization.class,
            JournalResourceReads.class,
            JournalResourceWrites.class,
            JournalWriterLifecycle.class,
            JournalCommit.class);

    @Test
    void collaboratorsAreImmutableOrdinaryObjectsWithAcyclicDependencies() {
        for (Class<?> component : COMPONENTS) {
            assertThat(Modifier.isFinal(component.getModifiers())).as(component.getSimpleName()).isTrue();
            assertThat(Modifier.isPublic(component.getModifiers())).isFalse();
            assertThat(component.getInterfaces()).isEmpty();
            assertNoSpringComponent(component);
            for (var field : component.getDeclaredFields()) {
                assertThat(Modifier.isFinal(field.getModifiers())).as(field.toString()).isTrue();
                assertThat(field.getType()).isNotIn(ManagedAgentStore.class, ManagedSessionStore.class);
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
        assertEntries(ManagedAgentStore.class, """
                findSessionWorktree/2:- findSessionWorktrees/2:- insertSessionCommand/10::REQUIRED:DEFAULT:false
                insertSessionCommand/11::REQUIRED:DEFAULT:false
                insertWorkspaceSessionCommand/1::REQUIRED:DEFAULT:false insertInternalTeamLeadSessionCommand/6::REQUIRED:DEFAULT:false findWorkspaceCreateReplay/4:-
                replayWorkspaceSessionCommand/4::REQUIRED:DEFAULT:false insertCsiSessionCommand/7:- requireCsiRequest/2:-
                insertChildSessionCommand/8::REQUIRED:DEFAULT:false insertChildSessionCommand/9::REQUIRED:DEFAULT:false findChildWorkspaceCwd/3:-
                insertPublicChildSessionCommand/9::REQUIRED:DEFAULT:false replayChildSessionCommand/4::REQUIRED:DEFAULT:false findChildLineage/2:-
                workspaceSessionOptions/2::REQUIRED:DEFAULT:false supportsPlanMode/1:- hasMcpServers/1:-
                requireMcpManagement/4::REQUIRED:DEFAULT:false requireMcpSettingsCommit/3::MANDATORY:DEFAULT:false requireExtensionManagement/5::REQUIRED:DEFAULT:false
                requireConfigurationCommit/4::MANDATORY:DEFAULT:false insertTurnCommand/7::REQUIRED:DEFAULT:false insertTurnCommand/8::REQUIRED:DEFAULT:false
                insertCancelCommand/6::REQUIRED:DEFAULT:false insertCancelCommand/7::REQUIRED:DEFAULT:false beginSessionRename/5::REQUIRED:DEFAULT:false
                beginSessionRename/6::REQUIRED:DEFAULT:false completeSessionRename/6::REQUIRED:DEFAULT:false completeSessionRename/3::REQUIRED:DEFAULT:false
                abandonSessionRename/5::REQUIRED:DEFAULT:false deliverableRenames/1::REQUIRED:DEFAULT:false claimRename/3::REQUIRED:DEFAULT:false
                markRenameSubmitted/2:- retryRename/3::REQUIRED:DEFAULT:false beginSessionMutation/6::REQUIRED:DEFAULT:false
                beginSessionMutation/7::REQUIRED:DEFAULT:false completeSessionMutation/7::REQUIRED:DEFAULT:false abandonSessionMutation/4::REQUIRED:DEFAULT:false
                beginOperation/6::REQUIRED:DEFAULT:false workspaceFilesEnabled/0:- workspaceShellEnabled/0:-
                beginWorkspaceClose/7::REQUIRED:DEFAULT:false beginWorkspaceLifecycle/8::REQUIRED:DEFAULT:false beginWorkspaceLifecycle/9::REQUIRED:DEFAULT:false
                hasCompletedWorkspaceClose/2:- completedWorkspaceCloses/2:- unarchiveWorkspaceSession/5::REQUIRED:DEFAULT:false
                beginChildClose/8::REQUIRED:DEFAULT:false beginContextCompression/8::REQUIRED:DEFAULT:false contextCompressionState/2:-
                contextCompressionStates/2:- contextCompressionRequest/3:- findContextCompressions/1:-
                claimContextCompression/5::REQUIRED:DEFAULT:false requireContextCompressionCommit/3:- markContextCompressionSubmitted/2::REQUIRED:DEFAULT:false
                settleContextCompression/5::REQUIRED:DEFAULT:false retryContextCompressionPreparation/3::REQUIRED:DEFAULT:false awaitContextCompression/5::REQUIRED:DEFAULT:false
                completeCwdChangeOperation/5::REQUIRED:DEFAULT:false failCwdChangeOperation/6::REQUIRED:DEFAULT:false beginTaskCancelOperation/6::REQUIRED:DEFAULT:false
                findDeliverableTaskCancels/1:- findParkedOperations/1:- settleParkedOperation/3::REQUIRED:DEFAULT:false
                turnInputAcceptance/3:- renameAcceptance/1:- settleParkedRename/3::REQUIRED:DEFAULT:false
                settleTaskCancel/7::REQUIRED:DEFAULT:false hasExecutionRegistryFacts/2:- sessionsWithExecutionRegistryFacts/2:-
                findOperation/3:- findDeliverableOperations/2:- claimOperation/5::REQUIRED:DEFAULT:false
                completeOperation/6::REQUIRED:DEFAULT:false failOperation/6::REQUIRED:DEFAULT:false renewLifecycleOperation/6::REQUIRED:DEFAULT:false
                blockLifecycleOperation/7::REQUIRED:DEFAULT:false blockLifecycleOperation/8::REQUIRED:DEFAULT:false retryOperation/6::REQUIRED:DEFAULT:false
                retryOperation/7::REQUIRED:DEFAULT:false markOperationAnswered/5::REQUIRED:DEFAULT:false replayCommand/4:-
                findCommand/3:- findSession/2:- findSessionById/1:-
                listSessions/5:- listSessions/6:- listSessions/7:-
                findLatestLifecycleOperations/2:- findTurn/3:- findActiveTurns/2:-
                findLatestTurns/2:- findModelContexts/2:- modelOptions/0:-
                findModelSelections/2:- findTurnModelSelection/3:- changeSessionModel/8::REQUIRED:DEFAULT:false
                findApprovalSelections/2:- findApprovalOwners/3:- findTurnApprovalSelection/3:-
                changeSessionApproval/9::REQUIRED:DEFAULT:false changeSessionApproval/11::REQUIRED:DEFAULT:false changeSessionApproval/12::REQUIRED:DEFAULT:false
                changeSessionApproval/15::REQUIRED:DEFAULT:false listTurns/5:- findTurnSummary/3:-
                findEvents/4:- findLatestEnvironmentEvents/2:- findControlEvents/3:-
                findTranscriptEvents/4:- findMessagePage/5:managedAgentTransactionManager:REQUIRED:REPEATABLE_READ:true findMessagePage/6:managedAgentTransactionManager:REQUIRED:REPEATABLE_READ:true
                findMessageCoveredSequences/2:- findReplayWindow/2:- findReplayFloorTargets/1:-
                advanceReplayFloor/3::REQUIRED:DEFAULT:false findMaterializationTargets/1:- materializeNextBatch/3::REQUIRED:DEFAULT:false
                deferMaterializationTarget/2::REQUIRED:DEFAULT:false findDispatchable/2:- findRuntimeRecoveryParked/2:-
                claimTurn/5::REQUIRED:DEFAULT:false renewTurn/5::REQUIRED:DEFAULT:false releaseTurnLease/4::REQUIRED:DEFAULT:false
                markTurnRecoveryBlocked/6::REQUIRED:DEFAULT:false markTurnFailureRecovery/5::REQUIRED:DEFAULT:false requestRecoveryRecheck/3::REQUIRED:DEFAULT:false
                parkTurnForRuntimeRecovery/6::REQUIRED:DEFAULT:false deferTurnRetry/5::REQUIRED:DEFAULT:false scheduleTurnRetry/6::REQUIRED:DEFAULT:false
                bindHarness/5::REQUIRED:DEFAULT:false bindRecoveredHarness/6::REQUIRED:DEFAULT:false markSubmissionAttempted/4::REQUIRED:DEFAULT:false
                withdrawSubmissionAttempted/4::REQUIRED:DEFAULT:false recordAdmission/6::REQUIRED:DEFAULT:false recordRecoveryAdmission/8::REQUIRED:DEFAULT:false
                retractContinuationOutput/6::REQUIRED:DEFAULT:false retractHarnessTurnOutput/7::REQUIRED:DEFAULT:false retractHarnessTurnOutput/10::REQUIRED:DEFAULT:false
                recordHarnessEvents/6::REQUIRED:DEFAULT:false cancelUnadmittedTurn/4::REQUIRED:DEFAULT:false cancelBeforeAdmission/4::REQUIRED:DEFAULT:false
                failTurn/6::REQUIRED:DEFAULT:false failWorktreeInitialTurns/3::REQUIRED:DEFAULT:false failRecoveryBlockedTurn/5::REQUIRED:DEFAULT:false
                appendPublicEventIfAbsent/7::REQUIRED:DEFAULT:false appendLiveSessionEventIfAbsent/5::REQUIRED:DEFAULT:false findLastVisibleStatusBeforeDelete/2:-
                requireSession/2:- readBinding/1:- insertSessionCommand/9::REQUIRED:DEFAULT:false
                """);
        assertEntries(ManagedSessionStore.class, """
                authorizeLifecycle/5::REQUIRED:DEFAULT:false skipContended/2:- lockBounded/1:-
                lockBoundedResult/1:- namedRootDeadlock/1:- authorizeOrdinary/4::REQUIRED:DEFAULT:false
                approvalSelection/4::REQUIRED:DEFAULT:false usesDataSource/1:- lockSnapshotWriter/4:-
                lockPublicationWriter/6:- acquireWriter/4::REQUIRED:DEFAULT:false acquireWriter/5::REQUIRED:DEFAULT:false
                renewWriter/4::REQUIRED:DEFAULT:false renewWriter/5::REQUIRED:DEFAULT:false sealWriter/4::REQUIRED:DEFAULT:false
                sealWriter/5::REQUIRED:DEFAULT:false quiesceOwnership/4::REQUIRED:DEFAULT:false releaseOwnership/4::REQUIRED:DEFAULT:false
                blockRecovery/4::REQUIRED:DEFAULT:false commit/4::REQUIRED:DEFAULT:false commit/5::REQUIRED:DEFAULT:false
                restore/4::REQUIRED:DEFAULT:true transactions/6::REQUIRED:DEFAULT:true recentTransactions/7::REQUIRED:READ_COMMITTED:true
                commandTransaction/7::REQUIRED:READ_COMMITTED:true hasPristineInitialJournal/3::NOT_SUPPORTED:DEFAULT:true readResource/5:-
                readSnapshotResource/5:- readOwnerResource/5:- publishAgentInstructions/4::REQUIRED:DEFAULT:false
                publishAgentSkills/4::REQUIRED:DEFAULT:false publishInheritedExtensionResource/4::REQUIRED:DEFAULT:false publishToolResult/4::REQUIRED:DEFAULT:false
                publishToolResult/5::REQUIRED:DEFAULT:false toolResultLimit/1:- requireCsiApplicationCredential/3:-
                requireCsiHistoricalCredential/5:- preflightCsiTerminal/5:- commitCsiTerminal/5:-
                validateCsiTerminalBytes/1:- lockCsiOriginal/2:- hasLiveWriter/2::REQUIRED:DEFAULT:false
                commandKeyHash/2:- journalCorrupt/0:-
                """);
    }

    private static void assertEntries(Class<?> facade, String expected) {
        assertThat(facade.getAnnotation(Qualifier.class).value()).isEqualTo("managedAgentTransactionManager");
        List<String> actual = Arrays.stream(facade.getDeclaredMethods())
                .filter(method -> !Modifier.isPrivate(method.getModifiers()) && !method.isSynthetic())
                .map(method -> {
                    var tx = method.getAnnotation(Transactional.class);
                    String attributes = tx == null ? "-" : tx.transactionManager() + ":" + tx.propagation()
                            + ":" + tx.isolation() + ":" + tx.readOnly();
                    return method.getName() + "/" + method.getParameterCount() + ":" + attributes;
                }).toList();
        assertThat(actual).containsExactlyInAnyOrderElementsOf(List.of(expected.trim().split("\\s+")));
    }

    @Test
    void facadeSourcesContainNoBusinessSql() throws Exception {
        Path sources = Path.of("..", "persistence", "src", "main", "java")
                .resolve(ManagedAgentStore.class.getPackageName().replace('.', '/'));
        for (Class<?> facade : List.of(ManagedAgentStore.class, ManagedSessionStore.class)) {
            assertNoBusinessSql(Files.readString(sources.resolve(facade.getSimpleName() + ".java")));
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
