package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import org.springframework.http.HttpStatus;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

final class WorkspaceLocalDirectories {
    private final List<Path> privateRoots;

    WorkspaceLocalDirectories(ManagedAgentProperties properties) {
        var broker = properties.getRuntimeBroker();
        privateRoots = new ArrayList<>();
        for (String value : List.of(broker.getStateDirectory(), broker.getWorkspaceCreationRoot())) {
            if (!value.isBlank()) {
                privateRoots.add(Path.of(value).toAbsolutePath().normalize());
            }
        }
    }

    Path project(String value) {
        try {
            Path requested = Path.of(value);
            if (!requested.isAbsolute() || Files.isSymbolicLink(requested)
                    || value.codePoints().anyMatch(Character::isISOControl)) {
                throw invalid();
            }
            Path path = requested.toRealPath();
            if (!Files.isDirectory(path) || !Files.isReadable(path) || !Files.isExecutable(path)) {
                throw invalid();
            }
            for (Path segment : path) {
                if (reserved(segment.toString())) {
                    throw invalid();
                }
            }
            requirePublic(path, false);
            return path;
        } catch (IOException | java.nio.file.InvalidPathException error) {
            throw invalid();
        }
    }

    Path root(Path project) {
        Path root = project.getParent();
        for (Path ancestor = project; ancestor != null; ancestor = ancestor.getParent()) {
            if (Files.exists(ancestor.resolve(".git"), LinkOption.NOFOLLOW_LINKS)) {
                root = ancestor.getParent();
            }
        }
        if (root == null || root.getParent() == null || !Files.isWritable(root)) {
            throw invalid();
        }
        requireStorageRoot(root);
        return root;
    }

    void requireStorageRoot(Path root) {
        requirePublic(root, true);
    }

    WorkspaceCreationStore.DirectoryPage directories(String value) {
        Path directory = project(value.isBlank() ? System.getProperty("user.home") : value);
        List<WorkspaceCreationStore.Directory> children = new ArrayList<>();
        boolean truncated = false;
        try (var entries = Files.newDirectoryStream(directory)) {
            int scanned = 0;
            for (Path child : entries) {
                if (++scanned > 1024) {
                    truncated = true;
                    break;
                }
                if (Files.isDirectory(child, LinkOption.NOFOLLOW_LINKS)) {
                    try {
                        Path path = project(child.toString());
                        if (children.size() == 100) {
                            truncated = true;
                            break;
                        }
                        children.add(new WorkspaceCreationStore.Directory(path.getFileName().toString(),
                                directory.relativize(path).toString()));
                    } catch (ManagedAgentException unavailable) {
                        // Inaccessible and private children are not browse targets.
                    }
                }
            }
        } catch (IOException error) {
            throw invalid();
        }
        children.sort(Comparator.comparing(WorkspaceCreationStore.Directory::name));
        return new WorkspaceCreationStore.DirectoryPage(directory.toString(), ".", children, truncated);
    }

    private void requirePublic(Path path, boolean importing) {
        for (Path configured : privateRoots) {
            try {
                Path root = Files.exists(configured) ? configured.toRealPath() : configured;
                if (path.startsWith(root) || importing && root.startsWith(path)) {
                    throw invalid();
                }
            } catch (IOException error) {
                throw invalid();
            }
        }
    }

    private static boolean reserved(String name) {
        return ".git".equals(name) || ".qwen-child-workspaces".equals(name);
    }

    private static ManagedAgentException invalid() {
        return new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_local_directory",
                "Select an accessible local project directory outside private Runtime state.");
    }
}
