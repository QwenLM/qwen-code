package main

import (
	"strings"
	"testing"
)

func TestSourceRequestExactFieldNames(t *testing.T) {
	for _, raw := range []string{
		`{"armId":"original","ArmID":"replacement"}`,
		`{"ArmID":"replacement","armId":"original"}`,
		`{"ArmID":"original"}`,
		`{"armId":"original","Namespace":"owned"}`,
		`{"armId":"original","armId":"replacement"}`,
		`{"armId":"original","unknown":"extra"}`,
	} {
		var task registeredTask
		if decodeClosed(strings.NewReader(raw), &task) == nil {
			t.Fatalf("accepted ambiguous/unknown fields: %s", raw)
		}
	}
	var exact registeredTask
	if err := decodeClosed(strings.NewReader(`{"armId":"original","namespace":"owned","podName":"original-pod","podUid":"original-uid","imageDigest":"digest"}`), &exact); err != nil || exact.ArmID != "original" || exact.Namespace != "owned" {
		t.Fatalf("exact fields refused: %+v %v", exact, err)
	}
	type nested struct {
		Task registeredTask `json:"task"`
	}
	var value nested
	if decodeClosed(strings.NewReader(`{"task":{"armId":"original","PodUID":"replacement"}}`), &value) == nil {
		t.Fatal("accepted nested field alias")
	}
	if err := decodeClosed(strings.NewReader(`{"task":{"armId":"original","podUid":"original-uid"}}`), &value); err != nil {
		t.Fatal(err)
	}
}
