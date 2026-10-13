//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"golang.org/x/sys/unix"
)

type armRequest struct {
	Scope       originalScope `json:"scope"`
	ImageDigest string        `json:"imageDigest"`
}

type bindRequest struct {
	ArmID              string `json:"armId"`
	PodUID             string `json:"podUid"`
	Target             string `json:"target"`
	GatedSpecSHA256    string `json:"gatedSpecSha256"`
	PodResourceVersion string `json:"podResourceVersion"`
}

type stopRequest struct {
	ArmID        string `json:"armId"`
	RetirementID string `json:"retirementId"`
	IntentHash   string `json:"intentHash"`
}

type originalSource struct {
	scope          originalScope
	imageDigest    string
	arm            journalRecord
	bound          *journalRecord
	custody        *kernelCustody
	opened         *journalRecord
	publish        *journalRecord
	publishRequest *csi.NodePublishVolumeRequest
	kubelet        runtimePeer
	intent         *journalRecord
	stop           *journalRecord
	unpublish      *journalRecord
	blocked        bool
}

type nodeSource struct {
	mu          sync.Mutex
	journal     *sourceJournal
	journalPath string
	gateway     *sourceGateway
	originals   map[string]*originalSource
	active      *originalSource
	coordinator string
	driver      string
}

func (s *nodeSource) record(original *originalSource, body journalBody) (journalRecord, error) {
	scope := original.scope
	body.Scope = &scope
	r, err := s.journal.append(body)
	if err != nil {
		original.blocked = true
	}
	return r, err
}

func (s *nodeSource) block(original *originalSource) error {
	if !original.blocked {
		original.blocked = true
		_, _ = s.record(original, journalBody{Kind: "CONFINEMENT_LOST"})
	}
	if original.custody != nil {
		_ = original.custody.close()
	}
	return errors.New("original source custody is unavailable")
}

func (s *nodeSource) arm(request armRequest) (journalRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !safeID(request.Scope.ArmID) || !safeID(request.Scope.Namespace) || !safeID(request.Scope.PodName) || request.Scope.Driver != s.driver || !hashString(request.ImageDigest) {
		return journalRecord{}, errors.New("invalid original ARM")
	}
	if original := s.originals[request.Scope.ArmID]; original != nil {
		if original.arm.Scope == nil || *original.arm.Scope != request.Scope || original.imageDigest != request.ImageDigest || original.blocked {
			return journalRecord{}, errors.New("original ARM cannot change")
		}
		if original.unpublish == nil && s.gateway.verify(context.Background()) != nil {
			return journalRecord{}, s.block(original)
		}
		return original.arm, nil
	}
	if s.active != nil && s.active.unpublish == nil || len(s.originals) >= 4096 {
		return journalRecord{}, errors.New("source has an unreleased original scope")
	}
	if err := s.gateway.verify(context.Background()); err != nil {
		return journalRecord{}, err
	}
	original := &originalSource{scope: request.Scope, imageDigest: request.ImageDigest}
	policy := s.gateway.policy.value
	r, err := s.record(original, journalBody{Kind: "ARM", ImageDigest: request.ImageDigest, Policy: &policy})
	if err != nil {
		return journalRecord{}, err
	}
	original.arm = r
	if s.originals == nil {
		s.originals = make(map[string]*originalSource)
	}
	s.originals[request.Scope.ArmID], s.active = original, original
	return r, nil
}

func (s *nodeSource) bind(ctx context.Context, request bindRequest) (journalRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	original := s.originals[request.ArmID]
	if original == nil || original.blocked || !safeID(request.PodUID) || !hashString(request.GatedSpecSHA256) || !bounded(request.PodResourceVersion) {
		return journalRecord{}, errors.New("original ARM is unavailable")
	}
	if original.unpublish == nil && s.gateway.verify(ctx) != nil {
		return journalRecord{}, s.block(original)
	}
	if original.bound != nil {
		if original.scope.PodUID != request.PodUID || original.scope.Target != request.Target || original.bound.GatedSpecSHA256 != request.GatedSpecSHA256 || original.bound.PodResourceVersion != request.PodResourceVersion {
			return journalRecord{}, errors.New("original UID association cannot change")
		}
		return *original.bound, nil
	}
	scope := original.scope
	scope.PodUID, scope.Target = request.PodUID, request.Target
	if _, err := originalTarget(scope); err != nil {
		return journalRecord{}, err
	}
	if _, err := readTarget(scope, false); !errors.Is(err, unix.ENOENT) {
		return journalRecord{}, errors.New("original target must be absent before scheduling")
	}
	if err := s.gateway.verify(ctx); err != nil {
		return journalRecord{}, s.block(original)
	}
	observation, err := s.gateway.observe(ctx, scope.ArmID)
	if err != nil || observation.PodUID != scope.PodUID || observation.ImageDigest != original.imageDigest || observation.State != "pending" || observation.PID != 0 || observation.ContainerID != "" || observation.SandboxID != "" {
		return journalRecord{}, errors.New("original gateway must already bind the gated, unborn task")
	}
	if s.gateway.verify(ctx) != nil {
		return journalRecord{}, s.block(original)
	}
	original.scope = scope
	r, err := s.record(original, journalBody{Kind: "BIND", GatedSpecSHA256: request.GatedSpecSHA256, PodResourceVersion: request.PodResourceVersion})
	if err != nil {
		return journalRecord{}, err
	}
	original.bound = &r
	return r, nil
}

func (s *nodeSource) requestStop(ctx context.Context, request stopRequest) (journalRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	original := s.originals[request.ArmID]
	if original == nil || original.bound == nil || original.blocked || !bounded(request.RetirementID) || !hashString(request.IntentHash) {
		return journalRecord{}, errors.New("original stop intent refused")
	}
	if original.unpublish == nil && s.gateway.verify(ctx) != nil {
		return journalRecord{}, s.block(original)
	}
	if original.intent != nil {
		if original.scope.RetirementID != request.RetirementID || original.intent.IntentHash != request.IntentHash {
			return journalRecord{}, errors.New("original stop intent cannot change")
		}
		return *original.intent, nil
	}
	original.scope.RetirementID = request.RetirementID
	r, err := s.record(original, journalBody{Kind: "STOP_INTENT", IntentHash: request.IntentHash})
	if err != nil {
		return journalRecord{}, err
	}
	original.intent = &r
	return r, nil
}

func (s *nodeSource) verifyStopped(ctx context.Context, original *originalSource) (custodyObservation, error) {
	if original.blocked || original.custody == nil || original.stop == nil || original.stop.Custody == nil || s.gateway.verify(ctx) != nil {
		return custodyObservation{}, s.block(original)
	}
	current, err := original.custody.observe()
	if err != nil || !sameTerminalCustody(current, *original.stop.Custody) || s.gateway.verify(ctx) != nil {
		return custodyObservation{}, s.block(original)
	}
	return current, nil
}

func (s *nodeSource) poll(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	original := s.active
	if original == nil || original.blocked || original.unpublish != nil {
		return
	}
	if s.gateway.verify(ctx) != nil {
		_ = s.block(original)
		return
	}
	if original.bound == nil {
		return
	}
	if original.stop != nil {
		_, _ = s.verifyStopped(ctx, original)
		return
	}
	runtime, err := s.gateway.observe(ctx, original.scope.ArmID)
	if err != nil || runtime.PodUID != original.scope.PodUID || runtime.ImageDigest != original.imageDigest || s.gateway.verify(ctx) != nil {
		_ = s.block(original)
		return
	}
	if runtime.State == "pending" && original.custody == nil {
		return
	}
	if original.custody == nil {
		if original.publish == nil {
			_ = s.block(original)
			return
		}
		c, err := openOriginalCustody(runtime)
		if err != nil {
			_ = s.block(original)
			return
		}
		if s.gateway.verify(ctx) != nil {
			_ = c.close()
			_ = s.block(original)
			return
		}
		original.custody, original.scope.ContainerID = c, runtime.ContainerID
		observation := c.initial
		r, err := s.record(original, journalBody{Kind: "CUSTODY_OPEN", Custody: &observation, Runtime: &runtime})
		if err != nil {
			_ = s.block(original)
			return
		}
		original.opened = &r
	}
	observation, err := original.custody.observe()
	if err != nil || runtime.PID != observation.PID || runtime.ContainerID != original.scope.ContainerID || runtime.SandboxID != original.opened.Runtime.SandboxID || s.gateway.verify(ctx) != nil {
		_ = s.block(original)
		return
	}
	if runtime.State == "running" && original.custody.verifyRunningSecurity() != nil || runtime.State == "created" && original.custody.security != nil {
		_ = s.block(original)
		return
	}
	if runtime.State == "stopped" && observation.Terminal && !observation.Populated {
		if original.publish == nil || original.intent == nil || original.opened == nil || original.custody.security == nil {
			_ = s.block(original)
			return
		}
		begin, publish := original.opened.cursor(), original.publish.cursor()
		r, err := s.record(original, journalBody{Kind: "ORIGINAL_STOPPED", Begin: &begin, Publish: &publish, Custody: &observation, Runtime: &runtime, IntentHash: original.intent.IntentHash})
		if err != nil {
			_ = s.block(original)
			return
		}
		original.stop = &r
	}
}

func (s *nodeSource) run(ctx context.Context) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.poll(ctx)
		}
	}
}

func (s *nodeSource) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !hasPrincipal(r, s.coordinator) {
		http.Error(w, "source coordinator principal required", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/v1/journal" && r.URL.RawQuery == "" && r.URL.RawPath == "" && r.ContentLength == 0 {
		s.journal.mu.Lock()
		defer s.journal.mu.Unlock()
		if s.journal.poisoned || s.journal.closed {
			http.Error(w, "source journal unavailable", http.StatusConflict)
			return
		}
		f, err := os.Open(s.journalPath)
		if err != nil {
			http.Error(w, "source journal unavailable", http.StatusServiceUnavailable)
			return
		}
		defer f.Close()
		raw, err := io.ReadAll(io.LimitReader(f, maxJournalBytes+1))
		if err != nil || uint64(len(raw)) != s.journal.bytes {
			http.Error(w, "source journal size differs", http.StatusConflict)
			return
		}
		if _, err := readJournal(bytes.NewReader(raw), s.journal.last); err != nil {
			http.Error(w, "source journal integrity differs", http.StatusConflict)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Head        cursor `json:"head"`
			BytesBase64 string `json:"bytesBase64"`
		}{s.journal.last, base64.StdEncoding.EncodeToString(raw)})
		return
	}
	if r.Method != http.MethodPost || r.URL.RawQuery != "" || r.URL.RawPath != "" {
		http.Error(w, "unsupported source control", http.StatusNotFound)
		return
	}
	var result journalRecord
	var err error
	switch r.URL.Path {
	case "/v1/source:arm":
		var request armRequest
		err = decodeClosed(r.Body, &request)
		if err == nil {
			result, err = s.arm(request)
		}
	case "/v1/source:bind":
		var request bindRequest
		err = decodeClosed(r.Body, &request)
		if err == nil {
			result, err = s.bind(r.Context(), request)
		}
	case "/v1/source:stop-intent":
		var request stopRequest
		err = decodeClosed(r.Body, &request)
		if err == nil {
			result, err = s.requestStop(r.Context(), request)
		}
	default:
		http.Error(w, "unsupported source control", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "original source transition refused", http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func (s *nodeSource) volume(volume string) *originalSource {
	if s.active != nil && s.active.scope.VolumeID == volume {
		return s.active
	}
	return nil
}

func (s *nodeSource) publication(volume, target string) *originalSource {
	for _, original := range s.originals {
		if original.scope.VolumeID == volume && original.scope.Target == target {
			return original
		}
	}
	return s.volume(volume)
}
