package main

import (
	"strings"
	"testing"
)

const workerStatus = "Name:\tnode\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t1000 \nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t1\nTracerPid:\t0\n"

func TestWorkerProcessSecurity(t *testing.T) {
	s, err := parseProcessSecurity([]byte(workerStatus))
	if err != nil || !s.worker() || s.UID[3] != 1000 || s.SeccompFilters != 1 {
		t.Fatalf("original worker status refused: %v", err)
	}
	if s, err := parseProcessSecurity([]byte(workerStatus + "x86_Thread_features:\t\nx86_Thread_features_locked:\t\n")); err != nil || !s.worker() {
		t.Fatal("refused unrelated supported kernel fields")
	}
	for _, field := range []string{"Uid", "Gid", "Groups", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp", "Seccomp_filters", "TracerPid"} {
		t.Run("missing-"+field, func(t *testing.T) {
			lines := strings.Split(workerStatus, "\n")
			var kept []string
			for _, line := range lines {
				if !strings.HasPrefix(line, field+":") {
					kept = append(kept, line)
				}
			}
			if _, err := parseProcessSecurity([]byte(strings.Join(kept, "\n"))); err == nil {
				t.Fatal("accepted missing security field")
			}
		})
	}
	for _, change := range []struct{ old, new string }{
		{"Uid:\t1000\t1000\t1000\t1000", "Uid:\t1000\t0\t1000\t1000"},
		{"Uid:\t1000\t1000\t1000\t1000", "Uid:\t1000\t1000\t1000\t0"},
		{"Gid:\t1000\t1000\t1000\t1000", "Gid:\t1000\t1000\t0\t1000"},
		{"Groups:\t1000 ", "Groups:\t1000 0"},
		{"Groups:\t1000 ", "Groups:\t0"},
		{"NoNewPrivs:\t1", "NoNewPrivs:\t0"},
		{"Seccomp:\t2", "Seccomp:\t0"},
		{"Seccomp:\t2", "Seccomp:\t1"},
		{"Seccomp_filters:\t1", "Seccomp_filters:\t0"},
		{"TracerPid:\t0", "TracerPid:\t1001"},
	} {
		s, err := parseProcessSecurity([]byte(strings.Replace(workerStatus, change.old, change.new, 1)))
		if err == nil && s.worker() {
			t.Errorf("accepted changed security field %s", change.new)
		}
	}
	for _, field := range []string{"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"} {
		s, err := parseProcessSecurity([]byte(strings.Replace(workerStatus, field+":\t0000000000000000", field+":\t0000000000080000", 1)))
		if err != nil || s.worker() {
			t.Errorf("failed to reject nonzero %s: %v", field, err)
		}
	}
}

func TestSourceThreadSecurity(t *testing.T) {
	raw := strings.ReplaceAll(workerStatus, "1000", "0")
	for _, field := range []string{"CapPrm", "CapEff", "CapBnd"} {
		raw = strings.Replace(raw, field+":\t0000000000000000", field+":\t0000000000080000", 1)
	}
	s, err := parseProcessSecurity([]byte(raw))
	if err != nil || !s.source() || s.worker() {
		t.Fatalf("exact source thread refused: %v", err)
	}
	for _, change := range []struct{ old, new string }{
		{"Uid:\t0\t0\t0\t0", "Uid:\t0\t0\t0\t1000"},
		{"CapPrm:\t0000000000080000", "CapPrm:\t0000000000000000"},
		{"CapEff:\t0000000000080000", "CapEff:\t0000000000080001"},
		{"CapBnd:\t0000000000080000", "CapBnd:\t000001ffffffffff"},
		{"CapInh:\t0000000000000000", "CapInh:\t0000000000080000"},
		{"CapAmb:\t0000000000000000", "CapAmb:\t0000000000080000"},
		{"NoNewPrivs:\t1", "NoNewPrivs:\t0"},
	} {
		v, err := parseProcessSecurity([]byte(strings.Replace(raw, change.old, change.new, 1)))
		if err != nil || v.source() {
			t.Errorf("source mismatch not decoded and refused: %s, %v", change.new, err)
		}
	}
}

func TestProcessSecurityMalformedStatus(t *testing.T) {
	for _, raw := range []string{
		workerStatus + "Uid:\t1000\t1000\t1000\t1000\n",
		workerStatus + "Name:\tduplicate\n",
		strings.TrimSuffix(workerStatus, "\n"),
		strings.Replace(workerStatus, "Uid:\t1000", "Uid:\t01000", 1),
		strings.Replace(workerStatus, "TracerPid:\t0", "TracerPid:\t-1", 1),
		strings.Replace(workerStatus, "TracerPid:\t0", "TracerPid:\t4294967296", 1),
		strings.Replace(workerStatus, "CapEff:\t0000000000000000", "CapEff:\t000000000000000F", 1),
		strings.Replace(workerStatus, "CapEff:\t0000000000000000", "CapEff:\t0", 1),
		strings.Replace(workerStatus, "Groups:\t1000 ", "Groups:\t", 1),
		strings.Replace(workerStatus, "NoNewPrivs:\t1", "NoNewPrivs:\t+1", 1),
		workerStatus + strings.Repeat("x", 4096),
		workerStatus + "\x00\n",
	} {
		if _, err := parseProcessSecurity([]byte(raw)); err == nil {
			t.Error("accepted malformed status")
		}
	}
}
