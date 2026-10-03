package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSException;
import com.aliyun.oss.model.AccessControlList;
import com.aliyun.oss.model.BucketVersioningConfiguration;
import com.aliyun.oss.model.CannedAccessControlList;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

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
        assertThatThrownBy(() -> objects.deleteIfPresent("exact/key")).isSameAs(denied);
    }
}
