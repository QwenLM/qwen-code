//go:build linux

package birth

import (
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

type Peer struct {
	PID          int32  `json:"pid"`
	StartTicks   uint64 `json:"startTicks"`
	Executable   Object `json:"executable"`
	Label        string `json:"label"`
	process      *os.File
	executable   *os.File
	pidfd        int
	namespaces   [2]*os.File
	namespaceIDs [2]peerNamespace
}

type peerNamespace struct {
	device uint64
	inode  uint64
}

var peerNamespaceNames = [2]string{"user", "mnt"}
var peerNamespaceKinds = [2]int{unix.CLONE_NEWUSER, unix.CLONE_NEWNS}

func peerNamespaceObject(file *os.File, kind int) (peerNamespace, error) {
	var stat unix.Stat_t
	var fs unix.Statfs_t
	if file == nil || unix.Fstat(int(file.Fd()), &stat) != nil || unix.Fstatfs(int(file.Fd()), &fs) != nil {
		return peerNamespace{}, errors.New("original peer namespace is unavailable")
	}
	actual, err := unix.IoctlRetInt(int(file.Fd()), 0xb703)
	if err != nil || fs.Type != unix.NSFS_MAGIC || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Ino == 0 || actual != kind || kind == unix.CLONE_NEWUSER && stat.Ino != 4026531837 {
		return peerNamespace{}, errors.New("original peer namespace type or initial user identity differs")
	}
	return peerNamespace{uint64(stat.Dev), stat.Ino}, nil
}

func openPeerNamespace(process *os.File, name string, kind int) (*os.File, peerNamespace, error) {
	// These fixed proc entries are kernel namespace links, not caller-provided paths.
	fd, err := unix.Openat(int(process.Fd()), "ns/"+name, unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, peerNamespace{}, err
	}
	file := os.NewFile(uintptr(fd), "original-peer-namespace")
	value, err := peerNamespaceObject(file, kind)
	if err != nil {
		return nil, peerNamespace{}, errors.Join(err, file.Close())
	}
	return file, value, nil
}

func (p *Peer) verifyNamespaces() error {
	for index, kind := range peerNamespaceKinds {
		retained, err := peerNamespaceObject(p.namespaces[index], kind)
		if err != nil || retained != p.namespaceIDs[index] {
			return errors.New("retained original peer namespace changed")
		}
		file, actual, err := openPeerNamespace(p.process, peerNamespaceNames[index], kind)
		if err != nil {
			return err
		}
		closeErr := file.Close()
		if closeErr != nil || actual != retained {
			return errors.New("original pre-exec peer changed its namespace")
		}
	}
	fd, err := unix.Openat(int(p.process.Fd()), "uid_map", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), "original-peer-uid-map")
	raw, readErr := io.ReadAll(io.LimitReader(file, 129))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || len(raw) > 128 || strings.Join(strings.Fields(string(raw)), " ") != "0 0 4294967295" {
		return errors.New("original pre-exec peer is outside the initial user namespace")
	}
	return nil
}

func processStart(process *os.File) (uint64, error) {
	fd, err := unix.Openat(int(process.Fd()), "stat", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return 0, err
	}
	f := os.NewFile(uintptr(fd), "stat")
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 4097))
	end := strings.LastIndex(string(raw), ") ")
	if err != nil || len(raw) > 4096 || end < 0 {
		return 0, errors.New("pre-exec peer process identity is unavailable")
	}
	fields := strings.Fields(string(raw[end+2:]))
	if len(fields) < 20 {
		return 0, errors.New("incomplete pre-exec peer process identity")
	}
	ticks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || ticks == 0 {
		return 0, errors.New("invalid pre-exec peer process start")
	}
	return ticks, nil
}

func processLabel(process *os.File) (string, error) {
	fd, err := unix.Openat2(int(process.Fd()), "attr/apparmor/current", &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return "", err
	}
	f := os.NewFile(uintptr(fd), "apparmor/current")
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(raw) > 4096 || !strings.HasSuffix(string(raw), " (enforce)\n") {
		return "", errors.New("pre-exec peer requires its enforced profile")
	}
	return strings.TrimSuffix(string(raw), " (enforce)\n"), nil
}

func OpenPeer(connection *net.UnixConn, expectedSHA, label string) (_ *Peer, err error) {
	if !Hash(expectedSHA) || label == "" {
		return nil, errors.New("fixed pre-exec peer policy is required")
	}
	raw, err := connection.SyscallConn()
	if err != nil {
		return nil, err
	}
	var credentials *unix.Ucred
	var peerErr error
	if err = raw.Control(func(fd uintptr) {
		credentials, peerErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil || peerErr != nil || credentials == nil || credentials.Uid != 0 || credentials.Gid != 0 || credentials.Pid <= 0 {
		return nil, errors.New("pre-exec peer credentials are unavailable")
	}
	peer := &Peer{PID: credentials.Pid, Label: label, pidfd: -1}
	defer func() {
		if err != nil {
			peer.Close()
		}
	}()
	proc, err := unix.Open("/proc", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(proc)
	var fs unix.Statfs_t
	if unix.Fstatfs(proc, &fs) != nil || fs.Type != unix.PROC_SUPER_MAGIC {
		return nil, errors.New("pre-exec peer requires the real proc filesystem")
	}
	fd, err := unix.Openat2(proc, strconv.FormatInt(int64(peer.PID), 10), &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, err
	}
	peer.process = os.NewFile(uintptr(fd), "original-peer")
	peer.StartTicks, err = processStart(peer.process)
	if err != nil {
		return nil, err
	}
	peer.pidfd, err = unix.PidfdOpen(int(peer.PID), 0)
	if err != nil {
		return nil, err
	}
	// proc/exe is a kernel link to the actual executable, rather than a caller path.
	fd, err = unix.Openat(int(peer.process.Fd()), "exe", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	peer.executable = os.NewFile(uintptr(fd), "original-executable")
	peer.Executable, err = object(peer.executable, true)
	if err != nil || peer.Executable.SHA256 != expectedSHA {
		return nil, errors.New("actual pre-exec peer executable differs")
	}
	if err = peer.verifyProcess(); err != nil {
		return nil, err
	}
	for index, kind := range peerNamespaceKinds {
		peer.namespaces[index], peer.namespaceIDs[index], err = openPeerNamespace(peer.process, peerNamespaceNames[index], kind)
		if err != nil {
			return nil, err
		}
	}
	if err = peer.Verify(); err != nil {
		return nil, err
	}
	return peer, nil
}

func (p *Peer) Verify() error {
	if err := p.verifyProcess(); err != nil {
		return err
	}
	if err := p.verifyNamespaces(); err != nil {
		return err
	}
	return p.verifyProcess()
}

func (p *Peer) verifyProcess() error {
	if p == nil || p.pidfd < 0 || p.process == nil || p.executable == nil {
		return errors.New("original pre-exec peer is closed")
	}
	poll := []unix.PollFd{{Fd: int32(p.pidfd), Events: unix.POLLIN}}
	if _, err := unix.Poll(poll, 0); err != nil || poll[0].Revents != 0 {
		return errors.New("original pre-exec peer is no longer live")
	}
	ticks, err := processStart(p.process)
	label, labelErr := processLabel(p.process)
	current, objectErr := object(p.executable, true)
	if err != nil || ticks != p.StartTicks || labelErr != nil || label != p.Label || objectErr != nil || current != p.Executable {
		return errors.New("original pre-exec peer changed")
	}
	fd, err := unix.Openat(int(p.process.Fd()), "exe", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), "actual-peer-executable")
	actual, readErr := object(f, true)
	closeErr := f.Close()
	if readErr != nil || closeErr != nil || actual != p.Executable {
		return errors.New("pre-exec peer replaced its executable")
	}
	return nil
}

func (p *Peer) Close() error {
	if p == nil {
		return nil
	}
	var err error
	if p.pidfd >= 0 {
		err = unix.Close(p.pidfd)
		p.pidfd = -1
	}
	for _, file := range []*os.File{p.process, p.executable, p.namespaces[0], p.namespaces[1]} {
		if file != nil {
			err = errors.Join(err, file.Close())
		}
	}
	p.process, p.executable = nil, nil
	p.namespaces = [2]*os.File{}
	return err
}
