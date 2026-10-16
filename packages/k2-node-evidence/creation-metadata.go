package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	containers "github.com/containerd/containerd/api/services/containers/v1"
	content "github.com/containerd/containerd/api/services/content/v1"
	images "github.com/containerd/containerd/api/services/images/v1"
	snapshots "github.com/containerd/containerd/api/services/snapshots/v1"
	api "github.com/containerd/containerd/api/types"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
)

type creationMetadata struct {
	Version     string            `json:"version"`
	Container   []byte            `json:"container"`
	Snapshot    []byte            `json:"snapshot"`
	Mounts      []*api.Mount      `json:"mounts"`
	ImageRootfs birth.ImageRootfs `json:"imageRootfs"`
}

func (g *runtimeReadGateway) creation(parent context.Context, arm, id string) (creationMetadata, error) {
	g.mu.Lock()
	original := g.originals[arm]
	if g.closed || original == nil || original.blocked || g.snapshots == nil || g.content == nil || g.images == nil || !hashString(id) {
		g.mu.Unlock()
		return creationMetadata{}, errors.New("original creation metadata authority is unavailable")
	}
	registered := original.task
	g.mu.Unlock()
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs("containerd-namespace", "k8s.io"))
	reply, err := g.containers.Get(ctx, &containers.GetContainerRequest{ID: id})
	if err != nil || reply.GetContainer() == nil {
		return creationMetadata{}, errors.New("actual original container metadata is unavailable")
	}
	c := proto.Clone(reply.Container).(*containers.Container)
	if c.ID != id || c.Runtime == nil || c.Runtime.Name != "io.containerd.qwen-k2.v1" || c.Runtime.Options == nil || c.Spec == nil || c.Spec.TypeUrl != "types.containerd.io/opencontainers/runtime-spec/1/Spec" || len(c.Spec.Value) == 0 || c.Snapshotter == "" || c.SnapshotKey == "" || c.CreatedAt == nil || c.CreatedAt.CheckValid() != nil || c.Labels["io.kubernetes.pod.uid"] != registered.PodUID || c.Labels["io.kubernetes.pod.name"] != registered.PodName || c.Labels["io.kubernetes.pod.namespace"] != registered.Namespace || proto.Size(c) > 32<<10 {
		return creationMetadata{}, errors.New("actual original creation metadata differs")
	}
	role := c.Labels["io.cri-containerd.kind"]
	if role != "sandbox" && (role != "container" || c.Labels["io.kubernetes.container.name"] != "runtime" || !matchesImage(c.Image, registered.ImageDigest)) {
		return creationMetadata{}, errors.New("actual creation owner or image differs")
	}
	stat, err := g.snapshots.Stat(ctx, &snapshots.StatSnapshotRequest{Snapshotter: c.Snapshotter, Key: c.SnapshotKey})
	if err != nil || stat.GetInfo() == nil || stat.Info.Name != c.SnapshotKey || proto.Size(stat) > 8192 {
		return creationMetadata{}, errors.New("actual original snapshot metadata is unavailable")
	}
	mounts, err := g.snapshots.Mounts(ctx, &snapshots.MountsRequest{Snapshotter: c.Snapshotter, Key: c.SnapshotKey})
	if err != nil || len(mounts.GetMounts()) == 0 || len(mounts.Mounts) > 8 || proto.Size(mounts) > 8192 {
		return creationMetadata{}, errors.New("actual original snapshot mounts are unavailable")
	}
	image, err := g.imageRootfs(ctx, c)
	if err != nil {
		return creationMetadata{}, err
	}
	current, err := g.snapshots.Stat(ctx, &snapshots.StatSnapshotRequest{Snapshotter: c.Snapshotter, Key: c.SnapshotKey})
	if err != nil || !proto.Equal(stat, current) {
		return creationMetadata{}, errors.New("actual active snapshot changed during image validation")
	}
	c.UpdatedAt = nil
	containerRaw, err := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	if err != nil {
		return creationMetadata{}, err
	}
	snapshotRaw, err := proto.MarshalOptions{Deterministic: true}.Marshal(stat)
	if err != nil {
		return creationMetadata{}, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed || g.originals[arm] != original || original.blocked || original.task != registered {
		return creationMetadata{}, errors.New("original creation metadata association changed")
	}
	return creationMetadata{"qwen-k2-creation-metadata/2", containerRaw, snapshotRaw, mounts.Mounts, image}, nil
}

func (g *runtimeReadGateway) imageRootfs(ctx context.Context, c *containers.Container) (birth.ImageRootfs, error) {
	var result birth.ImageRootfs
	image, err := g.images.Get(ctx, &images.GetImageRequest{Name: c.Image})
	if err != nil || image.GetImage() == nil || image.Image.Name != c.Image || image.Image.Target == nil || image.Image.Target.MediaType != "application/vnd.oci.image.manifest.v1+json" || !strings.HasPrefix(image.Image.Target.Digest, "sha256:") {
		return result, errors.New("actual original image target is unavailable")
	}
	target := image.Image.Target
	result.ManifestSHA256 = strings.TrimPrefix(target.Digest, "sha256:")
	if !hashString(result.ManifestSHA256) || !matchesImage(c.Image, result.ManifestSHA256) {
		return result, errors.New("actual image name and target digest differ")
	}
	result.Manifest, err = g.imageBlob(ctx, target.Digest, target.Size)
	if err != nil {
		return result, err
	}
	manifest, err := birth.ImageManifest(result.Manifest)
	if err != nil {
		return result, err
	}
	result.Configuration, err = g.imageBlob(ctx, manifest.Config.Digest.String(), manifest.Config.Size)
	if err != nil {
		return result, err
	}
	result.Snapshotter = c.Snapshotter
	key := c.SnapshotKey
	for key != "" && len(result.Snapshots) < 65 {
		current, err := g.snapshots.Stat(ctx, &snapshots.StatSnapshotRequest{Snapshotter: c.Snapshotter, Key: key})
		if err != nil || current.GetInfo() == nil || current.Info.Name != key || proto.Size(current) > 8192 {
			return result, errors.New("actual image snapshot chain is unavailable")
		}
		result.Snapshots = append(result.Snapshots, birth.ImageSnapshot{Name: key, Parent: current.Info.Parent, Kind: int32(current.Info.Kind)})
		key = current.Info.Parent
	}
	if key != "" || result.Validate(result.ManifestSHA256, c.SnapshotKey) != nil {
		return result, errors.New("actual image snapshot chain differs from its content bytes")
	}
	return result, nil
}

func (g *runtimeReadGateway) imageBlob(ctx context.Context, id string, size int64) ([]byte, error) {
	if !strings.HasPrefix(id, "sha256:") || !hashString(strings.TrimPrefix(id, "sha256:")) || size <= 0 || size > birth.MaxImageBytes {
		return nil, errors.New("original image content exceeds its bound")
	}
	info, err := g.content.Info(ctx, &content.InfoRequest{Digest: id})
	if err != nil || info.GetInfo() == nil || info.Info.Digest != id || info.Info.Size != size {
		return nil, errors.New("actual original content metadata differs")
	}
	stream, err := g.content.Read(ctx, &content.ReadContentRequest{Digest: id, Size: size})
	if err != nil {
		return nil, errors.New("actual original content reader is unavailable")
	}
	defer stream.CloseSend()
	raw := make([]byte, 0, int(size))
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil || chunk == nil || chunk.Offset != int64(len(raw)) || len(chunk.Data) == 0 || int64(len(raw))+int64(len(chunk.Data)) > size || len(chunk.ProtoReflect().GetUnknown()) != 0 {
			return nil, errors.New("actual original content stream changed or became incomplete")
		}
		raw = append(raw, chunk.Data...)
	}
	if int64(len(raw)) != size || "sha256:"+digest(raw) != id {
		return nil, errors.New("actual original content bytes differ from the pinned image")
	}
	return raw, nil
}

func creationPath(path string) (string, string, bool) {
	parts := strings.Split(path, "/")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "v1" || parts[2] != "original" || parts[4] != "creation" || !safeID(parts[3]) || !hashString(parts[5]) {
		return "", "", false
	}
	return parts[3], parts[5], true
}

func (g *sourceGateway) creation(ctx context.Context, arm, id string) (creationMetadata, error) {
	if !safeID(arm) || !hashString(id) {
		return creationMetadata{}, errors.New("actual original creation identity is required")
	}
	var result creationMetadata
	err := g.call(ctx, http.MethodGet, "/v1/original/"+arm+"/creation/"+id, nil, &result)
	if err != nil || result.Version != "qwen-k2-creation-metadata/2" {
		return creationMetadata{}, errors.New("actual creation metadata channel is unavailable")
	}
	return result, nil
}
