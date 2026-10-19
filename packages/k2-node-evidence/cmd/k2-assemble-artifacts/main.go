package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/artifactset"
	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
)

func run() error {
	pre := flag.String("pre-exec", "", "original artifact candidate directory")
	profiles := flag.String("profiles", "", "original profile candidate directory")
	compiled := flag.String("compilation", "", "original successful compilation directory")
	profileSHA := flag.String("profile-candidate-sha256", "", "reviewed original profile-candidate.json digest")
	compileSHA := flag.String("compile-record-sha256", "", "reviewed original compile.json digest")
	output := flag.String("output", "", "new absolute candidate output directory")
	flag.Parse()
	if flag.NArg() != 0 || !filepath.IsAbs(*output) || filepath.Clean(*output) != *output {
		return errors.New("a new absolute output and named inputs are required")
	}
	a, err := os.OpenRoot(*pre)
	if err != nil {
		return err
	}
	defer a.Close()
	p, err := os.OpenRoot(*profiles)
	if err != nil {
		return err
	}
	defer p.Close()
	c, err := os.OpenRoot(*compiled)
	if err != nil {
		return err
	}
	defer c.Close()
	files, err := artifactset.Assemble(a.FS(), p.FS(), c.FS(), *profileSHA, *compileSHA)
	if err != nil {
		return err
	}
	if err := os.Mkdir(*output, 0700); err != nil {
		return err
	}
	root, err := os.OpenRoot(*output)
	if err != nil {
		return err
	}
	defer root.Close()
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0400)
		if err != nil {
			return err
		}
		_, writeErr := f.Write(files[name])
		closeErr := f.Close()
		if err := errors.Join(writeErr, closeErr); err != nil {
			return err
		}
	}
	fmt.Println("Assembled artifact bytes:", birth.SHA256(files["installation.json"]))
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Artifact byte assembly refused:", err)
		os.Exit(1)
	}
}
