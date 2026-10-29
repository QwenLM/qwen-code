package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.AbstractDataSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

class WorkspaceCsiApplicationHistoryTest {
    @Test
    void rejectsRepositoriesFromAnotherDataSource() {
        var first = new JdbcDataSource();
        var second = new JdbcDataSource();
        var jdbc = new JdbcTemplate(first);
        var manager = mock(PlatformTransactionManager.class);
        var bindings = new JdbcRuntimeBindingRepository(first, new AesGcmSecretProtector("test", new byte[32]));
        assertThatThrownBy(() -> new WorkspaceCsiApplicationHistory(jdbc, manager, bindings,
                new ManagedSessionStore(new JdbcTemplate(second)), new ObjectMapper())).isInstanceOf(IllegalArgumentException.class);
        var foreign = new JdbcRuntimeBindingRepository(second, new AesGcmSecretProtector("test", new byte[32]));
        assertThatThrownBy(() -> new WorkspaceCsiApplicationHistory(jdbc, manager, foreign,
                new ManagedSessionStore(jdbc), new ObjectMapper())).isInstanceOf(IllegalArgumentException.class);
        verifyNoInteractions(manager);
    }

    @Test
    void refusesAmbientTransactionsBeforeObtainingAnotherConnection() {
        var source = new JdbcDataSource();
        var jdbc = new JdbcTemplate(source);
        var manager = mock(PlatformTransactionManager.class);
        var reader = new WorkspaceCsiApplicationHistory(jdbc, manager,
                new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32])),
                new ManagedSessionStore(jdbc), new ObjectMapper());
        boolean previous = TransactionSynchronizationManager.isActualTransactionActive();
        TransactionSynchronizationManager.setActualTransactionActive(true);
        try {
            assertThatThrownBy(() -> read(reader))
                    .isInstanceOf(IllegalArgumentException.class);
            verifyNoInteractions(manager);
        } finally {
            TransactionSynchronizationManager.setActualTransactionActive(previous);
        }
    }

    @Test
    void requestsFreshReadOnlyRepeatableReadAndRefusesADriverIgnoringReadOnly() {
        var h2 = new JdbcDataSource();
        h2.setURL("jdbc:h2:mem:history-fresh-" + UUID.randomUUID());
        var opens = new AtomicInteger();
        var closes = new AtomicInteger();
        var readOnly = new AtomicInteger();
        var repeatableRead = new AtomicInteger();
        var queries = new AtomicInteger();
        var source = new AbstractDataSource() {
            @Override
            public Connection getConnection() throws java.sql.SQLException {
                opens.incrementAndGet();
                var delegate = h2.getConnection();
                return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {Connection.class},
                        (proxy, method, arguments) -> {
                            if (method.getName().equals("setReadOnly") && Boolean.TRUE.equals(arguments[0])) {
                                readOnly.incrementAndGet();
                            }
                            if (method.getName().equals("setTransactionIsolation")
                                    && Integer.valueOf(Connection.TRANSACTION_REPEATABLE_READ).equals(arguments[0])) {
                                repeatableRead.incrementAndGet();
                            }
                            if (method.getName().equals("prepareStatement")) {
                                queries.incrementAndGet();
                            }
                            if (method.getName().equals("close")) {
                                closes.incrementAndGet();
                            }
                            try {
                                return method.invoke(delegate, arguments);
                            } catch (InvocationTargetException failure) {
                                throw failure.getCause();
                            }
                        });
            }

            @Override
            public Connection getConnection(String username, String password) throws java.sql.SQLException {
                return getConnection();
            }
        };
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var reader = new WorkspaceCsiApplicationHistory(jdbc, manager,
                new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32])),
                new ManagedSessionStore(jdbc), new ObjectMapper());
        // H2 ignores setReadOnly; the production guard must reject that actual Connection before SQL.
        assertThatThrownBy(() -> read(reader))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(opens.get()).isEqualTo(1);
        assertThat(closes.get()).isEqualTo(1);
        assertThat(readOnly.get()).isEqualTo(1);
        assertThat(repeatableRead.get()).isEqualTo(1);
        assertThat(queries.get()).isZero();
        assertThat(TransactionSynchronizationManager.hasResource(source)).isFalse();
        assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
    }

    private static Object read(WorkspaceCsiApplicationHistory reader) {
        return reader.readApplication("tenant", "workspace", "session", UUID.randomUUID().toString(), "token");
    }
}
