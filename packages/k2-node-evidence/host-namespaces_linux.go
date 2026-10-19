//go:build linux

package main

import (
	"errors"
	"strings"

	"golang.org/x/sys/unix"
)

type hostNamespaces struct {
	files  [2]int
	values [2]kernelObject
	closed bool
}

var hostNamespaceNames = [2]string{"user", "mnt"}
var hostNamespaceKinds = [2]int{unix.CLONE_NEWUSER, unix.CLONE_NEWNS}

func hostNamespaceObject(fd, kind int) (kernelObject, error) {
	value, err := policyObject(fd)
	actual, kindErr := unix.IoctlRetInt(fd, 0xb703)
	if err != nil || kindErr != nil || actual != kind || policyKind(fd, unix.NSFS_MAGIC, unix.S_IFREG) != nil || kind == unix.CLONE_NEWUSER && value.Inode != 4026531837 {
		return kernelObject{}, errors.New("original host namespace type or initial user identity differs")
	}
	return value, nil
}

func openHostNamespaces(process int) (_ *hostNamespaces, err error) {
	n := &hostNamespaces{files: [2]int{-1, -1}}
	defer func() {
		if err != nil {
			n.close()
		}
	}()
	for index, name := range hostNamespaceNames {
		// Only fixed kernel namespace links are followed through the original proc directory.
		n.files[index], err = unix.Openat(process, "ns/"+name, unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		n.values[index], err = hostNamespaceObject(n.files[index], hostNamespaceKinds[index])
		if err != nil {
			return nil, err
		}
	}
	if err = n.verify(process); err != nil {
		return nil, err
	}
	return n, nil
}

func (n *hostNamespaces) verify(process int) error {
	if n == nil || n.closed || policyKind(process, unix.PROC_SUPER_MAGIC, unix.S_IFDIR) != nil {
		return errors.New("original host namespace descriptors are unavailable")
	}
	for index, kind := range hostNamespaceKinds {
		retained, err := hostNamespaceObject(n.files[index], kind)
		if err != nil || retained != n.values[index] {
			return errors.New("retained original host namespace changed")
		}
		fd, err := unix.Openat(process, "ns/"+hostNamespaceNames[index], unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		actual, readErr := hostNamespaceObject(fd, kind)
		closeErr := unix.Close(fd)
		if readErr != nil || closeErr != nil || actual != retained {
			return errors.New("original host process changed its namespace")
		}
	}
	uidMap, err := procFile(process, "uid_map")
	if err != nil || len(uidMap) > 128 || strings.Join(strings.Fields(string(uidMap)), " ") != "0 0 4294967295" {
		return errors.New("original host process is outside the initial user namespace")
	}
	return nil
}

func (n *hostNamespaces) close() error {
	if n == nil || n.closed {
		return nil
	}
	n.closed = true
	var result error
	for _, fd := range n.files {
		if fd >= 0 {
			result = errors.Join(result, unix.Close(fd))
		}
	}
	return result
}

func openHostProcess(name string) (int, error) {
	proc, err := unix.Open("/proc", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	defer unix.Close(proc)
	if policyKind(proc, unix.PROC_SUPER_MAGIC, unix.S_IFDIR) != nil {
		return -1, errors.New("original host process requires the real proc filesystem")
	}
	return policyOpen(proc, name, true)
}
