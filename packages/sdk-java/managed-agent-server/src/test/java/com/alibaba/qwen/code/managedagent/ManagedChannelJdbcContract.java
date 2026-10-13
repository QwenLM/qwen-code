package com.alibaba.qwen.code.managedagent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.managedagent.store.ChannelDeliveryRepository;
import com.alibaba.qwen.code.managedagent.store.ChannelDeliveryRepository.ChannelDelivery;
import com.alibaba.qwen.code.managedagent.store.ChannelDeliveryRepository.DeliveryCursor;
import com.alibaba.qwen.code.managedagent.store.ChannelDeliveryRepository.DeliveryPage;
import com.alibaba.qwen.code.managedagent.store.ChannelRouteRepository;
import com.alibaba.qwen.code.managedagent.store.ChannelRouteRepository.ChannelRoute;
import com.alibaba.qwen.code.managedagent.store.ChannelRouteRepository.RouteCursor;
import com.alibaba.qwen.code.managedagent.store.ChannelRouteRepository.RoutePage;
import com.alibaba.qwen.code.managedagent.store.JdbcChannelDeliveryRepository;
import com.alibaba.qwen.code.managedagent.store.JdbcChannelRouteRepository;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Contract for the H5 channel route and delivery repositories
 * (qwen_managed_channel_route, qwen_managed_channel_delivery), run against
 * the Flyway schema. It is public so a MySQL gate can run the same checks;
 * ManagedChannelJdbcContractTest runs it on H2 in MySQL mode.
 */
public final class ManagedChannelJdbcContract {
    private static final String SESSION =
            "6f1c7d7e-3a4b-4c2d-9e8f-0123456789ab";

    private ManagedChannelJdbcContract() {
    }

    /**
     * Runs the contract. {@code prefix} namespaces every row it writes, so a
     * shared database needs a prefix that no earlier run used.
     */
    public static void verify(DataSource dataSource, String prefix) {
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        verifyRouteBindings(new JdbcChannelRouteRepository(jdbc), jdbc,
                prefix);
        verifyRouteListing(new JdbcChannelRouteRepository(jdbc), jdbc,
                prefix);
        verifyDeliveries(new JdbcChannelDeliveryRepository(jdbc), jdbc,
                prefix);
        verifyDeliveryListing(new JdbcChannelDeliveryRepository(jdbc), jdbc,
                prefix);
    }

    private static void verifyRouteBindings(ChannelRouteRepository routes,
            JdbcTemplate jdbc, String prefix) {
        String tenant = prefix + "-route";
        String channel = "channel-main";
        ChannelRoute candidate = route(tenant, channel, 1, "event-1", 1,
                null, List.of("artifact-1", "artifact-2"));
        ChannelRoute created = routes.findOrCreate(candidate);
        assertEquals("staged", created.state());
        assertNull(created.inputId());
        assertEquals(List.of("artifact-1", "artifact-2"),
                created.stagedAttachmentRefs());
        assertTrue(created.createdAt() > 0);
        assertEquals(created.createdAt(), created.updatedAt());
        assertNull(created.chatId());
        assertNull(created.threadId());

        // Ingress redelivery of one platform event keeps the first row.
        ChannelRoute redelivered = routes.findOrCreate(candidate);
        assertEquals(created.routeKey(), redelivered.routeKey());
        assertEquals(1, count(jdbc, "qwen_managed_channel_route", tenant));

        // An edited message binds a new revision; a re-authenticated account
        // starts a new generation. Each stays its own binding.
        routes.findOrCreate(route(tenant, channel, 1, "event-1", 2, null,
                List.of()));
        routes.findOrCreate(route(tenant, channel, 2, "event-1", 1, null,
                List.of()));
        assertEquals(3, count(jdbc, "qwen_managed_channel_route", tenant));
        assertTrue(routes.find(tenant, created.routeKey()).isPresent());
        assertTrue(routes.find(prefix + "-other", created.routeKey())
                .isEmpty());

        assertThrows(IllegalArgumentException.class, () -> routes
                .findOrCreate(new ChannelRoute(tenant,
                        ChannelRouteRepository.routeKey(tenant, channel, 1,
                                "event-bad", 1),
                        channel, 1, "event-bad", 1, SESSION, "sender-1", null,
                        null, "staged", "input-x", List.of(), 0, 0)));
        assertThrows(IllegalArgumentException.class, () -> routes
                .findOrCreate(new ChannelRoute(tenant,
                        ChannelRouteRepository.routeKey(tenant, channel, 1,
                                "event-bad", 1),
                        channel, 1, "event-bad", 1, SESSION, "sender-1", null,
                        null, "admitted", null, List.of(), 0, 0)));
        assertThrows(IllegalArgumentException.class, () -> routes
                .findOrCreate(new ChannelRoute(tenant,
                        ChannelRouteRepository.routeKey(tenant, channel, 1,
                                "event-bad", 1),
                        channel, 1, "event-bad", 1, SESSION, "sender-1", null,
                        null, "unknown", null, List.of(), 0, 0)));
        assertThrows(IllegalArgumentException.class, () -> routes
                .findOrCreate(route(tenant, channel, 1, "event-bad", 1, null,
                        null)));
        assertThrows(IllegalArgumentException.class, () -> routes
                .findOrCreate(route(tenant, channel, 0, "event-bad", 1, null,
                        List.of())));
        List<String> overBound = new ArrayList<>();
        for (int i = 0; i < 101; i++) {
            overBound.add("artifact-" + i);
        }
        assertThrows(IllegalArgumentException.class,
                () -> routes.findOrCreate(route(tenant, channel, 1,
                        "event-bad", 1, null, overBound)));

        // Admission records the input; the original input id stays queryable.
        ChannelRoute admitted = routes.admit(tenant, created.routeKey(),
                "input-1");
        assertNotNull(admitted);
        assertEquals("admitted", admitted.state());
        assertEquals("input-1", admitted.inputId());
        assertEquals(List.of("artifact-1", "artifact-2"),
                admitted.stagedAttachmentRefs());
        assertTrue(admitted.updatedAt() >= admitted.createdAt());
        ChannelRoute replayed = routes.admit(tenant, created.routeKey(),
                "input-1");
        assertNotNull(replayed);
        assertEquals("input-1", replayed.inputId());
        assertNull(routes.admit(tenant, created.routeKey(), "input-other"));
        assertNull(routes.admit(tenant,
                ChannelRouteRepository.routeKey(tenant, channel, 1,
                        "event-missing", 1),
                "input-1"));
    }

    private static void verifyRouteListing(ChannelRouteRepository routes,
            JdbcTemplate jdbc, String prefix) {
        String tenant = prefix + "-route-pages";
        String channel = "channel-pages";
        for (int i = 0; i < 205; i++) {
            routes.findOrCreate(route(tenant, channel, 1, "event-" + i, 1,
                    null, List.of()));
        }
        List<ChannelRoute> all = new ArrayList<>();
        RouteCursor cursor = null;
        RoutePage page;
        int pages = 0;
        do {
            page = routes.listByChannel(tenant, channel, cursor, 100);
            all.addAll(page.routes());
            List<ChannelRoute> rows = page.routes();
            if (!rows.isEmpty()) {
                ChannelRoute last = rows.get(rows.size() - 1);
                cursor = new RouteCursor(last.createdAt(), last.routeKey());
            }
            pages++;
        } while (page.hasMore());
        assertEquals(3, pages);
        assertEquals(205, all.size());
        Set<String> keys = new HashSet<>();
        ChannelRoute previous = null;
        for (ChannelRoute row : all) {
            assertTrue(keys.add(row.routeKey()), "duplicate row in pages");
            if (previous != null) {
                assertTrue(previous.createdAt() > row.createdAt()
                        || previous.createdAt() == row.createdAt()
                                && previous.routeKey().compareTo(
                                        row.routeKey()) > 0,
                        "newest-first order with a stable tiebreak");
            }
            previous = row;
        }
        assertTrue(routes.listByChannel(tenant, channel, null, 100).hasMore());
        assertTrue(routes.listByChannel(prefix + "-other", channel, null, 100)
                .routes().isEmpty());
        assertThrows(IllegalArgumentException.class,
                () -> routes.listByChannel(tenant, channel, null, 0));
        assertThrows(IllegalArgumentException.class,
                () -> routes.listByChannel(tenant, channel, null, 101));

        // Equal created times stay a stable total order through the key
        // tiebreak; written directly, as the repository never inserts them.
        String tieChannel = "channel-ties";
        long tieTime = 4_000_000_000_000L;
        List<String> tieKeys = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            String eventId = "tie-" + i;
            String key = ChannelRouteRepository.routeKey(tenant, tieChannel,
                    1, eventId, 1);
            tieKeys.add(key);
            jdbc.update("INSERT INTO qwen_managed_channel_route (tenant_id,"
                            + " route_key, channel_instance_id,"
                            + " account_generation, platform_event_id,"
                            + " semantic_revision, session_id, sender_id,"
                            + " chat_id, thread_id, state, input_id,"
                            + " staged_attachment_refs_json, created_at,"
                            + " updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?,"
                            + " ?, ?, ?, ?, ?, ?, ?)",
                    tenant, key, tieChannel, 1L, eventId, 1L, SESSION,
                    "sender-1", null, null, "staged", null, null, tieTime,
                    tieTime);
        }
        tieKeys.sort(Comparator.reverseOrder());
        assertEquals(tieKeys, routes.listByChannel(tenant, tieChannel, null,
                100).routes().stream().map(ChannelRoute::routeKey).toList());
    }

    private static void verifyDeliveries(ChannelDeliveryRepository deliveries,
            JdbcTemplate jdbc, String prefix) {
        String tenant = prefix + "-delivery";
        String channel = "channel-main";
        ChannelDelivery candidate = delivery(tenant, channel, "delivery-1",
                "segment-1", 0);
        ChannelDelivery created = deliveries.findOrCreate(candidate);
        assertEquals("planned", created.state());
        assertNull(created.providerReceipt());
        assertTrue(created.createdAt() > 0);
        assertEquals(created.createdAt(), created.updatedAt());

        ChannelDelivery retried = deliveries.findOrCreate(candidate);
        assertEquals(created.deliveryId(), retried.deliveryId());
        assertEquals(1, count(jdbc, "qwen_managed_channel_delivery", tenant));
        assertThrows(IllegalStateException.class,
                () -> deliveries.findOrCreate(delivery(tenant, channel,
                        "delivery-1", "segment-other", 0)));
        assertThrows(IllegalArgumentException.class, () -> deliveries
                .findOrCreate(new ChannelDelivery(tenant, channel,
                        "delivery-bad", "segment-1", 0, "sending", null, 0,
                        0)));
        assertThrows(IllegalArgumentException.class, () -> deliveries
                .findOrCreate(delivery(tenant, channel, "delivery-bad",
                        "segment-1", -1)));
        assertTrue(deliveries.find(tenant, channel, "delivery-1").isPresent());
        assertTrue(deliveries.find(prefix + "-other", channel, "delivery-1")
                .isEmpty());

        ChannelDelivery sending = deliveries.transition(tenant, channel,
                "delivery-1", "planned", "sending", null);
        assertNotNull(sending);
        assertEquals("sending", sending.state());
        assertTrue(sending.updatedAt() >= sending.createdAt());
        assertEquals("partial", deliveries.transition(tenant, channel,
                "delivery-1", "sending", "partial", null).state());
        assertEquals("sending", deliveries.transition(tenant, channel,
                "delivery-1", "partial", "sending", null).state());
        ChannelDelivery delivered = deliveries.transition(tenant, channel,
                "delivery-1", "sending", "delivered", "receipt-1");
        assertEquals("delivered", delivered.state());
        assertEquals("receipt-1", delivered.providerReceipt());

        // One step at a time, channel states only, terminal states stay.
        deliveries.findOrCreate(delivery(tenant, channel, "delivery-2",
                "segment-1", 0));
        assertThrows(IllegalArgumentException.class, () -> deliveries
                .transition(tenant, channel, "delivery-2", "planned",
                        "delivered", null));
        assertThrows(IllegalArgumentException.class, () -> deliveries
                .transition(tenant, channel, "delivery-2", "planned",
                        "accepting", null));
        assertThrows(IllegalArgumentException.class, () -> deliveries
                .transition(tenant, channel, "delivery-1", "delivered",
                        "sending", null));

        // A state mismatch refuses; the exact replay returns the stored row.
        assertNull(deliveries.transition(tenant, channel, "delivery-1",
                "sending", "delivered", "receipt-other"));
        ChannelDelivery replayed = deliveries.transition(tenant, channel,
                "delivery-1", "sending", "delivered", "receipt-1");
        assertNotNull(replayed);
        assertEquals("receipt-1", replayed.providerReceipt());
        assertNull(deliveries.transition(prefix + "-other", channel,
                "delivery-1", "planned", "sending", null));

        // delivery_unknown: the connection dropped after sending; recovery
        // reconciles without resending.
        deliveries.transition(tenant, channel, "delivery-2", "planned",
                "sending", null);
        assertEquals("unknown", deliveries.transition(tenant, channel,
                "delivery-2", "sending", "unknown", null).state());
        ChannelDelivery reconciled = deliveries.transition(tenant, channel,
                "delivery-2", "unknown", "delivered", "receipt-2");
        assertEquals("delivered", reconciled.state());
        assertEquals("receipt-2", reconciled.providerReceipt());

        // An explicit resend is a new deliveryId of the same segment.
        deliveries.findOrCreate(delivery(tenant, channel, "delivery-3",
                "segment-1", 0));
        assertEquals("cancelled", deliveries.transition(tenant, channel,
                "delivery-3", "planned", "cancelled", null).state());
        List<String> segmentDeliveries = new ArrayList<>();
        DeliveryPage outbox = deliveries.listByChannel(tenant, channel, null,
                100);
        for (ChannelDelivery row : outbox.deliveries()) {
            if (row.segmentId().equals("segment-1")) {
                segmentDeliveries.add(row.deliveryId());
            }
        }
        assertEquals(Set.of("delivery-1", "delivery-2", "delivery-3"),
                new HashSet<>(segmentDeliveries));
    }

    private static void verifyDeliveryListing(
            ChannelDeliveryRepository deliveries, JdbcTemplate jdbc,
            String prefix) {
        String tenant = prefix + "-delivery-pages";
        String channel = "channel-pages";
        for (int i = 0; i < 205; i++) {
            deliveries.findOrCreate(delivery(tenant, channel,
                    "delivery-page-" + i, "segment-" + i, 0));
        }
        List<ChannelDelivery> all = new ArrayList<>();
        DeliveryCursor cursor = null;
        DeliveryPage page;
        int pages = 0;
        do {
            page = deliveries.listByChannel(tenant, channel, cursor, 100);
            all.addAll(page.deliveries());
            List<ChannelDelivery> rows = page.deliveries();
            if (!rows.isEmpty()) {
                ChannelDelivery last = rows.get(rows.size() - 1);
                cursor = new DeliveryCursor(last.createdAt(),
                        last.deliveryId());
            }
            pages++;
        } while (page.hasMore());
        assertEquals(3, pages);
        assertEquals(205, all.size());
        Set<String> ids = new HashSet<>();
        ChannelDelivery previous = null;
        for (ChannelDelivery row : all) {
            assertTrue(ids.add(row.deliveryId()), "duplicate row in pages");
            if (previous != null) {
                assertTrue(previous.createdAt() > row.createdAt()
                        || previous.createdAt() == row.createdAt()
                                && previous.deliveryId().compareTo(
                                        row.deliveryId()) > 0,
                        "newest-first order with a stable tiebreak");
            }
            previous = row;
        }
        assertTrue(deliveries.listByChannel(tenant, channel, null, 100)
                .hasMore());
        assertTrue(deliveries
                .listByChannel(prefix + "-other", channel, null, 100)
                .deliveries().isEmpty());
        assertThrows(IllegalArgumentException.class,
                () -> deliveries.listByChannel(tenant, channel, null, 0));
        assertThrows(IllegalArgumentException.class,
                () -> deliveries.listByChannel(tenant, channel, null, 101));

        // Equal created times stay a stable total order through the id
        // tiebreak; written directly, as the repository never inserts them.
        String tieChannel = "channel-ties";
        long tieTime = 4_000_000_000_000L;
        List<String> tieIds = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            tieIds.add("tie-" + i);
            jdbc.update("INSERT INTO qwen_managed_channel_delivery (tenant_id,"
                            + " channel_instance_id, delivery_id, segment_id,"
                            + " segment_ordinal, state, provider_receipt,"
                            + " created_at, updated_at) VALUES (?, ?, ?, ?,"
                            + " ?, ?, ?, ?, ?)",
                    tenant, tieChannel, "tie-" + i, "segment-" + i, 0,
                    "planned", null, tieTime, tieTime);
        }
        tieIds.sort(Comparator.reverseOrder());
        assertEquals(tieIds, deliveries
                .listByChannel(tenant, tieChannel, null, 100).deliveries()
                .stream().map(ChannelDelivery::deliveryId).toList());
    }

    private static ChannelRoute route(String tenant, String channel,
            long generation, String eventId, long revision, String inputId,
            List<String> stagedRefs) {
        return new ChannelRoute(tenant,
                ChannelRouteRepository.routeKey(tenant, channel, generation,
                        eventId, revision),
                channel, generation, eventId, revision, SESSION,
                "sender-1", null, null,
                inputId == null ? "staged" : "admitted", inputId, stagedRefs,
                0, 0);
    }

    private static ChannelDelivery delivery(String tenant, String channel,
            String deliveryId, String segmentId, int ordinal) {
        return new ChannelDelivery(tenant, channel, deliveryId, segmentId,
                ordinal, "planned", null, 0, 0);
    }

    private static int count(JdbcTemplate jdbc, String table, String tenant) {
        Integer total = jdbc.queryForObject("SELECT COUNT(*) FROM " + table
                + " WHERE tenant_id = ?", Integer.class, tenant);
        return total == null ? 0 : total;
    }
}
