package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.sidequery.ManagedSideQueryModels.Create;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import javax.sql.DataSource;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedSideQueryStoreMySqlIT extends ManagedSideQueryStoreTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void closeDatabase() {
        if (database != null) {
            database.close();
        }
    }

    @Test
    @Timeout(30)
    void concurrentActorKindAdmissionsHaveExactlyOneDurableActiveSlot() throws Exception {
        var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(() -> admitAfter(start, "first"));
            var second = pool.submit(() -> admitAfter(start, "second"));
            start.countDown();
            int admitted = (first.get(10, TimeUnit.SECONDS) ? 1 : 0) + (second.get(10, TimeUnit.SECONDS) ? 1 : 0);
            assertThat(admitted).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_side_query WHERE active_slot IS NOT NULL", Integer.class)).isEqualTo(1);
        }
    }

    private boolean admitAfter(CountDownLatch start, String key) throws InterruptedException {
        assertThat(start.await(5, TimeUnit.SECONDS)).isTrue();
        try {
            tx(() -> queries.admit(tenant, actor, session, new Create("btw", "manual", "question", key, null, null), true));
            return true;
        } catch (ManagedAgentException failure) {
            assertThat(failure.getCode()).isEqualTo("side_query_active");
            return false;
        }
    }
}
