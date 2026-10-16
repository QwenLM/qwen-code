package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.ChannelDeliveryRepository.ChannelDelivery;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ConsolidatedChannelStoreTest {
    private ConsolidatedStoreFixture fixture;
    private JdbcTemplate jdbc;
    private JdbcChannelDeliveryRepository deliveries;
    private ChannelInstanceStore instances;

    @BeforeEach
    void initialize() {
        fixture = ConsolidatedStoreFixture.open("channel");
        var source = fixture.source();
        ManagedSchema.initialize(source);
        jdbc = new JdbcTemplate(source);
        deliveries = new JdbcChannelDeliveryRepository(jdbc);
        instances = new ChannelInstanceStore(jdbc);
    }

    @AfterEach
    void closeFixture() {
        if (fixture != null) {
            fixture.close();
        }
    }

    @Test
    void transportAndClaimShareOneFencedRowAndIgnoreOtherDeliveryKinds() {
        deliveries.findOrCreate(planned("channel"));
        assertThat(instances.findClaim("tenant", "channel", "delivery")).isEmpty();
        assertThat(instances.claim("tenant", "channel", "delivery", "session").sessionId())
                .isEqualTo("session");
        instances.claim("tenant", "channel", "delivery", "session");
        assertThatThrownBy(() -> instances.claim("tenant", "channel", "delivery", "another"))
                .isInstanceOf(IllegalStateException.class);
        assertThat(jdbc.queryForObject("SELECT claim_generation FROM ma_delivery", Long.class)).isEqualTo(1);
        instances.touchClaim("tenant", "channel", "delivery");
        assertThat(jdbc.queryForObject("SELECT claim_generation FROM ma_delivery", Long.class)).isEqualTo(2);
        assertThat(deliveries.transition("tenant", "channel", "delivery", "planned", "sending", null).state())
                .isEqualTo("sending");
        jdbc.update("UPDATE ma_delivery SET claimed_at = 1 WHERE delivery_kind = 'CHANNEL'");
        jdbc.update("INSERT INTO ma_delivery (delivery_key,delivery_kind,tenant_id,delivery_id,source_session_id,"
                + "source_scope_key,payload_json,transport_state,reception_state,consumption_state,claimed_at,"
                + "gmt_create,gmt_modified) VALUES ('other','SESSION_MESSAGE','tenant','delivery','session',"
                + "'another','{}','sending','PENDING','PENDING',1,0,0)");
        assertThat(instances.findExpiredClaims(2, 100)).hasSize(1);
        assertThat(deliveries.listByChannel("tenant", "channel", null, 100).deliveries()).hasSize(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_delivery WHERE delivery_kind = 'CHANNEL'", Long.class))
                .isEqualTo(1);
    }

    @Test
    void preservesExactChannelIdentityAndProviderReceiptsWithoutRetryingUnknown() {
        deliveries.findOrCreate(planned("channel"));
        deliveries.findOrCreate(planned("channel "));
        assertThat(deliveries.listByChannel("tenant", "channel", null, 100).deliveries()).hasSize(1);
        assertThat(deliveries.listByChannel("tenant", "channel ", null, 100).deliveries()).hasSize(1);
        assertThat(deliveries.find("tenant", "CHANNEL", "delivery")).isEmpty();
        deliveries.transition("tenant", "channel", "delivery", "planned", "sending", null);
        deliveries.transition("tenant", "channel", "delivery", "sending", "unknown", null);
        assertThatThrownBy(() -> deliveries.transition("tenant", "channel", "delivery", "unknown", "sending", null))
                .isInstanceOf(IllegalArgumentException.class);
        String receipt = "provider:\n\"message\"";
        assertThat(deliveries.transition("tenant", "channel", "delivery", "unknown", "delivered", receipt)
                .providerReceipt()).isEqualTo(receipt);
        assertThat(deliveries.transition("tenant", "channel", "delivery", "unknown", "delivered", receipt)
                .providerReceipt()).isEqualTo(receipt);
        assertThat(deliveries.transition("tenant", "channel", "delivery", "unknown", "delivered", "another"))
                .isNull();
    }

    @Test
    void privateResourceLookupCannotCrossSessionsThatReuseAnIdentity() {
        resource("first", "first-body");
        resource("second", "second-body");
        assertThat(instances.readResource("tenant", "first", "resource")).isEqualTo("first-body");
        assertThat(instances.readResource("tenant", "second", "resource")).isEqualTo("second-body");
        assertThat(instances.readResource("tenant", "missing", "resource")).isNull();
    }

    private void resource(String session, String body) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String scope = ManagedSessionStore.sessionScopeKey("tenant", session);
        jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,session_id,resource_id,kind,schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create) VALUES (?,?,'tenant',?,'resource','domain',1,?,?, 'MYSQL_INLINE',?,'REFERENCED'," + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSchemaKeys.key(scope, "resource"), scope, session, bytes.length,
                ChannelStoreSupport.sha256(body), bytes);
    }

    private static ChannelDelivery planned(String channel) {
        return new ChannelDelivery("tenant", channel, "delivery", "segment", 0, "planned", null, 0, 0);
    }
}
