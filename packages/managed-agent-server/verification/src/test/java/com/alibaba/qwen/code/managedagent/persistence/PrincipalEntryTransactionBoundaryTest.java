package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;

import javax.sql.DataSource;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.time.Clock;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Permanent witness for the transaction boundary of the principal-carrying
 * mutation entries (issue #16605). The #16603 decomposition moved the six
 * annotated principal entries into a superclass; because the contract
 * interfaces declare same-signature default methods, javac emitted
 * annotation-less ACC_BRIDGE delegates on the facade and Spring's
 * AnnotationTransactionAttributeSource resolved NO transaction attribute
 * through the interface path — every authenticated mutation silently lost
 * its transaction (ownership row, Session, receipt and creation event were
 * no longer atomic). H2 store tests masked it by wrapping calls in an
 * explicit TransactionTemplate.
 *
 * <p>This witness deliberately uses the REAL production resolution path —
 * interface {@link Method} objects against the concrete facade class, and a
 * real {@link TransactionInterceptor} over a real store — with no Mockito
 * and no outer TransactionTemplate. A recording DataSource observes the
 * {@code setAutoCommit(false)} that DataSourceTransactionManager issues at
 * transaction begin; without a boundary no such call ever happens. Both
 * parts must stay green forever: any future move of an annotated entry
 * into a superclass turns them red.
 */
class PrincipalEntryTransactionBoundaryTest {
    private static final Set<String> BOUNDARY_ENTRIES = Set.of(
            "insertSessionCommand", "insertWorkspaceSessionCommand",
            "insertTurnCommand", "insertCancelCommand",
            "beginSessionRename", "beginSessionMutation",
            "insertChildSessionCommand", "insertPublicChildSessionCommand",
            "replayChildSessionCommand", "replayWorkspaceSessionCommand");

    private RecordingDataSource recording;
    private AgentStateStore proxy;

    @BeforeEach
    void setup() {
        var raw = new JdbcDataSource();
        raw.setURL("jdbc:h2:mem:tx-boundary-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(raw);
        recording = new RecordingDataSource(raw);
        DataSource recorded = recording.proxy();
        var jdbc = new ManagedSchemaJdbcTemplate(recorded);
        var store = com.alibaba.qwen.code.managedagent.VerificationFixtures.managedAgentStore(
                jdbc, new ObjectMapper(), Clock.systemUTC(), events -> {},
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties(),
                new SdkHarnessRules());
        var interceptor = new TransactionInterceptor(
                new DataSourceTransactionManager(recorded),
                new AnnotationTransactionAttributeSource());
        var factory = new ProxyFactory(store);
        factory.setProxyTargetClass(true);
        factory.addAdvice(interceptor);
        proxy = (AgentStateStore) factory.getProxy();
    }

    @Test
    void everyBoundaryEntryResolvesATransactionAttributeThroughTheInterfacePath() {
        var source = new AnnotationTransactionAttributeSource();
        var checked = new HashSet<String>();
        int overloads = 0;
        for (Method method : AgentStateStore.class.getMethods()) {
            if (!BOUNDARY_ENTRIES.contains(method.getName())) {
                continue;
            }
            assertThat(source.getTransactionAttribute(method, ManagedAgentStore.class))
                    .as("%s argc=%d must resolve a transaction attribute through"
                            + " the interface path (an annotation-less bridge"
                            + " means the boundary was lost)",
                            method.getName(), method.getParameterCount())
                    .isNotNull();
            checked.add(method.getName());
            overloads++;
        }
        assertThat(checked).containsExactlyInAnyOrderElementsOf(BOUNDARY_ENTRIES);
        assertThat(overloads).isGreaterThanOrEqualTo(14);
    }

    @Test
    void principalAndActorMutationEntriesRunInsideAnActualTransaction() throws Exception {
        var principal = SessionPrincipal.ofUser("tenant", "actor");
        var input = List.<Map<String, Object>>of(Map.of("type", "text", "text", "hi"));

        // Creation entries commit; the witness only needs the boundary to
        // have begun. Unique keys keep the admissions independent.
        assertBoundary("insertSessionCommand",
                new Class<?>[] {String.class, SessionPrincipal.class, String.class,
                        String.class, String.class, String.class, String.class,
                        String.class, List.class, String.class},
                new Object[] {"tenant", principal, "create", key(), "digest",
                        "qwen-code", null, null, input, "payload"});
        assertBoundary("insertSessionCommand",
                new Class<?>[] {String.class, String.class, String.class,
                        String.class, String.class, String.class, String.class,
                        String.class, List.class, String.class},
                new Object[] {"tenant", "actor", "create", key(), "digest",
                        "qwen-code", null, null, input, "payload"});

        // The remaining entries refuse on the missing session inside the
        // boundary; the rollback still proves the transaction began.
        assertBoundary("insertTurnCommand",
                new Class<?>[] {String.class, String.class, String.class,
                        String.class, String.class, List.class, String.class,
                        SessionPrincipal.class},
                new Object[] {"tenant", "turn", key(), "digest",
                        "missing-session", input, "payload", principal});
        assertBoundary("insertTurnCommand",
                new Class<?>[] {String.class, String.class, String.class,
                        String.class, String.class, List.class, String.class,
                        String.class},
                new Object[] {"tenant", "turn", key(), "digest",
                        "missing-session", input, "payload", "actor"});
        assertBoundary("insertCancelCommand",
                new Class<?>[] {String.class, String.class, String.class,
                        String.class, String.class, String.class,
                        SessionPrincipal.class},
                new Object[] {"tenant", "cancel", key(), "digest",
                        "missing-session", "turn-1", principal});
        assertBoundary("insertCancelCommand",
                new Class<?>[] {String.class, String.class, String.class,
                        String.class, String.class, String.class, String.class},
                new Object[] {"tenant", "cancel", key(), "digest",
                        "missing-session", "turn-1", "actor"});
        assertBoundary("beginSessionRename",
                new Class<?>[] {String.class, String.class, String.class,
                        String.class, String.class, String.class,
                        SessionPrincipal.class},
                new Object[] {"tenant", key(), "digest", "missing-session",
                        "title", "actor", principal});
        assertBoundary("beginSessionRename",
                new Class<?>[] {String.class, String.class, String.class,
                        String.class, String.class, String.class},
                new Object[] {"tenant", key(), "digest", "missing-session",
                        "title", "actor"});
        assertBoundary("beginSessionMutation",
                new Class<?>[] {String.class, String.class, String.class,
                        String.class, String.class, SessionMutationKind.class,
                        String.class, SessionPrincipal.class},
                new Object[] {"tenant", "unarchive", key(), "digest",
                        "missing-session", SessionMutationKind.UNARCHIVE,
                        "actor", principal});
        assertBoundary("beginSessionMutation",
                new Class<?>[] {String.class, String.class, String.class,
                        String.class, String.class, SessionMutationKind.class,
                        String.class},
                new Object[] {"tenant", "unarchive", key(), "digest",
                        "missing-session", SessionMutationKind.UNARCHIVE, "actor"});
    }

    private void assertBoundary(String name, Class<?>[] types, Object[] args)
            throws Exception {
        recording.begins.set(0);
        Method entry = AgentStateStore.class.getMethod(name, types);
        try {
            entry.invoke(proxy, args);
        } catch (InvocationTargetException expected) {
            // A domain refusal inside the boundary is fine; anything else
            // means the fixture no longer exercises the real entry.
            assertThat(expected.getCause())
                    .as("%s argc=%d", name, types.length)
                    .isInstanceOf(ManagedAgentException.class);
        }
        assertThat(recording.begins.get())
                .as("%s argc=%d must begin an actual transaction"
                        + " (setAutoCommit(false) at boundary begin)",
                        name, types.length)
                .isPositive();
    }

    private static String key() {
        return "key-" + UUID.randomUUID();
    }

    /**
     * Counts the {@code setAutoCommit(false)} calls Spring's transaction
     * manager issues when it begins a transaction on a borrowed connection.
     * Plain JdbcTemplate work never disables auto-commit, so a positive
     * count is physical evidence that a transaction boundary surrounded
     * the entry call.
     */
    private static final class RecordingDataSource implements InvocationHandler {
        private final DataSource delegate;
        private final AtomicInteger begins = new AtomicInteger();

        private RecordingDataSource(DataSource delegate) {
            this.delegate = delegate;
        }

        DataSource proxy() {
            return (DataSource) Proxy.newProxyInstance(getClass().getClassLoader(),
                    new Class<?>[] {DataSource.class}, this);
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args)
                throws Throwable {
            Object result;
            try {
                result = method.invoke(delegate, args);
            } catch (InvocationTargetException unwrap) {
                throw unwrap.getCause();
            }
            if (method.getName().equals("getConnection")
                    && result instanceof Connection connection) {
                return Proxy.newProxyInstance(getClass().getClassLoader(),
                        new Class<?>[] {Connection.class},
                        (p, m, a) -> {
                            if (m.getName().equals("setAutoCommit")
                                    && a != null && a.length == 1
                                    && Boolean.FALSE.equals(a[0])) {
                                begins.incrementAndGet();
                            }
                            try {
                                return m.invoke(connection, a);
                            } catch (InvocationTargetException unwrap) {
                                throw unwrap.getCause();
                            }
                        });
            }
            return result;
        }
    }
}
