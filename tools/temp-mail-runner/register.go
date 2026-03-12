package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	tls_profiles "github.com/bogdanfinn/tls-client/profiles"
)

const (
	defaultRegisterPassword = "Qwer1234!Aa#"

	oaiClientID        = "app_EMoamEEZ73f0CkXaXp7hrann"
	oaiAuthURL         = "https://auth.openai.com/oauth/authorize"
	oaiTokenURL        = "https://auth.openai.com/oauth/token"
	oaiSentinelURL     = "https://sentinel.openai.com/backend-api/sentinel/req"
	oaiSignupURL       = "https://auth.openai.com/api/accounts/authorize/continue"
	oaiUserRegisterURL = "https://auth.openai.com/api/accounts/user/register"
	oaiSendOTPURL      = "https://auth.openai.com/api/accounts/passwordless/send-otp"
	oaiEmailOTPResend  = "https://auth.openai.com/api/accounts/email-otp/resend"
	oaiVerifyURL       = "https://auth.openai.com/api/accounts/email-otp/validate"
	oaiCreateURL       = "https://auth.openai.com/api/accounts/create_account"
	oaiWorkURL         = "https://auth.openai.com/api/accounts/workspace/select"

	localRedirectURI = "http://localhost:1455/auth/callback"
	maxRetry         = 2
)

type account struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type regResult struct {
	Email        string `json:"email"`
	Type         string `json:"type"`
	Name         string `json:"name"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	AccountID    string `json:"account_id"`
	ExpiresAt    string `json:"expires_at"`
	RegisteredAt string `json:"registered_at"`
	Mode         string `json:"mode"`
}

var givenNames = []string{
	"Liam", "Noah", "Oliver", "James", "Elijah", "William", "Henry", "Lucas",
	"Benjamin", "Theodore", "Jack", "Levi", "Alexander", "Mason", "Ethan",
	"Olivia", "Emma", "Charlotte", "Amelia", "Sophia", "Isabella", "Mia",
	"Evelyn", "Harper", "Luna", "Camila", "Sofia", "Scarlett", "Elizabeth",
}

var familyNames = []string{
	"Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis",
	"Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
	"Lee", "Thompson", "White", "Harris", "Clark", "Lewis", "Robinson",
}

var tlsProfiles = []tls_profiles.ClientProfile{
	tls_profiles.Chrome_131,
	tls_profiles.Chrome_131_PSK,
	tls_profiles.Chrome_124,
	tls_profiles.Chrome_120,
}

var userAgents = []string{
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
}

var acceptLanguages = []string{
	"en-US,en;q=0.9",
	"en-US,en;q=0.9,zh-CN;q=0.8",
	"en-GB,en;q=0.9,en-US;q=0.8",
}

type httpClient struct {
	client    tls_client.HttpClient
	cookies   map[string]string
	profile   string
	userAgent string
}

func newHTTPClient(proxy string) (*httpClient, error) {
	profile := tlsProfiles[rand.Intn(len(tlsProfiles))]
	ua := userAgents[rand.Intn(len(userAgents))]
	jar := tls_client.NewCookieJar()
	options := []tls_client.HttpClientOption{
		tls_client.WithClientProfile(profile),
		tls_client.WithTimeoutSeconds(30),
		tls_client.WithCookieJar(jar),
		tls_client.WithRandomTLSExtensionOrder(),
	}
	if proxy != "" {
		options = append(options, tls_client.WithProxyUrl(proxy))
	}
	client, err := tls_client.NewHttpClient(nil, options...)
	if err != nil {
		return nil, err
	}
	return &httpClient{
		client:    client,
		cookies:   make(map[string]string),
		profile:   fmt.Sprintf("%v", profile),
		userAgent: ua,
	}, nil
}

var chromeGetHeaderOrder = []string{
	"host", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
	"upgrade-insecure-requests", "user-agent", "accept",
	"sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest",
	"accept-encoding", "accept-language",
}

var chromePostHeaderOrder = []string{
	"host", "content-length", "sec-ch-ua", "sec-ch-ua-mobile",
	"sec-ch-ua-platform", "content-type", "user-agent", "accept",
	"origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
	"referer", "accept-encoding", "accept-language",
}

func (h *httpClient) setGetHeaders(req *fhttp.Request) {
	req.Header = fhttp.Header{
		"sec-ch-ua":                 {`"Chromium";v="131", "Not_A Brand";v="24"`},
		"sec-ch-ua-mobile":          {"?0"},
		"sec-ch-ua-platform":        {`"Windows"`},
		"upgrade-insecure-requests": {"1"},
		"user-agent":                {h.userAgent},
		"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"},
		"sec-fetch-site":            {"none"},
		"sec-fetch-mode":            {"navigate"},
		"sec-fetch-user":            {"?1"},
		"sec-fetch-dest":            {"document"},
		"accept-encoding":           {"gzip, deflate, br, zstd"},
		"accept-language":           {acceptLanguages[rand.Intn(len(acceptLanguages))]},
		"dnt":                       {"1"},
		fhttp.HeaderOrderKey:        chromeGetHeaderOrder,
	}
}

func (h *httpClient) setPostHeaders(req *fhttp.Request, contentType string, extraHeaders map[string]string) {
	req.Header = fhttp.Header{
		"sec-ch-ua":          {`"Chromium";v="131", "Not_A Brand";v="24"`},
		"sec-ch-ua-mobile":   {"?0"},
		"sec-ch-ua-platform": {`"Windows"`},
		"content-type":       {contentType},
		"user-agent":         {h.userAgent},
		"accept":             {"application/json"},
		"origin":             {"https://auth.openai.com"},
		"sec-fetch-site":     {"same-origin"},
		"sec-fetch-mode":     {"cors"},
		"sec-fetch-dest":     {"empty"},
		"accept-encoding":    {"gzip, deflate, br, zstd"},
		"accept-language":    {acceptLanguages[rand.Intn(len(acceptLanguages))]},
		"dnt":                {"1"},
		fhttp.HeaderOrderKey: chromePostHeaderOrder,
	}
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}
}

func (h *httpClient) Get(rawURL string) (int, string, error) {
	req, _ := fhttp.NewRequest("GET", rawURL, nil)
	h.setGetHeaders(req)
	resp, err := h.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	h.saveCookies(resp)
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), nil
}

func (h *httpClient) PostJSON(rawURL string, data interface{}, extraHeaders map[string]string) (int, string, error) {
	b, _ := json.Marshal(data)
	req, _ := fhttp.NewRequest("POST", rawURL, strings.NewReader(string(b)))
	h.setPostHeaders(req, "application/json", extraHeaders)
	resp, err := h.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	h.saveCookies(resp)
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), nil
}

func (h *httpClient) PostForm(rawURL string, data url.Values) (int, string, error) {
	req, _ := fhttp.NewRequest("POST", rawURL, strings.NewReader(data.Encode()))
	h.setPostHeaders(req, "application/x-www-form-urlencoded", nil)
	resp, err := h.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	h.saveCookies(resp)
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), nil
}

func (h *httpClient) FollowRedirects(startURL string, maxHops int) (string, error) {
	h.client.SetFollowRedirect(false)
	defer h.client.SetFollowRedirect(true)

	u := startURL
	for i := 0; i < maxHops; i++ {
		req, _ := fhttp.NewRequest("GET", u, nil)
		h.setGetHeaders(req)
		resp, err := h.client.Do(req)
		if err != nil {
			return "", err
		}
		resp.Body.Close()
		h.saveCookies(resp)
		loc := resp.Header.Get("Location")
		if loc == "" {
			return "", fmt.Errorf("no Location header at hop %d (status %d)", i, resp.StatusCode)
		}
		if strings.Contains(loc, "localhost") && strings.Contains(loc, "/auth/callback") {
			return loc, nil
		}
		u = loc
	}
	return "", fmt.Errorf("too many redirects")
}

func (h *httpClient) GetCookie(name string) string {
	return h.cookies[name]
}

func (h *httpClient) saveCookies(resp *fhttp.Response) {
	for _, c := range resp.Cookies() {
		h.cookies[c.Name] = c.Value
	}
}

func randomName() string {
	return givenNames[rand.Intn(len(givenNames))] + " " + familyNames[rand.Intn(len(familyNames))]
}

func randomBirthday() string {
	y := 1986 + rand.Intn(21)
	m := 1 + rand.Intn(12)
	d := 1 + rand.Intn(28)
	return fmt.Sprintf("%d-%02d-%02d", y, m, d)
}

func urlsafeB64(data []byte) string {
	return strings.TrimRight(base64.URLEncoding.EncodeToString(data), "=")
}

func createPKCE() (verifier, challenge string) {
	b := make([]byte, 48)
	rand.Read(b)
	verifier = urlsafeB64(b)
	h := sha256.Sum256([]byte(verifier))
	challenge = urlsafeB64(h[:])
	return
}

func createOAuthParams() (authURL, state, verifier string) {
	verifier, challenge := createPKCE()
	b := make([]byte, 16)
	rand.Read(b)
	state = urlsafeB64(b)
	q := url.Values{
		"client_id":                  {oaiClientID},
		"response_type":              {"code"},
		"redirect_uri":               {localRedirectURI},
		"scope":                      {"openid email profile offline_access"},
		"state":                      {state},
		"code_challenge":             {challenge},
		"code_challenge_method":      {"S256"},
		"prompt":                     {"login"},
		"id_token_add_organizations": {"true"},
		"codex_cli_simplified_flow":  {"true"},
	}
	authURL = oaiAuthURL + "?" + q.Encode()
	return
}

func decodeJWTPayload(token string) map[string]interface{} {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	payload := parts[1]
	for len(payload)%4 != 0 {
		payload += "="
	}
	raw, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		return nil
	}
	var m map[string]interface{}
	_ = json.Unmarshal(raw, &m)
	return m
}

func normalizeWorkers(requested int, allowParallel bool) int {
	if !allowParallel {
		return 1
	}
	if requested < 1 {
		return 1
	}
	if requested > 50 {
		return 50
	}
	return requested
}

func extractPageType(data map[string]interface{}) string {
	page, ok := data["page"].(map[string]interface{})
	if !ok {
		return ""
	}
	pageType, _ := page["type"].(string)
	return pageType
}

func isPasswordlessUnavailable(status int, body string) bool {
	return status == 401 && strings.Contains(strings.ToLower(body), "passwordless signup is unavailable")
}

func normalizeRegisterPassword(raw string) (string, error) {
	password := strings.TrimSpace(raw)
	switch password {
	case "", "Qwer1234!":
		return defaultRegisterPassword, nil
	}
	if len([]rune(password)) < 12 {
		return "", fmt.Errorf("OpenAI register password must be at least 12 characters")
	}
	return password, nil
}

func runAccounts(ctx context.Context, cfg tempMailConfig) {
	workers := normalizeWorkers(cfg.Workers, cfg.AllowParallel)
	accounts := make([]account, 0, cfg.Count)
	for i := 0; i < cfg.Count; i++ {
		accounts = append(accounts, account{
			Email:    fmt.Sprintf("temp-mail-%d@placeholder.local", i+1),
			Password: cfg.Password,
		})
	}

	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for i, acc := range accounts {
		if ctx.Err() != nil {
			break
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(a account, idx int) {
			defer func() {
				<-sem
				wg.Done()
			}()
			doOne(ctx, a, idx+1, len(accounts), cfg)
		}(acc, i)
	}
	wg.Wait()
}

func doOne(ctx context.Context, acc account, idx, total int, cfg tempMailConfig) {
	if ctx.Err() != nil {
		return
	}
	atomic.AddInt32(&runtime.started, 1)
	emitProgress()
	emitLog(fmt.Sprintf("%s", strings.Repeat("─", 45)), "dim")
	emitLog(fmt.Sprintf("[%d/%d] temp-mail#%d", idx, total, idx), "info")

	var success bool
	var lastErr string
	for attempt := 1; attempt <= maxRetry; attempt++ {
		if ctx.Err() != nil {
			return
		}
		if attempt > 1 {
			emitLog(fmt.Sprintf("  Retry #%d...", attempt), "warning")
			if err := sleepWithContext(ctx, time.Duration(2+attempt)*time.Second); err != nil {
				return
			}
		}

		result, err := registerAccount(ctx, acc, cfg)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			lastErr = err.Error()
			emitLog(fmt.Sprintf("  Attempt %d failed: %s", attempt, truncate(lastErr, 140)), "error")
			continue
		}

		success = true
		atomic.AddInt32(&runtime.success, 1)
		atomic.AddInt32(&runtime.completed, 1)
		emitProgress()
		emitLog(fmt.Sprintf("  Registration succeeded: %s", result.Email), "success")
		emitToken(result)
		if delay := cfg.PostSuccessDelaySeconds(); delay > 0 && idx < total {
			emitLog(fmt.Sprintf("  Waiting %d seconds before the next account...", delay), "dim")
			if err := sleepWithContext(ctx, time.Duration(delay)*time.Second); err != nil {
				return
			}
		}
		break
	}

	if !success {
		atomic.AddInt32(&runtime.fail, 1)
		atomic.AddInt32(&runtime.completed, 1)
		emitProgress()
		emitLog(fmt.Sprintf("  Final failure: %s", truncate(lastErr, 160)), "error")
	}
}

func registerAccount(ctx context.Context, acc account, cfg tempMailConfig) (*regResult, error) {
	email := strings.TrimSpace(acc.Email)
	if strings.HasSuffix(strings.ToLower(email), "@placeholder.local") {
		mailbox, err := tempMailService.AcquireMailbox(ctx)
		if err != nil {
			return nil, fmt.Errorf("Temp Mail mailbox failed: %w", err)
		}
		email = mailbox
		emitLog(fmt.Sprintf("  Temp Mail assigned mailbox: %s", mailbox), "info")
	}

	if ctx.Err() != nil {
		return nil, errStoppedRun
	}

	httpClient, err := newHTTPClient("")
	if err != nil {
		return nil, fmt.Errorf("create http client failed: %w", err)
	}
	emitLog(fmt.Sprintf("  Browser fingerprint: %s", httpClient.profile), "dim")

	authURL, state, verifier := createOAuthParams()
	emitLog("  [1] OAuth bootstrap...", "info")
	status, _, err := httpClient.Get(authURL)
	if err != nil {
		return nil, fmt.Errorf("oauth failed: %w", err)
	}
	emitLog(fmt.Sprintf("      status: %d", status), "dim")
	if err := sleepRand(ctx, 800, 2000); err != nil {
		return nil, err
	}

	deviceID := httpClient.GetCookie("oai-did")
	emitLog("  [2] Fetching Sentinel token...", "info")
	sentinelBody := map[string]interface{}{"p": "", "id": deviceID, "flow": "authorize_continue"}
	sStatus, sBody, err := httpClient.PostJSON(oaiSentinelURL, sentinelBody, map[string]string{
		"Origin":  "https://sentinel.openai.com",
		"Referer": "https://sentinel.openai.com/backend-api/sentinel/frame.html",
	})
	if err != nil || sStatus < 200 || sStatus >= 300 {
		return nil, fmt.Errorf("sentinel failed: %d %s", sStatus, truncate(sBody, 200))
	}
	var sentinelResp map[string]interface{}
	_ = json.Unmarshal([]byte(sBody), &sentinelResp)
	sentinelToken, _ := sentinelResp["token"].(string)
	sentinelHeader, _ := json.Marshal(map[string]interface{}{
		"p": "", "t": "", "c": sentinelToken, "id": deviceID, "flow": "authorize_continue",
	})
	emitLog("      OK", "dim")
	if err := sleepRand(ctx, 500, 1500); err != nil {
		return nil, err
	}

	otpSentAt := time.Now()
	emitLog(fmt.Sprintf("  [3] Submit email: %s", email), "info")
	signupBody := map[string]interface{}{
		"username":    map[string]interface{}{"value": email, "kind": "email"},
		"screen_hint": "signup",
	}
	s3Status, s3Body, err := httpClient.PostJSON(oaiSignupURL, signupBody, map[string]string{
		"Referer":               "https://auth.openai.com/create-account",
		"openai-sentinel-token": string(sentinelHeader),
	})
	if err != nil || s3Status < 200 || s3Status >= 300 {
		return nil, fmt.Errorf("submit email failed: %d %s", s3Status, truncate(s3Body, 300))
	}

	var step3Data map[string]interface{}
	_ = json.Unmarshal([]byte(s3Body), &step3Data)
	pageType := extractPageType(step3Data)
	step3ContinueURL, _ := step3Data["continue_url"].(string)
	isExisting := pageType == "email_otp_verification"
	emitLog(fmt.Sprintf("      page type: %s", pageType), "dim")
	if err := sleepRand(ctx, 500, 1500); err != nil {
		return nil, err
	}

	otpResendMode := ""
	switch pageType {
	case "create_account_password":
		if step3ContinueURL != "" {
			status, _, err := httpClient.Get(step3ContinueURL)
			if err != nil {
				return nil, fmt.Errorf("open password page failed: %w", err)
			}
			if status < 200 || status >= 400 {
				return nil, fmt.Errorf("open password page failed: %d", status)
			}
			if err := sleepRand(ctx, 300, 900); err != nil {
				return nil, err
			}
		}

		password, err := normalizeRegisterPassword(acc.Password)
		if err != nil {
			return nil, err
		}

		emitLog("  [4] Submit register password...", "info")
		r4Status, r4Body, err := httpClient.PostJSON(oaiUserRegisterURL, map[string]interface{}{
			"username": email,
			"password": password,
		}, map[string]string{
			"Referer": "https://auth.openai.com/create-account/password",
		})
		if err != nil {
			return nil, fmt.Errorf("submit register password failed: %w", err)
		}
		if r4Status < 200 || r4Status >= 300 {
			return nil, fmt.Errorf("submit register password failed: %d %s", r4Status, truncate(r4Body, 300))
		}

		var step4Data map[string]interface{}
		_ = json.Unmarshal([]byte(r4Body), &step4Data)
		pageType = extractPageType(step4Data)
		emitLog("      OK", "dim")
		emitLog(fmt.Sprintf("      next page type: %s", pageType), "dim")

		if nextURL, _ := step4Data["continue_url"].(string); nextURL != "" {
			status, _, err := httpClient.Get(nextURL)
			if err != nil {
				return nil, fmt.Errorf("open register next page failed: %w", err)
			}
			if status < 200 || status >= 400 {
				return nil, fmt.Errorf("open register next page failed: %d", status)
			}
		}

		if pageType == "email_otp_send" || pageType == "email_otp_verification" {
			otpResendMode = "email_otp"
			otpSentAt = time.Now()
		}
		if err := sleepRand(ctx, 500, 1200); err != nil {
			return nil, err
		}
	case "email_otp_verification":
		emitLog("  [4] Skip OTP send (already sent by server)", "info")
		otpResendMode = "email_otp"
	default:
		emitLog("  [4] Sending OTP...", "info")
		o4Status, o4Body, err := httpClient.PostJSON(oaiSendOTPURL, map[string]interface{}{}, map[string]string{
			"Referer": "https://auth.openai.com/create-account/password",
		})
		if err != nil {
			return nil, fmt.Errorf("send otp failed: %w", err)
		}
		if isPasswordlessUnavailable(o4Status, o4Body) {
			return nil, fmt.Errorf("send otp failed: passwordless flow is unavailable for page type %s", pageType)
		}
		if o4Status < 200 || o4Status >= 300 {
			return nil, fmt.Errorf("send otp failed: %d %s", o4Status, truncate(o4Body, 300))
		}
		otpSentAt = time.Now()
		otpResendMode = "passwordless"
	}

	if !isExisting && otpResendMode == "" {
		return nil, fmt.Errorf("registration flow did not reach an email verification page: %s", pageType)
	}

	emitLog(fmt.Sprintf("    Waiting for verification code (%s, Temp Mail)...", email), "info")
	resendFn := func() bool {
		switch otpResendMode {
		case "email_otp":
			s, _, _ := httpClient.PostJSON(oaiEmailOTPResend, map[string]interface{}{}, map[string]string{
				"Referer": "https://auth.openai.com/email-verification",
			})
			return s >= 200 && s < 300
		case "passwordless":
			s, _, _ := httpClient.PostJSON(oaiSendOTPURL, map[string]interface{}{}, map[string]string{
				"Referer": "https://auth.openai.com/email-verification",
			})
			return s >= 200 && s < 300
		default:
			return false
		}
	}
	code, err := waitForTempMailCode(ctx, email, otpSentAt, resendFn)
	if err != nil {
		return nil, err
	}
	if err := sleepRand(ctx, 300, 1000); err != nil {
		return nil, err
	}

	emitLog(fmt.Sprintf("  [6] Verify OTP: %s", code), "info")
	v6Status, v6Body, err := httpClient.PostJSON(oaiVerifyURL, map[string]interface{}{"code": code}, map[string]string{
		"Referer": "https://auth.openai.com/email-verification",
	})
	if err != nil || v6Status < 200 || v6Status >= 300 {
		return nil, fmt.Errorf("otp verify failed: %d %s", v6Status, truncate(v6Body, 300))
	}
	if err := sleepRand(ctx, 500, 1500); err != nil {
		return nil, err
	}

	name := ""
	if isExisting {
		emitLog("  [7] Skip account creation (existing account)", "info")
	} else {
		name = randomName()
		birthday := randomBirthday()
		emitLog(fmt.Sprintf("  [7] Creating account: %s, %s", name, birthday), "info")
		c7Status, c7Body, err := httpClient.PostJSON(oaiCreateURL, map[string]interface{}{
			"name": name, "birthdate": birthday,
		}, map[string]string{"Referer": "https://auth.openai.com/about-you"})
		if err != nil || c7Status < 200 || c7Status >= 300 {
			return nil, fmt.Errorf("create account failed: %d %s", c7Status, truncate(c7Body, 300))
		}
		if err := sleepRand(ctx, 500, 1500); err != nil {
			return nil, err
		}
	}

	authCookie := httpClient.GetCookie("oai-client-auth-session")
	if authCookie == "" {
		return nil, fmt.Errorf("missing oai-client-auth-session cookie")
	}
	parts := strings.Split(authCookie, ".")
	cookieB64 := parts[0]
	for len(cookieB64)%4 != 0 {
		cookieB64 += "="
	}
	cookieRaw, err := base64.StdEncoding.DecodeString(cookieB64)
	if err != nil {
		return nil, fmt.Errorf("decode cookie failed: %w", err)
	}
	var cookieData map[string]interface{}
	_ = json.Unmarshal(cookieRaw, &cookieData)
	workspaces, _ := cookieData["workspaces"].([]interface{})
	if len(workspaces) == 0 {
		return nil, fmt.Errorf("no workspace found")
	}
	ws0, _ := workspaces[0].(map[string]interface{})
	workspaceID, _ := ws0["id"].(string)
	if workspaceID == "" {
		return nil, fmt.Errorf("workspace_id is empty")
	}

	emitLog(fmt.Sprintf("  [8] Selecting workspace: %s...", truncate(workspaceID, 20)), "info")
	w8Status, w8Body, err := httpClient.PostJSON(oaiWorkURL, map[string]interface{}{
		"workspace_id": workspaceID,
	}, map[string]string{"Referer": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"})
	if err != nil || w8Status < 200 || w8Status >= 300 {
		return nil, fmt.Errorf("select workspace failed: %d %s", w8Status, truncate(w8Body, 300))
	}
	var w8Data map[string]interface{}
	_ = json.Unmarshal([]byte(w8Body), &w8Data)
	continueURL, _ := w8Data["continue_url"].(string)
	if continueURL == "" {
		return nil, fmt.Errorf("missing continue_url")
	}

	emitLog("  [9] Following redirects to get token...", "info")
	callbackURL, err := httpClient.FollowRedirects(continueURL, 12)
	if err != nil {
		return nil, fmt.Errorf("redirect flow failed: %w", err)
	}
	parsed, _ := url.Parse(callbackURL)
	authCode := parsed.Query().Get("code")
	returnedState := parsed.Query().Get("state")
	if authCode == "" {
		return nil, fmt.Errorf("callback missing code")
	}
	if returnedState != state {
		return nil, fmt.Errorf("state mismatch")
	}

	tStatus, tBody, err := httpClient.PostForm(oaiTokenURL, url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {oaiClientID},
		"code":          {authCode},
		"redirect_uri":  {localRedirectURI},
		"code_verifier": {verifier},
	})
	if err != nil || tStatus < 200 || tStatus >= 300 {
		return nil, fmt.Errorf("token exchange failed: %d %s", tStatus, truncate(tBody, 300))
	}

	var tokenData map[string]interface{}
	_ = json.Unmarshal([]byte(tBody), &tokenData)
	claims := decodeJWTPayload(strVal(tokenData, "id_token"))
	authClaims, _ := claims["https://api.openai.com/auth"].(map[string]interface{})
	now := time.Now()
	expiresIn := intVal(tokenData, "expires_in")
	return &regResult{
		Email:        email,
		Type:         "codex",
		Name:         firstNonEmpty(name, strFromMap(claims, "name")),
		AccessToken:  strVal(tokenData, "access_token"),
		RefreshToken: strVal(tokenData, "refresh_token"),
		IDToken:      strVal(tokenData, "id_token"),
		AccountID:    strFromMap(authClaims, "chatgpt_account_id"),
		ExpiresAt:    now.Add(time.Duration(expiresIn) * time.Second).UTC().Format(time.RFC3339),
		RegisteredAt: now.UTC().Format(time.RFC3339),
		Mode:         "register",
	}, nil
}

func sleepRand(ctx context.Context, minMs, maxMs int) error {
	return sleepWithContext(ctx, time.Duration(minMs+rand.Intn(maxMs-minMs))*time.Millisecond)
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return errStoppedRun
	case <-timer.C:
		return nil
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func strVal(m map[string]interface{}, key string) string {
	v, _ := m[key].(string)
	return v
}

func strFromMap(m map[string]interface{}, key string) string {
	if m == nil {
		return ""
	}
	v, _ := m[key].(string)
	return v
}

func intVal(m map[string]interface{}, key string) int {
	v, _ := m[key].(float64)
	return int(v)
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
