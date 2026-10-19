//go:build linux

package coldboot

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/artifactset"
	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	"golang.org/x/sys/unix"
)

const procThread = "/proc/1/task/1/"

type linuxBoot struct {
	plan                *artifactset.ColdPlan
	snapshot            *artifactset.Snapshot
	files               map[string][]byte
	objects             []*birth.ProtectedFile
	self                *birth.ProtectedFile
	links               []*birth.ColdLink
	directories         []*birth.ProtectedDirectory
	policy              *loadedPolicy
	runtimeFDs          map[int]fdIdentity
	namespaceFDs        map[string]int
	namespaceIdentities map[int]fdIdentity
}

// Run accepts no paths, PID/namespace overrides, qualification flags or fake ops.
func Run() error {
	o := &linuxBoot{}
	defer o.close()
	return execute(o)
}

func (o *linuxBoot) close() {
	for _, fd := range o.namespaceFDs {
		_ = unix.Close(fd)
	}
	for _, l := range o.links {
		_ = l.Close()
	}
	if o.policy != nil {
		o.policy.close()
	}
	for _, f := range o.objects {
		_ = f.Close()
	}
	for _, d := range o.directories {
		_ = d.Close()
	}
}

func fixedOpen(name string, flags int, magic int64, kind uint32) (*os.File, error) {
	fd, err := unix.Openat2(unix.AT_FDCWD, name, &unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC), Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	var st unix.Stat_t
	var fs unix.Statfs_t
	if unix.Fstat(fd, &st) != nil || st.Uid != 0 || st.Gid != 0 || st.Mode&unix.S_IFMT != kind || unix.Fstatfs(fd, &fs) != nil || fs.Type != magic {
		_ = f.Close()
		return nil, errors.New("fixed kernel object type or filesystem differs")
	}
	return f, nil
}

func fixedRead(name string, magic int64, limit int) ([]byte, error) {
	f, err := fixedOpen(name, unix.O_RDONLY, magic, unix.S_IFREG)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if err != nil || len(raw) > limit {
		return nil, errors.New("bounded kernel read failed")
	}
	return raw, nil
}

func (o *linuxBoot) context() error {
	if runtime.GOARCH != "amd64" || os.Getpid() != 1 || unix.Gettid() != 1 || os.Getuid() != 0 || os.Geteuid() != 0 || os.Getgid() != 0 || os.Getegid() != 0 || !reflect.DeepEqual(os.Environ(), []string{"LANG=C"}) {
		return errors.New("only the actual initial PID1 main thread with the fixed environment is supported")
	}
	self, selfErr := os.Readlink("/proc/thread-self")
	if selfErr != nil || self != "1/task/1" {
		return errors.New("the proc mount does not address this actual original PID1 thread")
	}
	for name, inode := range map[string]uint64{"user": 4026531837, "mnt": 4026531841, "pid": 4026531836} {
		var st unix.Stat_t
		if unix.Stat("/proc/thread-self/ns/"+name, &st) != nil || uint64(st.Dev) != 4 || st.Ino != inode {
			return errors.New("unsupported initial namespace")
		}
	}
	uid, err := fixedRead(procThread+"uid_map", unix.PROC_SUPER_MAGIC, 128)
	if err != nil || strings.Join(strings.Fields(string(uid)), " ") != "0 0 4294967295" {
		return errors.New("initial root uid map differs")
	}
	label, err := fixedRead(procThread+"attr/apparmor/current", unix.PROC_SUPER_MAGIC, 256)
	if err != nil || string(label) != "unconfined\n" {
		return errors.New("cold loader must be the reviewed pre-policy boot TCB")
	}
	return scanProcesses()
}

func scanProcesses() error {
	f, err := fixedOpen("/proc", unix.O_RDONLY|unix.O_DIRECTORY, unix.PROC_SUPER_MAGIC, unix.S_IFDIR)
	if err != nil {
		return err
	}
	defer f.Close()
	names, err := f.Readdirnames(4097)
	if err != nil && err != io.EOF || len(names) > 4096 {
		return errors.New("process scan exceeds its bound")
	}
	tasks := 0
	for _, name := range names {
		pid, err := strconv.Atoi(name)
		if err != nil || pid < 1 {
			continue
		}
		raw, err := fixedRead("/proc/"+name+"/stat", unix.PROC_SUPER_MAGIC, 4096)
		if err != nil {
			return errors.New("process disappeared or cannot be classified")
		}
		fields := strings.Fields(string(raw)[strings.LastIndex(string(raw), ")")+1:])
		if len(fields) < 7 || fields[0] == "Z" {
			return errors.New("zombie or unknown process in cold boundary")
		}
		flags, err := strconv.ParseUint(fields[6], 10, 64)
		if err != nil || pid != 1 && flags&0x00200000 == 0 {
			return errors.New("another userspace actor exists before first systemd")
		}
		d, err := fixedOpen("/proc/"+name+"/task", unix.O_RDONLY|unix.O_DIRECTORY, unix.PROC_SUPER_MAGIC, unix.S_IFDIR)
		if err != nil {
			return err
		}
		entries, readErr := d.Readdirnames(65537 - tasks)
		_ = d.Close()
		tasks += len(entries)
		if readErr != nil && readErr != io.EOF || tasks > 65536 {
			return errors.New("task scan exceeds its bound")
		}
	}
	return nil
}

func (o *linuxBoot) retain() error {
	var err error
	o.runtimeFDs, err = initialFDs()
	if err != nil {
		return err
	}
	o.namespaceFDs = map[string]int{}
	o.namespaceIdentities = map[int]fdIdentity{}
	for name, kind := range map[string]int{"user": unix.CLONE_NEWUSER, "mnt": unix.CLONE_NEWNS, "pid": unix.CLONE_NEWPID} {
		fd, err := unix.Open("/proc/thread-self/ns/"+name, unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		o.namespaceFDs[name] = fd
		var fs unix.Statfs_t
		actualKind, err := unix.IoctlRetInt(fd, unix.NS_GET_NSTYPE)
		if err != nil || actualKind != kind || unix.Fstatfs(fd, &fs) != nil || fs.Type != unix.NSFS_MAGIC {
			return errors.New("initial namespace object type differs")
		}
		id, err := fdObject(fd)
		if err != nil {
			return err
		}
		o.namespaceIdentities[fd] = id
	}
	root, err := birth.OpenProtectedDirectory("/etc/qwen-k2")
	if err != nil {
		return err
	}
	o.directories = append(o.directories, root)
	dir, err := birth.OpenProtectedDirectory(artifactset.Directory)
	if err != nil {
		return err
	}
	o.directories = append(o.directories, dir)
	names, err := dir.Names(27)
	if err != nil || len(names) != 26 {
		return errors.New("exact installed directory required")
	}
	o.files = map[string][]byte{}
	limits := artifactset.Limits()
	for _, name := range names {
		limit, ok := limits[name]
		if !ok {
			return errors.New("unknown installed child")
		}
		f, err := dir.OpenArtifact(name, limit)
		if err != nil {
			return err
		}
		o.objects = append(o.objects, f)
		raw, err := f.Bytes()
		if err != nil {
			return err
		}
		o.files[name] = raw
	}
	o.snapshot, err = artifactset.Validate(o.files)
	if err != nil {
		return err
	}
	o.plan, err = o.snapshot.Cold()
	if err != nil {
		return err
	}
	if o.plan.Architecture != "amd64" {
		return errors.New("only the reviewed amd64 boot lane is supported")
	}
	inputs := []struct {
		v            artifactset.ColdFile
		elf, execute bool
	}{
		{o.plan.Kernel, false, false}, {o.plan.BaseInitrd, false, false}, {o.plan.Boot.KernelConfiguration, false, false},
		{o.plan.ColdInit, true, true}, {o.plan.Systemd.ColdFile, true, true}, {o.plan.Rootfs.Target, false, false}, {o.plan.Rootfs.Manager, false, false},
	}
	for _, v := range o.plan.Dependencies {
		inputs = append(inputs, struct {
			v            artifactset.ColdFile
			elf, execute bool
		}{v.ColdFile, true, strings.HasSuffix(v.Path, "/ld-linux-x86-64.so.2")})
	}
	total := 0
	for _, input := range inputs {
		f, err := birth.OpenColdObject(input.v.Path, input.v.Bytes, input.execute)
		if err != nil {
			return err
		}
		o.objects = append(o.objects, f)
		raw, err := f.Bytes()
		if err != nil || len(raw) != input.v.Bytes || birth.SHA256(raw) != input.v.SHA {
			return errors.New("actual cold executable or startup input differs")
		}
		if input.elf && (len(raw) < 64 || !bytes.Equal(raw[:6], []byte{0x7f, 'E', 'L', 'F', 2, 1}) || raw[18] != 62 || raw[19] != 0) {
			return errors.New("actual cold ELF differs")
		}
		if input.v.Path == o.plan.ColdInit.Path && !staticELF(raw) {
			return errors.New("cold loader must be a static ELF without interpreter or dynamic section")
		}
		if input.v.Path == o.plan.ColdInit.Path {
			o.self = f
		}
		if input.elf && input.v.Path != o.plan.ColdInit.Path {
			total += len(raw)
			if total > 64<<20 {
				return errors.New("systemd dependency aggregate exceeds 64 MiB")
			}
		}
	}
	for _, name := range o.plan.Rootfs.Directories {
		d, err := birth.OpenProtectedDirectory(name)
		if err != nil {
			return err
		}
		o.directories = append(o.directories, d)
	}
	for _, links := range []map[string]string{o.plan.Links, o.plan.Rootfs.Links} {
		for name, target := range links {
			l, err := birth.OpenColdLink(name, target)
			if err != nil {
				return err
			}
			o.links = append(o.links, l)
		}
	}
	if err := o.runningObject(); err != nil {
		return err
	}
	return o.bootInputs()
}

func (o *linuxBoot) runningObject() error {
	name, err := os.Readlink("/proc/1/exe")
	if err != nil || name != o.plan.ColdInit.Path || o.self == nil {
		return errors.New("actual running cold entry differs")
	}
	// This fixed proc executable link identifies the running image; it is not
	// used as an executable path or a substitute for protected rootfs lookup.
	fd, err := unix.Open("/proc/1/exe", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	actual, actualErr := fdObject(fd)
	closeErr := unix.Close(fd)
	held, heldErr := fdObject(int(o.self.Descriptors()[0]))
	if actualErr != nil || heldErr != nil || closeErr != nil || actual != held {
		return errors.New("running and retained cold entry objects differ")
	}
	return nil
}

func (o *linuxBoot) bootInputs() error {
	cmd, err := fixedRead("/proc/cmdline", unix.PROC_SUPER_MAGIC, 4096)
	if err != nil || string(cmd) != o.plan.Boot.Cmdline {
		return errors.New("actual kernel cmdline differs")
	}
	release, err := fixedRead("/proc/sys/kernel/osrelease", unix.PROC_SUPER_MAGIC, 128)
	if err != nil || string(release) != o.plan.Boot.KernelRelease+"\n" {
		return errors.New("actual kernel release differs")
	}
	for name, target := range o.plan.Links {
		got, err := os.Readlink(name)
		if err != nil || got != target {
			return errors.New("actual dependency alias differs")
		}
	}
	for name, target := range o.plan.Rootfs.Links {
		got, err := os.Readlink(name)
		if err != nil || got != target {
			return errors.New("fixed unit alias differs")
		}
	}
	for i, d := range o.directories {
		if i < 2 {
			continue
		}
		want := []string{"units"}
		if strings.HasSuffix(o.plan.Rootfs.Directories[i-2], "/units") {
			want = []string{"apparmor.service", "default.target", "qwen-k2-cold.target"}
		}
		names, err := d.Names(4)
		sort.Strings(names)
		if err != nil || !reflect.DeepEqual(names, want) {
			return errors.New("fixed cold tree contains an unexpected entry")
		}
	}
	// The runtime and EFI roots are virtual filesystems, not exemptions from the
	// ext4/immutable checks on installed executable and artifact objects.
	for _, name := range []string{"/sys/firmware/efi/efivars", "/run"} {
		magic := int64(unix.TMPFS_MAGIC)
		if strings.HasPrefix(name, "/sys") {
			magic = 0xde5e81e4
		}
		f, err := fixedOpen(name, unix.O_RDONLY|unix.O_DIRECTORY, magic, unix.S_IFDIR)
		if err != nil {
			return err
		}
		_ = f.Close()
	}
	for _, name := range o.plan.Rootfs.Absent {
		fd, err := unix.Openat2(unix.AT_FDCWD, name, &unix.OpenHow{Flags: unix.O_PATH | unix.O_NOFOLLOW | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
		if err == nil {
			_ = unix.Close(fd)
		}
		if !errors.Is(err, unix.ENOENT) {
			return errors.New("forbidden startup input is not proven absent")
		}
	}
	for _, name := range o.plan.Rootfs.Empty {
		magic := int64(unix.EXT4_SUPER_MAGIC)
		if strings.HasPrefix(name, "/run/") {
			magic = unix.TMPFS_MAGIC
		}
		f, err := fixedOpen(name, unix.O_RDONLY|unix.O_DIRECTORY, magic, unix.S_IFDIR)
		if errors.Is(err, unix.ENOENT) {
			continue
		}
		if err != nil {
			return err
		}
		entries, readErr := f.Readdirnames(1)
		_ = f.Close()
		if readErr != io.EOF || len(entries) != 0 {
			return errors.New("manager drop-in root is not absent or empty")
		}
	}
	return nil
}

func writeFixed(name, want string, magic int64) error {
	return updateInterface(want, func(write bool) (kernelInterface, error) {
		flags := unix.O_RDONLY
		if write {
			flags = unix.O_WRONLY
		}
		f, err := fixedOpen(name, flags, magic, unix.S_IFREG)
		if err != nil {
			return nil, err
		}
		return fixedKernelInterface{f}, nil
	})
}

func (o *linuxBoot) closeHelpers() error {
	for _, name := range []string{"/proc/sys/kernel/modprobe", "/proc/sys/kernel/hotplug", "/sys/kernel/uevent_helper", "/proc/sys/kernel/core_pattern", "/proc/sys/fs/suid_dumpable"} {
		magic := int64(unix.PROC_SUPER_MAGIC)
		if strings.HasPrefix(name, "/sys") {
			magic = unix.SYSFS_MAGIC
		}
		if err := writeFixed(name, o.plan.Boot.Helpers[name], magic); err != nil {
			return err
		}
	}
	return unix.Setrlimit(unix.RLIMIT_CORE, &unix.Rlimit{Cur: 0, Max: 0})
}

func (o *linuxBoot) dropModule() error { return removeModule(kernelCapabilities{}) }

func (o *linuxBoot) ready() error {
	if err := o.runningObject(); err != nil {
		return err
	}
	for _, l := range o.links {
		if err := l.Verify(); err != nil {
			return err
		}
	}
	for fd, want := range o.namespaceIdentities {
		actual, err := fdObject(fd)
		if err != nil || actual != want {
			return errors.New("retained initial namespace changed")
		}
	}
	if err := o.context(); err != nil {
		return err
	}
	if err := o.bootInputs(); err != nil {
		return err
	}
	for _, f := range o.objects {
		if err := f.Verify(); err != nil {
			return err
		}
	}
	for _, d := range o.directories {
		if err := d.Verify(); err != nil {
			return err
		}
	}
	if currentCaps, err := (kernelCapabilities{}).read(); err != nil {
		return err
	} else if err = verifyModuleAbsent(currentCaps); err != nil {
		return err
	}
	var core unix.Rlimit
	if unix.Getrlimit(unix.RLIMIT_CORE, &core) != nil || core.Cur != 0 || core.Max != 0 {
		return errors.New("exec caller core limits differ")
	}
	for name, want := range o.plan.Boot.Helpers {
		magic := int64(unix.PROC_SUPER_MAGIC)
		if strings.HasPrefix(name, "/sys") {
			magic = unix.SYSFS_MAGIC
		}
		raw, err := fixedRead(name, magic, 64)
		if err != nil || string(raw) != want {
			return errors.New("helper closure changed")
		}
	}
	if err := o.policy.verify(true); err != nil {
		return err
	}
	known := map[int]fdIdentity{}
	for fd, id := range o.runtimeFDs {
		known[fd] = id
	}
	for _, f := range o.objects {
		for _, fd := range f.Descriptors() {
			id, err := fdObject(int(fd))
			if err != nil {
				return err
			}
			if id.flags&unix.O_ACCMODE != unix.O_RDONLY {
				return errors.New("retained descriptor is writable")
			}
			known[int(fd)] = id
		}
	}
	for _, d := range o.directories {
		for _, fd := range d.Descriptors() {
			id, err := fdObject(int(fd))
			if err != nil {
				return err
			}
			if id.flags&unix.O_ACCMODE != unix.O_RDONLY {
				return errors.New("retained descriptor is writable")
			}
			known[int(fd)] = id
		}
	}
	for _, l := range o.links {
		for _, fd := range l.Descriptors() {
			id, err := fdObject(int(fd))
			if err != nil {
				return err
			}
			if id.flags&unix.O_ACCMODE != unix.O_RDONLY {
				return errors.New("retained descriptor is writable")
			}
			known[int(fd)] = id
		}
	}
	for fd, id := range o.namespaceIdentities {
		if id.flags&unix.O_ACCMODE != unix.O_RDONLY {
			return errors.New("retained namespace descriptor is writable")
		}
		known[fd] = id
	}
	for fd, id := range o.policy.held {
		if id.flags&unix.O_ACCMODE != unix.O_RDONLY {
			return errors.New("retained policy descriptor is writable")
		}
		known[fd] = id
	}
	return finalFDs(known)
}

func (o *linuxBoot) onExec() error {
	if os.Getpid() != 1 || unix.Gettid() != 1 {
		return errors.New("original exec thread lost")
	}
	f, err := fixedOpen(procThread+"attr/exec", unix.O_WRONLY, unix.PROC_SUPER_MAGIC, unix.S_IFREG)
	if err != nil {
		return err
	}
	raw := []byte("exec " + o.plan.Systemd.Label)
	n, err := f.Write(raw)
	closeErr := f.Close()
	if err != nil || closeErr != nil || n != len(raw) {
		return errors.New("same-thread AppArmor on-exec failed")
	}
	return nil
}

func (o *linuxBoot) exec() error {
	return unix.Exec(o.plan.Systemd.Path, o.plan.Rootfs.Argv, o.plan.Rootfs.Environment)
}

func staticELF(raw []byte) bool {
	if len(raw) < 64 {
		return false
	}
	start := binary.LittleEndian.Uint64(raw[32:40])
	size := binary.LittleEndian.Uint16(raw[54:56])
	count := binary.LittleEndian.Uint16(raw[56:58])
	if size != 56 || count == 0 || count > 128 || start > uint64(len(raw)) || uint64(count)*56 > uint64(len(raw))-start {
		return false
	}
	for i := uint64(0); i < uint64(count); i++ {
		kind := binary.LittleEndian.Uint32(raw[start+i*56:])
		if kind == 2 || kind == 3 {
			return false
		}
	}
	return true
}
