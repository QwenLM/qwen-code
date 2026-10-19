//go:build linux

package main

import (
	"context"
	"time"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type csiProxy struct {
	csi.UnimplementedNodeServer
	csi.UnimplementedIdentityServer
	node     csi.NodeClient
	identity csi.IdentityClient
	source   *nodeSource
}

func backendContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, 30*time.Second)
}

func (p *csiProxy) NodePublishVolume(ctx context.Context, request *csi.NodePublishVolumeRequest) (*csi.NodePublishVolumeResponse, error) {
	p.source.mu.Lock()
	defer p.source.mu.Unlock()
	original := p.source.publication(request.GetVolumeId(), request.GetTargetPath())
	ctx, cancel := backendContext(ctx)
	defer cancel()
	if original == nil {
		return p.node.NodePublishVolume(ctx, request)
	}
	if original.blocked || original.bound == nil || original.intent != nil || request.TargetPath != original.scope.Target || request.VolumeCapability == nil || request.VolumeCapability.GetMount() == nil || request.Readonly {
		return nil, status.Error(codes.FailedPrecondition, "original publication is unavailable")
	}
	if p.source.gateway.verify(ctx) != nil {
		_ = p.source.block(original)
		return nil, status.Error(codes.FailedPrecondition, "original publication confinement differs")
	}
	caller, err := frontendCaller(ctx)
	if err != nil || original.arm.Frontend == nil || caller != original.arm.Frontend.Kubelet {
		return nil, status.Error(codes.PermissionDenied, "original ARM kubelet caller is required")
	}
	if original.publish != nil {
		target, err := readTarget(original.scope, false)
		if !proto.Equal(request, original.publishRequest) || err != nil || target != *original.publish.Target {
			_ = p.source.block(original)
			return nil, status.Error(codes.FailedPrecondition, "original publication retry differs")
		}
		return &csi.NodePublishVolumeResponse{}, nil
	}
	if p.source.gateway.verify(ctx) != nil || targetUnmounted(original.scope) != nil {
		_ = p.source.block(original)
		return nil, status.Error(codes.FailedPrecondition, "original publication chain is unknown")
	}
	begin, err := p.source.record(original, journalBody{Kind: "PUBLISH_BEGIN", Caller: &caller})
	if err != nil {
		return nil, status.Error(codes.Unavailable, "publication begin could not be persisted")
	}
	result, backendErr := p.node.NodePublishVolume(ctx, request)
	beginCursor := begin.cursor()
	if backendErr != nil || result == nil {
		code := codes.Unknown
		if backendErr != nil {
			code = status.Code(backendErr)
		}
		_, _ = p.source.record(original, journalBody{Kind: "PUBLISH_FAILED", Begin: &beginCursor, Status: uint32(code)})
		_ = p.source.block(original)
		if backendErr != nil {
			return nil, backendErr
		}
		return nil, status.Error(codes.Unknown, "original backend outcome is unknown")
	}
	target, err := readTarget(original.scope, false)
	parent, parentErr := readTarget(original.scope, true)
	if err != nil || parentErr != nil || target.MountID == parent.MountID || p.source.gateway.verify(ctx) != nil {
		_ = p.source.block(original)
		return nil, status.Error(codes.Unavailable, "original mounted target could not be observed")
	}
	r, err := p.source.record(original, journalBody{Kind: "PUBLISH_OK", Begin: &beginCursor, Target: &target})
	if err != nil {
		return nil, status.Error(codes.Unavailable, "publication success could not be persisted")
	}
	original.publish, original.publishRequest = &r, proto.Clone(request).(*csi.NodePublishVolumeRequest)
	original.kubelet = caller
	return result, nil
}

func (p *csiProxy) NodeUnpublishVolume(ctx context.Context, request *csi.NodeUnpublishVolumeRequest) (*csi.NodeUnpublishVolumeResponse, error) {
	p.source.mu.Lock()
	defer p.source.mu.Unlock()
	original := p.source.publication(request.GetVolumeId(), request.GetTargetPath())
	ctx, cancel := backendContext(ctx)
	defer cancel()
	if original == nil {
		return p.node.NodeUnpublishVolume(ctx, request)
	}
	if original.blocked || original.bound == nil || request.TargetPath != original.scope.Target || original.publish == nil || original.stop == nil {
		return nil, status.Error(codes.FailedPrecondition, "durable original stop barrier is required")
	}
	if original.unpublish != nil {
		return &csi.NodeUnpublishVolumeResponse{}, nil
	}
	caller, callerErr := frontendCaller(ctx)
	if callerErr != nil || caller != original.kubelet {
		return nil, status.Error(codes.PermissionDenied, "original kubelet caller differs")
	}
	target, err := readTarget(original.scope, false)
	if err != nil || target != *original.publish.Target || p.source.gateway.verify(ctx) != nil {
		_ = p.source.block(original)
		return nil, status.Error(codes.FailedPrecondition, "original unpublish target or source differs")
	}
	before, err := p.source.verifyStopped(ctx, original)
	if err != nil {
		return nil, status.Error(codes.FailedPrecondition, "original stopped custody was lost")
	}
	publish, stop := original.publish.cursor(), original.stop.cursor()
	begin, err := p.source.record(original, journalBody{Kind: "UNPUBLISH_BEGIN", Publish: &publish, Stop: &stop, Caller: &caller, Custody: &before, Runtime: original.stop.Runtime})
	if err != nil {
		return nil, status.Error(codes.Unavailable, "unpublish begin could not be persisted")
	}
	beginCursor := begin.cursor()
	result, backendErr := p.node.NodeUnpublishVolume(ctx, request)
	if backendErr != nil || result == nil {
		code := codes.Unknown
		if backendErr != nil {
			code = status.Code(backendErr)
		}
		_, _ = p.source.record(original, journalBody{Kind: "UNPUBLISH_FAILED", Begin: &beginCursor, Publish: &publish, Stop: &stop, Status: uint32(code)})
		_ = p.source.block(original)
		if backendErr != nil {
			return nil, backendErr
		}
		return nil, status.Error(codes.Unknown, "original backend outcome is unknown")
	}
	if targetUnmounted(original.scope) != nil || p.source.gateway.verify(ctx) != nil {
		_ = p.source.block(original)
		return nil, status.Error(codes.Unavailable, "original target remains mounted or unknown")
	}
	after, err := p.source.verifyStopped(ctx, original)
	if err != nil {
		return nil, status.Error(codes.Unavailable, "original stopped custody was lost during unpublish")
	}
	r, err := p.source.record(original, journalBody{Kind: "UNPUBLISH_OK", Begin: &beginCursor, Publish: &publish, Stop: &stop, Custody: &after, Runtime: original.stop.Runtime})
	if err != nil {
		return nil, status.Error(codes.Unavailable, "unpublish success could not be persisted")
	}
	original.unpublish = &r
	if original.custody != nil {
		_ = original.custody.close()
	}
	return result, nil
}

func (p *csiProxy) NodeStageVolume(ctx context.Context, request *csi.NodeStageVolumeRequest) (*csi.NodeStageVolumeResponse, error) {
	p.source.mu.Lock()
	defer p.source.mu.Unlock()
	original := p.source.volume(request.GetVolumeId())
	if original != nil && (original.blocked || original.bound == nil || original.publish != nil || original.intent != nil) {
		return nil, status.Error(codes.FailedPrecondition, "original volume stage is unavailable")
	}
	ctx, cancel := backendContext(ctx)
	defer cancel()
	if original != nil && p.source.gateway.verify(ctx) != nil {
		_ = p.source.block(original)
		return nil, status.Error(codes.FailedPrecondition, "original stage confinement differs")
	}
	result, err := p.node.NodeStageVolume(ctx, request)
	if original != nil && (err != nil || result == nil || p.source.gateway.verify(ctx) != nil) {
		_ = p.source.block(original)
		if err == nil {
			return nil, status.Error(codes.Unavailable, "original stage outcome or confinement is unknown")
		}
	}
	return result, err
}
func (p *csiProxy) NodeUnstageVolume(ctx context.Context, request *csi.NodeUnstageVolumeRequest) (*csi.NodeUnstageVolumeResponse, error) {
	p.source.mu.Lock()
	defer p.source.mu.Unlock()
	if original := p.source.volume(request.GetVolumeId()); original != nil && (original.blocked || original.unpublish == nil) {
		return nil, status.Error(codes.FailedPrecondition, "original target must first be unpublished")
	}
	ctx, cancel := backendContext(ctx)
	defer cancel()
	return p.node.NodeUnstageVolume(ctx, request)
}
func (p *csiProxy) NodeGetVolumeStats(ctx context.Context, request *csi.NodeGetVolumeStatsRequest) (*csi.NodeGetVolumeStatsResponse, error) {
	ctx, cancel := backendContext(ctx)
	defer cancel()
	return p.node.NodeGetVolumeStats(ctx, request)
}
func (p *csiProxy) NodeExpandVolume(ctx context.Context, request *csi.NodeExpandVolumeRequest) (*csi.NodeExpandVolumeResponse, error) {
	p.source.mu.Lock()
	defer p.source.mu.Unlock()
	if original := p.source.volume(request.GetVolumeId()); original != nil {
		if original.unpublish == nil {
			_ = p.source.block(original)
		}
		return nil, status.Error(codes.FailedPrecondition, "original volume expansion is unsupported")
	}
	ctx, cancel := backendContext(ctx)
	defer cancel()
	return p.node.NodeExpandVolume(ctx, request)
}
func (p *csiProxy) NodeGetCapabilities(ctx context.Context, request *csi.NodeGetCapabilitiesRequest) (*csi.NodeGetCapabilitiesResponse, error) {
	ctx, cancel := backendContext(ctx)
	defer cancel()
	return p.node.NodeGetCapabilities(ctx, request)
}
func (p *csiProxy) NodeGetInfo(ctx context.Context, request *csi.NodeGetInfoRequest) (*csi.NodeGetInfoResponse, error) {
	ctx, cancel := backendContext(ctx)
	defer cancel()
	return p.node.NodeGetInfo(ctx, request)
}
func (p *csiProxy) GetPluginInfo(ctx context.Context, request *csi.GetPluginInfoRequest) (*csi.GetPluginInfoResponse, error) {
	ctx, cancel := backendContext(ctx)
	defer cancel()
	return p.identity.GetPluginInfo(ctx, request)
}
func (p *csiProxy) GetPluginCapabilities(ctx context.Context, request *csi.GetPluginCapabilitiesRequest) (*csi.GetPluginCapabilitiesResponse, error) {
	ctx, cancel := backendContext(ctx)
	defer cancel()
	return p.identity.GetPluginCapabilities(ctx, request)
}
func (p *csiProxy) Probe(ctx context.Context, request *csi.ProbeRequest) (*csi.ProbeResponse, error) {
	ctx, cancel := backendContext(ctx)
	defer cancel()
	return p.identity.Probe(ctx, request)
}
