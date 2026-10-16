//go:build linux

package birth

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"

	task "github.com/containerd/containerd/api/runtime/task/v3"
	"golang.org/x/sys/unix"
	"google.golang.org/protobuf/proto"
)

const immutableFlag = 0x10

type Inputs struct {
	Original         *task.CreateTaskRequest
	Consumed         *task.CreateTaskRequest
	Spec             []byte
	OriginalSpec     []byte
	Directory        *os.File
	Files            [5]*os.File
	Objects          [5]Object
	runcPath         string
	root             *os.File
	closed           bool
	cleaning         bool
	removed          [4]bool
	directoryRemoved bool
	outputs          *outputPins
}

func directory(path string, ext4 bool) (*os.File, error) {
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, errors.New("fixed birth directory is unavailable")
	}
	f := os.NewFile(uintptr(fd), path)
	var st unix.Stat_t
	var fs unix.Statfs_t
	if unix.Fstat(fd, &st) != nil || st.Uid != 0 || st.Gid != 0 || st.Mode&0022 != 0 || unix.Fstatfs(fd, &fs) != nil || ext4 && fs.Type != unix.EXT4_SUPER_MAGIC {
		f.Close()
		return nil, errors.New("birth directory must be root owned, protected and on its declared filesystem")
	}
	return f, nil
}

func object(f *os.File, executable bool) (Object, error) {
	fd := int(f.Fd())
	var st unix.Stat_t
	var fs unix.Statfs_t
	var sx unix.Statx_t
	flags, err := unix.IoctlGetInt(fd, unix.FS_IOC_GETFLAGS)
	limit := int64(MaxInputs)
	if executable {
		limit = 128 << 20
	}
	if err != nil || flags&immutableFlag == 0 || unix.Fstat(fd, &st) != nil || st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || st.Uid != 0 || st.Gid != 0 || st.Mode&0222 != 0 || st.Size <= 0 || st.Size > limit || unix.Fstatfs(fd, &fs) != nil || fs.Type != unix.EXT4_SUPER_MAGIC || unix.Statx(fd, "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &sx) != nil || sx.Mask&unix.STATX_MNT_ID == 0 || sx.Mnt_id == 0 {
		return Object{}, errors.New("actual birth input is not an immutable bounded ext4 object")
	}
	if executable && st.Mode&0111 == 0 {
		return Object{}, errors.New("fixed runc object is not executable")
	}
	raw, err := io.ReadAll(io.NewSectionReader(f, 0, st.Size+1))
	if err != nil || int64(len(raw)) != st.Size {
		return Object{}, errors.New("actual birth input read failed")
	}
	after, err := unix.IoctlGetInt(fd, unix.FS_IOC_GETFLAGS)
	var end unix.Stat_t
	if err != nil || after != flags || unix.Fstat(fd, &end) != nil || end.Dev != st.Dev || end.Ino != st.Ino || end.Mode != st.Mode || end.Nlink != st.Nlink || end.Uid != st.Uid || end.Gid != st.Gid || end.Size != st.Size || end.Mtim != st.Mtim || end.Ctim != st.Ctim {
		return Object{}, errors.New("actual birth input changed during measurement")
	}
	return Object{uint64(st.Dev), st.Ino, sx.Mnt_id, st.Size, SHA256(raw), uint32(flags), st.Mode, st.Mtim.Sec, st.Mtim.Nsec, st.Ctim.Sec, st.Ctim.Nsec}, nil
}

func frozenFile(root *os.File, name string, raw []byte) (_ *os.File, err error) {
	if len(raw) == 0 || len(raw) > MaxInputs {
		return nil, errors.New("birth input exceeds its bound")
	}
	fd, err := unix.Openat(int(root.Fd()), name, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0400)
	if err != nil {
		return nil, errors.New("birth input cannot overwrite an existing object")
	}
	f := os.NewFile(uintptr(fd), name)
	defer func() {
		if err != nil {
			_, cleanupErr := removeOwned(root, name, f)
			err = errors.Join(err, cleanupErr, f.Close())
		}
	}()
	if _, err = f.Write(raw); err != nil {
		return nil, err
	}
	if err = f.Sync(); err != nil {
		return nil, err
	}
	flags, err := unix.IoctlGetInt(fd, unix.FS_IOC_GETFLAGS)
	if err != nil {
		return nil, err
	}
	if err = unix.IoctlSetPointerInt(fd, unix.FS_IOC_SETFLAGS, flags|immutableFlag); err != nil {
		return nil, errors.New("kernel birth input protection is unavailable")
	}
	if err = f.Sync(); err != nil {
		return nil, err
	}
	sealed, err := object(f, false)
	if err != nil {
		return nil, err
	}
	readFD, err := unix.Openat(int(root.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("sealed birth input cannot be retained read only")
	}
	reader := os.NewFile(uintptr(readFD), name)
	current, readErr := object(reader, false)
	if readErr != nil || current != sealed {
		reader.Close()
		return nil, errors.New("sealed birth input changed while dropping its writer")
	}
	// Retain only a read-only descriptor after the protection is durable.
	err = f.Close()
	f = reader
	if err != nil {
		return nil, err
	}
	return f, nil
}

func removeOwned(root *os.File, name string, held *os.File) (bool, error) {
	var expected, actual unix.Stat_t
	if held == nil || unix.Fstat(int(held.Fd()), &expected) != nil || expected.Mode&unix.S_IFMT != unix.S_IFREG || expected.Nlink != 1 || expected.Uid != 0 || expected.Gid != 0 {
		return false, errors.New("birth rollback lost its original file descriptor")
	}
	fd, err := unix.Openat(int(root.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return false, errors.New("birth rollback lost its original file name")
	}
	defer unix.Close(fd)
	if unix.Fstat(fd, &actual) != nil || actual.Dev != expected.Dev || actual.Ino != expected.Ino {
		return false, errors.New("birth rollback refuses a changed file")
	}
	flags, err := unix.IoctlGetInt(fd, unix.FS_IOC_GETFLAGS)
	if err != nil {
		return false, err
	}
	if flags&immutableFlag != 0 {
		if err := unix.IoctlSetPointerInt(fd, unix.FS_IOC_SETFLAGS, flags&^immutableFlag); err != nil {
			return false, errors.New("birth rollback cannot remove its input protection")
		}
	}
	if err := unix.Unlinkat(int(root.Fd()), name, 0); err != nil {
		return false, err
	}
	return true, root.Sync()
}

func Protect(p InputPolicy, request *task.CreateTaskRequest, contract *CreationContract) (_ *Inputs, err error) {
	if err = ValidateRequest(p, request); err != nil {
		return nil, err
	}
	original, err := directory(request.Bundle, false)
	if err != nil {
		return nil, err
	}
	defer original.Close()
	fd, err := unix.Openat(int(original.Fd()), "config.json", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("actual daemon OCI bundle is unavailable")
	}
	config := os.NewFile(uintptr(fd), "config.json")
	defer config.Close()
	var st unix.Stat_t
	if unix.Fstat(fd, &st) != nil || st.Mode&unix.S_IFMT != unix.S_IFREG || st.Size <= 0 || st.Size > MaxInputs {
		return nil, errors.New("actual OCI input is not a bounded regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(config, MaxInputs+1))
	if err != nil || len(raw) > MaxInputs {
		return nil, errors.New("actual OCI input is unavailable")
	}
	consumedSpec, _, err := ConsumedSpec(raw)
	if err != nil {
		return nil, err
	}
	if err = contract.Match(raw, request.ID); err != nil {
		return nil, err
	}
	root, err := directory(p.InputRoot, true)
	if err != nil {
		return nil, err
	}
	if err = unix.Mkdirat(int(root.Fd()), request.ID, 0700); err != nil {
		root.Close()
		return nil, errors.New("birth consumption bundle already exists or cannot be created")
	}
	inputs := &Inputs{Original: proto.Clone(request).(*task.CreateTaskRequest), Consumed: proto.Clone(request).(*task.CreateTaskRequest), Spec: consumedSpec, OriginalSpec: raw}
	inputs.runcPath = p.RuncPath
	inputs.root = root
	defer func() {
		if err != nil {
			err = errors.Join(err, inputs.Abort(), inputs.Close())
		}
	}()
	inputs.Consumed.Bundle = filepath.Join(p.InputRoot, request.ID)
	inputs.Directory, err = directory(inputs.Consumed.Bundle, true)
	if err != nil {
		return nil, err
	}
	inputs.outputs, err = openOutputs(p, inputs.Original)
	if err != nil {
		return nil, err
	}
	originalRaw, err := proto.MarshalOptions{Deterministic: true}.Marshal(inputs.Original)
	if err != nil {
		return nil, err
	}
	consumedRaw, err := proto.MarshalOptions{Deterministic: true}.Marshal(inputs.Consumed)
	if err != nil || len(raw)+len(consumedSpec)+len(originalRaw)+len(consumedRaw) > MaxInputs {
		return nil, errors.New("combined actual birth inputs exceed their bound")
	}
	for i, input := range []struct {
		name string
		raw  []byte
	}{{"config.json", consumedSpec}, {"original.create.pb", originalRaw}, {"consumed.create.pb", consumedRaw}, {"original.config.json", raw}} {
		inputs.Files[i], err = frozenFile(inputs.Directory, input.name, input.raw)
		if err != nil {
			return nil, err
		}
	}
	runcFD, err := unix.Openat2(unix.AT_FDCWD, p.RuncPath, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, errors.New("fixed runc executable is unavailable")
	}
	inputs.Files[4] = os.NewFile(uintptr(runcFD), p.RuncPath)
	for i, f := range inputs.Files {
		inputs.Objects[i], err = object(f, i == 4)
		if err != nil {
			return nil, err
		}
	}
	if inputs.Objects[4].SHA256 != p.RuncSHA256 {
		return nil, errors.New("actual consumed runc binary differs from the reviewed handler")
	}
	if err = inputs.Directory.Sync(); err != nil {
		return nil, err
	}
	if err = root.Sync(); err != nil {
		return nil, err
	}
	return inputs, nil
}

// Abort is only for preparation before a native Create has been issued.
func (i *Inputs) Abort() error {
	if i == nil || i.closed || i.root == nil || i.Directory == nil {
		return errors.New("birth rollback requires its original live directory")
	}
	if i.directoryRemoved {
		var st unix.Stat_t
		if err := unix.Fstatat(int(i.root.Fd()), i.Original.ID, &st, unix.AT_SYMLINK_NOFOLLOW); !errors.Is(err, unix.ENOENT) {
			return errors.New("removed birth bundle has reappeared or is unknown")
		}
		return i.root.Sync()
	}
	if _, err := i.Directory.Seek(0, io.SeekStart); err != nil {
		return err
	}
	entries, err := i.Directory.ReadDir(-1)
	if err != nil {
		return err
	}
	names := []string{"config.json", "original.create.pb", "consumed.create.pb", "original.config.json"}
	for _, entry := range entries {
		owned := false
		for n, name := range names {
			if entry.Name() == name && i.Files[n] != nil {
				owned = true
			}
		}
		if !owned {
			return errors.New("birth rollback refuses unknown or native bundle contents")
		}
	}
	for n, name := range names {
		if i.Files[n] != nil {
			if !i.removed[n] {
				removed, err := removeOwned(i.Directory, name, i.Files[n])
				i.removed[n] = removed
				if err != nil {
					return err
				}
			} else {
				var st unix.Stat_t
				if err := unix.Fstatat(int(i.Directory.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW); !errors.Is(err, unix.ENOENT) {
					return errors.New("removed birth input has reappeared or is unknown")
				}
				if err := i.Directory.Sync(); err != nil {
					return err
				}
			}
			if err := i.Files[n].Close(); err != nil {
				i.Files[n] = nil
				return err
			}
			i.Files[n] = nil
		}
	}
	fd, err := unix.Openat(int(i.root.Fd()), i.Original.ID, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	var held, named unix.Stat_t
	heldErr := unix.Fstat(int(i.Directory.Fd()), &held)
	namedErr := unix.Fstat(fd, &named)
	closeErr := unix.Close(fd)
	if heldErr != nil || namedErr != nil || closeErr != nil || held.Dev != named.Dev || held.Ino != named.Ino {
		return errors.New("birth rollback refuses a changed bundle directory")
	}
	if err := unix.Unlinkat(int(i.root.Fd()), i.Original.ID, unix.AT_REMOVEDIR); err != nil {
		return err
	}
	i.directoryRemoved = true
	return i.root.Sync()
}

// CleanupDeleted follows the saved native Delete; it never unmounts a live rootfs.
func (i *Inputs) CleanupDeleted() error {
	if i == nil || i.closed || i.root == nil || i.Directory == nil {
		return errors.New("native input cleanup requires its original live bundle")
	}
	if i.directoryRemoved {
		return i.Abort()
	}
	if !i.cleaning {
		if err := i.Verify(); err != nil {
			return err
		}
		i.cleaning = true
	}
	fd, err := unix.Openat(int(i.Directory.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	reader := os.NewFile(uintptr(fd), "deleted-native-bundle")
	entries, readErr := reader.ReadDir(17)
	closeErr := reader.Close()
	if readErr != nil && readErr != io.EOF || closeErr != nil || len(entries) > 16 {
		return errors.New("native bundle cleanup inventory exceeds its bound")
	}
	protected := map[string]int{"config.json": 0, "original.create.pb": 1, "consumed.create.pb": 2, "original.config.json": 3}
	var objects []*os.File
	defer func() { closeFiles(objects) }()
	var names []string
	var kinds []int
	var parentMount unix.Statx_t
	if unix.Statx(int(i.Directory.Fd()), "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &parentMount) != nil || parentMount.Mnt_id == 0 {
		return errors.New("native bundle cleanup mount identity is unavailable")
	}
	for _, entry := range entries {
		if n, ok := protected[entry.Name()]; ok {
			if i.Files[n] == nil {
				return errors.New("removed protected input has reappeared")
			}
			continue
		}
		kind := 0
		switch entry.Name() {
		case "options.json", "runtime", "log.json", "init.pid":
		case "rootfs", "work":
			kind = unix.AT_REMOVEDIR
		default:
			return errors.New("native bundle cleanup refuses an unknown entry")
		}
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if kind != 0 {
			flags |= unix.O_DIRECTORY
		}
		fd, err := unix.Openat(int(i.Directory.Fd()), entry.Name(), flags, 0)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(fd), entry.Name())
		objects = append(objects, file)
		var st unix.Stat_t
		var sx unix.Statx_t
		if unix.Fstat(fd, &st) != nil || st.Uid != 0 || st.Gid != 0 || unix.Statx(fd, "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &sx) != nil || sx.Mnt_id != parentMount.Mnt_id || kind == 0 && (st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || st.Size < 0 || st.Size > 1<<20) {
			return errors.New("native cleanup refuses a changed, mounted or unsupported object")
		}
		if kind != 0 {
			contents, err := file.ReadDir(1)
			if err != nil && err != io.EOF || len(contents) != 0 {
				return errors.New("native cleanup refuses nonempty rootfs or work directories")
			}
		}
		names, kinds = append(names, entry.Name()), append(kinds, kind)
	}
	for n, file := range objects {
		var held, named unix.Stat_t
		if unix.Fstat(int(file.Fd()), &held) != nil || unix.Fstatat(int(i.Directory.Fd()), names[n], &named, unix.AT_SYMLINK_NOFOLLOW) != nil || held.Dev != named.Dev || held.Ino != named.Ino || held.Mode != named.Mode {
			return errors.New("native cleanup object changed before removal")
		}
		if err := unix.Unlinkat(int(i.Directory.Fd()), names[n], kinds[n]); err != nil {
			return err
		}
	}
	if err := i.Directory.Sync(); err != nil {
		return err
	}
	return i.Abort()
}

func (i *Inputs) Verify() error {
	if i == nil || i.closed {
		return errors.New("actual birth inputs are closed")
	}
	if i.outputs != nil {
		if err := i.outputs.verify(); err != nil {
			return err
		}
	}
	for n, f := range i.Files {
		current, err := object(f, n == 4)
		if err != nil || current != i.Objects[n] {
			return errors.New("retained birth input object changed")
		}
	}
	for n, name := range []string{"config.json", "original.create.pb", "consumed.create.pb", "original.config.json"} {
		fd, err := unix.Openat(int(i.Directory.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return errors.New("actual consumed input name is unavailable")
		}
		f := os.NewFile(uintptr(fd), name)
		current, readErr := object(f, false)
		closeErr := f.Close()
		if readErr != nil || closeErr != nil || !sameObjectAcrossMountView(current, i.Objects[n]) {
			return errors.New("actual consumed input name changed")
		}
	}
	actual, err := directory(i.Consumed.Bundle, true)
	if err != nil {
		return err
	}
	var held, named unix.Stat_t
	err = unix.Fstat(int(i.Directory.Fd()), &held)
	namedErr := unix.Fstat(int(actual.Fd()), &named)
	closeErr := actual.Close()
	if err != nil || namedErr != nil || closeErr != nil || held.Dev != named.Dev || held.Ino != named.Ino {
		return errors.New("actual consumption bundle path changed")
	}
	runcFD, err := unix.Openat2(unix.AT_FDCWD, i.runcPath, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return errors.New("actual consumed runc path is unavailable")
	}
	runc := os.NewFile(uintptr(runcFD), i.runcPath)
	current, readErr := object(runc, true)
	closeErr = runc.Close()
	if readErr != nil || closeErr != nil || !sameObjectAcrossMountView(current, i.Objects[4]) {
		return errors.New("actual consumed runc path changed")
	}
	return nil
}

func sameObjectAcrossMountView(actual, held Object) bool {
	if actual.MountID == 0 || held.MountID == 0 {
		return false
	}
	actual.MountID = held.MountID
	return actual == held
}

func (i *Inputs) MountedRoot() (*os.File, error) {
	if err := i.Verify(); err != nil {
		return nil, err
	}
	fd, err := unix.Openat(int(i.Directory.Fd()), "rootfs", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("actual consumed rootfs cannot be retained")
	}
	return os.NewFile(uintptr(fd), "actual-consumed-rootfs"), nil
}

// ReceiveInputs measures duplicated kernel descriptors rather than trusting caller hashes.
func ReceiveInputs(p InputPolicy, files []*os.File) (_ *Inputs, err error) {
	return receiveInputs(p, files, true)
}

func receiveInputs(p InputPolicy, files []*os.File, liveOutputs bool) (_ *Inputs, err error) {
	if p.Validate() != nil || len(files) != 6 {
		return nil, errors.New("original source requires all six consumed input descriptors")
	}
	inputs := &Inputs{runcPath: p.RuncPath}
	defer func() {
		if err != nil {
			inputs.Close()
		}
	}()
	for n, file := range files {
		flags, flagsErr := unix.FcntlInt(file.Fd(), unix.F_GETFL, 0)
		if flagsErr != nil || flags&unix.O_ACCMODE != unix.O_RDONLY || flags&unix.O_PATH != 0 {
			return nil, errors.New("source must receive read-only input descriptors")
		}
		fd, err := unix.FcntlInt(file.Fd(), unix.F_DUPFD_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		copy := os.NewFile(uintptr(fd), "retained-original-birth-input")
		if n == 5 {
			inputs.Directory = copy
		} else {
			inputs.Files[n] = copy
			inputs.Objects[n], err = object(copy, n == 4)
			if err != nil {
				return nil, err
			}
		}
	}
	var raw [4][]byte
	combined := 0
	for n := range raw {
		raw[n], err = io.ReadAll(io.NewSectionReader(inputs.Files[n], 0, MaxInputs+1))
		if err != nil {
			return nil, err
		}
		combined += len(raw[n])
	}
	inputs.Original, inputs.Consumed = &task.CreateTaskRequest{}, &task.CreateTaskRequest{}
	if combined > MaxInputs || proto.Unmarshal(raw[1], inputs.Original) != nil || proto.Unmarshal(raw[2], inputs.Consumed) != nil || ValidateRequest(p, inputs.Original) != nil {
		return nil, errors.New("actual received birth request is unavailable")
	}
	expected := proto.Clone(inputs.Original).(*task.CreateTaskRequest)
	expected.Bundle = filepath.Join(p.InputRoot, expected.ID)
	if !proto.Equal(expected, inputs.Consumed) || inputs.Objects[4].SHA256 != p.RuncSHA256 {
		return nil, errors.New("actual received consumption mapping differs")
	}
	consumedSpec, _, err := ConsumedSpec(raw[3])
	if err != nil || !bytes.Equal(consumedSpec, raw[0]) {
		return nil, errors.New("actual confined OCI input differs from the original creation mapping")
	}
	inputs.Spec = raw[0]
	inputs.OriginalSpec = raw[3]
	if liveOutputs {
		inputs.outputs, err = openOutputs(p, inputs.Original)
		if err != nil {
			return nil, err
		}
	}
	if err := inputs.Verify(); err != nil {
		return nil, err
	}
	return inputs, nil
}

// RecoverInputs recovers only the protected mapping for manager cleanup, never live kernel authority.
func RecoverInputs(p InputPolicy, id string) (_ *Inputs, err error) {
	if p.Validate() != nil || !Hash(id) {
		return nil, errors.New("fixed original cleanup mapping is required")
	}
	bundle, err := directory(filepath.Join(p.InputRoot, id), true)
	if err != nil {
		return nil, err
	}
	defer bundle.Close()
	var files []*os.File
	defer func() { closeFiles(files) }()
	for _, name := range []string{"config.json", "original.create.pb", "consumed.create.pb", "original.config.json"} {
		fd, err := unix.Openat(int(bundle.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		files = append(files, os.NewFile(uintptr(fd), name))
	}
	fd, err := unix.Openat2(unix.AT_FDCWD, p.RuncPath, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, err
	}
	files = append(files, os.NewFile(uintptr(fd), p.RuncPath), bundle)
	inputs, err := receiveInputs(p, files, false)
	if err != nil {
		return nil, err
	}
	if inputs.Original.ID != id {
		inputs.Close()
		return nil, errors.New("cleanup mapping belongs to another original init")
	}
	inputs.root, err = directory(p.InputRoot, true)
	if err != nil {
		inputs.Close()
		return nil, err
	}
	return inputs, nil
}

func (i *Inputs) Close() error {
	if i == nil || i.closed {
		return nil
	}
	i.closed = true
	var result error
	if i.outputs != nil {
		result = errors.Join(result, i.outputs.close())
	}
	for _, f := range i.Files {
		if f != nil {
			result = errors.Join(result, f.Close())
		}
	}
	if i.Directory != nil {
		result = errors.Join(result, i.Directory.Close())
	}
	if i.root != nil {
		result = errors.Join(result, i.root.Close())
	}
	return result
}
