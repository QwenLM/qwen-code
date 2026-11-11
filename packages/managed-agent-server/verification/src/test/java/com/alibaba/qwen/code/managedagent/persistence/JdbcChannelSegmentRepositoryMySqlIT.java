package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelSegmentRepository.SegmentLedger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import javax.sql.DataSource;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class JdbcChannelSegmentRepositoryMySqlIT extends JdbcChannelSegmentRepositoryTest {
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
    void concurrentReceiptsForOneSegmentLeaveExactlyOneDurableReceipt() throws Exception {
        segments.plan(tenant, channel, "d1", List.of(new SegmentLedger("d1:0", 0, null)));
        var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(() -> receiptAfter(start, "m-first"));
            var second = pool.submit(() -> receiptAfter(start, "m-second"));
            start.countDown();
            String a = first.get(10, TimeUnit.SECONDS);
            String b = second.get(10, TimeUnit.SECONDS);
            // The write-once update admits exactly one of the two receipts.
            assertThat((a == null) ^ (b == null)).isTrue();
            String winner = a != null ? a : b;
            assertThat(segments.list(tenant, channel, "d1"))
                    .extracting(SegmentLedger::providerReceipt)
                    .containsExactly(winner);
        }
    }

    private String receiptAfter(CountDownLatch start, String receipt) throws InterruptedException {
        assertThat(start.await(5, TimeUnit.SECONDS)).isTrue();
        return segments.receipt(tenant, channel, "d1", 0, receipt) ? receipt : null;
    }
}
