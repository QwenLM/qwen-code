//go:build linux

package coldboot

import (
	"errors"
	"io"
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

type fdIdentity struct {
	device, inode, mount, rdev uint64
	mode                       uint32
	flags                      int
}

type descriptorState struct {
	identity    fdIdentity
	closeOnExec bool
}

func checkFinalDescriptors(known map[int]fdIdentity, observed map[int]descriptorState) error {
	if len(known) != len(observed) {
		return errors.New("retained descriptor set changed before exec")
	}
	for fd, actual := range observed {
		want, ok := known[fd]
		if fd < 3 || !ok || !actual.closeOnExec || actual.identity != want {
			return errors.New("unknown, changed or inheritable non-console descriptor")
		}
	}
	return nil
}

func fdObject(fd int) (fdIdentity, error) {
	var st unix.Stat_t
	var sx unix.Statx_t
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil || unix.Fstat(fd, &st) != nil || unix.Statx(fd, "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &sx) != nil || sx.Mask&unix.STATX_MNT_ID == 0 {
		return fdIdentity{}, errors.New("descriptor identity unavailable")
	}
	return fdIdentity{uint64(st.Dev), st.Ino, sx.Mnt_id, uint64(st.Rdev), st.Mode, flags}, nil
}

func census() ([]int, error) {
	f, err := fixedOpen(procThread+"fd", unix.O_RDONLY|unix.O_DIRECTORY, unix.PROC_SUPER_MAGIC, unix.S_IFDIR)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	names, err := f.Readdirnames(4097)
	if err != nil && err != io.EOF || len(names) > 4096 {
		return nil, errors.New("descriptor scan exceeds its bound")
	}
	var result []int
	for _, name := range names {
		fd, err := strconv.Atoi(name)
		if err != nil || fd < 0 {
			return nil, errors.New("unknown descriptor entry")
		}
		if fd != int(f.Fd()) {
			result = append(result, fd)
		}
	}
	return result, nil
}

func console(fd int) error {
	actual, err := fdObject(fd)
	if err != nil {
		return err
	}
	var st unix.Stat_t
	var named unix.Statx_t
	flags, flagsErr := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if flagsErr != nil || flags&unix.FD_CLOEXEC != 0 || unix.Lstat("/dev/console", &st) != nil || unix.Statx(unix.AT_FDCWD, "/dev/console", unix.AT_SYMLINK_NOFOLLOW, unix.STATX_MNT_ID, &named) != nil || named.Mask&unix.STATX_MNT_ID == 0 || actual.mount != named.Mnt_id || st.Mode&unix.S_IFMT != unix.S_IFCHR || st.Uid != 0 || st.Gid != 0 || unix.Major(uint64(st.Rdev)) != 5 || unix.Minor(uint64(st.Rdev)) != 1 || actual.device != uint64(st.Dev) || actual.inode != st.Ino || actual.rdev != uint64(st.Rdev) || actual.mode&unix.S_IFMT != unix.S_IFCHR {
		return errors.New("only exact inherited console descriptors are supported")
	}
	return nil
}

func initialFDs() (map[int]fdIdentity, error) {
	fds, err := census()
	if err != nil {
		return nil, err
	}
	known := map[int]fdIdentity{}
	counts := map[string]int{}
	for _, fd := range fds {
		if fd <= 2 {
			if err := console(fd); err != nil {
				return nil, err
			}
			continue
		}
		name, err := os.Readlink(procThread + "fd/" + strconv.Itoa(fd))
		if err != nil {
			return nil, err
		}
		if name != "anon_inode:[eventpoll]" && name != "anon_inode:[eventfd]" {
			return nil, errors.New("unclassified descriptor inherited from initrd")
		}
		counts[name]++
		if counts[name] > 1 {
			return nil, errors.New("ambiguous Go runtime descriptor")
		}
		flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
		if err != nil || flags&unix.FD_CLOEXEC == 0 {
			return nil, errors.New("runtime descriptor must be CLOEXEC")
		}
		id, err := fdObject(fd)
		if err != nil {
			return nil, err
		}
		known[fd] = id
	}
	for fd := 0; fd < 3; fd++ {
		if err := console(fd); err != nil {
			return nil, err
		}
	}
	return known, nil
}

func finalFDs(known map[int]fdIdentity) error {
	for fd := 0; fd < 3; fd++ {
		if err := console(fd); err != nil {
			return err
		}
	}
	fds, err := census()
	if err != nil {
		return err
	}
	observed := map[int]descriptorState{}
	for _, fd := range fds {
		if fd <= 2 {
			if err := console(fd); err != nil {
				return err
			}
			continue
		}
		actual, err := fdObject(fd)
		flags, flagErr := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
		if err != nil || flagErr != nil {
			return errors.New("unknown, changed or inheritable non-console descriptor")
		}
		observed[fd] = descriptorState{actual, flags&unix.FD_CLOEXEC != 0}
	}
	return checkFinalDescriptors(known, observed)
}
