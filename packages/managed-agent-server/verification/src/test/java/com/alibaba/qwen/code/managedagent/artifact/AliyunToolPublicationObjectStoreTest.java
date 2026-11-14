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
import com.aliyun.oss.model.PutObjectRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.ByteArrayInputStream;
import java.io.IOException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
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
        verify(client, never()).putObject(any(PutObjectRequest.class));
    }

    @Test
    void openRangeDoesNotReprobeVersioning() throws IOException {
        var objects = store();
        // The constructor itself probes versioning once; only the range read is under test.
        clearInvocations(client);
        var object = new OSSObject();
        object.setObjectContent(new ByteArrayInputStream(new byte[] {1, 2, 3}));
        when(client.getObject(any(GetObjectRequest.class))).thenReturn(object);
        try (var input = objects.openRange("exact/key", 0, 3, () -> {})) {
            assertThat(input.readAllBytes()).containsExactly(1, 2, 3);
        }
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
