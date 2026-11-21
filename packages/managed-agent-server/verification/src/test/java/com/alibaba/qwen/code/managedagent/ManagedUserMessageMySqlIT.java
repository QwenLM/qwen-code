package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.session.UserMessagePolicy;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedUserMessageStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.session.UserMessageDispatcher;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

@SpringBootTest(properties = {
        "spring.datasource.url=${mysql.url}",
        "spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
        "spring.datasource.username=${mysql.user}",
        "spring.datasource.password=${mysql.password:}",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedUserMessageMySqlIT extends ManagedUserMessageStoreTest {
    // Only the explicit sweep may retire these committed concurrency fixtures.
    @MockitoBean
    private UserMessageDispatcher dispatcher;

    @Autowired
    @Qualifier("managedJdbcTemplate")
    private JdbcTemplate mysqlJdbc;

    @Test
    void compensationRevisitsLockedRowsAfterFixedRoundDespiteInserts() throws Exception {
        String tenant = "queue-mysql-" + UUID.randomUUID();
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(mysqlJdbc.getDataSource()));
        transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        transactions.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        var ids = transactions.execute(transaction -> {
            for (int index = 0; index < 64; index++) {
                String session = index == 0 ? "busy" : index == 1 ? "stale-snapshot" : "filler-" + index;
                mysqlJdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, 'agent', ?, 0, 0)", tenant, session, "busy".equals(session) ? "CLOSED" : "ACTIVE");
                mysqlJdbc.update("INSERT INTO ma_user_message_queue (tenant_id, session_id) VALUES (?, ?)", tenant, session);
                if (index < 2) {
                    mysqlJdbc.update("INSERT INTO ma_user_message (tenant_id, session_id, message_id, sequence_number, revision, actor_id, input_json, state)"
                            + " VALUES (?, ?, ?, 1, 1, 'actor', '[]', 'queued')", tenant, session, "umsg_" + session);
                }
            }
            return mysqlJdbc.queryForList("SELECT id FROM ma_user_message_queue ORDER BY id", Long.class);
        });
        try {
            assertThat(ids).hasSize(64);
            transactions.executeWithoutResult(transaction -> assertThat(mysqlJdbc.queryForList(
                    "EXPLAIN SELECT MAX(id) FROM ma_user_message_queue")).singleElement()
                    .satisfies(row -> assertThat(row.get("extra")).isEqualTo("Select tables optimized away")));
            AtomicBoolean changedAfterSnapshot = new AtomicBoolean();
            var maxima = new ArrayList<Long>();
            var bounds = new ArrayList<List<Object>>();
            var pageSizes = new ArrayList<Integer>();
            var observed = new ManagedSchemaJdbcTemplate(mysqlJdbc.getDataSource()) {
                @Override
                public <T> T queryForObject(String sql, Class<T> type) {
                    assertThat(sql).isEqualTo("SELECT MAX(id) FROM ma_user_message_queue");
                    T value = super.queryForObject(sql, type);
                    maxima.add(((Number) value).longValue());
                    return value;
                }

                @Override
                public <T> List<T> query(String sql, RowMapper<T> mapper, Object... arguments) {
                    if (sql.startsWith("SELECT status FROM ma_session") && tenant.equals(arguments[0])
                            && "stale-snapshot".equals(arguments[1]) && changedAfterSnapshot.compareAndSet(false, true)) {
                        transactions.executeWithoutResult(transaction -> mysqlJdbc.update(
                                "UPDATE ma_session SET status = 'CLOSING' WHERE tenant_id = ? AND session_id = ?", tenant, "stale-snapshot"));
                    }
                    var rows = super.query(sql, mapper, arguments);
                    if (sql.startsWith("SELECT id, tenant_id, session_id FROM ma_user_message_queue")) {
                        assertThat(sql).contains("WHERE id > ? AND id <= ? ORDER BY id LIMIT 32");
                        bounds.add(List.of(arguments));
                        pageSizes.add(rows.size());
                    }
                    return rows;
                }
            };
            var sweep = new JdbcManagedUserMessageStore(observed, new ObjectMapper(), new RequestDigests(), mock(UserMessagePolicy.class));
            try (var holder = mysqlJdbc.getDataSource().getConnection()) {
                holder.setAutoCommit(false);
                try (var lock = holder.prepareStatement("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE")) {
                    lock.setBytes(1, ManagedSchemaKeys.identity(tenant));
                    lock.setBytes(2, ManagedSchemaKeys.identity("busy"));
                    try (var rows = lock.executeQuery()) {
                        assertThat(rows.next()).isTrue();
                    }
                    transactions.executeWithoutResult(transaction -> sweep.retireClosed());
                    assertThat(changedAfterSnapshot).isTrue();
                    transactions.executeWithoutResult(transaction -> {
                        assertThat(mysqlJdbc.queryForObject("SELECT state FROM ma_user_message WHERE tenant_id = ? AND session_id = ?",
                                String.class, tenant, "busy")).isEqualTo("queued");
                        assertThat(mysqlJdbc.queryForObject("SELECT state FROM ma_user_message WHERE tenant_id = ? AND session_id = ?",
                                String.class, tenant, "stale-snapshot")).isEqualTo("withdrawn");
                    });
                } finally {
                    holder.rollback();
                }
            }
            assertThat(bounds).containsExactly(List.of(0L, ids.getLast()));
            for (int scan = 1; scan <= 2; scan++) {
                int page = scan;
                transactions.executeWithoutResult(transaction -> {
                    for (int index = 0; index < 32; index++) {
                        String added = "new-" + page + "-" + index;
                        mysqlJdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified)"
                                + " VALUES (?, ?, 'agent', 'ACTIVE', 0, 0)", tenant, added);
                        mysqlJdbc.update("INSERT INTO ma_user_message_queue (tenant_id, session_id) VALUES (?, ?)", tenant, added);
                    }
                });
                assertThat(maxima).containsExactly(ids.getLast());
                transactions.executeWithoutResult(transaction -> sweep.retireClosed());
                if (scan == 1) {
                    assertThat(maxima).containsExactly(ids.getLast());
                    assertThat(bounds.getLast()).containsExactly(ids.get(31), ids.getLast());
                    transactions.executeWithoutResult(transaction -> assertThat(mysqlJdbc.queryForObject(
                            "SELECT state FROM ma_user_message WHERE tenant_id = ? AND session_id = ?",
                            String.class, tenant, "busy")).isEqualTo("queued"));
                }
            }
            transactions.executeWithoutResult(transaction -> {
                long latest = mysqlJdbc.queryForObject("SELECT MAX(id) FROM ma_user_message_queue", Long.class);
                assertThat(maxima).containsExactly(ids.getLast(), latest);
                assertThat(bounds.getLast()).containsExactly(0L, latest);
                assertThat(pageSizes).containsExactly(32, 32, 32);
                assertThat(mysqlJdbc.queryForList("SELECT state FROM ma_user_message WHERE tenant_id = ?", String.class, tenant))
                        .containsOnly("withdrawn").hasSize(2);
                assertThat(mysqlJdbc.queryForList("SELECT queue_revision FROM ma_user_message_queue WHERE tenant_id = ?"
                        + " AND session_id IN (?, ?)", Long.class, tenant, "busy", "stale-snapshot"))
                        .containsOnly(1L).hasSize(2);
                assertThat(mysqlJdbc.queryForList("SELECT queue_revision FROM ma_user_message_queue WHERE tenant_id = ?"
                        + " AND session_id NOT IN (?, ?)", Long.class, tenant, "busy", "stale-snapshot"))
                        .containsOnly(0L).hasSize(126);
                assertThat(mysqlJdbc.queryForList("SELECT revision FROM ma_user_message WHERE tenant_id = ?", Long.class, tenant))
                        .containsOnly(1L).hasSize(2);
            });
        } finally {
            transactions.executeWithoutResult(transaction -> {
                mysqlJdbc.update("DELETE FROM ma_user_message WHERE tenant_id = ?", tenant);
                mysqlJdbc.update("DELETE FROM ma_user_message_queue WHERE tenant_id = ?", tenant);
                mysqlJdbc.update("DELETE FROM ma_session WHERE tenant_id = ?", tenant);
            });
        }
    }
}
