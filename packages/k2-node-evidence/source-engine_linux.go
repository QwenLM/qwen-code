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
	births         map[string]*sourceBirth
	disposed       bool
	disposalError  error
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
	_ = original.closePins()
	return errors.New("original source custody is unavailable")
}

// Called under source.mu after completion or invalidation. Peer descriptors
// belong to ServeConnection; saved journal facts survive disposal of these pins.
func (original *originalSource) closePins() error {
	if original.disposed {
		return original.disposalError
	}
	original.disposed = true
	if original.custody != nil {
		original.disposalError = errors.Join(original.disposalError, original.custody.close())
	}
	for _, b := range original.births {
		if b.custody != nil {
			original.disposalError = errors.Join(original.disposalError, b.custody.close())
		}
		if b.namespaces != nil {
			original.disposalError = errors.Join(original.disposalError, b.namespaces.close())
		}
		if b.inputs != nil {
			original.disposalError = errors.Join(original.disposalError, b.inputs.Close())
		}
	}
	return original.disposalError
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
	if s.active != nil && s.active.closePins() != nil {
		return journalRecord{}, errors.New("completed original descriptor disposal is unavailable")
	}
	if err := s.gateway.verify(context.Background()); err != nil {
		return journalRecord{}, err
	}
	frontend, err := s.gateway.frontend.snapshot()
	if err != nil {
		return journalRecord{}, err
	}
	original := &originalSource{scope: request.Scope, imageDigest: request.ImageDigest}
	policy := s.gateway.policy.value
	r, err := s.record(original, journalBody{Kind: "ARM", ImageDigest: request.ImageDigest, Policy: &policy, Frontend: &frontend})
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
	original := s.active
	if original == nil || original.blocked || original.unpublish != nil || original.bound == nil {
		s.mu.Unlock()
		return
	}
	for _, born := range original.births {
		if born.receipt.Role != "sandbox" || born.started == nil || born.deleted != nil {
			continue
		}
		actual, err := born.custody.observe()
		if err != nil || !actual.Terminal && (born.namespaces.verify(born.custody) != nil || born.custody.verifyRunningSecurityProfile("qwen-k2-sandbox-v1") != nil) {
			_ = s.block(original)
			s.mu.Unlock()
			return
		}
	}
	worker := original.births[original.scope.ContainerID]
	if worker == nil || worker.started == nil {
		s.mu.Unlock()
		return
	}
	scope, bound, publish, stop := original.scope, original.bound, original.publish, original.stop
	s.mu.Unlock()
	identityErr := s.gateway.verify(ctx)
	var runtime runtimeObservation
	var observationErr error
	if identityErr == nil && stop == nil {
		runtime, observationErr = s.gateway.observe(ctx, scope.ArmID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != original || original.blocked || original.unpublish != nil || original.scope != scope || original.bound != bound || original.publish != publish || original.stop != stop || original.births[scope.ContainerID] != worker {
		return
	}
	if identityErr != nil {
		_ = s.block(original)
		return
	}
	if stop != nil {
		current, err := original.custody.observe()
		if err != nil || !sameTerminalCustody(current, *stop.Custody) {
			_ = s.block(original)
		}
		return
	}
	if errors.Is(observationErr, errRuntimeTransition) && original.opened == nil && time.Since(worker.startedAt) < 30*time.Second {
		return
	}
	if observationErr != nil || runtime.PodUID != scope.PodUID || runtime.ImageDigest != original.imageDigest || runtime.ContainerID != scope.ContainerID || runtime.SandboxID != worker.receipt.SandboxID || original.custody != worker.custody {
		_ = s.block(original)
		return
	}
	observation, err := original.custody.observe()
	if err != nil || runtime.PID != observation.PID {
		_ = s.block(original)
		return
	}
	if runtime.State == "running" && (worker.namespaces.verify(worker.custody) != nil || original.custody.verifyRunningSecurity() != nil) || runtime.State == "created" {
		_ = s.block(original)
		return
	}
	if original.opened == nil {
		if observation.Terminal || !observation.Populated || runtime.State != "running" {
			_ = s.block(original)
			return
		}
		birth := worker.started.cursor()
		r, err := s.record(original, journalBody{Kind: "CUSTODY_OPEN", Begin: &birth, Custody: &observation, Runtime: &runtime})
		if err != nil {
			_ = s.block(original)
			return
		}
		original.opened = &r
	}
	if runtime.State == "stopped" && observation.Terminal && !observation.Populated {
		pause := original.births[worker.receipt.SandboxID]
		if original.publish == nil || original.intent == nil || original.custody.security == nil || pause == nil || pause.custody.security == nil {
			_ = s.block(original)
			return
		}
		pauseState, pauseErr := pause.custody.observe()
		if pauseErr != nil {
			_ = s.block(original)
			return
		}
		if !pauseState.Terminal || pauseState.Populated {
			return
		}
		// Release the source's namespace/root pins before CSI teardown; Delete may follow unpublish.
		if errors.Join(worker.namespaces.close(), pause.namespaces.close()) != nil {
			_ = s.block(original)
			return
		}
		begin, publication := original.opened.cursor(), original.publish.cursor()
		r, err := s.record(original, journalBody{Kind: "ORIGINAL_STOPPED", Begin: &begin, Publish: &publication, Custody: &observation, Runtime: &runtime, IntentHash: original.intent.IntentHash})
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
