package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelope;
import com.alibaba.qwen.code.managedagent.store.ManagedEventEnvelopes;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.rocketmq.client.apis.ClientServiceProvider;
import org.apache.rocketmq.client.apis.message.Message;
import org.apache.rocketmq.client.apis.producer.Producer;
import org.apache.rocketmq.client.apis.producer.SendReceipt;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LiteTopicEventTransportTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TENANT = "t1";
    private static final String WORKSPACE = "w1";
    private static final String SESSION = "s1";
    private static final String BOOTSTRAP = "wake-bootstrap";

    private static String eventRecord(long sequence, String eventId,
            String kind) {
        return "{\"subtype\":\"managed_session_event_v1\",\"sessionId\":\""
                + SESSION + "\",\"managedSession\":{\"v\":1,\"sequence\":"
                + sequence + ",\"eventId\":\"" + eventId + "\",\"sessionKey\":"
                + "{\"tenantId\":\"" + TENANT + "\",\"workspaceId\":\""
                + WORKSPACE + "\",\"sessionId\":\"" + SESSION + "\"},\"kind\":\""
                + kind + "\",\"occurredAt\":1760000000000,\"payload\":{}}}";
    }

    private static String commitMarker() {
        return "{\"subtype\":\"managed_session_commit_v1\",\"sessionId\":\""
                + SESSION + "\",\"managedSession\":{}}";
    }

    private static byte[] journalRecord(String... records) {
        return (String.join("\n", records) + "\n")
                .getBytes(StandardCharsets.UTF_8);
    }

    private static String body(Message message) {
        java.nio.ByteBuffer buffer = message.getBody();
        byte[] bytes = new byte[buffer.remaining()];
        buffer.get(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    @Test
    void envelopesOfExtractsEventsAndSkipsTheCommitMarker() {
        byte[] recordBytes = journalRecord(
                eventRecord(1, "evt-1", "input.accepted"),
                eventRecord(2, "evt-2", "wake.requested"),
                commitMarker());
        List<ManagedEventEnvelope> envelopes =
                LiteTopicEventTransport.envelopesOf(recordBytes);
        assertEquals(2, envelopes.size());
        assertEquals("evt-1", envelopes.get(0).eventId());
        assertEquals(1, envelopes.get(0).sequence());
        assertEquals("input.accepted", envelopes.get(0).kind());
        assertEquals(SESSION, envelopes.get(0).sessionId());
        assertEquals(TENANT, envelopes.get(0).tenantId());
        assertEquals(WORKSPACE, envelopes.get(0).workspaceId());
        assertEquals("evt-2", envelopes.get(1).eventId());
        assertEquals("wake.requested", envelopes.get(1).kind());
    }

    @Test
    void envelopeSerializesToTheCanonicalWireForm() throws Exception {
        byte[] recordBytes = journalRecord(
                eventRecord(7, "evt-7", "input.accepted"), commitMarker());
        ManagedEventEnvelope envelope =
                LiteTopicEventTransport.envelopesOf(recordBytes).get(0);
        String json = ManagedEventEnvelopes.toJson(envelope);
        // canonical form: keys sorted, no spaces.
        assertTrue(json.startsWith("{\"eventId\":\"evt-7\""), json);
        assertTrue(json.contains("\"stream\":\"authoritative_journal\""), json);
        assertTrue(json.contains("\"workspaceId\":\"" + WORKSPACE + "\""), json);
        // the wire form round-trips through the contract parser unchanged.
        assertEquals(envelope,
                ManagedEventEnvelopes.parse(JSON.readTree(json)));
    }

    @Test
    void publishCommittedSendsOneMessagePerEventToTheSessionLiteTopic() {
        Producer producer = mock(Producer.class);
        CompletableFuture<SendReceipt> ok = CompletableFuture.completedFuture(null);
        when(producer.sendAsync(any())).thenReturn(ok);
        LiteTopicEventTransport transport = new LiteTopicEventTransport(
                producer, ClientServiceProvider.loadService(), "journal-parent",
                BOOTSTRAP);
        transport.publishCommitted(journalRecord(
                eventRecord(1, "evt-1", "input.accepted"),
                eventRecord(2, "evt-2", "model.attempt"),
                commitMarker()));
        ArgumentCaptor<Message> captor = ArgumentCaptor.forClass(Message.class);
        verify(producer, times(2)).sendAsync(captor.capture());
        List<Message> sent = captor.getAllValues();
        assertEquals("journal-parent", sent.get(0).getTopic());
        assertEquals(SESSION, sent.get(0).getLiteTopic().orElseThrow());
        assertEquals(List.of("evt-1"), List.copyOf(sent.get(0).getKeys()));
        String body = body(sent.get(0));
        assertTrue(body.contains("\"eventId\":\"evt-1\""), body);
        assertTrue(body.contains("\"stream\":\"authoritative_journal\""), body);
        assertEquals("evt-2", sent.get(1).getKeys().iterator().next());
        assertEquals(SESSION, sent.get(1).getLiteTopic().orElseThrow());
    }

    // MQ2c: a wake nobody owns has no subscriber on its Session's LiteTopic,
    // so the same envelope also rides the shared bootstrap lane.
    @Test
    void aWakeAlsoRidesTheBootstrapLiteTopic() {
        Producer producer = mock(Producer.class);
        when(producer.sendAsync(any()))
                .thenReturn(CompletableFuture.completedFuture(null));
        LiteTopicEventTransport transport = new LiteTopicEventTransport(
                producer, ClientServiceProvider.loadService(), "journal-parent",
                BOOTSTRAP);
        transport.publishCommitted(journalRecord(
                eventRecord(1, "evt-1", "input.accepted"),
                eventRecord(2, "evt-2", "wake.requested"),
                commitMarker()));
        ArgumentCaptor<Message> captor = ArgumentCaptor.forClass(Message.class);
        verify(producer, times(3)).sendAsync(captor.capture());
        List<Message> sent = captor.getAllValues();
        assertEquals(List.of(SESSION, SESSION, BOOTSTRAP), sent.stream()
                .map(message -> message.getLiteTopic().orElseThrow())
                .toList());
        assertEquals("evt-2", sent.get(2).getKeys().iterator().next());
        assertEquals(body(sent.get(1)), body(sent.get(2)));
    }

    @Test
    void aSynchronouslyRefusedSendNeitherPropagatesNorSkipsTheRest() {
        Producer producer = mock(Producer.class);
        when(producer.sendAsync(any()))
                .thenThrow(new IllegalStateException("producer closing"))
                .thenReturn(CompletableFuture.completedFuture(null));
        LiteTopicEventTransport transport = new LiteTopicEventTransport(
                producer, ClientServiceProvider.loadService(), "journal-parent",
                BOOTSTRAP);
        transport.publishCommitted(journalRecord(
                eventRecord(1, "evt-1", "wake.requested"), commitMarker()));
        // the session-lane send threw; the bootstrap send still went out.
        verify(producer, times(2)).sendAsync(any());
    }

    @Test
    void publishCommittedIsolatesASendFailure() {
        Producer producer = mock(Producer.class);
        CompletableFuture<SendReceipt> failed = new CompletableFuture<>();
        failed.completeExceptionally(new IllegalStateException("broker down"));
        when(producer.sendAsync(any())).thenReturn(failed);
        LiteTopicEventTransport transport = new LiteTopicEventTransport(
                producer, ClientServiceProvider.loadService(), "journal-parent",
                BOOTSTRAP);
        // must not throw even though every send fails.
        transport.publishCommitted(journalRecord(
                eventRecord(1, "evt-1", "input.accepted"), commitMarker()));
        verify(producer, times(1)).sendAsync(any());
    }

    @Test
    void publishCommittedNeverThrowsOnAMalformedRecord() {
        Producer producer = mock(Producer.class);
        LiteTopicEventTransport transport = new LiteTopicEventTransport(
                producer, ClientServiceProvider.loadService(), "journal-parent",
                BOOTSTRAP);
        // A record that is not valid JSON must not propagate — a transport
        // failure never blocks the commit path (#12380).
        transport.publishCommitted("not json".getBytes(StandardCharsets.UTF_8));
        verify(producer, never()).sendAsync(any());
    }
}
