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
