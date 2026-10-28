package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.Test;

import java.sql.Timestamp;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedSchemaJdbcTimeTest {
    @Test
    void bindsAndReadsNullableEpochMillisecondsWithoutTimezoneConversion() {
        try (var fixture = ConsolidatedStoreFixture.open("jdbc_time")) {
            var jdbc = new ManagedSchemaJdbcTemplate(fixture.source());
            jdbc.execute("CREATE TABLE time_values (id INT PRIMARY KEY, time_value BIGINT UNSIGNED)");
            Timestamp time = Timestamp.from(java.time.Instant.parse("2050-01-01T01:02:03.123456Z"));
            jdbc.update("INSERT INTO time_values VALUES (1, ?), (2, ?)", time, null);
            assertThat(jdbc.queryForObject("SELECT time_value FROM time_values WHERE id = 1", Long.class))
                    .isEqualTo(2_524_611_723_123L);
            assertThat(jdbc.queryForObject("SELECT time_value FROM time_values WHERE id = 1", Timestamp.class)
                    .toInstant()).isEqualTo(java.time.Instant.parse("2050-01-01T01:02:03.123Z"));
            assertThat(jdbc.queryForObject("SELECT time_value FROM time_values WHERE id = 2", Timestamp.class))
                    .isNull();
            assertThat(jdbc.queryForMap("SELECT time_value FROM time_values WHERE id = 1")
                    .get("time_value")).isEqualTo(2_524_611_723_123L);
        }
    }
}
