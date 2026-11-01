package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.security.PublicSurface;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/** The ceiling of a remote Store reader; in-process readers support both formats. */
@org.springframework.stereotype.Component
public final class ManagedSessionReaderVersion implements com.alibaba.qwen.code.managedagent.contracts.persistence.StorageReadPolicy {
    static final String HEADER = "X-Qwen-Managed-Max-Readable-Storage-Version";
    static final int SUPPORTED = com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedStorageVersions.SUPPORTED;

    public void requireReadable(int floor) {
        int ceiling = SUPPORTED;
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attributes) {
            var request = attributes.getRequest();
            String path = PublicSurface.pathWithinApplication(request);
            if (path.startsWith("/internal/managed-session-store/")
                    || path.startsWith("/internal/managed-tool-publications/")) {
                String header = request.getHeader(HEADER);
                if (header != null && !header.matches("[12]")) {
                    throw new ManagedAgentException(400, "invalid_managed_session_reader_version",
                            "The Managed Session reader version is invalid.");
                }
                ceiling = header == null ? 1 : Integer.parseInt(header);
            }
        }
        if (floor > ceiling) {
            throw new ManagedAgentException(409, "managed_session_reader_version_unsupported",
                    "This reader cannot read the Managed Session storage version.");
        }
    }
}
