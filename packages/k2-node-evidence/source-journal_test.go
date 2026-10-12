package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func testSource() sourceIdentity {
	return sourceIdentity{NodeUID: "owned-node", BootID: "owned-boot", RuntimeDigest: digest([]byte("runtime")), RuntimeStart: 1, RuntimePID: 100, GatewayIncarnation: "0123456789abcdef0123456789abcdef", PluginDigest: digest([]byte("plugin")), PluginStart: 2, PluginPID: 200}
}

func testArm(id string) originalScope {
	return originalScope{ArmID: id, Namespace: "owned", PodName: "owned-pod", Driver: "owned-driver", VolumeID: "owned-volume", PVUID: "owned-pv", PVCUID: "owned-pvc", BindingID: "owned-binding"}
}

func testPolicy() workerPolicy {
	return workerPolicy{KernelRelease: "synthetic-kernel", SourceUserNamespace: kernelObject{2, 10}, SourceMountNamespace: kernelObject{2, 11}, SourceLsmLabel: sourceProfile + " (enforce)", SecurityfsRoot: policyFilesystem{2, 12, 7, 0x73636673}, ApparmorfsRoot: policyFilesystem{2, 13, 7, apparmorFSMagic}, ProfileDirectory: "worker.1", ProfileObject: kernelObject{2, 14}, SourceProfileDirectory: "source.2", SourceProfileObject: kernelObject{2, 15}, ProfileName: workerProfile, ProfileMode: "enforce", GlobalMode: "enforce", LockPolicy: true, NamespaceRevision: "2", LoadRevision: "1", RawABI: "v9", RawLink: "../../raw_data/1/raw_data", RawObject: kernelObject{2, 16}, RawBytes: 1, RawSHA256: digest([]byte("synthetic policy"))}
}

func testArmBody(scope *originalScope) journalBody {
	policy := testPolicy()
	return journalBody{Kind: "ARM", Scope: scope, ImageDigest: digest([]byte("synthetic image")), Policy: &policy}
}

func newTestJournal(t *testing.T) (*sourceJournal, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	j, path, err := createJournal(root, testSource())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = j.close() })
	return j, path
}

func TestJournalDurableHeadAndConcurrentAppend(t *testing.T) {
	j, path := newTestJournal(t)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			scope := testArm("owned-arm")
			if _, err := j.append(testArmBody(&scope)); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	head := j.last
	if err := j.close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	records, err := readJournal(bytes.NewReader(raw), head)
	if err != nil || len(records) != 17 {
		t.Fatalf("durable read: records=%d error=%v", len(records), err)
	}
	for i, record := range records {
		if record.Sequence != uint64(i+1) || record.Incarnation != j.incarnation {
			t.Fatal("concurrent source append changed the sequence or incarnation")
		}
	}
	for length := 0; length < len(raw); length++ {
		if _, err := readJournal(bytes.NewReader(raw[:length]), head); err == nil {
			t.Fatalf("accepted truncated durable journal at %d", length)
		}
	}
}

func TestJournalRejectsTamperingUnknownFieldsAndDuplicateKeys(t *testing.T) {
	j, path := newTestJournal(t)
	arm := testArm("owned-arm")
	if _, err := j.append(testArmBody(&arm)); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	firstSize := int(binary.BigEndian.Uint32(raw))
	first, second := raw[:firstSize+4], raw[firstSize+4:]
	mutations := map[string][]byte{
		"omit":      first,
		"reorder":   append(append([]byte{}, second...), first...),
		"duplicate": append(append([]byte{}, first...), raw...),
	}
	for _, addition := range []string{`"unknown":1,`, `"sequence":1,`} {
		body := append([]byte("{"+addition), first[5:]...)
		frame := make([]byte, 4+len(body))
		binary.BigEndian.PutUint32(frame, uint32(len(body)))
		copy(frame[4:], body)
		mutations[addition] = append(frame, second...)
	}
	for name, input := range mutations {
		if _, err := readJournal(bytes.NewReader(input), j.last); err == nil {
			t.Fatalf("accepted %s", name)
		}
	}
	for i := 4; i < len(raw); i++ {
		input := append([]byte{}, raw...)
		input[i] ^= 1
		if _, err := readJournal(bytes.NewReader(input), j.last); err == nil {
			t.Fatalf("accepted byte tampering at %d", i)
		}
	}
}

type failedJournalFile struct {
	bytes.Buffer
	partial bool
	syncErr bool
	writes  int
	syncs   int
}

func (f *failedJournalFile) Write(b []byte) (int, error) {
	f.writes++
	if f.partial {
		return f.Buffer.Write(b[:3])
	}
	return f.Buffer.Write(b)
}

func (f *failedJournalFile) Sync() error {
	f.syncs++
	if f.syncErr {
		return errors.New("owned sync failure")
	}
	return nil
}

func (f *failedJournalFile) Close() error { return nil }

func TestJournalPoisonsUnknownAppendAndDoesNotRetryIO(t *testing.T) {
	for _, partial := range []bool{false, true} {
		f := &failedJournalFile{partial: partial, syncErr: !partial}
		j := &sourceJournal{file: f, incarnation: "0123456789abcdef0123456789abcdef", last: cursor{Hash: digest(nil)}}
		identity := testSource()
		body := journalBody{Kind: "SOURCE_START", Source: &identity}
		if _, err := j.append(body); !errors.Is(err, errJournalPoisoned) {
			t.Fatalf("unknown first append reported %v", err)
		}
		writes, syncs := f.writes, f.syncs
		if _, err := j.append(body); !errors.Is(err, errJournalPoisoned) || f.writes != writes || f.syncs != syncs || j.last.Sequence != 0 {
			t.Fatal("unknown outcome retried or advanced its durable cursor")
		}
	}
}

func TestJournalExclusiveOwnershipAndNewIncarnation(t *testing.T) {
	j, path := newTestJournal(t)
	root := filepath.Dir(path)
	if other, _, err := createJournal(root, testSource()); err == nil {
		other.close()
		t.Fatal("allowed a second live source owner")
	}
	if err := j.close(); err != nil {
		t.Fatal(err)
	}
	next, nextPath, err := createJournal(root, testSource())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = next.close() })
	if next.incarnation == j.incarnation || nextPath == path || next.last.Sequence != 1 {
		t.Fatal("source restart continued the original live incarnation")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("original journal was removed")
	}
}
