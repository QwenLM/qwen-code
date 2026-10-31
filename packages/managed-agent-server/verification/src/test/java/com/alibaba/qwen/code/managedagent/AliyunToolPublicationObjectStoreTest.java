package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationStorageException;
import com.aliyun.oss.ClientErrorCode;
import com.aliyun.oss.ClientException;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSException;
import com.aliyun.oss.model.AccessControlList;
import com.aliyun.oss.model.BucketVersioningConfiguration;
import com.aliyun.oss.model.CannedAccessControlList;
import com.aliyun.oss.model.OSSObject;
import com.aliyun.oss.model.PutObjectRequest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AliyunToolPublicationObjectStoreTest {
    private OSS client;
    private AliyunToolPublicationObjectStore store;

    @BeforeEach
    void setUp() {
        client = mock(OSS.class);
        when(client.getBucketVersioning("bucket")).thenReturn(new BucketVersioningConfiguration());
        var acl = new AccessControlList();
        acl.setCannedACL(CannedAccessControlList.Private);
        when(client.getBucketAcl("bucket")).thenReturn(acl);
        store = new AliyunToolPublicationObjectStore(client, "bucket");
    }

    @Test
    void retriesTransientGetAndRechecksTheOriginalGuard() throws IOException {
        when(client.getObject("bucket", "key")).thenThrow(error("InternalError"))
                .thenReturn(object(new ByteArrayInputStream(new byte[] {1, 2, 3})));
        var checks = new AtomicInteger();
        try (var input = store.open("key", checks::incrementAndGet)) {
            assertThat(input.readAllBytes()).containsExactly(1, 2, 3);
        }
        assertThat(checks.get()).isEqualTo(3);
        verify(client, times(2)).getObject("bucket", "key");
    }

    @Test
    void expiryAfterFirstGetFailurePreventsAnotherNetworkAttempt() {
        var live = new AtomicBoolean(true);
        when(client.getObject("bucket", "key")).thenAnswer(call -> {
            live.set(false);
            throw error("InternalError");
        });
        assertThatThrownBy(() -> store.open("key", () -> {
            if (!live.get()) {
                throw new IllegalStateException("lease expired");
            }
        })).hasMessage("lease expired");
        verify(client).getObject("bucket", "key");
    }

    @Test
    void persistentTransientFailureStopsAfterThreeRetries() {
        var failure = error("InternalError");
        when(client.getObject("bucket", "key")).thenThrow(failure);
        assertThatThrownBy(() -> store.open("key"))
                .isInstanceOf(ToolPublicationStorageException.class).hasCause(failure);
        verify(client, times(4)).getObject("bucket", "key");
    }

    @Test
    void aTimedOutOpenIsRetried() throws IOException {
        // The configuration reference's read-timeout row promises this retry:
        // an open that times out before the response is reissued, while a
        // stall inside the returned body is not (aReturnedBodyIsNeverReplayed).
        when(client.getObject("bucket", "key")).thenThrow(timeout(ClientErrorCode.SOCKET_TIMEOUT))
                .thenReturn(object(new ByteArrayInputStream(new byte[] {1, 2, 3})));
        try (var input = store.open("key")) {
            assertThat(input.readAllBytes()).containsExactly(1, 2, 3);
        }
        verify(client, times(2)).getObject("bucket", "key");
    }

    @Test
    void persistentTimeoutsStopAfterThreeRetries() {
        for (String code : new String[] {ClientErrorCode.SOCKET_TIMEOUT, ClientErrorCode.CONNECTION_TIMEOUT}) {
            clearInvocations(client);
            var failure = timeout(code);
            doThrow(failure).when(client).getObject("bucket", "key");
            assertThatThrownBy(() -> store.open("key"))
                    .isInstanceOf(ToolPublicationStorageException.class).hasCause(failure);
            verify(client, times(4)).getObject("bucket", "key");
        }
    }

    @Test
    void permanentOrUnclassifiedErrorsAreNotRetried() {
        for (RuntimeException failure : new RuntimeException[] {
                error("AccessDenied"), error("NoSuchKey"), new ClientException("unknown")}) {
            doThrow(failure).when(client).getObject("bucket", "key");
            assertThatThrownBy(() -> store.open("key"))
                    .isInstanceOf(ToolPublicationStorageException.class).hasCause(failure);
        }
        verify(client, times(3)).getObject("bucket", "key");
    }

    @Test
    void interruptionStopsBackoffAndPreservesTheInterrupt() {
        when(client.getObject("bucket", "key")).thenAnswer(call -> {
            Thread.currentThread().interrupt();
            throw error("InternalError");
        });
        try {
            assertThatThrownBy(() -> store.open("key"))
                    .hasMessage("Publication read retry interrupted")
                    .hasCauseInstanceOf(InterruptedException.class);
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
            verify(client).getObject("bucket", "key");
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    void aReturnedBodyIsNeverReplayed() throws IOException {
        var body = new InputStream() {
            @Override
            public int read() throws IOException {
                throw new IOException("body failed");
            }
        };
        when(client.getObject("bucket", "key")).thenReturn(object(body));
        try (var input = store.open("key")) {
            assertThatThrownBy(input::read).isInstanceOf(IOException.class).hasMessage("body failed");
        }
        verify(client).getObject("bucket", "key");
    }

    @Test
    void putFailurePropagatesWithoutSendingAnotherPut() {
        var failure = error("InternalError");
        when(client.putObject(any(PutObjectRequest.class))).thenThrow(failure);
        assertThatThrownBy(() -> store.putIfAbsent("key", new byte[] {1}))
                .isInstanceOf(ToolPublicationStorageException.class).hasCause(failure);
        verify(client).putObject(any(PutObjectRequest.class));
    }

    @Test
    void storageDenialHasTheSameNeutralReasonForEveryOperation() {
        var denied = error("AccessDenied");
        when(client.getObject("bucket", "key")).thenThrow(denied);
        when(client.putObject(any(PutObjectRequest.class))).thenThrow(denied);
        doThrow(denied).when(client).deleteObject("bucket", "key");
        for (Runnable operation : new Runnable[] {
                () -> store.open("key"), () -> store.putIfAbsent("key", new byte[] {1}),
                () -> store.deleteIfPresent("key")}) {
            assertThatThrownBy(operation::run).isInstanceOfSatisfying(ToolPublicationStorageException.class,
                    error -> assertThat(error.getReason())
                            .isEqualTo(ToolPublicationStorageException.Reason.ACCESS_DENIED))
                    .hasCause(denied);
        }
    }

    private static OSSObject object(InputStream stream) {
        var object = new OSSObject();
        object.setObjectContent(stream);
        return object;
    }

    private static OSSException error(String code) {
        return new OSSException("fixture", code, "request", "host", "bucket", "key", "resource");
    }

    private static ClientException timeout(String code) {
        // The one-argument constructor leaves the code null, which the store
        // treats as unclassified and never retries.
        return new ClientException("fixture", code, "request");
    }
}
