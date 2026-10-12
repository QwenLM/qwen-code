package main

import (
	"errors"
	"regexp"
	"strings"
)

const parentCoverage = "retained-pod-parent/1"

var podCgroupUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func originalPodParent(path, podUID, containerID string) (string, error) {
	if !podCgroupUID.MatchString(podUID) || !hashString(containerID) {
		return "", errors.New("original Pod cgroup identity is invalid")
	}
	parts := strings.Split(path, "/")
	if len(parts) < 3 {
		return "", errors.New("original Pod parent cannot be the cgroup root")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\x00\r\n") {
			return "", errors.New("invalid original Pod cgroup path")
		}
	}
	parent, leaf := parts[len(parts)-2], parts[len(parts)-1]
	if leaf == containerID && parent == "pod"+podUID && parts[0] == "kubepods" &&
		(len(parts) == 3 || len(parts) == 4 && (parts[1] == "burstable" || parts[1] == "besteffort")) {
		return strings.Join(parts[:len(parts)-1], "/"), nil
	}
	pod := "pod" + strings.ReplaceAll(podUID, "-", "_") + ".slice"
	if parts[0] == "kubepods.slice" && leaf == "cri-containerd-"+containerID+".scope" &&
		(len(parts) == 3 && parent == "kubepods-"+pod || len(parts) == 4 &&
			(parts[1] == "kubepods-burstable.slice" && parent == "kubepods-burstable-"+pod ||
				parts[1] == "kubepods-besteffort.slice" && parent == "kubepods-besteffort-"+pod)) {
		return strings.Join(parts[:len(parts)-1], "/"), nil
	}
	return "", errors.New("original task is not in its supported Pod cgroup")
}
