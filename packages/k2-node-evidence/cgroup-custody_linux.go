//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

type peerIdentity = runtimePeer

func startTicks(pid uint32) (uint64, error) {
	raw, err := os.ReadFile("/proc/" + strconv.FormatUint(uint64(pid), 10) + "/stat")
	if err != nil || len(raw) > 4096 {
		return 0, errors.New("original process identity unavailable")
	}
	return parseStartTicks(raw)
}

func parseStartTicks(raw []byte) (uint64, error) {
	end := strings.LastIndex(string(raw), ") ")
	if end < 0 {
		return 0, errors.New("invalid original process identity")
	}
	fields := strings.Fields(string(raw[end+2:]))
	if len(fields) < 20 {
		return 0, errors.New("incomplete original process identity")
	}
	ticks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || ticks == 0 {
		return 0, errors.New("invalid original process start time")
	}
	return ticks, nil
}

func unixPeer(connection net.Conn) (peerIdentity, error) {
	conn, ok := connection.(*net.UnixConn)
	if !ok {
		return peerIdentity{}, errors.New("original backend must be a Unix socket")
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return peerIdentity{}, err
	}
	var credentials *unix.Ucred
	var peerErr error
	if err = raw.Control(func(fd uintptr) {
		credentials, peerErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil || peerErr != nil || credentials == nil || credentials.Uid != 0 || credentials.Pid <= 0 {
		return peerIdentity{}, errors.New("original backend peer is unavailable")
	}
	ticks, err := startTicks(uint32(credentials.Pid))
	if err != nil {
		return peerIdentity{}, err
	}
	f, err := os.Open("/proc/" + strconv.FormatInt(int64(credentials.Pid), 10) + "/exe")
	if err != nil {
		return peerIdentity{}, errors.New("original backend executable is unavailable")
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, 128<<20+1))
	if err != nil || n == 0 || n > 128<<20 {
		return peerIdentity{}, errors.New("original backend executable exceeds the supported bound")
	}
	after, err := startTicks(uint32(credentials.Pid))
	if err != nil || after != ticks {
		return peerIdentity{}, errors.New("original backend process changed")
	}
	return peerIdentity{credentials.Pid, ticks, hex.EncodeToString(h.Sum(nil))}, nil
}

type kernelCustody struct {
	pidfd     int
	process   int
	procID    kernelObject
	security  *processSecurity
	directory int
	parent    int
	events    int
	eventsID  kernelObject
	initial   custodyObservation
	path      string
	closed    bool
	failed    bool
}

func parseProcessCgroup(raw []byte) (string, error) {
	if len(raw) > 4096 || !strings.HasPrefix(string(raw), "0::/") || strings.Count(string(raw), "\n") != 1 || !strings.HasSuffix(string(raw), "\n") {
		return "", errors.New("original process requires a single unified cgroup")
	}
	path := strings.TrimSuffix(strings.TrimPrefix(string(raw), "0::/"), "\n")
	if path == "" {
		return "", errors.New("original process cannot own the cgroup root")
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\x00\r\n") {
			return "", errors.New("invalid original cgroup path")
		}
	}
	return path, nil
}

func procFile(process int, name string) ([]byte, error) {
	fd, err := policyOpen(process, name, false)
	if err != nil {
		return nil, errors.New("original proc entry unavailable")
	}
	defer unix.Close(fd)
	if policyKind(fd, unix.PROC_SUPER_MAGIC, unix.S_IFREG) != nil {
		return nil, errors.New("original proc entry is not a kernel file")
	}
	var raw [4097]byte
	n, err := unix.Pread(fd, raw[:], 0)
	if err != nil || n == 0 || n == len(raw) {
		return nil, errors.New("original proc entry read failed")
	}
	return raw[:n], nil
}

func (c *kernelCustody) processIdentity() (uint64, string, error) {
	object, err := policyObject(c.process)
	if err != nil || object != c.procID || policyKind(c.process, unix.PROC_SUPER_MAGIC, unix.S_IFDIR) != nil {
		return 0, "", errors.New("original proc directory has been lost")
	}
	rawStat, err := procFile(c.process, "stat")
	if err != nil {
		return 0, "", err
	}
	ticks, err := parseStartTicks(rawStat)
	if err != nil {
		return 0, "", err
	}
	rawCgroup, err := procFile(c.process, "cgroup")
	if err != nil {
		return 0, "", err
	}
	path, err := parseProcessCgroup(rawCgroup)
	return ticks, path, err
}

func (c *kernelCustody) verifyRunningSecurity() error {
	return c.verifyRunningSecurityProfile(workerProfile)
}

func (c *kernelCustody) verifyRunningSecurityProfile(profile string) error {
	fail := func() error {
		c.failed = true
		return errors.New("original running process security changed")
	}
	before, err := c.observe()
	if err != nil || before.Terminal {
		return fail()
	}
	raw, err := procFile(c.process, "status")
	if err != nil {
		return fail()
	}
	current, err := parseProcessSecurity(raw)
	if err != nil || !current.worker() || c.security != nil && current != *c.security {
		return fail()
	}
	label, err := procFile(c.process, "attr/apparmor/current")
	if err != nil || string(label) != profile+" (enforce)\n" {
		return fail()
	}
	after, err := c.observe()
	if err != nil || after.Terminal || before != after {
		return fail()
	}
	if c.security == nil {
		c.security = &current
	}
	return nil
}

func openOriginalCustody(original runtimeObservation) (_ *kernelCustody, err error) {
	if original.PID == 0 || original.State != "created" && original.State != "running" {
		return nil, errors.New("original process must be observed before termination")
	}
	return openCreatedCustody(original.PID, original.PodUID, original.ContainerID)
}

func openCreatedCustody(pid uint32, podUID, containerID string) (_ *kernelCustody, err error) {
	if pid == 0 || !safeID(podUID) || !hashString(containerID) {
		return nil, errors.New("actual created init identity is required")
	}
	c := &kernelCustody{pidfd: -1, process: -1, directory: -1, parent: -1, events: -1}
	defer func() {
		if err != nil {
			c.close()
		}
	}()
	proc, err := unix.Open("/proc", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("original proc root unavailable")
	}
	defer unix.Close(proc)
	if policyKind(proc, unix.PROC_SUPER_MAGIC, unix.S_IFDIR) != nil {
		return nil, errors.New("original proc root is not a kernel filesystem")
	}
	c.process, err = policyOpen(proc, strconv.FormatUint(uint64(pid), 10), true)
	if err != nil {
		return nil, errors.New("original proc directory could not be retained")
	}
	c.procID, err = policyObject(c.process)
	if err != nil {
		return nil, err
	}
	ticks, path, err := c.processIdentity()
	if err != nil {
		return nil, err
	}
	c.path = path
	parentPath, err := originalPodParent(path, podUID, containerID)
	if err != nil {
		return nil, err
	}
	c.pidfd, err = unix.PidfdOpen(int(pid), 0)
	if err != nil {
		return nil, errors.New("original pidfd could not be retained")
	}
	root, err := unix.Open("/sys/fs/cgroup", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("original cgroup root unavailable")
	}
	defer unix.Close(root)
	var filesystem unix.Statfs_t
	if err = unix.Fstatfs(root, &filesystem); err != nil || filesystem.Type != unix.CGROUP2_SUPER_MAGIC {
		err = errors.New("original cgroup root is not a unified kernel filesystem")
		return nil, err
	}
	c.directory, err = unix.Openat2(root, path, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, errors.New("original cgroup directory could not be retained")
	}
	c.parent, err = unix.Openat2(root, parentPath, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, errors.New("original Pod parent directory could not be retained")
	}
	c.events, err = unix.Openat(c.parent, "cgroup.events", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("original cgroup events could not be retained")
	}
	c.eventsID, err = policyObject(c.events)
	if err != nil || policyKind(c.events, unix.CGROUP2_SUPER_MAGIC, unix.S_IFREG) != nil {
		return nil, errors.New("original parent events is not a retained kernel object")
	}
	var stat unix.Stat_t
	if err = unix.Fstat(c.directory, &stat); err != nil {
		return nil, errors.New("original cgroup identity unavailable")
	}
	c.initial = custodyObservation{PID: pid, StartTicks: ticks, CgroupDevice: uint64(stat.Dev), CgroupInode: stat.Ino}
	if err = unix.Fstat(c.parent, &stat); err != nil || uint64(stat.Dev) != c.initial.CgroupDevice || stat.Ino == 0 || stat.Ino == c.initial.CgroupInode {
		return nil, errors.New("original Pod parent must be a distinct same-filesystem object")
	}
	c.initial.Coverage, c.initial.ParentDevice, c.initial.ParentInode = parentCoverage, uint64(stat.Dev), stat.Ino
	actualParent, err := unix.Openat2(c.directory, "..", &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, errors.New("original leaf parent is unavailable")
	}
	parentObject, parentErr := policyObject(actualParent)
	closeErr := unix.Close(actualParent)
	if parentErr != nil || closeErr != nil || parentObject != (kernelObject{Device: c.initial.ParentDevice, Inode: c.initial.ParentInode}) {
		return nil, errors.New("retained parent does not own the original leaf")
	}
	afterTicks, afterPath, identityErr := c.processIdentity()
	if identityErr != nil || afterTicks != ticks || afterPath != path {
		err = errors.New("original process changed during custody binding")
		return nil, err
	}
	first, err := c.observe()
	if err != nil {
		return nil, err
	}
	if first.Terminal || !first.Populated {
		err = errors.New("original custody must begin before termination")
		return nil, err
	}
	c.initial = first
	return c, nil
}

func (c *kernelCustody) observe() (custodyObservation, error) {
	if c.closed || c.failed {
		return custodyObservation{}, errors.New("original custody has been lost")
	}
	fail := func() (custodyObservation, error) {
		c.failed = true
		return custodyObservation{}, errors.New("original kernel observation failed")
	}
	var stat unix.Stat_t
	if unix.Fstat(c.directory, &stat) != nil || uint64(stat.Dev) != c.initial.CgroupDevice || stat.Ino != c.initial.CgroupInode {
		return fail()
	}
	if unix.Fstat(c.parent, &stat) != nil || uint64(stat.Dev) != c.initial.ParentDevice || stat.Ino != c.initial.ParentInode ||
		policyKind(c.parent, unix.CGROUP2_SUPER_MAGIC, unix.S_IFDIR) != nil || stat.Nlink == 0 {
		return fail()
	}
	object, err := policyObject(c.process)
	if err != nil || object != c.procID || policyKind(c.process, unix.PROC_SUPER_MAGIC, unix.S_IFDIR) != nil {
		return fail()
	}
	poll := []unix.PollFd{{Fd: int32(c.pidfd), Events: unix.POLLIN}}
	if _, err := unix.Poll(poll, 0); err != nil || poll[0].Revents&(unix.POLLNVAL|unix.POLLERR) != 0 {
		return fail()
	}
	result := c.initial
	result.Terminal = poll[0].Revents&(unix.POLLIN|unix.POLLHUP) != 0
	if !result.Terminal {
		ticks, path, err := c.processIdentity()
		if err != nil || ticks != result.StartTicks || path != c.path {
			return fail()
		}
	}
	var raw [1025]byte
	events, err := policyObject(c.events)
	if err != nil || events != c.eventsID || policyKind(c.events, unix.CGROUP2_SUPER_MAGIC, unix.S_IFREG) != nil {
		return fail()
	}
	n, err := unix.Pread(c.events, raw[:], 0)
	if err != nil || n == 0 || n == len(raw) {
		return fail()
	}
	fields := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSuffix(string(raw[:n]), "\n"), "\n") {
		pair := strings.Split(line, " ")
		if len(pair) != 2 || pair[0] != "populated" && pair[0] != "frozen" || pair[1] != "0" && pair[1] != "1" || fields[pair[0]] != "" {
			return fail()
		}
		fields[pair[0]] = pair[1]
	}
	if len(fields) != 2 || fields["frozen"] != "0" {
		return fail()
	}
	result.Populated = fields["populated"] == "1"
	return result, nil
}

func (c *kernelCustody) close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	var err error
	for _, fd := range []int{c.events, c.parent, c.directory, c.process, c.pidfd} {
		if fd >= 0 {
			err = errors.Join(err, unix.Close(fd))
		}
	}
	return err
}
