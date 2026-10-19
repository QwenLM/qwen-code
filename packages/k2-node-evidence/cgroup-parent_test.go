package main

import (
	"strings"
	"testing"
)

func TestTerminalCustodyRefusesChangedIdentityAndLiveDescendants(t *testing.T) {
	stopped := custodyObservation{PID: 123, StartTicks: 456, CgroupDevice: 1, CgroupInode: 2, Coverage: parentCoverage, ParentDevice: 1, ParentInode: 3, Terminal: true}
	if !sameTerminalCustody(stopped, stopped) {
		t.Fatal("unchanged terminal custody refused")
	}
	for name, change := range map[string]func(*custodyObservation){
		"PID":           func(c *custodyObservation) { c.PID++ },
		"start":         func(c *custodyObservation) { c.StartTicks++ },
		"leaf-device":   func(c *custodyObservation) { c.CgroupDevice++ },
		"leaf-inode":    func(c *custodyObservation) { c.CgroupInode++ },
		"parent-device": func(c *custodyObservation) { c.ParentDevice++ },
		"parent-inode":  func(c *custodyObservation) { c.ParentInode++ },
		"coverage":      func(c *custodyObservation) { c.Coverage = "retained-leaf/1" },
		"descendant":    func(c *custodyObservation) { c.Populated = true },
		"pidfd-live":    func(c *custodyObservation) { c.Terminal = false },
	} {
		t.Run(name, func(t *testing.T) {
			current := stopped
			change(&current)
			if sameTerminalCustody(current, stopped) {
				t.Fatal("accepted changed custody")
			}
		})
	}
	for _, invalid := range []custodyObservation{{Terminal: true, Populated: true}, {Terminal: false}} {
		if sameTerminalCustody(invalid, invalid) {
			t.Fatal("equal observations supplied live custody")
		}
	}
}

func TestOriginalPodParentSupportsExactCgroupfsAndSystemdLayouts(t *testing.T) {
	uid := "6c6c7d4b-a1eb-4a16-8a4c-b1c208824d83"
	cid := strings.Repeat("a", 64)
	pod := strings.ReplaceAll(uid, "-", "_")
	for _, parent := range []string{
		"kubepods/pod" + uid,
		"kubepods/burstable/pod" + uid,
		"kubepods/besteffort/pod" + uid,
		"kubepods.slice/kubepods-pod" + pod + ".slice",
		"kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod" + pod + ".slice",
		"kubepods.slice/kubepods-besteffort.slice/kubepods-besteffort-pod" + pod + ".slice",
	} {
		leaf := cid
		if strings.HasPrefix(parent, "kubepods.slice/") {
			leaf = "cri-containerd-" + cid + ".scope"
		}
		actual, err := originalPodParent(parent+"/"+leaf, uid, cid)
		if err != nil || actual != parent {
			t.Fatalf("original parent %q: %q %v", parent, actual, err)
		}
	}
}

func TestOriginalPodParentRefusesForeignAmbiguousAndEscapingPaths(t *testing.T) {
	uid := "6c6c7d4b-a1eb-4a16-8a4c-b1c208824d83"
	cid := strings.Repeat("a", 64)
	pod := "kubepods/pod" + uid
	for _, path := range []string{
		cid, "pod" + uid + "/" + cid, "/" + pod + "/" + cid, pod + "//" + cid,
		pod + "/../" + cid, pod + "/./" + cid, pod + "/" + cid + "\n",
		"other/pod" + uid + "/" + cid, "kubepods/unknown/pod" + uid + "/" + cid,
		"kubepods/burstable/nested/pod" + uid + "/" + cid, "kubepods/podforeign/" + cid,
		pod + "/" + strings.Repeat("b", 64),
		"kubepods.slice/kubepods-besteffort.slice/kubepods-burstable-pod" + strings.ReplaceAll(uid, "-", "_") + ".slice/cri-containerd-" + cid + ".scope",
	} {
		if _, err := originalPodParent(path, uid, cid); err == nil {
			t.Fatalf("accepted non-original parent %q", path)
		}
	}
	for _, badUID := range []string{"", "pod-uid", strings.ToUpper(uid), uid + "extra"} {
		if _, err := originalPodParent(pod+"/"+cid, badUID, cid); err == nil {
			t.Fatal("accepted noncanonical Pod UID")
		}
	}
	for _, badCID := range []string{"", cid[:63], strings.ToUpper(cid), "containerd://" + cid} {
		if _, err := originalPodParent(pod+"/"+cid, uid, badCID); err == nil {
			t.Fatal("accepted noncanonical container ID")
		}
	}
}
