package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ChannelSegmentRepository.SegmentLedger;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Contract for the per-segment channel delivery ledger (ma_channel_segment),
 * run against the Flyway schema. A MySQL gate reruns it on a real database.
 */
class JdbcChannelSegmentRepositoryTest {
    protected JdbcTemplate jdbc;
    protected JdbcChannelSegmentRepository segments;
    protected String tenant;
    protected final String channel = "channel-main";

    @BeforeEach
    void setup() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        segments = new JdbcChannelSegmentRepository(jdbc);
        tenant = "tenant-" + UUID.randomUUID();
    }

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:channel-segment-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        return source;
    }

    @Test
    void plansEverySegmentInOrdinalOrderAndReplanIsIdempotent() {
        segments.plan(tenant, channel, "d1", List.of(
                new SegmentLedger("d1:2", 2, null),
                new SegmentLedger("d1:0", 0, null),
                new SegmentLedger("d1:1", 1, null)));
        assertThat(segments.list(tenant, channel, "d1"))
                .extracting(SegmentLedger::segmentId)
                .containsExactly("d1:0", "d1:1", "d1:2");

        segments.receipt(tenant, channel, "d1", 0, "m0");
        // A re-claim replays the plan; it never overwrites a stored receipt
        // nor duplicates a row.
        segments.plan(tenant, channel, "d1", List.of(
                new SegmentLedger("d1:0", 0, null),
                new SegmentLedger("d1:1", 1, null),
                new SegmentLedger("d1:2", 2, null)));
        assertThat(count()).isEqualTo(3);
        assertThat(segments.list(tenant, channel, "d1").get(0).providerReceipt())
                .isEqualTo("m0");
    }

    @Test
    void writesAReceiptOncePerSegment() {
        segments.plan(tenant, channel, "d1", List.of(
                new SegmentLedger("d1:0", 0, null),
                new SegmentLedger("d1:1", 1, null)));
        assertThat(segments.receipt(tenant, channel, "d1", 0, "m0")).isTrue();
        // A replayed or conflicting second receipt leaves the first intact.
        assertThat(segments.receipt(tenant, channel, "d1", 0, "m0")).isFalse();
        assertThat(segments.receipt(tenant, channel, "d1", 0, "other")).isFalse();
        assertThat(segments.list(tenant, channel, "d1").get(0).providerReceipt())
                .isEqualTo("m0");
        assertThat(segments.list(tenant, channel, "d1").get(1).providerReceipt())
                .isNull();
        assertThat(segments.receipt(tenant, channel, "d1", 1, "m1")).isTrue();
        assertThat(segments.list(tenant, channel, "d1"))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("m0", "m1");
    }

    @Test
    void aResumedPartialPlansTheReceiptsTheRecordAlreadyHolds() {
        segments.plan(tenant, channel, "d1", List.of(
                new SegmentLedger("d1:0", 0, "m0"),
                new SegmentLedger("d1:1", 1, null)));
        assertThat(segments.list(tenant, channel, "d1"))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("m0", null);
    }

    @Test
    void aResumedPlanBackfillsAMissingReceiptOnAnExistingRow() {
        segments.plan(tenant, channel, "d1", List.of(new SegmentLedger("d1:0", 0, null)));
        assertThat(segments.list(tenant, channel, "d1").get(0).providerReceipt()).isNull();
        // A resumed plan carries the receipt the record now holds; it
        // backfills the existing row instead of leaving it null.
        segments.plan(tenant, channel, "d1", List.of(new SegmentLedger("d1:0", 0, "m0")));
        assertThat(segments.list(tenant, channel, "d1").get(0).providerReceipt())
                .isEqualTo("m0");
        // A later plan never overwrites the stored receipt.
        segments.plan(tenant, channel, "d1", List.of(new SegmentLedger("d1:0", 0, "other")));
        assertThat(segments.list(tenant, channel, "d1").get(0).providerReceipt())
                .isEqualTo("m0");
    }

    @Test
    void isolatesTenantsChannelsAndDeliveries() {
        segments.plan(tenant, channel, "d1", List.of(new SegmentLedger("d1:0", 0, null)));
        segments.receipt(tenant, channel, "d1", 0, "m0");
        assertThat(segments.list(tenant + "-other", channel, "d1")).isEmpty();
        assertThat(segments.list(tenant, channel + "-other", "d1")).isEmpty();
        assertThat(segments.list(tenant, channel, "d2")).isEmpty();
        assertThat(segments.receipt(tenant + "-other", channel, "d1", 0, "x")).isFalse();
        assertThat(segments.list(tenant, channel, "d1").get(0).providerReceipt())
                .isEqualTo("m0");
    }

    @Test
    void listsSegmentsInOrdinalOrderNotLexicographic() {
        // Twelve segments make d1:10 and d1:11 sort before d1:2 lexically, so
        // only an ordinal-ordered read returns 0..11; dropping the ORDER BY
        // would surface the segment-id index order instead.
        List<SegmentLedger> plan = java.util.stream.IntStream.range(0, 12)
                .mapToObj(i -> new SegmentLedger("d1:" + i, i, null))
                .toList();
        segments.plan(tenant, channel, "d1", plan);
        assertThat(segments.list(tenant, channel, "d1"))
                .extracting(SegmentLedger::ordinal)
                .containsExactly(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
    }

    @Test
    void plansTheFullContractBoundAndReplanStaysIdempotent() {
        List<SegmentLedger> plan = java.util.stream.IntStream.range(0, 64)
                .mapToObj(i -> new SegmentLedger("d1:" + i, i, null))
                .toList();
        segments.plan(tenant, channel, "d1", plan);
        assertThat(segments.list(tenant, channel, "d1"))
                .extracting(SegmentLedger::ordinal)
                .containsExactlyElementsOf(
                        java.util.stream.IntStream.range(0, 64).boxed().toList());
        // A re-claim replays the whole batch; no row duplicates.
        segments.plan(tenant, channel, "d1", plan);
        assertThat(count()).isEqualTo(64);
    }

    @Test
    void aBatchBackfillsExistingRowsAndCarriesReceiptsOnNewOnes() {
        // The pre-existing null-receipt row sits at batch position 0 but
        // carries ordinal 1, and the new row at position 1 carries ordinal 0,
        // so neither skipping count-0 rows nor indexing the insert counts by
        // ordinal instead of batch position can hide.
        segments.plan(tenant, channel, "d1",
                List.of(new SegmentLedger("d1:1", 1, null)));
        segments.plan(tenant, channel, "d1", List.of(
                new SegmentLedger("d1:1", 1, "m1"),
                new SegmentLedger("d1:0", 0, "m0")));
        assertThat(segments.list(tenant, channel, "d1"))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("m0", "m1");
        assertThat(count()).isEqualTo(2);
    }

    @Test
    void aDriverReportingNoPerRowCountStillBackfills() {
        segments.plan(tenant, channel, "d1",
                List.of(new SegmentLedger("d1:0", 0, null)));
        // A driver that reports SUCCESS_NO_INFO for the insert batch: the
        // count is neither 1 (fresh insert) nor 0 (ignored), so the backfill
        // must still run via the guarded update. Dropping the != 1 fallback
        // (or turning it into == 0) leaves the receipt null and reds this case.
        JdbcTemplate spied = org.mockito.Mockito.spy(jdbc);
        org.mockito.Mockito.doReturn(
                new int[]{java.sql.Statement.SUCCESS_NO_INFO})
                .when(spied).batchUpdate(
                        org.mockito.ArgumentMatchers.startsWith("INSERT IGNORE"),
                        org.mockito.ArgumentMatchers.any(
                                org.springframework.jdbc.core.BatchPreparedStatementSetter.class));
        new JdbcChannelSegmentRepository(spied).plan(tenant, channel, "d1",
                List.of(new SegmentLedger("d1:0", 0, "m0")));
        assertThat(segments.list(tenant, channel, "d1").get(0).providerReceipt())
                .isEqualTo("m0");
    }

    @Test
    void aReclaimBatchesTheBackfillWithoutPerRowUpdates() {
        segments.plan(tenant, channel, "d1", java.util.stream.IntStream.range(0, 3)
                .mapToObj(i -> new SegmentLedger("d1:" + i, i, null)).toList());
        segments.receipt(tenant, channel, "d1", 0, "m0");
        segments.receipt(tenant, channel, "d1", 1, "m1");
        segments.receipt(tenant, channel, "d1", 2, "m2");
        // A re-claim where every row is pre-existing and receipted: the
        // backfill must be one guarded batch, not a per-row UPDATE round trip
        // per segment. Reverting it to per-row receiptOnce reds this case.
        JdbcTemplate spied = org.mockito.Mockito.spy(jdbc);
        new JdbcChannelSegmentRepository(spied).plan(tenant, channel, "d1",
                java.util.stream.IntStream.range(0, 3)
                        .mapToObj(i -> new SegmentLedger("d1:" + i, i, "m" + i))
                        .toList());
        // The backfill is one guarded batch (the Collection overload), not a
        // per-row receiptOnce UPDATE per segment.
        org.mockito.Mockito.verify(spied, org.mockito.Mockito.times(1))
                .batchUpdate(
                        org.mockito.ArgumentMatchers.startsWith("UPDATE ma_channel_segment"),
                        org.mockito.ArgumentMatchers.any(java.util.Collection.class),
                        org.mockito.ArgumentMatchers.anyInt(),
                        org.mockito.ArgumentMatchers.any(
                                org.springframework.jdbc.core.ParameterizedPreparedStatementSetter.class));
        assertThat(segments.list(tenant, channel, "d1"))
                .extracting(SegmentLedger::providerReceipt)
                .containsExactly("m0", "m1", "m2");
    }

    @Test
    void listByDeliveryReadsTheWholePageGroupedByDelivery() {
        segments.plan(tenant, channel, "d1", List.of(
                new SegmentLedger("d1:1", 1, null),
                new SegmentLedger("d1:0", 0, "m0")));
        segments.plan(tenant, channel, "d3",
                List.of(new SegmentLedger("d3:0", 0, null)));
        var byDelivery = segments.listByDelivery(tenant, channel,
                List.of("d1", "d2", "d3"));
        assertThat(byDelivery.keySet()).containsExactly("d1", "d2", "d3");
        assertThat(byDelivery.get("d1"))
                .extracting(SegmentLedger::ordinal)
                .containsExactly(0, 1);
        assertThat(byDelivery.get("d1").get(0).providerReceipt()).isEqualTo("m0");
        // A delivery with no segments keeps an empty entry, not a missing key.
        assertThat(byDelivery.get("d2")).isEmpty();
        assertThat(byDelivery.get("d3"))
                .extracting(SegmentLedger::segmentId)
                .containsExactly("d3:0");
        assertThat(segments.listByDelivery(tenant, channel, List.of())).isEmpty();
    }

    @Test
    void refusesInvalidArguments() {
        assertThatThrownBy(() -> segments.plan(tenant, channel, "d1",
                List.of(new SegmentLedger("d1:0", -1, null))))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> segments.plan(tenant, channel, "d1",
                List.of(new SegmentLedger(" ", 0, null))))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> segments.receipt(tenant, channel, "d1", 0, " "))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> segments.receipt(tenant, channel, "d1", -1, "m"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private int count() {
        Integer total = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_channel_segment WHERE tenant_id = ?",
                Integer.class, tenant);
        return total == null ? 0 : total;
    }
}
