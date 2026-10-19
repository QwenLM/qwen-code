//go:build linux

package main

import (
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type countingNodeClient struct {
	csi.NodeClient
	calls int
}

func (b *countingNodeClient) reached() error {
	b.calls++
	return status.Error(codes.Unavailable, "test backend reached")
}

func (b *countingNodeClient) NodePublishVolume(context.Context, *csi.NodePublishVolumeRequest, ...grpc.CallOption) (*csi.NodePublishVolumeResponse, error) {
	return nil, b.reached()
}

func (b *countingNodeClient) NodeUnpublishVolume(context.Context, *csi.NodeUnpublishVolumeRequest, ...grpc.CallOption) (*csi.NodeUnpublishVolumeResponse, error) {
	return nil, b.reached()
}

func (b *countingNodeClient) NodeStageVolume(context.Context, *csi.NodeStageVolumeRequest, ...grpc.CallOption) (*csi.NodeStageVolumeResponse, error) {
	return nil, b.reached()
}

func (b *countingNodeClient) NodeUnstageVolume(context.Context, *csi.NodeUnstageVolumeRequest, ...grpc.CallOption) (*csi.NodeUnstageVolumeResponse, error) {
	return nil, b.reached()
}

func (b *countingNodeClient) NodeExpandVolume(context.Context, *csi.NodeExpandVolumeRequest, ...grpc.CallOption) (*csi.NodeExpandVolumeResponse, error) {
	return nil, b.reached()
}

func retiredProxyFixture(t *testing.T, activeOther bool) (*csiProxy, *originalSource, *countingNodeClient, string) {
	t.Helper()
	journal, path := newTestJournal(t)
	scope := testArm("old-arm")
	scope.Target, scope.PodUID, scope.ContainerID, scope.RetirementID = "/old-target", "old-pod", "old-container", "old-retirement"
	old := &originalSource{
		scope: scope, arm: journalRecord{journalBody: journalBody{Sequence: 2}},
		bound: &journalRecord{}, publish: &journalRecord{}, intent: &journalRecord{},
		stop: &journalRecord{}, unpublish: &journalRecord{}, disposed: true,
	}
	source := &nodeSource{journal: journal, originals: map[string]*originalSource{scope.ArmID: old}, active: old}
	if activeOther {
		currentScope := testArm("current-arm")
		currentScope.VolumeID, currentScope.Target = "current-volume", "/current-target"
		current := &originalSource{scope: currentScope, arm: journalRecord{journalBody: journalBody{Sequence: 10}}, bound: &journalRecord{}}
		source.originals[currentScope.ArmID], source.active = current, current
	}
	backend := &countingNodeClient{}
	return &csiProxy{source: source, node: backend}, old, backend, path
}

func callTestMutation(p *csiProxy, method, volume, target string) error {
	ctx := context.Background()
	capability := &csi.VolumeCapability{AccessType: &csi.VolumeCapability_Mount{Mount: &csi.VolumeCapability_MountVolume{FsType: "ext4"}}}
	switch method {
	case "publish":
		_, err := p.NodePublishVolume(ctx, &csi.NodePublishVolumeRequest{VolumeId: volume, TargetPath: target, VolumeCapability: capability})
		return err
	case "unpublish":
		_, err := p.NodeUnpublishVolume(ctx, &csi.NodeUnpublishVolumeRequest{VolumeId: volume, TargetPath: target})
		return err
	case "stage":
		_, err := p.NodeStageVolume(ctx, &csi.NodeStageVolumeRequest{VolumeId: volume, StagingTargetPath: target, VolumeCapability: capability})
		return err
	case "unstage":
		_, err := p.NodeUnstageVolume(ctx, &csi.NodeUnstageVolumeRequest{VolumeId: volume, StagingTargetPath: target})
		return err
	case "expand":
		_, err := p.NodeExpandVolume(ctx, &csi.NodeExpandVolumeRequest{VolumeId: volume, VolumePath: target})
		return err
	default:
		panic("unknown test mutation")
	}
}

func TestRetiredVolumeMutationsDoNotFallThrough(t *testing.T) {
	for _, activeOther := range []bool{false, true} {
		state := "still-active"
		if activeOther {
			state = "another-volume-active"
		}
		for _, method := range []string{"publish", "unpublish", "stage", "expand"} {
			t.Run(state+"/"+method, func(t *testing.T) {
				proxy, old, backend, path := retiredProxyFixture(t, activeOther)
				before, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				head := proxy.source.journal.last
				if err := callTestMutation(proxy, method, old.scope.VolumeID, "/different-target"); status.Code(err) != codes.FailedPrecondition {
					t.Fatalf("retired %s returned %v", method, err)
				}
				after, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if backend.calls != 0 || old.blocked || proxy.source.journal.last != head || !bytes.Equal(before, after) {
					t.Fatal("retired request reached the backend or changed completed history")
				}
			})
		}
	}
}

func TestRetiredUnpublishRemainsCached(t *testing.T) {
	proxy, old, backend, _ := retiredProxyFixture(t, true)
	response, err := proxy.NodeUnpublishVolume(context.Background(), &csi.NodeUnpublishVolumeRequest{VolumeId: old.scope.VolumeID, TargetPath: old.scope.Target})
	if err != nil || response == nil || backend.calls != 0 || old.blocked {
		t.Fatalf("cached unpublish changed: response=%v error=%v calls=%d", response, err, backend.calls)
	}
}

func TestRetiredUnstageRetainsExistingCleanup(t *testing.T) {
	proxy, old, backend, _ := retiredProxyFixture(t, true)
	err := callTestMutation(proxy, "unstage", old.scope.VolumeID, "/staging-target")
	if status.Code(err) != codes.Unavailable || backend.calls != 1 || old.blocked {
		t.Fatalf("completed unstage cleanup changed: error=%v calls=%d", err, backend.calls)
	}
}

func TestLatestRetainedVolumeControlsUnstage(t *testing.T) {
	proxy, old, backend, _ := retiredProxyFixture(t, true)
	latest := *old
	latest.scope.ArmID = "later-retained-arm"
	latest.arm.Sequence = 5
	latest.blocked = true
	proxy.source.originals[latest.scope.ArmID] = &latest
	err := callTestMutation(proxy, "unstage", old.scope.VolumeID, "/staging-target")
	if status.Code(err) != codes.FailedPrecondition || backend.calls != 0 {
		t.Fatalf("ignored latest retained volume state: error=%v calls=%d", err, backend.calls)
	}
}

func TestActiveSameVolumeDoesNotBorrowCompletedUnstage(t *testing.T) {
	proxy, old, backend, _ := retiredProxyFixture(t, true)
	proxy.source.active.scope.VolumeID = old.scope.VolumeID
	err := callTestMutation(proxy, "unstage", old.scope.VolumeID, "/staging-target")
	if status.Code(err) != codes.FailedPrecondition || backend.calls != 0 {
		t.Fatalf("active scope borrowed old unpublish: error=%v calls=%d", err, backend.calls)
	}
}

func TestUntrackedVolumeKeepsExistingForwarding(t *testing.T) {
	for _, method := range []string{"publish", "unpublish", "stage", "unstage", "expand"} {
		t.Run(method, func(t *testing.T) {
			proxy, _, backend, _ := retiredProxyFixture(t, true)
			err := callTestMutation(proxy, method, "untracked-volume", "/untracked-target")
			if status.Code(err) != codes.Unavailable || backend.calls != 1 {
				t.Fatalf("untracked %s changed: error=%v calls=%d", method, err, backend.calls)
			}
		})
	}
}

func TestLiveVolumeExpansionStillPoisonsOriginal(t *testing.T) {
	proxy, old, backend, path := retiredProxyFixture(t, false)
	old.unpublish = nil
	err := callTestMutation(proxy, "expand", old.scope.VolumeID, old.scope.Target)
	if status.Code(err) != codes.FailedPrecondition || backend.calls != 0 || !old.blocked {
		t.Fatalf("live expansion did not block original: error=%v calls=%d", err, backend.calls)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	records, err := readJournal(bytes.NewReader(raw), proxy.source.journal.last)
	if err != nil || len(records) != 2 || records[1].Kind != "CONFINEMENT_LOST" || records[1].Scope.ArmID != old.scope.ArmID {
		t.Fatalf("live expansion poison changed: records=%v error=%v", records, err)
	}
}
