package main

import (
	"bytes"
	"errors"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	task "github.com/containerd/containerd/api/runtime/task/v3"
	"google.golang.org/protobuf/proto"
)

type namespaceBirth struct {
	Namespaces  [7]kernelObject  `json:"namespaces"`
	Root        policyFilesystem `json:"root"`
	MountedRoot policyFilesystem `json:"mountedRoot"`
	Readonly    bool             `json:"readonly"`
}

type birthPeer struct {
	PID        int32        `json:"pid"`
	StartTicks uint64       `json:"startTicks"`
	Executable birth.Object `json:"executable"`
	Label      string       `json:"label"`
}

type birthRecord struct {
	Role            string              `json:"role"`
	ID              string              `json:"id"`
	SandboxID       string              `json:"sandboxId"`
	Peer            birthPeer           `json:"peer"`
	Policy          birth.InputPolicy   `json:"policy"`
	Objects         [5]birth.Object     `json:"objects"`
	OriginalRequest []byte              `json:"originalRequest"`
	ConsumedRequest []byte              `json:"consumedRequest"`
	OriginalSpec    []byte              `json:"originalSpec"`
	ConsumedSpec    []byte              `json:"consumedSpec"`
	ImageRootfs     birth.ImageRootfs   `json:"imageRootfs"`
	MetadataSHA256  string              `json:"metadataSha256"`
	Prepared        *cursor             `json:"prepared,omitempty"`
	Created         *cursor             `json:"created,omitempty"`
	StartBegin      *cursor             `json:"startBegin,omitempty"`
	Namespaces      *namespaceBirth     `json:"namespaces,omitempty"`
	Custody         *custodyObservation `json:"custody,omitempty"`
	NativeDelete    []byte              `json:"nativeDelete,omitempty"`
}

func validateBirthRecord(b *birthRecord, kind string, scope originalScope, sequence uint64) error {
	if b == nil || b.Role != "container" && b.Role != "sandbox" || !hashString(b.ID) || !hashString(b.SandboxID) || b.Role == "sandbox" && b.ID != b.SandboxID || b.Policy.Validate() != nil || b.Peer.PID <= 0 || b.Peer.StartTicks == 0 || b.Peer.Label != "qwen-k2-shim-v1" || !hashString(b.Peer.Executable.SHA256) || !hashString(b.MetadataSHA256) {
		return errors.New("invalid actual original birth identity")
	}
	if len(b.ImageRootfs.Snapshots) == 0 || b.ImageRootfs.Validate(b.ImageRootfs.ManifestSHA256, b.ImageRootfs.Snapshots[0].Name) != nil {
		return errors.New("invalid original image to rootfs chain")
	}
	var original, consumed task.CreateTaskRequest
	if proto.Unmarshal(b.OriginalRequest, &original) != nil || proto.Unmarshal(b.ConsumedRequest, &consumed) != nil || birth.ValidateRequest(b.Policy, &original) != nil || original.ID != b.ID || len(b.OriginalRequest)+len(b.ConsumedRequest)+len(b.OriginalSpec)+len(b.ConsumedSpec) > birth.MaxInputs {
		return errors.New("invalid actual birth creation request")
	}
	expected := proto.Clone(&original).(*task.CreateTaskRequest)
	expected.Bundle = b.Policy.InputRoot + "/" + b.ID
	if !proto.Equal(expected, &consumed) {
		return errors.New("actual birth consumption mapping differs")
	}
	actualSpec, spec, err := birth.ConsumedSpec(b.OriginalSpec)
	if err != nil || !bytes.Equal(actualSpec, b.ConsumedSpec) || spec.Annotations["io.kubernetes.cri.container-type"] != b.Role || spec.Annotations["io.kubernetes.cri.sandbox-id"] != b.SandboxID || spec.Annotations["io.kubernetes.cri.sandbox-uid"] != scope.PodUID || spec.Annotations["io.kubernetes.cri.sandbox-name"] != scope.PodName || spec.Annotations["io.kubernetes.cri.sandbox-namespace"] != scope.Namespace {
		return errors.New("actual consumed birth spec differs from its original bound Pod")
	}
	for n, raw := range [][]byte{b.ConsumedSpec, b.OriginalRequest, b.ConsumedRequest, b.OriginalSpec} {
		if b.Objects[n].Inode == 0 || b.Objects[n].MountID == 0 || b.Objects[n].Bytes != int64(len(raw)) || b.Objects[n].SHA256 != birth.SHA256(raw) || b.Objects[n].Flags&0x10 == 0 || b.Objects[n].Mode&0222 != 0 {
			return errors.New("actual protected birth object differs from its consumed bytes")
		}
	}
	if b.Objects[4].Inode == 0 || b.Objects[4].MountID == 0 || b.Objects[4].Bytes <= 0 || b.Objects[4].Bytes > 128<<20 || b.Objects[4].Flags&0x10 == 0 || b.Objects[4].Mode&0222 != 0 || b.Objects[4].SHA256 != b.Policy.RuncSHA256 {
		return errors.New("actual birth executable differs")
	}
	prepared := kind != "BIRTH_PREPARED"
	created := kind == "BIRTH_START_BEGIN" || kind == "BIRTH_STARTED"
	start := kind == "BIRTH_STARTED"
	kernel := kind != "BIRTH_PREPARED"
	deleted := kind == "BIRTH_NATIVE_DELETED"
	if (b.Prepared != nil) != prepared || prepared && !validCursor(b.Prepared, sequence) || (b.Created != nil) != created || created && !validCursor(b.Created, sequence) || (b.StartBegin != nil) != start || start && !validCursor(b.StartBegin, sequence) || (b.Namespaces != nil) != kernel || (b.Custody != nil) != kernel || (len(b.NativeDelete) != 0) != deleted {
		return errors.New("invalid birth source dependencies")
	}
	if kernel {
		n, c := b.Namespaces, b.Custody
		if !n.Readonly || n.Root.Inode == 0 || n.Root.MountID == 0 || n.Root.Device != n.MountedRoot.Device || n.Root.Inode != n.MountedRoot.Inode || c.PID == 0 || c.StartTicks == 0 || c.CgroupInode == 0 || c.ParentDevice != c.CgroupDevice || c.ParentInode == 0 || c.ParentInode == c.CgroupInode || c.Coverage != parentCoverage || !deleted && (c.Terminal || !c.Populated) || deleted && !c.Terminal {
			return errors.New("invalid actual birth kernel custody")
		}
		for _, namespace := range n.Namespaces {
			if namespace.Inode == 0 {
				return errors.New("missing actual birth namespace")
			}
		}
		if deleted {
			var actual task.DeleteResponse
			if proto.Unmarshal(b.NativeDelete, &actual) != nil || len(actual.ProtoReflect().GetUnknown()) != 0 || actual.Pid != c.PID || actual.ExitedAt == nil || actual.ExitedAt.CheckValid() != nil {
				return errors.New("invalid original native deletion result")
			}
		}
	}
	return nil
}
