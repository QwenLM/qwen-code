package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"testing"
)

func TestPolicyRevisionsAndRawLinks(t *testing.T) {
	for _, value := range []string{"0", "1", "9223372036854775807"} {
		if policyRevision(value, false) != nil {
			t.Fatalf("rejected supported signed kernel revision %q", value)
		}
	}
	for _, value := range []string{"", "00", "01", "-1", "+1", " 1", "1\n", "9223372036854775808", "18446744073709551615", "1/x"} {
		if policyRevision(value, false) == nil {
			t.Fatalf("accepted unsupported signed kernel revision %q", value)
		}
	}
	if policyRevision("0", true) == nil {
		t.Fatal("accepted unborn policy namespace")
	}
	if path, err := policyRawPath("../../raw_data/1/raw_data"); err != nil || path != "raw_data/1" {
		t.Fatal("did not resolve the documented top-level raw-data link")
	}
	for _, link := range []string{"/raw_data/1/raw_data", "../raw_data/1/raw_data", "../../../raw_data/1/raw_data", "../../raw_data/01/raw_data", "../../raw_data/1/../raw_data", "../../raw_data/1/raw_data\n", "../../raw_data/9223372036854775808/raw_data"} {
		if _, err := policyRawPath(link); err == nil {
			t.Fatalf("accepted arbitrary raw-data link %q", link)
		}
	}
}

func TestPolicyRequiresActualClosedEnforceMeasurement(t *testing.T) {
	valid := testPolicy()
	valid.SourceUserNamespace.Inode = ^uint64(0)
	valid.NamespaceRevision = "9223372036854775807"
	if validatePolicy(&valid) != nil {
		t.Fatal("lost full unsigned identity or signed kernel revision range")
	}
	for _, mutate := range []func(*workerPolicy){
		func(p *workerPolicy) { p.LockPolicy = false },
		func(p *workerPolicy) { p.ProfileMode = "complain" },
		func(p *workerPolicy) { p.GlobalMode = "complain" },
		func(p *workerPolicy) { p.SourceLsmLabel = "unconfined" },
		func(p *workerPolicy) { p.SourceProfileDirectory = p.ProfileDirectory },
		func(p *workerPolicy) { p.SecurityfsRoot.Type = apparmorFSMagic },
		func(p *workerPolicy) { p.ApparmorfsRoot.Type = 0x73636673 },
		func(p *workerPolicy) { p.RawSHA256 = "tag" },
		func(p *workerPolicy) { p.RawBytes = maxPolicyBytes + 1 },
		func(p *workerPolicy) { p.LoadRevision = "-1" },
		func(p *workerPolicy) { p.LoadRevision = "9223372036854775807"; p.NamespaceRevision = "1" },
		func(p *workerPolicy) { p.RawABI = "v4" },
		func(p *workerPolicy) { p.RawABI = "v10" },
		func(p *workerPolicy) { p.RawLink = "../../raw_data/1/raw_data/extra" },
	} {
		candidate := valid
		mutate(&candidate)
		if validatePolicy(&candidate) == nil {
			t.Fatal("accepted invalid policy measurement")
		}
	}
}

func TestV3FixtureMatchesActualGoCanonicalEncoding(t *testing.T) {
	raw, err := os.ReadFile("../sdk-java/runtime-broker/src/test/resources/contracts/k2-node-source-v3.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Head        cursor `json:"head"`
		BytesBase64 string `json:"bytesBase64"`
		BytesSHA256 string `json:"bytesSha256"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	frames, err := base64.StdEncoding.DecodeString(fixture.BytesBase64)
	if err != nil || digest(frames) != fixture.BytesSHA256 {
		t.Fatal("fixture byte digest differs")
	}
	if records, err := readJournal(bytes.NewReader(frames), fixture.Head); err != nil || len(records) != 10 {
		t.Fatalf("Go canonical body/field validation failed: %v", err)
	}
	input := frames
	for len(input) != 0 {
		size := int(binary.BigEndian.Uint32(input[:4]))
		var record journalRecord
		if json.Unmarshal(input[4:4+size], &record) != nil {
			t.Fatal("cannot parse fixture")
		}
		encoded, err := json.Marshal(record)
		if err != nil || !bytes.Equal(encoded, input[4:4+size]) {
			t.Fatal("fixture is not actual Go ordered and HTML-escaped encoding")
		}
		input = input[4+size:]
	}
}
