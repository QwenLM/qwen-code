//go:build linux

package coldboot

import (
	"errors"
	"io"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	"golang.org/x/sys/unix"
)

const securityMagic = 0x73636673
const apparmorMagic = 0x5a3c69f0

type policyState struct {
	profiles                   map[string]fdIdentity
	rawPath, abi, loadRevision string
	raw                        fdIdentity
	rawDirectory               fdIdentity
}
type loadedPolicy struct {
	aa, root, revision int
	held               map[int]fdIdentity
	state              *policyState
	expected           []string
	packed             []byte
	loadRevision       uint64
}

func (p *loadedPolicy) close() {
	for fd := range p.held {
		_ = unix.Close(fd)
	}
	p.held = nil
}

func (p *loadedPolicy) retain(fd int) error {
	id, err := fdObject(fd)
	if err != nil {
		return err
	}
	p.held[fd] = id
	return nil
}

func (p *loadedPolicy) open(name string, directory bool) (*os.File, error) {
	flags := uint64(unix.O_RDONLY | unix.O_CLOEXEC)
	if directory {
		flags |= unix.O_DIRECTORY
	}
	fd, err := unix.Openat2(p.root, name, &unix.OpenHow{Flags: flags, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV})
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	var st unix.Stat_t
	var fs unix.Statfs_t
	kind := uint32(unix.S_IFREG)
	if directory {
		kind = unix.S_IFDIR
	}
	if unix.Fstat(fd, &st) != nil || st.Uid != 0 || st.Gid != 0 || st.Mode&unix.S_IFMT != kind || unix.Fstatfs(fd, &fs) != nil || fs.Type != apparmorMagic {
		_ = f.Close()
		return nil, errors.New("AppArmor root policy object type differs")
	}
	return f, nil
}

func (p *loadedPolicy) text(name string, limit int) (string, error) {
	f, err := p.open(name, false)
	if err != nil {
		return "", err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if err != nil || len(raw) == 0 || len(raw) > limit {
		return "", errors.New("bounded policy export read failed")
	}
	return string(raw), nil
}

func (p *loadedPolicy) names(name string) ([]string, error) {
	f, err := p.open(name, true)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	names, err := f.Readdirnames(4097)
	if err != nil && err != io.EOF || len(names) > 4096 {
		return nil, errors.New("bounded root policy inventory failed")
	}
	sort.Strings(names)
	return names, nil
}

func (p *loadedPolicy) parameters(locked bool) error {
	lock := "N\n"
	if locked {
		lock = "Y\n"
	}
	for name, want := range map[string]string{"enabled": "Y\n", "mode": "enforce", "hash_policy": "Y\n", "export_binary": "Y\n", "lock_policy": lock} {
		raw, err := fixedRead("/sys/module/apparmor/parameters/"+name, unix.SYSFS_MAGIC, 64)
		if err != nil || string(raw) != want {
			return errors.New("AppArmor must be enforcing, exported and in the required lock state")
		}
	}
	for name, want := range map[string]string{".ns_level": "0\n", ".ns_name": "root\n", ".stacked": "no\n", ".ns_stacked": "no\n"} {
		fd, err := unix.Openat2(p.aa, name, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
		if err != nil {
			return err
		}
		f := os.NewFile(uintptr(fd), name)
		var st unix.Stat_t
		var fs unix.Statfs_t
		if unix.Fstat(fd, &st) != nil || st.Uid != 0 || st.Gid != 0 || st.Mode&unix.S_IFMT != unix.S_IFREG || unix.Fstatfs(fd, &fs) != nil || fs.Type != securityMagic {
			_ = f.Close()
			return errors.New("AppArmor namespace attribute object differs")
		}
		raw, readErr := io.ReadAll(io.LimitReader(f, 65))
		closeErr := f.Close()
		if readErr != nil || closeErr != nil || string(raw) != want {
			return errors.New("AppArmor root namespace context differs")
		}
	}
	return nil
}

func (o *linuxBoot) loadPolicy() error {
	if err := o.context(); err != nil {
		return err
	}
	var fs unix.Statfs_t
	if unix.Statfs("/sys/kernel/security", &fs) != nil {
		return errors.New("securityfs mountpoint unavailable")
	}
	if fs.Type == unix.SYSFS_MAGIC {
		d, err := fixedOpen("/sys/kernel/security", unix.O_RDONLY|unix.O_DIRECTORY, unix.SYSFS_MAGIC, unix.S_IFDIR)
		if err != nil {
			return err
		}
		names, readErr := d.Readdirnames(1)
		_ = d.Close()
		if readErr != io.EOF || len(names) != 0 {
			return errors.New("foreign securityfs mountpoint contents")
		}
		if err := unix.Mount("securityfs", "/sys/kernel/security", "securityfs", unix.MS_NODEV|unix.MS_NOSUID|unix.MS_NOEXEC, ""); err != nil {
			return err
		}
	} else if fs.Type != securityMagic {
		return errors.New("foreign securityfs mount")
	}
	lsm, err := fixedRead("/sys/kernel/security/lsm", securityMagic, 256)
	if err != nil || string(lsm) != o.plan.Boot.LSM {
		return errors.New("participating LSM list differs")
	}
	p := &loadedPolicy{aa: -1, root: -1, revision: -1, held: map[int]fdIdentity{}, packed: o.files["packed.bin"], expected: append([]string{"qwen-k2-source-v1", "qwen-k2-gateway-v1", "qwen-k2-shim-v1", "qwen-k2-worker-v1", "qwen-k2-sandbox-v1"}, o.snapshot.HostPolicyLabels()...)}
	o.policy = p
	aa, err := fixedOpen("/sys/kernel/security/apparmor", unix.O_RDONLY|unix.O_DIRECTORY, securityMagic, unix.S_IFDIR)
	if err != nil {
		return err
	}
	p.aa, err = unix.FcntlInt(aa.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	_ = aa.Close()
	if err != nil {
		return err
	}
	if err = p.retain(p.aa); err != nil {
		return err
	}
	// This fixed policy link is AppArmor's reviewed mount boundary. Its root
	// namespace is checked before and after opening; no caller path enters it.
	p.root, err = unix.Openat(p.aa, "policy", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	if err = p.retain(p.root); err != nil {
		return err
	}
	if unix.Fstatfs(p.root, &fs) != nil || fs.Type != apparmorMagic {
		return errors.New("AppArmor policy filesystem differs")
	}
	if err = p.parameters(false); err != nil {
		return err
	}
	for _, name := range []string{"profiles", "namespaces", "raw_data"} {
		names, err := p.names(name)
		if err != nil || len(names) != 0 {
			return errors.New("reviewed initial root policy namespace is not empty")
		}
	}
	p.revision, err = unix.Openat(p.root, "revision", unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	if err = p.retain(p.revision); err != nil {
		return err
	}
	before, err := p.revisionRead()
	if err != nil || before != 0 {
		return errors.New("initial policy revision differs")
	}
	fd, err := unix.Openat(p.aa, ".load", unix.O_WRONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	n, writeErr := unix.Write(fd, p.packed)
	closeErr := unix.Close(fd)
	if writeErr != nil || closeErr != nil || n != len(p.packed) {
		return errors.New("single complete packed policy load failed")
	}
	p.loadRevision, err = p.revisionRead()
	if err != nil || p.loadRevision != before+1 {
		return errors.New("single policy load revision differs")
	}
	p.state, err = p.readState(true)
	if err != nil {
		return err
	}
	return p.verify(false)
}

func (p *loadedPolicy) revisionRead() (uint64, error) {
	var raw [65]byte
	n, err := unix.Read(p.revision, raw[:])
	if err != nil || n < 2 || n > 64 || raw[n-1] != '\n' {
		return 0, errors.New("policy revision unavailable")
	}
	v, err := strconv.ParseUint(string(raw[:n-1]), 10, 64)
	if err != nil || strconv.FormatUint(v, 10) != string(raw[:n-1]) {
		return 0, errors.New("noncanonical policy revision")
	}
	return v, nil
}

func (p *loadedPolicy) keep(f *os.File) error {
	fd, err := unix.FcntlInt(f.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return err
	}
	if err = p.retain(fd); err != nil {
		_ = unix.Close(fd)
		return err
	}
	return nil
}

var rawLink = regexp.MustCompile(`^\.\./\.\./raw_data/(0|[1-9][0-9]*)/raw_data$`)
var profileDirectory = regexp.MustCompile(`^[A-Za-z0-9._-]{1,255}$`)

func (p *loadedPolicy) readState(retain bool) (*policyState, error) {
	names, err := p.names("profiles")
	if err != nil || len(names) != len(p.expected) || len(names) != 11 {
		return nil, errors.New("exact five Qwen and six distinct host profiles are required")
	}
	state := &policyState{profiles: map[string]fdIdentity{}}
	want := map[string]bool{}
	for _, label := range p.expected {
		want[label] = true
	}
	if len(want) != 11 {
		return nil, errors.New("ambiguous complete profile names")
	}
	for _, name := range names {
		if !profileDirectory.MatchString(name) || name == "." || name == ".." {
			return nil, errors.New("unsupported profile directory")
		}
		base := "profiles/" + name
		label, err := p.text(base+"/name", 256)
		if err != nil || !strings.HasSuffix(label, "\n") || !want[strings.TrimSuffix(label, "\n")] {
			return nil, errors.New("unknown, duplicate or nested profile")
		}
		delete(want, strings.TrimSuffix(label, "\n"))
		mode, err := p.text(base+"/mode", 64)
		if err != nil || mode != "enforce\n" {
			return nil, errors.New("loaded profile is not enforce")
		}
		children, err := p.names(base + "/profiles")
		if err != nil && !errors.Is(err, unix.ENOENT) || len(children) != 0 {
			return nil, errors.New("nested profile extras are forbidden")
		}
		f, err := p.open(base, true)
		if err != nil {
			return nil, err
		}
		id, idErr := fdObject(int(f.Fd()))
		if retain && idErr == nil {
			idErr = p.keep(f)
		}
		_ = f.Close()
		if idErr != nil {
			return nil, idErr
		}
		state.profiles[base] = id
		var buffer [256]byte
		n, err := unix.Readlinkat(p.root, base+"/raw_data", buffer[:])
		if err != nil || n == len(buffer) || n == 0 {
			return nil, errors.New("policy raw link unavailable")
		}
		link := string(buffer[:n])
		match := rawLink.FindStringSubmatch(link)
		if match == nil {
			return nil, errors.New("unsupported raw policy link")
		}
		path := "raw_data/" + match[1]
		if state.rawPath != "" && state.rawPath != path {
			return nil, errors.New("profiles did not come from one packed bundle")
		}
		state.rawPath = path
		for _, suffix := range []string{"raw_abi", "raw_sha256"} {
			n, err := unix.Readlinkat(p.root, base+"/"+suffix, buffer[:])
			wantSuffix := "abi"
			if suffix == "raw_sha256" {
				wantSuffix = "sha256"
			}
			if err != nil || string(buffer[:n]) != "../../"+path+"/"+wantSuffix {
				return nil, errors.New("profile export linkage differs")
			}
		}
	}
	if len(want) != 0 {
		return nil, errors.New("missing complete bundle profile")
	}
	groups, err := p.names("raw_data")
	if err != nil || len(groups) != 1 || "raw_data/"+groups[0] != state.rawPath {
		return nil, errors.New("additional raw policy bundles are forbidden")
	}
	rawDirectory, err := p.open(state.rawPath, true)
	if err != nil {
		return nil, err
	}
	state.rawDirectory, err = fdObject(int(rawDirectory.Fd()))
	if retain && err == nil {
		err = p.keep(rawDirectory)
	}
	_ = rawDirectory.Close()
	if err != nil {
		return nil, err
	}
	ns, err := p.names("namespaces")
	if err != nil || len(ns) != 0 {
		return nil, errors.New("AppArmor namespace extras are forbidden")
	}
	state.abi, err = p.text(state.rawPath+"/abi", 64)
	if err != nil || !regexp.MustCompile(`^v[5-9]\n$`).MatchString(state.abi) {
		return nil, errors.New("unsupported policy export ABI")
	}
	state.loadRevision, err = p.text(state.rawPath+"/revision", 64)
	if err != nil {
		return nil, err
	}
	revision, err := strconv.ParseUint(strings.TrimSuffix(state.loadRevision, "\n"), 10, 64)
	if err != nil || state.loadRevision != strconv.FormatUint(revision, 10)+"\n" || revision > p.loadRevision {
		return nil, errors.New("raw load revision differs")
	}
	sha, err := p.text(state.rawPath+"/sha256", 128)
	if err != nil || sha != birth.SHA256(p.packed)+"\n" {
		return nil, errors.New("kernel raw packed digest differs")
	}
	raw, err := p.open(state.rawPath+"/raw_data", false)
	if err != nil {
		return nil, err
	}
	defer raw.Close()
	info, err := raw.Stat()
	if err != nil || info.Size() != int64(len(p.packed)) || info.Size() > 8<<20 {
		return nil, errors.New("kernel raw size differs")
	}
	actual, err := io.ReadAll(io.LimitReader(raw, 8<<20+1))
	if err != nil || !reflect.DeepEqual(actual, p.packed) {
		return nil, errors.New("actual exported packed bytes differ")
	}
	state.raw, err = fdObject(int(raw.Fd()))
	if err != nil {
		return nil, err
	}
	if retain {
		if err = p.keep(raw); err != nil {
			return nil, err
		}
	}
	return state, nil
}

func (p *loadedPolicy) verify(locked bool) error {
	if err := p.parameters(locked); err != nil {
		return err
	}
	for fd, want := range p.held {
		actual, err := fdObject(fd)
		if err != nil || actual != want {
			return errors.New("retained kernel policy object changed")
		}
	}
	root, err := unix.Open("/sys/kernel/security/apparmor/policy", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	actual, objectErr := fdObject(root)
	_ = unix.Close(root)
	if objectErr != nil || actual != p.held[p.root] {
		return errors.New("named AppArmor policy root changed")
	}
	current, err := p.readState(false)
	if err != nil || !reflect.DeepEqual(current, p.state) {
		return errors.New("loaded complete policy state changed")
	}
	var revision [65]byte
	if _, err := unix.Read(p.revision, revision[:]); !errors.Is(err, unix.EAGAIN) {
		return errors.New("policy namespace revision changed")
	}
	return nil
}

func (o *linuxBoot) lockPolicy() error {
	if err := o.policy.verify(false); err != nil {
		return err
	}
	if err := writeFixed("/sys/module/apparmor/parameters/lock_policy", "Y\n", unix.SYSFS_MAGIC); err != nil {
		return err
	}
	return o.policy.verify(true)
}
