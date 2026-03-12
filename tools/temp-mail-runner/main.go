package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

type startEnvelope struct {
	Type   string         `json:"type"`
	Config tempMailConfig `json:"config"`
}

type stopEnvelope struct {
	Type string `json:"type"`
}

type runtimeState struct {
	ctx       context.Context
	cancel    context.CancelFunc
	total     int
	started   int32
	completed int32
	success   int32
	fail      int32
}

var (
	emitterMu     sync.Mutex
	runStartedAt  time.Time
	runtime       = &runtimeState{}
	errStoppedRun = errors.New("run stopped")
)

func main() {
	rand.Seed(time.Now().UnixNano())

	start, err := readStartEnvelope()
	if err != nil {
		emitError(fmt.Sprintf("invalid start envelope: %v", err))
		os.Exit(1)
	}

	cfg := normalizeConfig(start.Config)
	password, err := normalizeRegisterPassword(cfg.Password)
	if err != nil {
		emitError(err.Error())
		os.Exit(1)
	}
	cfg.Password = password

	ctx, cancel := context.WithCancel(context.Background())
	runtime.ctx = ctx
	runtime.cancel = cancel
	runtime.total = cfg.Count
	runStartedAt = time.Now()

	go watchStopCommands(cancel)

	emitLog(
		fmt.Sprintf(
			"Temp Mail runner started: count=%d delay=%ds allowParallel=%t effectiveThreads=%d",
			cfg.Count,
			cfg.PostSuccessDelaySeconds(),
			cfg.AllowParallel,
			normalizeWorkers(cfg.Workers, cfg.AllowParallel),
		),
		"info",
	)
	emitProgress()

	if err := tempMailService.Configure("", &cfg); err != nil {
		emitError(fmt.Sprintf("Temp Mail init failed: %v", err))
		emitDone(true)
		os.Exit(1)
	}

	runAccounts(ctx, cfg)
	emitDone(ctx.Err() != nil)
}

func readStartEnvelope() (*startEnvelope, error) {
	scanner := bufio.NewScanner(os.Stdin)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		return nil, errors.New("empty stdin")
	}
	line := scanner.Text()
	var env startEnvelope
	if err := json.Unmarshal([]byte(line), &env); err != nil {
		return nil, err
	}
	if env.Type != "start" {
		return nil, fmt.Errorf("unexpected message type %q", env.Type)
	}
	return &env, nil
}

func watchStopCommands(cancel context.CancelFunc) {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		var env stopEnvelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			continue
		}
		if env.Type == "stop" {
			emitLog("Stop requested from controller.", "warning")
			cancel()
			return
		}
	}
}

func emitLine(v interface{}) {
	emitterMu.Lock()
	defer emitterMu.Unlock()
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	_, _ = os.Stdout.Write(append(b, '\n'))
}

func emitLog(text, level string) {
	emitLine(map[string]interface{}{
		"type":  "log",
		"level": level,
		"text":  fmt.Sprintf("[%s] %s", time.Now().Format("15:04:05"), text),
	})
}

func emitError(message string) {
	emitLine(map[string]interface{}{
		"type":    "error",
		"message": message,
	})
}

func emitProgress() {
	emitLine(map[string]interface{}{
		"type":      "progress",
		"total":     runtime.total,
		"started":   atomic.LoadInt32(&runtime.started),
		"completed": atomic.LoadInt32(&runtime.completed),
		"success":   atomic.LoadInt32(&runtime.success),
		"fail":      atomic.LoadInt32(&runtime.fail),
	})
}

func emitToken(result *regResult) {
	if result == nil {
		return
	}
	emitLine(map[string]interface{}{
		"type": "token",
		"payload": map[string]interface{}{
			"email":         result.Email,
			"label":         result.Email,
			"name":          result.Name,
			"access_token":  result.AccessToken,
			"refresh_token": result.RefreshToken,
			"id_token":      result.IDToken,
			"account_id":    result.AccountID,
			"expires_at":    result.ExpiresAt,
			"registered_at": result.RegisteredAt,
			"mode":          result.Mode,
			"plan_type":     "chatgpt",
		},
	})
}

func emitDone(stopped bool) {
	success := atomic.LoadInt32(&runtime.success)
	fail := atomic.LoadInt32(&runtime.fail)
	total := runtime.total
	message := fmt.Sprintf("Temp Mail run finished: success=%d fail=%d total=%d", success, fail, total)
	if stopped {
		message = "Temp Mail run stopped."
	}
	emitLine(map[string]interface{}{
		"type":    "done",
		"success": success,
		"fail":    fail,
		"total":   total,
		"stopped": stopped,
		"elapsed": fmt.Sprintf("%.1fs", time.Since(runStartedAt).Seconds()),
		"message": message,
	})
}
