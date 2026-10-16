//go:build linux

package main

import (
	"bytes"
	"crypto/tls"
	"errors"
	"net/http"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/roleboundary"
)

type roleFiles struct {
	files map[string]*birth.ProtectedFile
}

func loadRoleConfiguration(path string, target any) (*roleFiles, error) {
	files := &roleFiles{files: make(map[string]*birth.ProtectedFile)}
	if err := files.add(path); err != nil {
		return nil, err
	}
	raw, err := files.bytes(path)
	if err == nil {
		err = decodeClosed(bytes.NewReader(raw), target)
	}
	if err != nil {
		return nil, errors.Join(err, files.close())
	}
	return files, nil
}

func (p *roleFiles) add(paths ...string) error {
	for _, path := range paths {
		if p.files[path] != nil {
			continue
		}
		f, err := birth.OpenProtectedFile(path)
		if err != nil {
			return err
		}
		p.files[path] = f
	}
	return nil
}

func (p *roleFiles) bytes(path string) ([]byte, error) {
	if p.files[path] == nil {
		return nil, errors.New("original role file was not retained before startup")
	}
	return p.files[path].Bytes()
}

func (p *roleFiles) private(paths ...string) error {
	for _, path := range paths {
		if p.files[path] == nil || p.files[path].RequirePrivate() != nil {
			return errors.New("original role private key protection is unavailable")
		}
	}
	return nil
}

func (p *roleFiles) verify() error {
	for _, f := range p.files {
		if err := f.Verify(); err != nil {
			return err
		}
	}
	return nil
}

func (p *roleFiles) close() error {
	var err error
	for _, f := range p.files {
		err = errors.Join(err, f.Close())
	}
	return err
}

func (p *roleFiles) serverTLS(cfg listenerConfig) (*tls.Config, error) {
	cert, certErr := p.bytes(cfg.Certificate)
	key, keyErr := p.bytes(cfg.Key)
	ca, caErr := p.bytes(cfg.Authority)
	if err := errors.Join(certErr, keyErr, caErr); err != nil {
		return nil, err
	}
	return serverTLS(cert, key, ca)
}

func (p *roleFiles) handler(next http.Handler) http.Handler {
	return roleboundary.Handler(p.verify, next)
}
