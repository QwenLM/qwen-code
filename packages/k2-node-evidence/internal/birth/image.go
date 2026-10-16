package birth

import (
	"errors"
	"strings"

	v1 "github.com/opencontainers/image-spec/specs-go/v1"
)

const MaxImageBytes = 64 << 10

type ImageSnapshot struct {
	Name   string `json:"name"`
	Parent string `json:"parent"`
	Kind   int32  `json:"kind"`
}

// ImageRootfs binds the original content bytes to the active snapshot's complete parent chain.
// The installed content/snapshot producer still requires deployment qualification.
type ImageRootfs struct {
	ManifestSHA256 string          `json:"manifestSha256"`
	Manifest       []byte          `json:"manifest"`
	Configuration  []byte          `json:"configuration"`
	Snapshotter    string          `json:"snapshotter"`
	Snapshots      []ImageSnapshot `json:"snapshots"`
}

func (p ImageRootfs) Validate(imageSHA, snapshotKey string) error {
	if !Hash(imageSHA) || p.ManifestSHA256 != imageSHA || SHA256(p.Manifest) != imageSHA || len(p.Manifest)+len(p.Configuration) > MaxImageBytes || p.Snapshotter != "overlayfs" || len(snapshotKey) == 0 || len(snapshotKey) > 128 {
		return errors.New("original image and snapshot identity differ")
	}
	manifest, err := ImageManifest(p.Manifest)
	if err != nil || int64(len(p.Configuration)) != manifest.Config.Size || "sha256:"+SHA256(p.Configuration) != manifest.Config.Digest.String() {
		return errors.New("actual image configuration bytes differ")
	}
	var config v1.Image
	if Decode(p.Configuration, &config, MaxImageBytes) != nil || config.OS != "linux" || config.Architecture != "amd64" && config.Architecture != "arm64" || config.RootFS.Type != "layers" || len(config.RootFS.DiffIDs) != len(manifest.Layers) || len(p.Snapshots) != len(manifest.Layers)+1 {
		return errors.New("unsupported original image rootfs configuration")
	}
	chain := make([]string, len(config.RootFS.DiffIDs))
	for n, diffID := range config.RootFS.DiffIDs {
		if !strings.HasPrefix(diffID.String(), "sha256:") || !Hash(strings.TrimPrefix(diffID.String(), "sha256:")) {
			return errors.New("unsupported original image diff ID")
		}
		chain[n] = diffID.String()
		if n != 0 {
			chain[n] = "sha256:" + SHA256([]byte(chain[n-1]+" "+diffID.String()))
		}
	}
	if p.Snapshots[0] != (ImageSnapshot{Name: snapshotKey, Parent: chain[len(chain)-1], Kind: 2}) {
		return errors.New("active snapshot does not descend from the original image")
	}
	for n := 1; n < len(p.Snapshots); n++ {
		index := len(chain) - n
		parent := ""
		if index != 0 {
			parent = chain[index-1]
		}
		if p.Snapshots[n] != (ImageSnapshot{Name: chain[index], Parent: parent, Kind: 3}) {
			return errors.New("original image snapshot parent chain changed")
		}
	}
	return nil
}

func ImageManifest(raw []byte) (*v1.Manifest, error) {
	var value v1.Manifest
	if Decode(raw, &value, MaxImageBytes) != nil || value.SchemaVersion != 2 || value.MediaType != v1.MediaTypeImageManifest || value.ArtifactType != "" || value.Subject != nil || len(value.Layers) == 0 || len(value.Layers) > 64 || value.Config.MediaType != v1.MediaTypeImageConfig || value.Config.Size <= 0 || value.Config.Size > MaxImageBytes || !descriptor(value.Config) {
		return nil, errors.New("unsupported actual original image manifest")
	}
	for _, layer := range value.Layers {
		if !descriptor(layer) || layer.MediaType != v1.MediaTypeImageLayer && layer.MediaType != v1.MediaTypeImageLayerGzip && layer.MediaType != v1.MediaTypeImageLayerZstd {
			return nil, errors.New("unsupported actual original image layer")
		}
	}
	return &value, nil
}

func descriptor(value v1.Descriptor) bool {
	return value.Size > 0 && strings.HasPrefix(value.Digest.String(), "sha256:") && Hash(strings.TrimPrefix(value.Digest.String(), "sha256:")) && len(value.URLs) == 0 && len(value.Data) == 0 && value.Platform == nil && value.ArtifactType == ""
}
