package localapi

import (
	"os"
	"path/filepath"
	"strings"
)

func validateDirectory(raw string) DirectoryValidation {
	path := strings.TrimSpace(raw)
	if path == "" {
		return DirectoryValidation{OK: false, Path: "", Reason: "not_absolute"}
	}
	if strings.HasPrefix(path, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, strings.TrimPrefix(path, "~"))
		}
	}
	if !filepath.IsAbs(path) {
		return DirectoryValidation{OK: false, Path: path, Reason: "not_absolute"}
	}
	stat, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return DirectoryValidation{OK: false, Path: path, Reason: "not_found"}
		}
		return DirectoryValidation{OK: false, Path: path, Reason: "not_readable"}
	}
	if !stat.IsDir() {
		return DirectoryValidation{OK: false, Path: path, Reason: "not_a_directory"}
	}
	if err := accessReadable(path); err != nil {
		return DirectoryValidation{OK: false, Path: path, Reason: "not_readable"}
	}
	return DirectoryValidation{OK: true, Path: path}
}

func accessReadable(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	return f.Close()
}
