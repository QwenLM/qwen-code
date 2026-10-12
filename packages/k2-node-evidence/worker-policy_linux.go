//go:build linux

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"

	"golang.org/x/sys/unix"
)

type fixedWorkerPolicy struct {
	proc     int
	sys      int
	security int
	apparmor int
	root     int
	revision int
	raw      int
	userNS   int
	mountNS  int
	worker   int
	source   int
	rawDir   int
	procFS   policyFilesystem
	sysFS    policyFilesystem
	value    workerPolicy
	closed   bool
}

func policyOpen(root int, path string, directory bool) (int, error) {
	flags := uint64(unix.O_RDONLY | unix.O_CLOEXEC)
	if directory {
		flags |= unix.O_DIRECTORY
	}
	return unix.Openat2(root, path, &unix.OpenHow{Flags: flags, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV})
}

func policyKind(fd int, magic uint64, kind uint32) error {
	var stat unix.Stat_t
	var fs unix.Statfs_t
	if unix.Fstat(fd, &stat) != nil || stat.Mode&unix.S_IFMT != kind || unix.Fstatfs(fd, &fs) != nil || uint64(fs.Type) != magic {
		return errors.New("kernel policy entry type differs")
	}
	return nil
}

func policyMountOpen(root int, path string) (int, error) {
	return unix.Openat2(root, path, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
}

func policyObject(fd int) (kernelObject, error) {
	var stat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil || stat.Ino == 0 {
		return kernelObject{}, errors.New("kernel policy object unavailable")
	}
	return kernelObject{uint64(stat.Dev), stat.Ino}, nil
}

func policyFS(fd int) (policyFilesystem, error) {
	object, err := policyObject(fd)
	var fs unix.Statfs_t
	var stat unix.Statx_t
	if err != nil || unix.Fstatfs(fd, &fs) != nil || unix.Statx(fd, "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &stat) != nil || stat.Mask&unix.STATX_MNT_ID == 0 || stat.Mnt_id == 0 {
		return policyFilesystem{}, errors.New("kernel policy filesystem unavailable")
	}
	return policyFilesystem{object.Device, object.Inode, stat.Mnt_id, uint64(fs.Type)}, nil
}

func policyText(root int, path string) (string, error) {
	fd, err := policyOpen(root, path, false)
	if err != nil {
		return "", errors.New("kernel policy text unavailable")
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	var fs unix.Statfs_t
	if unix.Fstatfs(root, &fs) != nil || policyKind(fd, uint64(fs.Type), unix.S_IFREG) != nil {
		return "", errors.New("kernel policy text type differs")
	}
	raw, err := io.ReadAll(io.LimitReader(f, 2049))
	if err != nil || len(raw) == 0 || len(raw) > 2048 {
		return "", errors.New("kernel policy text exceeds bound")
	}
	return string(raw), nil
}

func policyLink(root int, path string) (string, error) {
	var raw [256]byte
	n, err := unix.Readlinkat(root, path, raw[:])
	if err != nil || n == 0 || n == len(raw) {
		return "", errors.New("kernel policy export link unavailable")
	}
	return string(raw[:n]), nil
}

func (p *fixedWorkerPolicy) profile(name string) (_ string, owned int, _ string, err error) {
	owned = -1
	defer func() {
		if err != nil && owned >= 0 {
			unix.Close(owned)
		}
	}()
	fd, err := policyOpen(p.root, "profiles", true)
	if err != nil {
		return "", owned, "", err
	}
	f := os.NewFile(uintptr(fd), "profiles")
	defer f.Close()
	entries, err := f.ReadDir(4097)
	if err != nil && err != io.EOF || len(entries) > 4096 {
		return "", owned, "", errors.New("kernel profile inventory unavailable")
	}
	var directory, link string
	for _, entry := range entries {
		candidate := entry.Name()
		if !policyDirectory.MatchString(candidate) || candidate == "." || candidate == ".." {
			return "", owned, "", errors.New("unsupported kernel profile directory")
		}
		current, err := policyText(p.root, "profiles/"+candidate+"/name")
		if err != nil {
			return "", owned, "", err
		}
		if current != name+"\n" {
			continue
		}
		if directory != "" {
			return "", owned, "", errors.New("fixed kernel profile is ambiguous")
		}
		mode, err := policyText(p.root, "profiles/"+candidate+"/mode")
		if err != nil || mode != "enforce\n" {
			return "", owned, "", errors.New("fixed kernel profile is not enforcing")
		}
		owned, err = policyOpen(p.root, "profiles/"+candidate, true)
		if err != nil {
			return "", owned, "", err
		}
		link, err = policyLink(owned, "raw_data")
		abi, abiErr := policyLink(owned, "raw_abi")
		sha, shaErr := policyLink(owned, "raw_sha256")
		if err != nil || abiErr != nil || shaErr != nil || abi != strings.TrimSuffix(link, "raw_data")+"abi" || sha != strings.TrimSuffix(link, "raw_data")+"sha256" {
			return "", owned, "", errors.New("fixed kernel export links differ")
		}
		directory = candidate
	}
	if directory == "" {
		return "", owned, "", errors.New("fixed kernel profile is not loaded")
	}
	return directory, owned, link, nil
}

func (p *fixedWorkerPolicy) threadPath(suffix string) string {
	return fmt.Sprintf("%d/task/%d/%s", os.Getpid(), unix.Gettid(), suffix)
}

func (p *fixedWorkerPolicy) namespace(name string, namespaceType int) (int, error) {
	// Only these fixed proc namespace magic entries may be followed.
	fd, err := unix.Openat(p.proc, p.threadPath("ns/"+name), unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, errors.New("source namespace unavailable")
	}
	kind, kindErr := unix.IoctlRetInt(fd, 0xb703) // NS_GET_NSTYPE
	object, objectErr := policyObject(fd)
	if policyKind(fd, unix.NSFS_MAGIC, unix.S_IFREG) != nil || kindErr != nil || kind != namespaceType || objectErr != nil || name == "user" && object.Inode != 4026531837 {
		unix.Close(fd)
		return -1, errors.New("source namespace type differs")
	}
	return fd, nil
}

func openFixedWorkerPolicy(expected string) (_ *fixedWorkerPolicy, err error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if !hashString(expected) {
		return nil, errors.New("reviewed worker policy digest is required")
	}
	p := &fixedWorkerPolicy{proc: -1, sys: -1, security: -1, apparmor: -1, root: -1, revision: -1, raw: -1, userNS: -1, mountNS: -1, worker: -1, source: -1, rawDir: -1}
	defer func() {
		if err != nil {
			p.close()
		}
	}()
	p.proc, err = unix.Open("/proc", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil || policyKind(p.proc, unix.PROC_SUPER_MAGIC, unix.S_IFDIR) != nil {
		return nil, errors.New("source proc filesystem unavailable")
	}
	p.procFS, err = policyFS(p.proc)
	if err != nil {
		return nil, err
	}
	p.sys, err = unix.Open("/sys", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil || policyKind(p.sys, unix.SYSFS_MAGIC, unix.S_IFDIR) != nil {
		return nil, errors.New("source sys filesystem unavailable")
	}
	p.sysFS, err = policyFS(p.sys)
	if err != nil {
		return nil, err
	}
	// This fixed mount boundary is the only ordinary sysfs traversal allowed to cross a device.
	p.security, err = policyMountOpen(p.sys, "kernel/security")
	if err != nil {
		return nil, errors.New("kernel security filesystem unavailable")
	}
	p.value.SecurityfsRoot, err = policyFS(p.security)
	if err != nil || p.value.SecurityfsRoot.Type != unix.SECURITYFS_MAGIC {
		return nil, errors.New("kernel security filesystem differs")
	}
	p.apparmor, err = policyOpen(p.security, "apparmor", true)
	if err != nil {
		return nil, errors.New("kernel AppArmor interface unavailable")
	}
	// This single fixed kernel entry is a namespace-dependent magic link.
	p.root, err = unix.Openat(p.apparmor, "policy", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("kernel AppArmor policy filesystem unavailable")
	}
	p.value.ApparmorfsRoot, err = policyFS(p.root)
	if err != nil || p.value.ApparmorfsRoot.Type != apparmorFSMagic {
		return nil, errors.New("kernel AppArmor policy filesystem differs")
	}
	p.userNS, err = p.namespace("user", unix.CLONE_NEWUSER)
	if err != nil {
		return nil, errors.New("source user namespace unavailable")
	}
	p.value.SourceUserNamespace, err = policyObject(p.userNS)
	if err != nil {
		return nil, err
	}
	p.mountNS, err = p.namespace("mnt", unix.CLONE_NEWNS)
	if err != nil {
		return nil, errors.New("source mount namespace unavailable")
	}
	p.value.SourceMountNamespace, err = policyObject(p.mountNS)
	if err != nil {
		return nil, err
	}
	if err = p.context(); err != nil {
		return nil, err
	}
	var uts unix.Utsname
	if unix.Uname(&uts) != nil {
		return nil, errors.New("kernel release unavailable")
	}
	for _, c := range uts.Release {
		if c == 0 {
			break
		}
		p.value.KernelRelease += string(byte(c))
	}
	p.value.SourceLsmLabel, p.value.ProfileName, p.value.ProfileMode, p.value.GlobalMode, p.value.LockPolicy = sourceProfile+" (enforce)", workerProfile, "enforce", "enforce", true
	p.revision, err = unix.Openat(p.root, "revision", unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("kernel policy revision unavailable")
	}
	if policyKind(p.revision, apparmorFSMagic, unix.S_IFREG) != nil {
		return nil, errors.New("kernel policy revision type differs")
	}
	var revision [64]byte
	n, err := unix.Read(p.revision, revision[:])
	if err != nil || n < 2 || revision[n-1] != '\n' || policyRevision(string(revision[:n-1]), true) != nil {
		return nil, errors.New("kernel policy revision unavailable")
	}
	p.value.NamespaceRevision = string(revision[:n-1])
	p.value.ProfileDirectory, p.worker, p.value.RawLink, err = p.profile(workerProfile)
	if err != nil {
		return nil, err
	}
	p.value.ProfileObject, err = policyObject(p.worker)
	if err != nil {
		return nil, err
	}
	var sourceLink string
	p.value.SourceProfileDirectory, p.source, sourceLink, err = p.profile(sourceProfile)
	if err != nil || sourceLink != p.value.RawLink {
		return nil, errors.New("source and worker must share the reviewed policy bundle")
	}
	p.value.SourceProfileObject, err = policyObject(p.source)
	if err != nil {
		return nil, err
	}
	path, err := policyRawPath(p.value.RawLink)
	if err != nil {
		return nil, err
	}
	p.rawDir, err = policyOpen(p.root, path, true)
	if err != nil {
		return nil, errors.New("kernel packed policy directory unavailable")
	}
	abi, abiErr := policyText(p.rawDir, "abi")
	load, loadErr := policyText(p.rawDir, "revision")
	if abiErr != nil || loadErr != nil || !strings.HasSuffix(abi, "\n") || !strings.HasSuffix(load, "\n") {
		return nil, errors.New("kernel policy export metadata unavailable")
	}
	p.value.RawABI, p.value.LoadRevision = strings.TrimSuffix(abi, "\n"), strings.TrimSuffix(load, "\n")
	probe, err := unix.Openat(p.rawDir, "raw_data", unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("kernel packed policy metadata unavailable")
	}
	var stat unix.Stat_t
	statErr := unix.Fstat(probe, &stat)
	typeErr := policyKind(probe, apparmorFSMagic, unix.S_IFREG)
	unix.Close(probe)
	if statErr != nil || typeErr != nil || stat.Size <= 0 || stat.Size > maxPolicyBytes {
		return nil, errors.New("kernel packed policy size differs")
	}
	p.raw, err = policyOpen(p.rawDir, "raw_data", false)
	if err != nil {
		return nil, errors.New("kernel packed policy export unavailable")
	}
	p.value.RawObject, err = policyObject(p.raw)
	if err != nil || p.value.RawObject != (kernelObject{uint64(stat.Dev), stat.Ino}) {
		return nil, errors.New("kernel packed policy object differs")
	}
	duplicated, err := unix.FcntlInt(uintptr(p.raw), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(duplicated), "kernel packed policy")
	raw, readErr := io.ReadAll(io.LimitReader(f, maxPolicyBytes+1))
	closeErr := f.Close()
	kernelSHA, shaErr := policyText(p.rawDir, "sha256")
	if readErr != nil || closeErr != nil || len(raw) == 0 || len(raw) > maxPolicyBytes || int64(len(raw)) != stat.Size || digest(raw) != expected || shaErr != nil || kernelSHA != expected+"\n" {
		return nil, errors.New("loaded packed policy differs from reviewed artifact")
	}
	p.value.RawSHA256, p.value.RawBytes = expected, uint64(len(raw))
	if err = validatePolicy(&p.value); err != nil {
		return nil, err
	}
	if err = p.verify(); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *fixedWorkerPolicy) context() error {
	if os.Getuid() != 0 || os.Geteuid() != 0 || os.Getgid() != 0 || os.Getegid() != 0 {
		return errors.New("source requires the initial root user namespace")
	}
	rawStatus, statusErr := procFile(p.proc, p.threadPath("status"))
	security, securityErr := parseProcessSecurity(rawStatus)
	if statusErr != nil || securityErr != nil || !security.source() {
		return errors.New("source thread credentials or confinement differ")
	}
	uidMap, err := policyText(p.proc, p.threadPath("uid_map"))
	if err != nil || len(uidMap) > 128 || strings.Join(strings.Fields(string(uidMap)), " ") != "0 0 4294967295" {
		return errors.New("source is outside the initial user namespace")
	}
	label, err := policyText(p.proc, p.threadPath("attr/apparmor/current"))
	if err != nil || string(label) != sourceProfile+" (enforce)\n" {
		return errors.New("source enforce label differs")
	}
	for path, want := range map[string]string{".ns_level": "0\n", ".ns_name": "root\n", ".stacked": "no\n", ".ns_stacked": "no\n"} {
		got, err := policyText(p.apparmor, path)
		if err != nil || got != want {
			return errors.New("source AppArmor namespace differs")
		}
	}
	// systemd's read-only /sys/module bind is an explicit, type-checked boundary.
	params, err := policyMountOpen(p.sys, "module/apparmor/parameters")
	if err != nil {
		return errors.New("kernel policy parameters unavailable")
	}
	defer unix.Close(params)
	fs, err := policyFS(params)
	if err != nil || fs.Type != unix.SYSFS_MAGIC {
		return errors.New("kernel policy parameters filesystem differs")
	}
	for path, want := range map[string]string{"enabled": "Y\n", "mode": "enforce", "lock_policy": "Y\n", "hash_policy": "Y\n", "export_binary": "Y\n"} {
		got, err := policyText(params, path)
		if err != nil || got != want {
			return errors.New("kernel policy is not exported, enforcing and locked")
		}
	}
	return nil
}

func (p *fixedWorkerPolicy) verify() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if p == nil || p.closed || p.context() != nil {
		return errors.New("original loaded worker policy unavailable")
	}
	for name, kind := range map[string]int{"user": unix.CLONE_NEWUSER, "mnt": unix.CLONE_NEWNS} {
		fd, err := p.namespace(name, kind)
		if err != nil {
			return errors.New("current source namespace unavailable")
		}
		current, objectErr := policyObject(fd)
		unix.Close(fd)
		expected := p.value.SourceUserNamespace
		if name == "mnt" {
			expected = p.value.SourceMountNamespace
		}
		if objectErr != nil || current != expected {
			return errors.New("current source namespace differs")
		}
	}
	for path, expected := range map[string]policyFilesystem{"/proc": p.procFS, "/sys": p.sysFS, "/sys/kernel/security": p.value.SecurityfsRoot, "/sys/kernel/security/apparmor/policy": p.value.ApparmorfsRoot} {
		fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		if err != nil {
			return errors.New("current policy filesystem unavailable")
		}
		current, fsErr := policyFS(fd)
		unix.Close(fd)
		if fsErr != nil || current != expected {
			return errors.New("current policy filesystem differs")
		}
	}
	for fd, expected := range map[int]kernelObject{p.userNS: p.value.SourceUserNamespace, p.mountNS: p.value.SourceMountNamespace, p.worker: p.value.ProfileObject, p.source: p.value.SourceProfileObject, p.raw: p.value.RawObject} {
		current, err := policyObject(fd)
		if err != nil || current != expected {
			return errors.New("retained original policy object differs")
		}
	}
	for fd, expected := range map[int]policyFilesystem{p.proc: p.procFS, p.sys: p.sysFS, p.security: p.value.SecurityfsRoot, p.root: p.value.ApparmorfsRoot} {
		current, err := policyFS(fd)
		if err != nil || current != expected {
			return errors.New("retained original policy filesystem differs")
		}
	}
	var revision [64]byte
	if _, err := unix.Read(p.revision, revision[:]); !errors.Is(err, unix.EAGAIN) {
		return errors.New("original policy namespace revision changed")
	}
	for name, expected := range map[string]string{workerProfile: p.value.ProfileDirectory, sourceProfile: p.value.SourceProfileDirectory} {
		directory, fd, link, err := p.profile(name)
		if err != nil {
			return err
		}
		object, objectErr := policyObject(fd)
		unix.Close(fd)
		want := p.value.ProfileObject
		if name == sourceProfile {
			want = p.value.SourceProfileObject
		}
		if objectErr != nil || directory != expected || object != want || link != p.value.RawLink {
			return errors.New("current original policy profile differs")
		}
	}
	path, err := policyRawPath(p.value.RawLink)
	if err != nil {
		return err
	}
	directory, err := policyOpen(p.root, path, true)
	if err != nil {
		return errors.New("current original packed policy directory disappeared")
	}
	dirObject, dirErr := policyObject(directory)
	unix.Close(directory)
	retainedDir, retainedErr := policyObject(p.rawDir)
	if dirErr != nil || retainedErr != nil || dirObject != retainedDir {
		return errors.New("current original packed policy directory differs")
	}
	current, err := unix.Openat(p.rawDir, "raw_data", unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return errors.New("current original packed policy disappeared")
	}
	object, objectErr := policyObject(current)
	typeErr := policyKind(current, apparmorFSMagic, unix.S_IFREG)
	unix.Close(current)
	abi, abiErr := policyText(p.rawDir, "abi")
	load, loadErr := policyText(p.rawDir, "revision")
	sha, shaErr := policyText(p.rawDir, "sha256")
	if objectErr != nil || typeErr != nil || object != p.value.RawObject || abiErr != nil || abi != p.value.RawABI+"\n" || loadErr != nil || load != p.value.LoadRevision+"\n" || shaErr != nil || sha != p.value.RawSHA256+"\n" {
		return errors.New("current original packed policy differs")
	}
	return p.context()
}

func (p *fixedWorkerPolicy) close() error {
	if p.closed {
		return nil
	}
	p.closed = true
	var err error
	for _, fd := range []int{p.raw, p.rawDir, p.worker, p.source, p.revision, p.root, p.apparmor, p.security, p.sys, p.proc, p.userNS, p.mountNS} {
		if fd >= 0 {
			err = errors.Join(err, unix.Close(fd))
		}
	}
	return err
}
