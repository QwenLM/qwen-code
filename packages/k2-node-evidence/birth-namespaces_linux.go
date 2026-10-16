//go:build linux

package main

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	"github.com/opencontainers/runtime-spec/specs-go"
	"golang.org/x/sys/unix"
)

type retainedBirthNamespaces struct {
	files   [7]int
	root    int
	mounted int
	value   namespaceBirth
	closed  bool
}

var birthNamespaceNames = [7]string{"mnt", "pid", "cgroup", "net", "ipc", "uts", "user"}
var birthNamespaceKinds = [7]int{unix.CLONE_NEWNS, unix.CLONE_NEWPID, unix.CLONE_NEWCGROUP, unix.CLONE_NEWNET, unix.CLONE_NEWIPC, unix.CLONE_NEWUTS, unix.CLONE_NEWUSER}

func openBirthNamespaces(custody *kernelCustody, inputs *birth.Inputs, sandbox *retainedBirthNamespaces, mounted *os.File) (_ *retainedBirthNamespaces, err error) {
	before, err := custody.observe()
	if err != nil || before.Terminal || !before.Populated || inputs.Verify() != nil {
		return nil, errors.New("created init custody and inputs are required")
	}
	n := &retainedBirthNamespaces{files: [7]int{-1, -1, -1, -1, -1, -1, -1}, root: -1, mounted: -1}
	defer func() {
		if err != nil {
			n.close()
		}
	}()
	for index, name := range birthNamespaceNames {
		fd, err := unix.Openat(custody.process, "ns/"+name, unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		n.files[index] = fd
		kind, kindErr := unix.IoctlRetInt(fd, 0xb703)
		n.value.Namespaces[index], err = policyObject(fd)
		if err != nil || kindErr != nil || kind != birthNamespaceKinds[index] || policyKind(fd, unix.NSFS_MAGIC, unix.S_IFREG) != nil {
			return nil, errors.New("created init namespace is not its actual kernel object")
		}
		host, err := unix.Open("/proc/self/ns/"+name, unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		identity, hostErr := policyObject(host)
		closeErr := unix.Close(host)
		if hostErr != nil || closeErr != nil || index == 6 && (identity != n.value.Namespaces[index] || identity.Inode != 4026531837) || index != 6 && identity == n.value.Namespaces[index] {
			return nil, errors.New("created init inherits a host namespace or changes its user namespace")
		}
		if sandbox != nil && (index >= 3 && index <= 5 && sandbox.value.Namespaces[index] != n.value.Namespaces[index] || index <= 2 && sandbox.value.Namespaces[index] == n.value.Namespaces[index]) {
			return nil, errors.New("worker namespace membership differs from the actual original sandbox")
		}
	}
	if sandbox == nil {
		var spec specs.Spec
		if birth.Decode(inputs.Spec, &spec, birth.MaxInputs) != nil || spec.Linux == nil {
			return nil, errors.New("actual sandbox network namespace input is unavailable")
		}
		path := ""
		for _, namespace := range spec.Linux.Namespaces {
			if namespace.Type == specs.NetworkNamespace {
				path = namespace.Path
			}
		}
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return nil, errors.New("sandbox requires its actual CNI network namespace object")
		}
		fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
		if err != nil {
			return nil, err
		}
		actual, readErr := policyObject(fd)
		kind, kindErr := unix.IoctlRetInt(fd, 0xb703)
		closeErr := unix.Close(fd)
		if readErr != nil || kindErr != nil || closeErr != nil || kind != unix.CLONE_NEWNET || actual != n.value.Namespaces[3] {
			return nil, errors.New("sandbox consumes a different CNI namespace")
		}
	}
	n.root, err = unix.Openat(custody.process, "root", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	if mounted == nil {
		return nil, errors.New("actual consumed rootfs descriptor is required")
	}
	flags, flagErr := unix.FcntlInt(mounted.Fd(), unix.F_GETFL, 0)
	if flagErr != nil || flags&unix.O_ACCMODE != unix.O_RDONLY || flags&unix.O_PATH != 0 {
		return nil, errors.New("source must receive the actual rootfs read only")
	}
	n.mounted, err = unix.FcntlInt(mounted.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	n.value.Root, err = policyFS(n.root)
	if err != nil {
		return nil, err
	}
	n.value.MountedRoot, err = policyFS(n.mounted)
	if err != nil {
		return nil, err
	}
	var fs unix.Statfs_t
	if unix.Fstatfs(n.root, &fs) != nil || fs.Flags&unix.ST_RDONLY == 0 || n.value.Root.Device != n.value.MountedRoot.Device || n.value.Root.Inode != n.value.MountedRoot.Inode {
		return nil, errors.New("created init root differs from its actual readonly consumed rootfs")
	}
	n.value.Readonly = true
	after, err := custody.observe()
	if err != nil || before != after {
		return nil, errors.New("created init changed during namespace retention")
	}
	return n, nil
}

func (n *retainedBirthNamespaces) verify(custody *kernelCustody) error {
	if n == nil || n.closed {
		return errors.New("original birth namespaces are closed")
	}
	for index, fd := range n.files {
		current, err := policyObject(fd)
		if err != nil || current != n.value.Namespaces[index] {
			return errors.New("retained birth namespace changed")
		}
		named, err := unix.Openat(custody.process, "ns/"+birthNamespaceNames[index], unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		actual, readErr := policyObject(named)
		closeErr := unix.Close(named)
		if readErr != nil || closeErr != nil || actual != current {
			return errors.New("original init changed its namespace")
		}
	}
	root, err := policyFS(n.root)
	if err != nil || root != n.value.Root {
		return errors.New("retained original init root changed")
	}
	named, err := unix.Openat(custody.process, "root", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	actual, readErr := policyFS(named)
	var fs unix.Statfs_t
	fsErr := unix.Fstatfs(named, &fs)
	closeErr := unix.Close(named)
	if readErr != nil || fsErr != nil || closeErr != nil || actual != root || fs.Flags&unix.ST_RDONLY == 0 {
		return errors.New("original init changed its readonly root")
	}
	return nil
}

func (n *retainedBirthNamespaces) close() error {
	if n == nil || n.closed {
		return nil
	}
	n.closed = true
	var result error
	for _, fd := range append(n.files[:], n.root, n.mounted) {
		if fd >= 0 {
			result = errors.Join(result, unix.Close(fd))
		}
	}
	return result
}
