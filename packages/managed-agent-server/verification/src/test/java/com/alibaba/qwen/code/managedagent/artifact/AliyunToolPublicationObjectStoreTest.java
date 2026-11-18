package com.alibaba.qwen.code.managedagent.artifact;

import com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationStorageException;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSException;
import com.aliyun.oss.model.AccessControlList;
import com.aliyun.oss.model.BucketVersioningConfiguration;
import com.aliyun.oss.model.CannedAccessControlList;
import com.aliyun.oss.model.GetObjectRequest;
import com.aliyun.oss.model.OSSObject;
import com.aliyun.oss.model.ObjectMetadata;
import com.aliyun.oss.model.PutObjectRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AliyunToolPublicationObjectStoreTest {
    private final OSS client = mock(OSS.class);

    private AliyunToolPublicationObjectStore store() {
        var acl = new AccessControlList();
        acl.setCannedACL(CannedAccessControlList.Private);
        when(client.getBucketAcl("private-bucket")).thenReturn(acl);
        return new AliyunToolPublicationObjectStore(client, "private-bucket");
    }

    @ParameterizedTest
    @ValueSource(strings = {"Enabled", "Suspended"})
    void deletionRejectsVersioningEnabledAfterConstruction(String state) {
        var objects = store();
        when(client.getBucketVersioning("private-bucket"))
                .thenReturn(new BucketVersioningConfiguration(state));
        assertThatThrownBy(() -> objects.deleteIfPresent("exact/key"))
                .isInstanceOf(IllegalStateException.class);
        verify(client, never()).deleteObject("private-bucket", "exact/key");
    }

    @ParameterizedTest
    @ValueSource(strings = {"Enabled", "Suspended"})
    void putRejectsVersioningEnabledAfterConstruction(String state) {
        var objects = store();
        when(client.getBucketVersioning("private-bucket"))
                .thenReturn(new BucketVersioningConfiguration(state));
        assertThatThrownBy(() -> objects.putIfAbsent("exact/key", new byte[] {1}))
                .isInstanceOf(IllegalStateException.class);
        // Cover the sibling stream and File overloads too: a refactor could write
        // through putObject(bucket, key, stream|file[, metadata]) instead of
        // PutObjectRequest, and never() on one overload alone would let that write
        // slip through. The URL overloads take a presigned URL this class never holds.
        verify(client, never()).putObject(any(PutObjectRequest.class));
        verify(client, never()).putObject(anyString(), anyString(), any(InputStream.class));
        verify(client, never()).putObject(anyString(), anyString(), any(InputStream.class), any(ObjectMetadata.class));
        verify(client, never()).putObject(anyString(), anyString(), any(File.class));
        verify(client, never()).putObject(anyString(), anyString(), any(File.class), any(ObjectMetadata.class));
    }

    @Test
    void openRangeRequestsTheExactRangeWithoutAVersioningProbe() throws IOException {
        var objects = store();
        // The constructor itself probes versioning once; only the range read is under test.
        clearInvocations(client);
        var object = new OSSObject();
        object.setObjectContent(new ByteArrayInputStream(new byte[] {1, 2, 3}));
        when(client.getObject(any(GetObjectRequest.class))).thenReturn(object);
        // offset 2, length 3 keeps the inclusive end (offset + length - 1 == 4) distinct
        // from length (3), so setRange(offset, length) cannot pose as the correct mapping;
        // the non-zero offset also excludes setRange(0, length - 1).
        try (var input = objects.openRange("exact/key", 2, 3, () -> {})) {
            assertThat(input.readAllBytes()).containsExactly(1, 2, 3);
        }
        var request = ArgumentCaptor.forClass(GetObjectRequest.class);
        verify(client).getObject(request.capture());
        assertThat(request.getValue().getBucketName()).isEqualTo("private-bucket");
        assertThat(request.getValue().getKey()).isEqualTo("exact/key");
        assertThat(request.getValue().getRange()).containsExactly(2L, 4L);
        verify(client, never()).getBucketVersioning("private-bucket");
    }

    @Test
    void openRangeRetriesTransientReadsAndRerunsTheGuard() throws IOException {
        var objects = store();
        clearInvocations(client);
        var checks = new AtomicInteger();
        var object = new OSSObject();
        object.setObjectContent(new ByteArrayInputStream(new byte[] {1, 2, 3}));
        when(client.getObject(any(GetObjectRequest.class)))
                .thenThrow(new OSSException("fixture", "InternalError", "request", "host", "bucket", "key", "resource"))
                .thenReturn(object);
        try (var input = objects.openRange("exact/key", 2, 3, checks::incrementAndGet)) {
            assertThat(input.readAllBytes()).containsExactly(1, 2, 3);
        }
        // Two guard runs: one before each getObject attempt. The range read retries
        // through read(...) and, like open, never re-probes versioning.
        assertThat(checks.get()).isEqualTo(2);
        verify(client, times(2)).getObject(any(GetObjectRequest.class));
        verify(client, never()).getBucketVersioning("private-bucket");
    }

    @Test
    void unversionedDeletionUsesTheExactBucketAndKey() {
        store().deleteIfPresent("exact/key");
        verify(client).deleteObject("private-bucket", "exact/key");
    }

    @Test
    void deletionPreservesStorageFailures() {
        var objects = store();
        var denied = new OSSException("denied");
        doThrow(denied).when(client).deleteObject("private-bucket", "exact/key");
        assertThatThrownBy(() -> objects.deleteIfPresent("exact/key"))
                .isInstanceOf(ToolPublicationStorageException.class).hasCause(denied);
    }
}
