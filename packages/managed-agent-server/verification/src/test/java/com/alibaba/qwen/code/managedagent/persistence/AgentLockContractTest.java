package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;

import javax.sql.DataSource;

import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AgentLockContractTest extends RecoverySettlementStoreTest {
    protected StoreLockTrace trace;
    private AgentStateStore proxy;

    @Override
    protected DataSource dataSource() {
        trace = new StoreLockTrace(super.dataSource());
        return trace;
    }

    @BeforeEach
    void proxy() {
        proxy = transactional(store, trace);
        trace.clear();
    }

    static <T> T transactional(T target, DataSource source) {
        var beans = new DefaultListableBeanFactory();
        beans.registerSingleton("managedAgentTransactionManager", new DataSourceTransactionManager(source));
        var interceptor = new TransactionInterceptor();
        interceptor.setBeanFactory(beans);
        interceptor.setTransactionAttributeSource(new AnnotationTransactionAttributeSource());
        interceptor.setTransactionManagerBeanName("managedAgentTransactionManager");
        interceptor.afterPropertiesSet();
        var factory = new ProxyFactory(target);
        factory.setProxyTargetClass(true);
        factory.addAdvice(interceptor);
        @SuppressWarnings("unchecked")
        T result = (T) factory.getProxy();
        return result;
    }

    @ParameterizedTest
    @ValueSource(strings = {"failure", "bind", "rebind", "recovery", "continuation", "retract", "events"})
    void pairedEntriesKeepTheirExecutedOrder(String route) {
        invoke(route, OWNER);
        trace.assertSessionBeforeTurn(TENANT, sessionId);
        trace.assertOneTransaction(TENANT, sessionId);
        // Same exclusion as StoreLockTrace.root(): pin-index probes are not
        // root locks; the legacy guard's primary-key current read is one.
        var locks = trace.successful(TENANT, sessionId).stream()
                .filter(event -> event.sql().contains("for update") && !event.sql().contains("is_csi_guard = true"))
                .map(event -> event.root() ? "root" : event.turn() ? "turn" : "stream").toList();
        assertThat(locks.subList(0, 3)).containsExactly("root", "stream", "turn");
        assertThat(trace.events()).anyMatch(event -> event.phase() == StoreLockTrace.Phase.COMMIT);
    }

    @ParameterizedTest
    @ValueSource(strings = {"failure", "bind", "rebind", "recovery", "continuation", "retract", "events"})
    void refusalsStillAcquireThePair(String route) {
        try {
            invoke(route, "wrong-owner");
        } catch (IllegalStateException refused) {
            assertThat(refused).hasMessageContaining("lease was lost");
        }
        trace.assertSessionBeforeTurn(TENANT, sessionId);
        trace.assertOneTransaction(TENANT, sessionId);
    }

    private void invoke(String route, String owner) {
        switch (route) {
            case "failure" -> proxy.markTurnFailureRecovery(TENANT, sessionId, turnId, owner, "failure");
            case "bind" -> proxy.bindHarness(TENANT, sessionId, turnId, owner, "boot");
            case "rebind" -> proxy.bindRecoveredHarness(TENANT, sessionId, turnId, owner, null, "boot");
            case "recovery" -> proxy.recordRecoveryAdmission(TENANT, sessionId, turnId, owner,
                    "epoch-original", "epoch-original", "recovered", 2);
            case "continuation" -> proxy.retractContinuationOutput(TENANT, sessionId, turnId, owner, "boot", "epoch-original");
            case "retract" -> proxy.retractHarnessTurnOutput(TENANT, sessionId, turnId, owner, "epoch-original", 1, 2);
            case "events" -> proxy.recordHarnessEvents(TENANT, sessionId, turnId, owner, "epoch-original",
                    List.of(terminal("turn.completed", "COMPLETED")));
            default -> throw new IllegalArgumentException(route);
        }
    }

    @Test
    void emptyBatchNeverReachesThePairAndCsiRefusesBeforeIt() {
        proxy.recordHarnessEvents(TENANT, sessionId, "missing", OWNER, "epoch-original", List.of());
        assertThat(trace.successful(TENANT, sessionId)).noneMatch(event -> event.turn() || event.root());
        jdbc.update("UPDATE ma_session SET tool_profile = 'csi-files-retirement/1' WHERE tenant_id = ? AND session_id = ?", TENANT, sessionId);
        trace.clear();
        assertThatThrownBy(() -> proxy.recordHarnessEvents(TENANT, sessionId, turnId, OWNER, "epoch-original", List.of()))
                .isInstanceOf(RuntimeException.class);
        assertThat(trace.successful(TENANT, sessionId)).noneMatch(StoreLockTrace.Event::turn);
    }

    @ParameterizedTest
    @ValueSource(strings = {"claim", "renew", "release", "retry", "submission"})
    void singleRowCasDoesNotAcquirePublicSessionOrStream(String route) {
        jdbc.update("UPDATE ma_turn SET harness_event_epoch = NULL WHERE tenant_id = ? AND session_id = ? AND turn_id = ?", TENANT, sessionId, turnId);
        trace.clear();
        switch (route) {
            case "claim" -> proxy.claimTurn(TENANT, sessionId, turnId, OWNER, Duration.ofMinutes(1));
            case "renew" -> proxy.renewTurn(TENANT, sessionId, turnId, OWNER, Duration.ofMinutes(1));
            case "release" -> proxy.releaseTurnLease(TENANT, sessionId, turnId, OWNER);
            case "retry" -> proxy.scheduleTurnRetry(TENANT, sessionId, turnId, OWNER, 0, false);
            case "submission" -> proxy.markSubmissionAttempted(TENANT, sessionId, turnId, OWNER);
            default -> throw new IllegalArgumentException(route);
        }
        assertThat(trace.successful(TENANT, sessionId)).noneMatch(StoreLockTrace.Event::root)
                .noneMatch(event -> event.sql().contains("ma_event_stream"));
        assertThat(trace.successful(TENANT, sessionId).stream().filter(event -> event.sql().startsWith("update ma_turn ")))
                .hasSize(1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"cancel", "fail", "recovery-blocked"})
    void terminalCasRejectionsKeepOneSnapshotReadAndNoUpdate(String route) {
        switch (route) {
            case "cancel" -> proxy.cancelBeforeAdmission(TENANT, sessionId, turnId, "wrong-owner");
            case "fail" -> proxy.failTurn(TENANT, sessionId, turnId, "wrong-owner", "failure", "failure");
            case "recovery-blocked" -> assertThat(proxy.failRecoveryBlockedTurn(TENANT, sessionId, turnId, "wrong-owner", "failure")).isFalse();
            default -> throw new IllegalArgumentException(route);
        }
        trace.assertSessionBeforeTurn(TENANT, sessionId);
        assertThat(trace.successful(TENANT, sessionId).stream().filter(StoreLockTrace.Event::turn)).hasSize(1)
                .allMatch(event -> event.sql().startsWith("select ") && !event.sql().contains("for update"));
    }

    @Test
    void missingRowsAndStreamKeepTheirFailurePriority() {
        assertThatThrownBy(() -> proxy.bindHarness(TENANT, "missing", "missing", OWNER, "boot"))
                .isInstanceOfSatisfying(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
        assertThatThrownBy(() -> proxy.bindHarness(TENANT, sessionId, "missing", OWNER, "boot"))
                .isInstanceOfSatisfying(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("turn_not_found"));
        jdbc.update("DELETE FROM ma_public_event WHERE tenant_id = ? AND session_id = ?", TENANT, sessionId);
        jdbc.update("DELETE FROM ma_event_stream WHERE tenant_id = ? AND session_id = ?", TENANT, sessionId);
        trace.clear();
        assertThatThrownBy(() -> proxy.bindHarness(TENANT, sessionId, "missing", OWNER, "boot"))
                .isInstanceOf(IllegalStateException.class).hasMessage("Session stream is unavailable.");
        assertThat(trace.successful(TENANT, sessionId)).noneMatch(StoreLockTrace.Event::turn);
        jdbc.update("UPDATE ma_session SET tool_profile = 'csi-files-retirement/1' WHERE tenant_id = ? AND session_id = ?", TENANT, sessionId);
        assertThatThrownBy(() -> proxy.bindHarness(TENANT, sessionId, "missing", OWNER, "boot"))
                .isInstanceOfSatisfying(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("csi_managed_mutation_unavailable"));
    }

    @Test
    void externalRollbackAndInterfaceDefaultCreationUseTheSameConnection() {
        transactions.executeWithoutResult(status -> {
            proxy.insertSessionCommand(TENANT, "CREATE_SESSION", "second", "second", "qwen-code", "1", null, List.of(), null);
            proxy.bindHarness(TENANT, sessionId, turnId, OWNER, "rolled-back");
            status.setRollbackOnly();
        });
        trace.assertSessionBeforeTurn(TENANT, sessionId);
        trace.assertOneTransaction(TENANT, sessionId);
        assertThat(trace.events()).anyMatch(event -> event.phase() == StoreLockTrace.Phase.ROLLBACK);
        assertThat(store.findSession(TENANT, sessionId).orElseThrow().harnessBootId()).isNull();
    }
}
