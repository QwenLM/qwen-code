//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	containers "github.com/containerd/containerd/api/services/containers/v1"
	"github.com/opencontainers/runtime-spec/specs-go"
	"google.golang.org/protobuf/proto"
)

type sourceBirth struct {
	peer       *birth.Peer
	inputs     *birth.Inputs
	receipt    birthRecord
	prepared   journalRecord
	created    *journalRecord
	startBegin *journalRecord
	started    *journalRecord
	deleted    *journalRecord
	custody    *kernelCustody
	namespaces *retainedBirthNamespaces
	startedAt  time.Time
}

type birthHandler struct {
	source       *nodeSource
	policy       birth.InputPolicy
	sandboxImage string
	contract     *birth.CreationContract
}

var _ birth.Handler = (*birthHandler)(nil)

func metadataHash(actual creationMetadata, inputs *birth.Inputs, image string) (string, error) {
	var container containers.Container
	if actual.Version != "qwen-k2-creation-metadata/2" || proto.Unmarshal(actual.Container, &container) != nil || container.ID != inputs.Original.ID || container.Spec == nil || container.Runtime == nil || !proto.Equal(container.Runtime.Options, inputs.Original.Options) || !matchesImage(container.Image, image) || actual.ImageRootfs.Validate(image, container.SnapshotKey) != nil || len(actual.Mounts) != len(inputs.Original.Rootfs) {
		return "", errors.New("actual original creation metadata differs")
	}
	for n, mount := range actual.Mounts {
		if !proto.Equal(mount, inputs.Original.Rootfs[n]) {
			return "", errors.New("actual consumed rootfs mounts differ from the original snapshot")
		}
	}
	var metadataSpec, originalSpec specs.Spec
	if birth.Decode(container.Spec.Value, &metadataSpec, birth.MaxInputs) != nil || birth.Decode(inputs.OriginalSpec, &originalSpec, birth.MaxInputs) != nil {
		return "", errors.New("original creation metadata spec is unavailable")
	}
	metadataRaw, _ := json.Marshal(metadataSpec)
	originalRaw, _ := json.Marshal(originalSpec)
	if !bytes.Equal(metadataRaw, originalRaw) {
		return "", errors.New("actual original OCI spec differs from the metadata whole value")
	}
	raw, err := json.Marshal(actual)
	if err != nil {
		return "", err
	}
	return digest(raw), nil
}

func (h *birthHandler) prepare(ctx context.Context, peer *birth.Peer, call birth.Call, files []*os.File) (string, error) {
	inputs, err := birth.ReceiveInputs(h.policy, files)
	if err != nil {
		return "", err
	}
	accepted := false
	defer func() {
		if !accepted {
			inputs.Close()
		}
	}()
	_, spec, err := birth.ConsumedSpec(inputs.OriginalSpec)
	if err != nil || inputs.Original.ID != call.ID || h.contract.Match(inputs.OriginalSpec, call.ID) != nil {
		return "", errors.New("actual original birth inputs differ")
	}
	role, sandbox := spec.Annotations["io.kubernetes.cri.container-type"], spec.Annotations["io.kubernetes.cri.sandbox-id"]
	s := h.source
	s.mu.Lock()
	original := s.active
	if original == nil || original.bound == nil || original.publish == nil || original.blocked || original.intent != nil || original.unpublish != nil || spec.Annotations["io.kubernetes.cri.sandbox-uid"] != original.scope.PodUID || spec.Annotations["io.kubernetes.cri.sandbox-name"] != original.scope.PodName || spec.Annotations["io.kubernetes.cri.sandbox-namespace"] != original.scope.Namespace || original.births[call.ID] != nil || len(original.births) >= 2 || role == "sandbox" && call.ID != sandbox {
		s.mu.Unlock()
		return "", errors.New("actual creation does not own the original bound and published Pod")
	}
	for _, previous := range original.births {
		if previous.receipt.Role == role || previous.receipt.SandboxID != sandbox {
			s.mu.Unlock()
			return "", errors.New("original Pod birth membership cannot change")
		}
	}
	if role == "container" {
		pause := original.births[sandbox]
		if pause == nil || pause.started == nil || pause.deleted != nil {
			s.mu.Unlock()
			return "", errors.New("worker requires the actual original started sandbox")
		}
	}
	b := &sourceBirth{peer: peer, inputs: inputs}
	if original.births == nil {
		original.births = make(map[string]*sourceBirth)
	}
	original.births[call.ID] = b
	arm, bound, publish := original.scope.ArmID, original.bound.cursor(), original.publish.cursor()
	image := original.imageDigest
	if role == "sandbox" {
		image = h.sandboxImage
	}
	s.mu.Unlock()
	actual, err := s.gateway.creation(ctx, arm, call.ID)
	metadataDigest, metadataErr := metadataHash(actual, inputs, image)
	identityErr := s.gateway.verify(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil || metadataErr != nil || identityErr != nil || peer.Verify() != nil || inputs.Verify() != nil || s.active != original || original.blocked || original.intent != nil || original.births[call.ID] != b || original.bound.cursor() != bound || original.publish.cursor() != publish {
		_ = s.block(original)
		return "", errors.New("original creation preparation changed or became unavailable")
	}
	originalRaw, _ := proto.MarshalOptions{Deterministic: true}.Marshal(inputs.Original)
	consumedRaw, _ := proto.MarshalOptions{Deterministic: true}.Marshal(inputs.Consumed)
	b.receipt = birthRecord{Role: role, ID: call.ID, SandboxID: sandbox, Peer: birthPeer{peer.PID, peer.StartTicks, peer.Executable, peer.Label}, Policy: h.policy, Objects: inputs.Objects, OriginalRequest: originalRaw, ConsumedRequest: consumedRaw, OriginalSpec: inputs.OriginalSpec, ConsumedSpec: inputs.Spec, ImageRootfs: actual.ImageRootfs, MetadataSHA256: metadataDigest}
	body := b.receipt
	r, err := s.record(original, journalBody{Kind: "BIRTH_PREPARED", Publish: &publish, Birth: &body})
	if err != nil {
		_ = s.block(original)
		return "", err
	}
	b.prepared = r
	accepted = true
	return r.Hash, nil
}

func (h *birthHandler) Handle(ctx context.Context, peer *birth.Peer, call birth.Call, files []*os.File) (string, error) {
	if call.Action == "prepare" {
		return h.prepare(ctx, peer, call, files)
	}
	s := h.source
	if s.gateway.verify(ctx) != nil {
		return "", errors.New("original source incarnation is unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	original := s.active
	if original == nil {
		return "", errors.New("original creation source is unavailable")
	}
	b := original.births[call.ID]
	if b == nil || b.peer != peer || b.prepared.Hash != call.Association || peer.Verify() != nil || original.blocked || original.unpublish != nil {
		return "", errors.New("original creation association cannot change")
	}
	if call.Action != "native-deleted" && (original.intent != nil || b.deleted != nil || b.inputs.Verify() != nil) {
		return "", s.block(original)
	}
	if call.Action == "before-start" {
		current, err := readTarget(original.scope, false)
		if err != nil || original.publish.Target == nil || current != *original.publish.Target {
			return "", s.block(original)
		}
	}
	body := b.receipt
	prepared := b.prepared.cursor()
	body.Prepared = &prepared
	publish := original.publish.cursor()
	switch call.Action {
	case "bind-created":
		if b.created != nil || b.started != nil {
			return "", s.block(original)
		}
		c, err := openCreatedCustody(call.PID, original.scope.PodUID, call.ID)
		if err != nil {
			return "", s.block(original)
		}
		var sandbox *retainedBirthNamespaces
		if b.receipt.Role == "container" {
			sandbox = original.births[b.receipt.SandboxID].namespaces
		}
		if len(files) != 1 {
			c.close()
			return "", s.block(original)
		}
		n, err := openBirthNamespaces(c, b.inputs, sandbox, files[0])
		if err != nil {
			c.close()
			return "", s.block(original)
		}
		observation, err := c.observe()
		if err != nil {
			c.close()
			n.close()
			return "", s.block(original)
		}
		body.Namespaces, body.Custody = &n.value, &observation
		if b.receipt.Role == "container" {
			original.scope.ContainerID = call.ID
		}
		r, err := s.record(original, journalBody{Kind: "BIRTH_CREATED", Publish: &publish, Birth: &body})
		if err != nil {
			c.close()
			n.close()
			return "", s.block(original)
		}
		b.custody, b.namespaces, b.created = c, n, &r
		if b.receipt.Role == "container" {
			original.custody = c
		}
	case "before-start", "started", "native-deleted":
		if b.created == nil || b.custody.initial.PID != call.PID {
			return "", s.block(original)
		}
		observation, err := b.custody.observe()
		if err != nil || call.Action != "native-deleted" && (observation.Terminal || b.namespaces.verify(b.custody) != nil) || call.Action == "native-deleted" && !observation.Terminal {
			return "", s.block(original)
		}
		body.Namespaces, body.Custody = &b.namespaces.value, &observation
		kind := "BIRTH_START_BEGIN"
		created := b.created.cursor()
		if call.Action == "before-start" {
			if b.startBegin != nil || b.started != nil {
				return "", s.block(original)
			}
			body.Created = &created
		} else if call.Action == "started" {
			if b.startBegin == nil || b.started != nil {
				return "", s.block(original)
			}
			start := b.startBegin.cursor()
			body.Created, body.StartBegin = &created, &start
			kind = "BIRTH_STARTED"
		} else {
			kind = "BIRTH_NATIVE_DELETED"
			body.NativeDelete = call.Deleted
			if b.deleted != nil {
				if !bytes.Equal(b.deleted.Birth.NativeDelete, call.Deleted) {
					return "", s.block(original)
				}
				return b.prepared.Hash, nil
			}
		}
		r, err := s.record(original, journalBody{Kind: kind, Publish: &publish, Birth: &body})
		if err != nil {
			return "", s.block(original)
		}
		if call.Action == "before-start" {
			b.startBegin = &r
		} else if call.Action == "started" {
			b.started, b.startedAt = &r, time.Now()
		} else {
			b.deleted = &r
			if err := errors.Join(b.namespaces.close(), b.inputs.Close()); err != nil {
				return "", s.block(original)
			}
		}
	default:
		return "", s.block(original)
	}
	return b.prepared.Hash, nil
}

func (h *birthHandler) Lost(peer *birth.Peer) {
	s := h.source
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, original := range s.originals {
		for _, b := range original.births {
			if b.peer == peer && b.deleted == nil && original.unpublish == nil {
				_ = s.block(original)
			}
		}
	}
}
