package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

//go:embed payload.zip
var payload []byte

// Set at build time so a new EXE gets a separate cache directory.
var version = "development"

func showError(err error) {
	title, _ := syscall.UTF16PtrFromString("ClipDeck")
	message, _ := syscall.UTF16PtrFromString("ClipDeck could not start:\n\n" + err.Error())
	proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
}

func extract(destination string) error {
	if _, err := os.Stat(filepath.Join(destination, ".ready")); err == nil {
		return nil
	}

	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return err
	}
	temp, err := os.MkdirTemp(parent, "install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)

	archive, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return err
	}
	prefix := filepath.Clean(temp) + string(filepath.Separator)
	for _, file := range archive.File {
		target := filepath.Join(temp, filepath.FromSlash(file.Name))
		if !strings.HasPrefix(target, prefix) {
			return fmt.Errorf("invalid bundled file path: %q", file.Name)
		}
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0700); err != nil {
				return err
			}
			continue
		}
		if !file.FileInfo().Mode().IsRegular() {
			return fmt.Errorf("unexpected bundled file: %q", file.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		reader, err := file.Open()
		if err != nil {
			return err
		}
		writer, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			reader.Close()
			return err
		}
		_, copyErr := io.Copy(writer, reader)
		closeErr := writer.Close()
		reader.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if err := os.WriteFile(filepath.Join(temp, ".ready"), []byte(version), 0600); err != nil {
		return err
	}
	if err := os.Rename(temp, destination); err != nil {
		// A concurrent launch may already have installed the same version.
		if _, statErr := os.Stat(filepath.Join(destination, ".ready")); statErr == nil {
			return nil
		}
		return err
	}
	return nil
}

func available(client *http.Client, address string) bool {
	response, err := client.Get(address + "/api/status")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var info struct {
		Hosted            bool            `json:"hosted"`
		ConversionCatalog json.RawMessage `json:"conversionCatalog"`
	}
	return json.NewDecoder(response.Body).Decode(&info) == nil &&
		!info.Hosted && len(info.ConversionCatalog) > 2
}

func openBrowser(address string) {
	if os.Getenv("CLIPDECK_NO_BROWSER") != "1" {
		exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", address).Start()
	}
}

func main() {
	if err := start(); err != nil {
		showError(err)
		os.Exit(1)
	}
}

func start() error {
	cache, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	directory := filepath.Join(cache, "ClipDeck", version)
	if err := extract(directory); err != nil {
		return fmt.Errorf("could not unpack the bundled tools: %w", err)
	}
	address := "http://127.0.0.1:4174"
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	if available(client, address) {
		openBrowser(address)
		return nil
	}

	logFile, err := os.OpenFile(filepath.Join(cache, "ClipDeck", "launcher.log"),
		os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer logFile.Close()

	command := exec.Command(filepath.Join(directory, "node.exe"), "server.mjs")
	command.Dir = directory
	command.Env = append(os.Environ(),
		"CLIPDECK_HOSTED=0", "CLIPDECK_PORT=4174", "PORT=4174",
		"PATH="+directory+";"+os.Getenv("PATH"))
	command.Stdout, command.Stderr = logFile, logFile
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := command.Start(); err != nil {
		return fmt.Errorf("could not launch the local server: %w", err)
	}

	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	for attempt := 0; attempt < 100; attempt++ {
		select {
		case err := <-done:
			return fmt.Errorf("server exited before starting (%v); see %s", err, logFile.Name())
		default:
		}
		if available(client, address) {
			openBrowser(address)
			// Keep this EXE running while its local server is active.
			<-done
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	command.Process.Kill()
	<-done
	return fmt.Errorf("server did not start; see %s", logFile.Name())
}
