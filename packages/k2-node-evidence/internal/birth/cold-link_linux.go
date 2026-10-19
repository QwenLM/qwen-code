//go:build linux

package birth

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

type coldLinkIdentity struct {
	device, inode, mount, links uint64
	mode                        uint32
	modified, changed           unix.Timespec
}

// ColdLink retains a declared alias without following it. Only its immutable
// cold parent or the retained root-owned startup ancestors may contain it.
type ColdLink struct {
	path, target string
	file         *os.File
	identity     coldLinkIdentity
	ancestors    []*os.File
	identities   []directoryIdentity
}

func linkObject(f *os.File, target string) (coldLinkIdentity, error) {
	fd := int(f.Fd())
	var st unix.Stat_t
	var fs unix.Statfs_t
	var sx unix.Statx_t
	var link [2049]byte
	n, err := unix.Readlinkat(fd, "", link[:])
	if err != nil || string(link[:n]) != target || unix.Fstat(fd, &st) != nil || st.Mode&unix.S_IFMT != unix.S_IFLNK || st.Nlink != 1 || st.Uid != 0 || st.Gid != 0 || unix.Fstatfs(fd, &fs) != nil || fs.Type != unix.EXT4_SUPER_MAGIC || unix.Statx(fd, "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &sx) != nil || sx.Mask&unix.STATX_MNT_ID == 0 {
		return coldLinkIdentity{}, errors.New("declared startup link differs")
	}
	return coldLinkIdentity{uint64(st.Dev), st.Ino, sx.Mnt_id, uint64(st.Nlink), st.Mode, st.Mtim, st.Ctim}, nil
}

func openColdLink(path string) (*os.File, error) {
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{Flags: unix.O_PATH | unix.O_NOFOLLOW | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

func OpenColdLink(path, target string) (_ *ColdLink, err error) {
	if !cleanAbsolute(path) || target == "" || len(target) > 2048 {
		return nil, errors.New("literal declared cold alias required")
	}
	f, err := openColdLink(path)
	if err != nil {
		return nil, err
	}
	p := &ColdLink{path: path, target: target, file: f}
	defer func() {
		if err != nil {
			_ = p.Close()
		}
	}()
	p.identity, err = linkObject(f, target)
	if err != nil {
		return nil, err
	}
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		a, openErr := directory(parent, false)
		if openErr != nil {
			return nil, openErr
		}
		p.ancestors = append(p.ancestors, a)
		id, idErr := ancestorObject(a)
		if idErr != nil {
			return nil, idErr
		}
		p.identities = append(p.identities, id)
		if parent == "/" {
			break
		}
	}
	return p, p.Verify()
}

func (p *ColdLink) Verify() error {
	if p.file == nil {
		return errors.New("cold alias closed")
	}
	held, err := linkObject(p.file, p.target)
	if err != nil || held != p.identity {
		return errors.New("retained cold alias changed")
	}
	named, err := openColdLink(p.path)
	if err != nil {
		return err
	}
	current, err := linkObject(named, p.target)
	_ = named.Close()
	if err != nil || current != held {
		return errors.New("named cold alias changed")
	}
	for i, a := range p.ancestors {
		held, err := ancestorObject(a)
		if err != nil || held != p.identities[i] {
			return errors.New("cold alias ancestor changed")
		}
		n, err := directory(a.Name(), false)
		if err != nil {
			return err
		}
		named, err := ancestorObject(n)
		_ = n.Close()
		if err != nil || named != held {
			return errors.New("named cold alias ancestor changed")
		}
	}
	return nil
}

func (p *ColdLink) Descriptors() []uintptr {
	r := []uintptr{p.file.Fd()}
	for _, f := range p.ancestors {
		r = append(r, f.Fd())
	}
	return r
}
func (p *ColdLink) Close() error {
	var err error
	if p.file != nil {
		err = p.file.Close()
		p.file = nil
	}
	for _, f := range p.ancestors {
		err = errors.Join(err, f.Close())
	}
	p.ancestors = nil
	return err
}
