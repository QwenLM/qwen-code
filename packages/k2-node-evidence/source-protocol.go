package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
)

func decodeClosed(reader io.Reader, target any) error {
	raw, err := io.ReadAll(io.LimitReader(reader, maxRecordBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > maxRecordBytes || !json.Valid(raw) {
		return errors.New("invalid bounded source request")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("invalid closed source request")
	}
	var decoded any
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := uniqueJSON(decoder); err != nil {
		return err
	}
	if err := decoder.Decode(&decoded); err != io.EOF {
		return errors.New("source request has trailing data")
	}
	known, err := json.Marshal(target)
	if err != nil {
		return errors.New("invalid source request fields")
	}
	var suppliedFields, knownFields any
	if json.Unmarshal(raw, &suppliedFields) != nil || json.Unmarshal(known, &knownFields) != nil || !exactFields(suppliedFields, knownFields) {
		return errors.New("source request fields must match exact names")
	}
	return nil
}

func exactFields(supplied, known any) bool {
	switch fields := supplied.(type) {
	case map[string]any:
		allowed, ok := known.(map[string]any)
		if !ok {
			return false
		}
		for name, value := range fields {
			expected, ok := allowed[name]
			if !ok || !exactFields(value, expected) {
				return false
			}
		}
	case []any:
		allowed, ok := known.([]any)
		if !ok || len(fields) != len(allowed) {
			return false
		}
		for i, value := range fields {
			if !exactFields(value, allowed[i]) {
				return false
			}
		}
	}
	return true
}

func uniqueJSON(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return errors.New("invalid source JSON")
	}
	delimiter, container := token.(json.Delim)
	if !container {
		return nil
	}
	if delimiter != '{' && delimiter != '[' {
		return errors.New("invalid source JSON container")
	}
	keys := make(map[string]bool)
	for decoder.More() {
		if delimiter == '{' {
			key, err := decoder.Token()
			name, ok := key.(string)
			if err != nil || !ok || keys[name] {
				return errors.New("duplicate source JSON field")
			}
			keys[name] = true
		}
		if err := uniqueJSON(decoder); err != nil {
			return err
		}
	}
	end, err := decoder.Token()
	if err != nil || delimiter == '{' && end != json.Delim('}') || delimiter == '[' && end != json.Delim(']') {
		return errors.New("invalid source JSON terminator")
	}
	return nil
}

func hasPrincipal(r *http.Request, expected string) bool {
	if expected == "" || r.TLS == nil || len(r.TLS.VerifiedChains) == 0 || len(r.TLS.PeerCertificates) == 0 {
		return false
	}
	leaf := r.TLS.PeerCertificates[0]
	return len(leaf.URIs) == 1 && leaf.URIs[0].String() == expected
}

func serverTLS(certPath, keyPath, caPath string) (*tls.Config, error) {
	certificate, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, errors.New("source server certificate is unavailable")
	}
	ca, err := os.ReadFile(caPath)
	if err != nil {
		return nil, errors.New("source authority is unavailable")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("source authority is invalid")
	}
	return &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{certificate}, ClientCAs: pool, ClientAuth: tls.RequireAndVerifyClientCert}, nil
}
