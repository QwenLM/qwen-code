package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import org.junit.jupiter.api.Test;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.http.HttpStatus;

import java.sql.SQLException;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The named mapping of a failed tenant-guard wait, without a database. The
 * default subclass translator reports a MySQL/MariaDB deadlock (1213,
 * SQLState 40001) as CannotAcquireLockException, which is what this stack
 * produces on MariaDB 10.11 and MySQL 8.4; the error-code translator reports
 * it as DeadlockLoserDataAccessException, and 1205/3572 as
 * CannotAcquireLockException. A statement timeout is QueryTimeoutException.
 */
class ManagedSessionGuardMappingTest {
    private static final SQLException DEADLOCK =
            new SQLException("Deadlock found when trying to get lock", "40001", 1213);
    private static final SQLException LOCK_WAIT_TIMEOUT =
            new SQLException("Lock wait timeout exceeded", "HY000", 1205);

    @Test
    void boundedGuardWaitsNameEveryLockFailureEitherTranslatorProduces() {
        // DeadlockLoserDataAccessException and CannotAcquireLockException
        // are sibling subclasses of PessimisticLockingFailureException, so
        // catching only one of them let a deadlock at a bounded acquisition
        // escape as a 500 under the error-code translator (#13800 R2-1).
        for (DataAccessException failure : List.of(
                new DeadlockLoserDataAccessException("injected 1213", DEADLOCK),
                new CannotAcquireLockException("injected 1213", DEADLOCK),
                new CannotAcquireLockException("injected 1205", LOCK_WAIT_TIMEOUT),
                new QueryTimeoutException("injected statement timeout"))) {
            assertThatThrownBy(() -> ManagedSessionStore.lockBounded(() -> {
                throw failure;
            }))
                    .as(failure.getClass().getSimpleName() + ": " + failure.getMessage())
                    .isInstanceOfSatisfying(ManagedAgentException.class, this::requireGuardContended);
        }
    }

    @Test
    void rootWaitsNameOnlyTheirDeadlockVictim() {
        // The root side of a pinned CSI Session's cycle (#13800 R1-1), in
        // both translators' shapes.
        for (DataAccessException failure : List.of(
                new CannotAcquireLockException("injected 1213", DEADLOCK),
                new DeadlockLoserDataAccessException("injected 1213", DEADLOCK))) {
            assertThatThrownBy(() -> ManagedSessionStore.namedRootDeadlock(() -> {
                throw failure;
            }))
                    .as(failure.getClass().getSimpleName())
                    .isInstanceOfSatisfying(ManagedAgentException.class, this::requireGuardContended);
        }
        // An ordinary root wait is not a tenant-guard wait and keeps its
        // own failure.
        var timedOut = new CannotAcquireLockException("injected 1205", LOCK_WAIT_TIMEOUT);
        assertThatThrownBy(() -> ManagedSessionStore.namedRootDeadlock(() -> {
            throw timedOut;
        })).isSameAs(timedOut);
        assertThat(ManagedSessionStore.namedRootDeadlock(() -> true)).isTrue();
    }

    private void requireGuardContended(ManagedAgentException error) {
        assertThat(error.getStatus()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(error.getCode()).isEqualTo("tenant_guard_contended");
    }
}
