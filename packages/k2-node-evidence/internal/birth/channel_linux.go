//go:build linux

package birth

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

func readPacket(connection *net.UnixConn) ([]byte, []*os.File, error) {
	raw := make([]byte, MaxFrame+1)
	oob := make([]byte, unix.CmsgSpace(6*4))
	n, ancillary, flags, _, readErr := connection.ReadMsgUnix(raw, oob)
	messages, parseErr := unix.ParseSocketControlMessage(oob[:ancillary])
	var files []*os.File
	var rightsErr error
	for _, message := range messages {
		if message.Header.Level != unix.SOL_SOCKET || message.Header.Type != unix.SCM_RIGHTS {
			rightsErr = errors.New("unsupported pre-exec ancillary data")
			continue
		}
		fds, err := unix.ParseUnixRights(&message)
		if err != nil {
			rightsErr = err
			continue
		}
		for _, fd := range fds {
			unix.CloseOnExec(fd)
			files = append(files, os.NewFile(uintptr(fd), "original-pre-exec-input"))
		}
	}
	if readErr != nil || parseErr != nil || rightsErr != nil || n == 0 || n > MaxFrame || flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 || len(files) > 6 {
		closeFiles(files)
		return nil, nil, errors.New("original pre-exec packet is unavailable or truncated")
	}
	return raw[:n], files, nil
}

func closeFiles(files []*os.File) {
	for _, file := range files {
		_ = file.Close()
	}
}

func writePacket(connection *net.UnixConn, raw []byte, files []*os.File) error {
	if len(raw) == 0 || len(raw) > MaxFrame || len(files) > 6 {
		return errors.New("pre-exec packet exceeds its bound")
	}
	var oob []byte
	if len(files) != 0 {
		fds := make([]int, len(files))
		for n, file := range files {
			if file == nil {
				return errors.New("original pre-exec input descriptor is missing")
			}
			fds[n] = int(file.Fd())
		}
		oob = unix.UnixRights(fds...)
	}
	n, ancillary, err := connection.WriteMsgUnix(raw, oob, nil)
	if err != nil || n != len(raw) || ancillary != len(oob) {
		return errors.New("original pre-exec send outcome is unknown")
	}
	return nil
}

type Channel struct {
	mu          sync.Mutex
	connection  *net.UnixConn
	peer        *Peer
	sequence    uint64
	incarnation string
	association string
	closed      bool
}

func Dial(ctx context.Context, path, digest, label string) (*Channel, error) {
	if !cleanAbsolute(path) || len(path) > 100 {
		return nil, errors.New("fixed pre-exec Unix endpoint is required")
	}
	parent, err := directory(filepath.Dir(path), false)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	var st unix.Stat_t
	if unix.Fstatat(int(parent.Fd()), filepath.Base(path), &st, unix.AT_SYMLINK_NOFOLLOW) != nil || st.Mode&unix.S_IFMT != unix.S_IFSOCK || st.Uid != 0 || st.Gid != 0 || st.Mode&0077 != 0 {
		return nil, errors.New("pre-exec endpoint must be a protected root socket")
	}
	connection, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unixpacket", path)
	if err != nil {
		return nil, errors.New("original pre-exec endpoint is unavailable")
	}
	conn, ok := connection.(*net.UnixConn)
	if !ok {
		connection.Close()
		return nil, errors.New("pre-exec endpoint must use Unix sequenced packets")
	}
	peer, err := OpenPeer(conn, digest, label)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return &Channel{connection: conn, peer: peer}, nil
}

func (c *Channel) Call(ctx context.Context, call Call, inputs *Inputs) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return "", errors.New("original pre-exec source channel is closed")
	}
	var files []*os.File
	if call.Action == "prepare" {
		if inputs == nil || inputs.Verify() != nil {
			return "", errors.New("original protected inputs are unavailable")
		}
		files = append(files, inputs.Files[:]...)
		files = append(files, inputs.Directory)
	} else if call.Action == "bind-created" {
		if inputs == nil {
			return "", errors.New("actual consumed rootfs descriptor is required")
		}
		root, err := inputs.MountedRoot()
		if err != nil {
			return "", err
		}
		defer root.Close()
		files = []*os.File{root}
	}
	c.sequence++
	call.Version, call.Sequence, call.Association = ChannelVersion, c.sequence, c.association
	raw, err := json.Marshal(call)
	if err != nil || call.Validate(c.sequence) != nil || c.peer.Verify() != nil {
		return "", errors.Join(errors.New("original pre-exec call refused"), c.close())
	}
	deadline := time.Now().Add(5 * time.Second)
	if bound, ok := ctx.Deadline(); ok && bound.Before(deadline) {
		deadline = bound
	}
	if err := ctx.Err(); err != nil {
		return "", errors.Join(err, c.close())
	}
	if c.connection.SetDeadline(deadline) != nil || writePacket(c.connection, raw, files) != nil {
		return "", errors.Join(errors.New("original pre-exec send failed"), c.close())
	}
	replyRaw, rights, err := readPacket(c.connection)
	if len(rights) != 0 {
		closeFiles(rights)
		err = errors.New("pre-exec source cannot return descriptors")
	}
	if err != nil || c.peer.Verify() != nil {
		return "", errors.Join(errors.New("original pre-exec source was lost"), c.close())
	}
	reply, err := DecodeReply(replyRaw, raw, c.sequence, c.incarnation, c.association)
	if err != nil {
		return "", errors.Join(err, c.close())
	}
	c.incarnation, c.association = reply.Incarnation, reply.Association
	return c.association, nil
}

func (c *Channel) close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	return errors.Join(c.connection.Close(), c.peer.Close())
}

func (c *Channel) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.close()
}

type Handler interface {
	Handle(context.Context, *Peer, Call, []*os.File) (string, error)
	Lost(*Peer)
}

// ServeConnection authenticates once and rechecks the same retained peer for every call.
func ServeConnection(ctx context.Context, connection *net.UnixConn, digest, label, incarnation string, handler Handler) error {
	defer connection.Close()
	stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stop()
	if !Hash(incarnation) || handler == nil {
		return errors.New("original pre-exec source incarnation is required")
	}
	peer, err := OpenPeer(connection, digest, label)
	if err != nil {
		return err
	}
	defer peer.Close()
	defer handler.Lost(peer)
	association := ""
	id := ""
	for sequence := uint64(1); sequence <= 16; sequence++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := peer.Verify(); err != nil {
			return err
		}
		raw, files, err := readPacket(connection)
		if err != nil {
			return err
		}
		call, decodeErr := DecodeCall(raw, sequence)
		expectedFiles := 0
		if call.Action == "prepare" {
			expectedFiles = 6
		} else if call.Action == "bind-created" {
			expectedFiles = 1
		}
		if decodeErr != nil || call.Association != association || id != "" && call.ID != id || len(files) != expectedFiles || peer.Verify() != nil {
			closeFiles(files)
			return errors.New("original pre-exec frame refused")
		}
		id = call.ID
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		next, handleErr := handler.Handle(callCtx, peer, call, files)
		cancel()
		closeFiles(files)
		if handleErr != nil || !Hash(next) || association != "" && next != association || peer.Verify() != nil {
			return errors.New("original pre-exec source transition refused")
		}
		association = next
		reply, err := json.Marshal(Reply{ChannelVersion, sequence, incarnation, SHA256(raw), association, true})
		if err != nil || writePacket(connection, reply, nil) != nil {
			return errors.New("original pre-exec reply outcome is unknown")
		}
	}
	return errors.New("pre-exec source channel exhausted its bound")
}
