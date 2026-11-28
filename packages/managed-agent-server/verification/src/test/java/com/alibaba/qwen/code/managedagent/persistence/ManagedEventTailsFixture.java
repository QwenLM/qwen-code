package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionKey;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.alibaba.qwen.code.managedagent.persistence.ManagedEventTailsTest.key;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.entry;

/** Event tail scenarios shared by the H2 and real-MySQL suites. */
final class ManagedEventTailsFixture {
    private final ManagedAgentStore store;
    private final TransactionTemplate transactions;

    ManagedEventTailsFixture(DataSource source) {
        store = ManagedEventTailsTest.store(source);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
    }

    void readsEachRequestedTailAcrossTenantsOnly() {
        String a = UUID.randomUUID().toString();
        String b = UUID.randomUUID().toString();
        String first = session(a, 2);
        String second = session(b, 3);
        session(a, 1);

        Map<SessionKey, Long> tails = store.findEventTails(List.of(key(a, first),
                key(b, second), key(b, first), key(a, "missing")));

        assertThat(tails).containsOnly(entry(key(a, first), lastEvent(a, first)),
                entry(key(b, second), lastEvent(b, second)));
    }

    void splitsALargeRequestIntoBatches() {
        String tenant = UUID.randomUUID().toString();
        String session = session(tenant, 1);
        List<SessionKey> keys = new ArrayList<>();
        for (int i = 0; i < 500; i++) {
            keys.add(key(tenant, "missing-" + i));
        }
        keys.add(key(tenant, session));

        assertThat(store.findEventTails(keys))
                .containsOnly(entry(key(tenant, session), lastEvent(tenant, session)));
    }

    private String session(String tenant, int events) {
        String session = transactions.execute(status -> store.insertSessionCommand(tenant, "actor",
                "CREATE_SESSION", "create-" + UUID.randomUUID(), "digest", "qwen-code", null,
                "title", List.of(), null)).sessionId();
        for (int i = 0; i < events; i++) {
            transactions.executeWithoutResult(status -> store.appendPublicEventIfAbsent(tenant,
                    session, "turn", "item.output_text.delta", Map.of("itemId", "m", "text", "x"),
                    false, "event-" + UUID.randomUUID()));
        }
        return session;
    }

    private long lastEvent(String tenant, String session) {
        return store.findEvents(tenant, session, 0, 100).getLast().sequence();
    }
}
