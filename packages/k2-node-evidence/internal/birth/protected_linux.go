//go:build linux

package birth

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/sys/unix"
)

// ProtectedFile retains an installed configuration or PEM object; Close never
// clears its immutable flag or removes a deployment-owned file.
type ProtectedFile struct {
	mu       sync.Mutex
	path     string
	file     *os.File
	identity Object
	limit    int64
	parent   *ProtectedDirectory
	name     string
}

func OpenProtectedFile(path string) (*ProtectedFile, error) {
	return openProtectedFile(path, MaxInputs)
}

func openProtectedFile(path string, limit int64) (*ProtectedFile, error) {
	if !cleanAbsolute(path) {
		return nil, errors.New("fixed protected file path is required")
	}
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, errors.New("fixed protected file is unavailable")
	}
	f := os.NewFile(uintptr(fd), path)
	identity, err := boundedObject(f, false, limit)
	if err != nil {
		f.Close()
		return nil, err
	}
	return &ProtectedFile{path: path, file: f, identity: identity, limit: limit}, nil
}

func (p *ProtectedFile) verify() error {
	if p.file == nil {
		return errors.New("original protected file is closed")
	}
	current, err := boundedObject(p.file, false, p.limit)
	if err != nil || current != p.identity {
		return errors.New("original protected file changed")
	}
	var fd int
	if p.parent != nil {
		fd, err = p.parent.openArtifact(p.name)
	} else {
		fd, err = unix.Openat2(unix.AT_FDCWD, p.path, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	}
	if err != nil {
		return errors.New("original protected file name is unavailable")
	}
	f := os.NewFile(uintptr(fd), p.path)
	named, readErr := boundedObject(f, false, p.limit)
	closeErr := f.Close()
	if readErr != nil || closeErr != nil || named != p.identity {
		return errors.New("original protected file name changed")
	}
	return nil
}

func (p *ProtectedFile) Verify() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.verify()
}

func (p *ProtectedFile) RequirePrivate() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.identity.Mode&07777 != 0400 || p.verify() != nil {
		return errors.New("original private key must remain root private and read only")
	}
	return nil
}

func (p *ProtectedFile) Bytes() ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.verify(); err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.NewSectionReader(p.file, 0, p.limit+1))
	if err != nil || int64(len(raw)) != p.identity.Bytes || SHA256(raw) != p.identity.SHA256 || p.verify() != nil {
		return nil, errors.New("actual protected file bytes changed")
	}
	return raw, nil
}

type directoryIdentity struct {
	device, inode, mount, links uint64
	mode                        uint32
	flags                       int
	modified, changed           unix.Timespec
}

type ProtectedDirectory struct {
	mu                 sync.Mutex
	path               string
	file               *os.File
	identity           directoryIdentity
	ancestors          []*os.File
	ancestorIdentities []directoryIdentity
}

func directoryObject(f *os.File) (directoryIdentity, error) {
	fd := int(f.Fd())
	var st unix.Stat_t
	var mount unix.Statx_t
	flags, err := unix.IoctlGetInt(fd, unix.FS_IOC_GETFLAGS)
	if err != nil || flags&immutableFlag == 0 || unix.Fstat(fd, &st) != nil || st.Mode&unix.S_IFMT != unix.S_IFDIR || st.Mode&07777 != 0700 || st.Uid != 0 || st.Gid != 0 || unix.Statx(fd, "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &mount) != nil || mount.Mask&unix.STATX_MNT_ID == 0 || mount.Mnt_id == 0 {
		return directoryIdentity{}, errors.New("installed artifact directory is not private and immutable")
	}
	return directoryIdentity{uint64(st.Dev), st.Ino, mount.Mnt_id, uint64(st.Nlink), st.Mode, flags, st.Mtim, st.Ctim}, nil
}

func OpenProtectedDirectory(path string) (*ProtectedDirectory, error) {
	if !cleanAbsolute(path) {
		return nil, errors.New("fixed artifact directory path is required")
	}
	f, err := directory(path, true)
	if err != nil {
		return nil, err
	}
	identity, err := directoryObject(f)
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	p := &ProtectedDirectory{path: path, file: f, identity: identity}
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		ancestor, err := directory(parent, false)
		if err != nil {
			_ = p.Close()
			return nil, err
		}
		p.ancestors = append(p.ancestors, ancestor)
		id, err := ancestorObject(ancestor)
		if err != nil {
			_ = p.Close()
			return nil, err
		}
		p.ancestorIdentities = append(p.ancestorIdentities, id)
		if parent == "/" {
			break
		}
	}
	return p, nil
}

func (p *ProtectedDirectory) Verify() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.verify()
}

func ancestorObject(f *os.File) (directoryIdentity, error) {
	var st unix.Stat_t
	var mount unix.Statx_t
	fd := int(f.Fd())
	if unix.Fstat(fd, &st) != nil || st.Mode&unix.S_IFMT != unix.S_IFDIR || st.Uid != 0 || st.Gid != 0 || st.Mode&0022 != 0 || unix.Statx(fd, "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &mount) != nil || mount.Mask&unix.STATX_MNT_ID == 0 || mount.Mnt_id == 0 {
		return directoryIdentity{}, errors.New("installed artifact path ancestor is unavailable")
	}
	return directoryIdentity{device: uint64(st.Dev), inode: st.Ino, mount: mount.Mnt_id, mode: st.Mode}, nil
}

func (p *ProtectedDirectory) verify() error {
	if p.file == nil {
		return errors.New("original artifact directory is closed")
	}
	held, err := directoryObject(p.file)
	if err != nil || held != p.identity {
		return errors.New("original artifact directory changed")
	}
	f, err := directory(p.path, true)
	if err != nil {
		return err
	}
	named, err := directoryObject(f)
	closeErr := f.Close()
	if err != nil || closeErr != nil || named != p.identity {
		return errors.New("original artifact directory name changed")
	}
	for i, ancestor := range p.ancestors {
		held, err := ancestorObject(ancestor)
		if err != nil || held != p.ancestorIdentities[i] {
			return errors.New("original artifact path ancestor changed")
		}
		named, err := directory(ancestor.Name(), false)
		if err != nil {
			return err
		}
		current, err := ancestorObject(named)
		closeErr := named.Close()
		if err != nil || closeErr != nil || current != held {
			return errors.New("original artifact path ancestor name changed")
		}
	}
	return nil
}

func (p *ProtectedDirectory) openArtifact(name string) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || p.verify() != nil {
		return -1, errors.New("original artifact basename or directory is unavailable")
	}
	return unix.Openat2(int(p.file.Fd()), name, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV})
}

// OpenArtifact keeps artifact bounds separate and opens only the retained root's
// literal children on that same mount. It creates no installation authority.
func (p *ProtectedDirectory) OpenArtifact(name string, limit int) (*ProtectedFile, error) {
	if limit <= 0 || limit > 16<<20 {
		return nil, errors.New("unsupported protected artifact bound")
	}
	fd, err := p.openArtifact(name)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(p.path, name)
	f := os.NewFile(uintptr(fd), path)
	identity, err := boundedObject(f, false, int64(limit))
	if err != nil || identity.Device != p.identity.device || identity.MountID != p.identity.mount || p.Verify() != nil {
		_ = f.Close()
		return nil, errors.New("original artifact is not a protected child of its retained root")
	}
	return &ProtectedFile{path: path, file: f, identity: identity, limit: int64(limit), parent: p, name: name}, nil
}

func (p *ProtectedDirectory) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	var err error
	for _, ancestor := range p.ancestors {
		err = errors.Join(err, ancestor.Close())
	}
	p.ancestors = nil
	if p.file != nil {
		err = errors.Join(err, p.file.Close())
		p.file = nil
	}
	return err
}

func (p *ProtectedFile) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file == nil {
		return nil
	}
	err := p.file.Close()
	p.file = nil
	return err
}
