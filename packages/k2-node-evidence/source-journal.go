package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const journalVersion = "qwen-k2-node-source/4"
const maxRecordBytes = 64 << 10
const maxJournalBytes = 64 << 20
const maxJournalRecords = 65536

var errJournalPoisoned = errors.New("source journal has an unknown append outcome")

type sourceIdentity struct {
	NodeUID            string `json:"nodeUid"`
	BootID             string `json:"bootId"`
	RuntimeDigest      string `json:"runtimeDigest"`
	RuntimeStart       uint64 `json:"runtimeStart"`
	RuntimePID         int32  `json:"runtimePid"`
	GatewayIncarnation string `json:"gatewayIncarnation"`
	PluginDigest       string `json:"pluginDigest"`
	PluginStart        uint64 `json:"pluginStart"`
	PluginPID          int32  `json:"pluginPid"`
}

type originalScope struct {
	ArmID        string `json:"armId"`
	Namespace    string `json:"namespace"`
	PodName      string `json:"podName"`
	PodUID       string `json:"podUid"`
	ContainerID  string `json:"containerId"`
	Driver       string `json:"driver"`
	VolumeID     string `json:"volumeId"`
	PVUID        string `json:"pvUid"`
	PVCUID       string `json:"pvcUid"`
	Target       string `json:"target"`
	BindingID    string `json:"bindingId"`
	RetirementID string `json:"retirementId"`
}

type cursor struct {
	Sequence uint64 `json:"sequence"`
	Hash     string `json:"hash"`
}

type custodyObservation struct {
	PID          uint32 `json:"pid"`
	StartTicks   uint64 `json:"startTicks"`
	CgroupDevice uint64 `json:"cgroupDevice"`
	CgroupInode  uint64 `json:"cgroupInode"`
	Coverage     string `json:"coverage"`
	ParentDevice uint64 `json:"parentDevice"`
	ParentInode  uint64 `json:"parentInode"`
	Populated    bool   `json:"populated"`
	Terminal     bool   `json:"terminal"`
}

type targetIdentity struct {
	Device  uint64 `json:"device"`
	Inode   uint64 `json:"inode"`
	MountID uint64 `json:"mountId"`
}

type journalBody struct {
	Version            string              `json:"version"`
	Incarnation        string              `json:"incarnation"`
	Sequence           uint64              `json:"sequence"`
	Previous           string              `json:"previous"`
	Kind               string              `json:"kind"`
	Source             *sourceIdentity     `json:"source,omitempty"`
	Scope              *originalScope      `json:"scope,omitempty"`
	Begin              *cursor             `json:"begin,omitempty"`
	Publish            *cursor             `json:"publish,omitempty"`
	Stop               *cursor             `json:"stop,omitempty"`
	Custody            *custodyObservation `json:"custody,omitempty"`
	Runtime            *runtimeObservation `json:"runtime,omitempty"`
	Caller             *runtimePeer        `json:"caller,omitempty"`
	Target             *targetIdentity     `json:"target,omitempty"`
	IntentHash         string              `json:"intentHash,omitempty"`
	Status             uint32              `json:"status,omitempty"`
	ImageDigest        string              `json:"imageDigest,omitempty"`
	Policy             *workerPolicy       `json:"policy,omitempty"`
	GatedSpecSHA256    string              `json:"gatedSpecSha256,omitempty"`
	PodResourceVersion string              `json:"podResourceVersion,omitempty"`
}

type journalRecord struct {
	journalBody
	Hash string `json:"hash"`
}

func (r journalRecord) cursor() cursor {
	return cursor{r.Sequence, r.Hash}
}

func digest(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func hashString(s string) bool {
	if len(s) != 64 {
		return false
	}
	b, err := hex.DecodeString(s)
	return err == nil && hex.EncodeToString(b) == s
}

func bounded(s string) bool {
	return len(s) > 0 && len(s) <= 2048 && utf8.ValidString(s) && bytes.IndexByte([]byte(s), 0) < 0
}

func validCursor(c *cursor, seq uint64) bool {
	return c != nil && c.Sequence > 0 && c.Sequence < seq && hashString(c.Hash)
}

func validateBody(b journalBody) error {
	if b.Version != journalVersion || len(b.Incarnation) != 32 || b.Sequence == 0 || b.Sequence > maxJournalRecords {
		return errors.New("invalid source journal identity")
	}
	inc, err := hex.DecodeString(b.Incarnation)
	if err != nil || hex.EncodeToString(inc) != b.Incarnation || !hashString(b.Previous) {
		return errors.New("invalid source journal chain")
	}
	if b.Kind == "SOURCE_START" {
		if b.Sequence != 1 || b.Source == nil || b.Scope != nil || b.Begin != nil || b.Publish != nil || b.Stop != nil || b.Custody != nil || b.Runtime != nil || b.Caller != nil || b.Target != nil || b.IntentHash != "" || b.Status != 0 || b.ImageDigest != "" || b.Policy != nil || b.GatedSpecSHA256 != "" || b.PodResourceVersion != "" {
			return errors.New("invalid source start")
		}
		s := b.Source
		if !bounded(s.NodeUID) || !bounded(s.BootID) || !hashString(s.RuntimeDigest) || !hashString(s.PluginDigest) || s.RuntimeStart == 0 || s.PluginStart == 0 || s.RuntimePID <= 0 || s.PluginPID <= 0 || len(s.GatewayIncarnation) != 32 || !hashString(s.GatewayIncarnation+s.GatewayIncarnation) {
			return errors.New("invalid original source identity")
		}
		return nil
	}
	if b.Sequence == 1 || b.Source != nil || b.Scope == nil {
		return errors.New("missing original scope")
	}
	s := b.Scope
	for _, field := range []string{s.ArmID, s.Namespace, s.PodName, s.Driver, s.VolumeID, s.PVUID, s.PVCUID, s.BindingID} {
		if !bounded(field) {
			return errors.New("invalid original scope")
		}
	}
	if b.Kind != "ARM" && b.Kind != "CONFINEMENT_LOST" && (!bounded(s.PodUID) || !bounded(s.Target)) {
		return errors.New("missing original Pod association")
	}
	if b.Kind == "ARM" && (s.PodUID != "" || s.ContainerID != "" || s.Target != "" || s.RetirementID != "") {
		return errors.New("ARM must precede original Pod creation")
	}
	if s.ContainerID != "" && !bounded(s.ContainerID) {
		return errors.New("invalid original container identity")
	}
	if b.Kind == "CONFINEMENT_LOST" && ((s.PodUID == "") != (s.Target == "") || s.PodUID == "" && (s.ContainerID != "" || s.RetirementID != "")) {
		return errors.New("invalid confinement loss association")
	}
	if (b.ImageDigest != "") != (b.Kind == "ARM") || (b.Policy != nil) != (b.Kind == "ARM") || (b.GatedSpecSHA256 != "") != (b.Kind == "BIND") || (b.PodResourceVersion != "") != (b.Kind == "BIND") || b.Kind == "ARM" && (!hashString(b.ImageDigest) || validatePolicy(b.Policy) != nil) || b.Kind == "BIND" && (!hashString(b.GatedSpecSHA256) || !bounded(b.PodResourceVersion)) {
		return errors.New("invalid original policy or admitted BIND")
	}
	wantBegin, wantPublish, wantStop, wantCustody, wantTarget, wantIntent, wantStatus := false, false, false, false, false, false, false
	switch b.Kind {
	case "ARM", "BIND", "PUBLISH_BEGIN":
	case "CUSTODY_OPEN":
		wantCustody = true
	case "CONFINEMENT_LOST":
	case "PUBLISH_OK":
		wantBegin, wantTarget = true, true
	case "PUBLISH_FAILED":
		wantBegin, wantStatus = true, true
	case "UNPUBLISH_FAILED":
		wantBegin, wantPublish, wantStop, wantStatus = true, true, true, true
	case "STOP_INTENT":
		wantIntent = true
	case "ORIGINAL_STOPPED":
		wantBegin, wantPublish, wantCustody, wantIntent = true, true, true, true
	case "UNPUBLISH_BEGIN":
		wantPublish, wantStop, wantCustody = true, true, true
	case "UNPUBLISH_OK":
		wantBegin, wantPublish, wantStop, wantCustody = true, true, true, true
	default:
		return errors.New("unknown source record kind")
	}
	if (b.Begin != nil) != wantBegin || (b.Publish != nil) != wantPublish || (b.Stop != nil) != wantStop || (b.Custody != nil) != wantCustody || (b.Runtime != nil) != wantCustody || (b.Target != nil) != wantTarget || (b.IntentHash != "") != wantIntent || (b.Status != 0) != wantStatus {
		return errors.New("unexpected source record fields")
	}
	wantCaller := b.Kind == "PUBLISH_BEGIN" || b.Kind == "UNPUBLISH_BEGIN"
	if (b.Caller != nil) != wantCaller || wantCaller && (b.Caller.PID <= 0 || b.Caller.StartTicks == 0 || !hashString(b.Caller.Digest)) {
		return errors.New("invalid original CSI caller")
	}
	if wantBegin && !validCursor(b.Begin, b.Sequence) || wantPublish && !validCursor(b.Publish, b.Sequence) || wantStop && !validCursor(b.Stop, b.Sequence) || wantIntent && (!hashString(b.IntentHash) || !bounded(s.RetirementID)) || wantStatus && b.Status > 16 {
		return errors.New("invalid source dependencies or outcome")
	}
	if wantCustody {
		c := b.Custody
		terminal := b.Kind != "CUSTODY_OPEN"
		if !bounded(s.ContainerID) || c.PID == 0 || c.StartTicks == 0 || c.CgroupInode == 0 || c.Coverage != parentCoverage ||
			c.ParentDevice != c.CgroupDevice || c.ParentInode == 0 || c.ParentInode == c.CgroupInode ||
			(terminal && (c.Populated || !c.Terminal)) || (!terminal && (!c.Populated || c.Terminal)) {
			return errors.New("invalid original custody observation")
		}
		r := b.Runtime
		if r.Version != "qwen-k2-runtime-read/1" || r.ArmID != s.ArmID || r.PodUID != s.PodUID || r.ContainerID != s.ContainerID || r.PID != c.PID || !hashString(r.ImageDigest) || !hashString(r.SandboxID) || (terminal && (r.State != "stopped" || r.ExitedAtNano <= 0)) || (!terminal && (r.State != "created" && r.State != "running" || r.ExitedAtNano != 0)) {
			return errors.New("invalid original runtime observation")
		}
	}
	if wantTarget && (b.Target.Inode == 0 || b.Target.MountID == 0) {
		return errors.New("invalid original publication target")
	}
	return nil
}

type journalFile interface {
	io.Writer
	Sync() error
	Close() error
}

type sourceJournal struct {
	mu          sync.Mutex
	file        journalFile
	lock        *os.File
	incarnation string
	last        cursor
	bytes       uint64
	poisoned    bool
	closed      bool
}

func createJournal(root string, identity sourceIdentity) (*sourceJournal, string, error) {
	if !filepath.IsAbs(root) {
		return nil, "", errors.New("source journal root must be absolute")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return nil, "", errors.New("source journal root must be an existing private directory")
	}
	lockFD, err := unix.Open(filepath.Join(root, "source.lock"), unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, "", err
	}
	lock := os.NewFile(uintptr(lockFD), "source.lock")
	if err = unix.Flock(lockFD, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		lock.Close()
		return nil, "", errors.New("source journal already has a live owner")
	}
	var inc [16]byte
	if _, err = rand.Read(inc[:]); err != nil {
		lock.Close()
		return nil, "", err
	}
	incarnation := hex.EncodeToString(inc[:])
	path := filepath.Join(root, incarnation+".journal")
	fd, err := unix.Open(path, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		lock.Close()
		return nil, "", err
	}
	f := os.NewFile(uintptr(fd), path)
	dir, err := os.Open(root)
	if err == nil {
		err = dir.Sync()
		dir.Close()
	}
	if err != nil {
		f.Close()
		lock.Close()
		return nil, "", err
	}
	j := &sourceJournal{file: f, lock: lock, incarnation: incarnation, last: cursor{Hash: fmt.Sprintf("%064x", 0)}}
	if _, err = j.append(journalBody{Kind: "SOURCE_START", Source: &identity}); err != nil {
		j.close()
		return nil, path, err
	}
	return j, path, nil
}

func (j *sourceJournal) append(b journalBody) (journalRecord, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.poisoned || j.closed {
		return journalRecord{}, errJournalPoisoned
	}
	b.Version, b.Incarnation, b.Sequence, b.Previous = journalVersion, j.incarnation, j.last.Sequence+1, j.last.Hash
	if err := validateBody(b); err != nil {
		return journalRecord{}, err
	}
	body, err := json.Marshal(b)
	if err != nil {
		return journalRecord{}, err
	}
	r := journalRecord{journalBody: b, Hash: digest(body)}
	raw, err := json.Marshal(r)
	if err != nil || len(raw) > maxRecordBytes || j.bytes+uint64(len(raw)+4) > maxJournalBytes {
		return journalRecord{}, errors.New("source journal capacity exceeded")
	}
	frame := make([]byte, len(raw)+4)
	binary.BigEndian.PutUint32(frame, uint32(len(raw)))
	copy(frame[4:], raw)
	if n, err := j.file.Write(frame); err != nil || n != len(frame) {
		j.poisoned = true
		return journalRecord{}, errJournalPoisoned
	}
	if err := j.file.Sync(); err != nil {
		j.poisoned = true
		return journalRecord{}, errJournalPoisoned
	}
	j.last = r.cursor()
	j.bytes += uint64(len(frame))
	return r, nil
}

func (j *sourceJournal) close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return nil
	}
	j.closed = true
	err := j.file.Close()
	if j.lock != nil {
		err = errors.Join(err, j.lock.Close())
	}
	return err
}

func readJournal(reader io.Reader, expected cursor) ([]journalRecord, error) {
	if expected.Sequence == 0 || !hashString(expected.Hash) {
		return nil, errors.New("original durable journal head is required")
	}
	reader = io.LimitReader(reader, maxJournalBytes+1)
	var records []journalRecord
	var consumed uint64
	last := cursor{Hash: fmt.Sprintf("%064x", 0)}
	incarnation := ""
	for {
		var length [4]byte
		n, err := io.ReadFull(reader, length[:])
		if err == io.EOF && n == 0 {
			if last != expected {
				return nil, errors.New("source journal does not reach its original durable head")
			}
			return records, nil
		}
		size := binary.BigEndian.Uint32(length[:])
		consumed += 4 + uint64(size)
		if err != nil || size == 0 || size > maxRecordBytes || consumed > maxJournalBytes || len(records) >= maxJournalRecords {
			return nil, errors.New("invalid source journal frame")
		}
		raw := make([]byte, int(size))
		if _, err = io.ReadFull(reader, raw); err != nil {
			return nil, errors.New("truncated source journal record")
		}
		var r journalRecord
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&r); err != nil || validateBody(r.journalBody) != nil {
			return nil, errors.New("invalid source journal record")
		}
		canonical, err := json.Marshal(r)
		body, bodyErr := json.Marshal(r.journalBody)
		if err != nil || bodyErr != nil || !bytes.Equal(raw, canonical) || !hashString(r.Hash) || digest(body) != r.Hash || r.Sequence != last.Sequence+1 || r.Previous != last.Hash || (incarnation != "" && r.Incarnation != incarnation) {
			return nil, errors.New("source journal integrity failure")
		}
		incarnation, last = r.Incarnation, r.cursor()
		records = append(records, r)
	}
}
