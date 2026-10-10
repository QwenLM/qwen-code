package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class ManagedAgentReplayOutageTest {

    // The replay contract during a Harness outage: a recorded submit must
    // answer its 202 to every client retry without re-dispatching. A
    // replay-driven dispatch would defer the Turn once per client retry,
    // spend the whole pre-admission budget inside one outage, and terminally
    // fail a Turn whose client kept reading 202s.
    @Test
    void defersWithoutBurningBudgetWhileTheHarnessIsDisabled() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:replay-outage-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE"
                + ";LOCK_TIMEOUT=10000");
        Flyway.configure().dataSource(source).load().migrate();
        ManagedAgentStore store = new ManagedAgentStore(
                new JdbcTemplate(source), new ObjectMapper(),
                Clock.systemUTC(), events -> { },
                mock(ManagedWorkspaceRegistry.class),
                new ManagedAgentProperties());
        HarnessCoordinator coordinator = mock(HarnessCoordinator.class);
        UnavailableHarnessConnector harness =
                new UnavailableHarnessConnector();
        RequestDigests digests = new RequestDigests();
        ManagedAgentService service = new ManagedAgentService(store, digests,
                coordinator, harness, mock(ManagedWorkspaceRegistry.class));

        String tenant = "tenant-replay-outage";
        List<Map<String, Object>> input =
                List.of(Map.of("type", "text", "text", "hold"));
        // The recorded create and submit stand in for the 202s whose
        // responses the outage hid from the client.
        Admission session = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "outage-create", "digest-create",
                "qwen-code", null, null, List.of(), null);
        Admission turn = store.insertTurnCommand(tenant, "SUBMIT_TURN",
                "outage-submit", digests.digest(Map.of("sessionId",
                        session.sessionId(), "input", input)),
                session.sessionId(), input, "payload");

        List<InputBlock> blocks = List.of(new InputBlock("text", "hold"));
        int replays = new ManagedAgentProperties().getDispatch()
                .getMaxPreAdmissionRetries() + 1;
        for (int attempt = 0; attempt < replays; attempt++) {
            CommandAdmission replayed = service.submitTurn(tenant, null,
                    "outage-submit", session.sessionId(), blocks);
            assertThat(replayed.replayed()).isTrue();
            assertThat(replayed.turnId()).isEqualTo(turn.turnId());
        }

        // No replay re-dispatched while the Harness was down...
        verify(coordinator, never()).dispatch(anyString(), anyString(),
                anyString());
        // ...so the Turn never deferred, never spent its pre-admission
        // budget, and stays parked where the availability-gated sweep can
        // re-offer it once the Harness returns.
        TurnRecord row = store.findTurn(tenant, session.sessionId(),
                turn.turnId()).orElseThrow();
        assertThat(row.status()).isEqualTo("ACCEPTED");
        assertThat(row.retryCount()).isZero();
        assertThat(store.findDispatchable(System.currentTimeMillis(), 10))
                .extracting(DispatchTarget::turnId)
                .contains(turn.turnId());
    }
}
