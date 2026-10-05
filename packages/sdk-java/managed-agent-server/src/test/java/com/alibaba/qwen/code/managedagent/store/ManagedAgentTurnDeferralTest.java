package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class ManagedAgentTurnDeferralTest {

    // deferTurnRetry carries the outage hold: it must free the lease so the
    // availability-gated sweep can re-offer the Turn, hold it back until
    // retry_after, and still spend the pre-admission budget so a permanent
    // outage terminates instead of holding the Turn ACCEPTED forever.
    @Test
    void deferTurnRetryHoldsTheTurnUntilItsBackoffElapses() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:defer-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE"
                + ";LOCK_TIMEOUT=10000");
        Flyway.configure().dataSource(source).load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(source);
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), events -> { },
                org.mockito.Mockito.mock(ManagedWorkspaceRegistry.class),
                new ManagedAgentProperties());

        String tenant = "tenant-defer";
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "create-key", "digest-create", "qwen-code",
                "1", null, List.of(), null);
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT",
                "submit-key", "digest-submit", session.sessionId(),
                List.of(Map.of("type", "text", "text", "hi")), "payload");
        long now = System.currentTimeMillis();
        assertThat(store.claimTurn(tenant, session.sessionId(), turn.turnId(),
                "owner-a", Duration.ofSeconds(30))).isPresent();

        long retryAfter = now + 60_000L;
        store.deferTurnRetry(tenant, session.sessionId(), turn.turnId(),
                "owner-a", retryAfter);

        assertThat(jdbc.queryForObject("SELECT status FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " turn_id = ?", String.class, tenant, turn.turnId()))
                .isEqualTo("ACCEPTED");
        assertThat(jdbc.queryForObject("SELECT retry_count FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " turn_id = ?", Integer.class, tenant,
                turn.turnId())).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT retry_after FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " turn_id = ?", Long.class, tenant, turn.turnId()))
                .isEqualTo(retryAfter);
        assertThat(jdbc.queryForObject("SELECT dispatch_owner FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " turn_id = ?", String.class, tenant,
                turn.turnId())).isNull();
        assertThat(jdbc.queryForObject("SELECT dispatch_lease_until FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " turn_id = ?", Long.class, tenant,
                turn.turnId())).isNull();

        assertThat(store.findDispatchable(now + 30_000L, 10)).isEmpty();
        assertThat(store.findDispatchable(now + 120_000L, 10))
                .extracting(DispatchTarget::turnId)
                .containsExactly(turn.turnId());
    }
}
