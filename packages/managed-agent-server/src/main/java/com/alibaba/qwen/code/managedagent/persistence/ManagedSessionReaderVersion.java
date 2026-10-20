package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.security.PublicSurface;
import org.springframework.http.HttpStatus;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/** The ceiling of a remote Store reader; in-process readers support both formats. */
final class ManagedSessionReaderVersion {
    static final String HEADER = "X-Qwen-Managed-Max-Readable-Storage-Version";
    static final int SUPPORTED = 2;

    private ManagedSessionReaderVersion() {}

    static void requireReadable(int floor) {
        int ceiling = SUPPORTED;
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attributes) {
            var request = attributes.getRequest();
            String path = PublicSurface.pathWithinApplication(request);
            if (path.startsWith("/internal/managed-session-store/")
                    || path.startsWith("/internal/managed-tool-publications/")) {
                String header = request.getHeader(HEADER);
                if (header != null && !header.matches("[12]")) {
                    throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_managed_session_reader_version",
                            "The Managed Session reader version is invalid.");
                }
                ceiling = header == null ? 1 : Integer.parseInt(header);
            }
        }
        if (floor > ceiling) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "managed_session_reader_version_unsupported",
                    "This reader cannot read the Managed Session storage version.");
        }
    }
}
