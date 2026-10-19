//go:build linux

package main

import (
	"errors"
	"strings"

	"golang.org/x/sys/unix"
)

const kubeletRoot = "/var/lib/kubelet"

func originalTarget(scope originalScope) (string, error) {
	prefix := kubeletRoot + "/pods/" + scope.PodUID + "/volumes/kubernetes.io~csi/"
	if !safeID(scope.PodUID) || !strings.HasPrefix(scope.Target, prefix) {
		return "", errors.New("original CSI target is outside its Pod")
	}
	tail := strings.TrimPrefix(scope.Target, prefix)
	parts := strings.Split(tail, "/")
	if len(parts) != 2 || !safeID(parts[0]) || parts[1] != "mount" {
		return "", errors.New("unsupported original CSI target")
	}
	return strings.TrimPrefix(scope.Target, kubeletRoot+"/"), nil
}

func readTarget(scope originalScope, parent bool) (targetIdentity, error) {
	relative, err := originalTarget(scope)
	if err != nil {
		return targetIdentity{}, err
	}
	if parent {
		relative = strings.TrimSuffix(relative, "/mount")
	}
	root, err := unix.Open(kubeletRoot, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return targetIdentity{}, err
	}
	defer unix.Close(root)
	fd, err := unix.Openat2(root, relative, &unix.OpenHow{Flags: unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return targetIdentity{}, err
	}
	defer unix.Close(fd)
	var stat unix.Statx_t
	mask := unix.STATX_INO | unix.STATX_MNT_ID
	if err := unix.Statx(fd, "", unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW, mask, &stat); err != nil || stat.Mask&uint32(mask) != uint32(mask) || stat.Ino == 0 || stat.Mnt_id == 0 {
		return targetIdentity{}, errors.New("original CSI target identity unavailable")
	}
	return targetIdentity{Device: unix.Mkdev(stat.Dev_major, stat.Dev_minor), Inode: stat.Ino, MountID: stat.Mnt_id}, nil
}

func targetUnmounted(scope originalScope) error {
	target, err := readTarget(scope, false)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	parent, err := readTarget(scope, true)
	if err != nil || target.MountID != parent.MountID {
		return errors.New("original CSI target is mounted or unknown")
	}
	return nil
}
