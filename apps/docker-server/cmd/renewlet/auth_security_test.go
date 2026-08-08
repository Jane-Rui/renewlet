package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

// 这组测试覆盖 Turnstile 安全边界：secret 单向写入、公开 status 脱敏、登录前置校验和上游 raw 不外泄。
func TestAuthSecurityAdminRouteManagesTurnstileWithoutSecretEcho(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "admin")

	incomplete := serveTestRequest(t, app, http.MethodPut, "/api/app/admin/auth-security", `{"turnstile":{"enabled":true,"siteKey":"site-key"}}`, token)
	if incomplete.Code != http.StatusBadRequest || !strings.Contains(incomplete.Body.String(), "TURNSTILE_CONFIG_INCOMPLETE") {
		t.Fatalf("expected incomplete config rejection, got %d: %s", incomplete.Code, incomplete.Body.String())
	}

	save := serveTestRequest(t, app, http.MethodPut, "/api/app/admin/auth-security", `{"turnstile":{"enabled":true,"siteKey":"site-key","secret":"secret-value"}}`, token)
	if save.Code != http.StatusOK {
		t.Fatalf("expected auth security save 200, got %d: %s", save.Code, save.Body.String())
	}
	if strings.Contains(save.Body.String(), "secret-value") || strings.Contains(save.Body.String(), "turnstileSecret") {
		t.Fatalf("auth security response leaked secret: %s", save.Body.String())
	}
	saved := decodeAPISuccessDataForTest[authSecurityResponse](t, save.Body.Bytes())
	if !saved.Turnstile.Enabled || saved.Turnstile.SiteKey != "site-key" || !saved.Turnstile.SecretConfigured {
		t.Fatalf("unexpected saved auth security response: %#v", saved)
	}

	status := serveTestRequest(t, app, http.MethodGet, "/api/app/status", "", "")
	if status.Code != http.StatusOK {
		t.Fatalf("expected app status 200, got %d: %s", status.Code, status.Body.String())
	}
	if strings.Contains(status.Body.String(), "secret") {
		t.Fatalf("app status leaked secret metadata: %s", status.Body.String())
	}
	statusData := decodeAPISuccessDataForTest[appStatusResponse](t, status.Body.Bytes())
	if !statusData.Turnstile.Enabled || statusData.Turnstile.SiteKey != "site-key" {
		t.Fatalf("expected public status to expose only enabled site key, got %#v", statusData.Turnstile)
	}

	retain := serveTestRequest(t, app, http.MethodPut, "/api/app/admin/auth-security", `{"turnstile":{"enabled":true,"siteKey":"site-key-2"}}`, token)
	if retain.Code != http.StatusOK {
		t.Fatalf("expected secret retention save 200, got %d: %s", retain.Code, retain.Body.String())
	}
	retained, err := readAuthSecuritySettings(app)
	if err != nil {
		t.Fatal(err)
	}
	if retained.TurnstileSiteKey != "site-key-2" || retained.TurnstileSecret != "secret-value" {
		t.Fatalf("expected omitted secret to retain old value, got %#v", retained)
	}

	clear := serveTestRequest(t, app, http.MethodPut, "/api/app/admin/auth-security", `{"turnstile":{"enabled":false,"siteKey":"site-key-2","secret":""}}`, token)
	if clear.Code != http.StatusOK {
		t.Fatalf("expected secret clear 200, got %d: %s", clear.Code, clear.Body.String())
	}
	cleared := decodeAPISuccessDataForTest[authSecurityResponse](t, clear.Body.Bytes())
	if cleared.Turnstile.Enabled || cleared.Turnstile.SecretConfigured {
		t.Fatalf("expected cleared secret to disable Turnstile, got %#v", cleared)
	}
}

func TestAuthLoginRequiresTurnstileBeforePasswordFlow(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "user")
	if err := saveAuthSecuritySettings(app, authSecurityStoredSettings{
		TurnstileEnabled: true,
		TurnstileSiteKey: "site-key",
		TurnstileSecret:  "secret-value",
	}); err != nil {
		t.Fatal(err)
	}

	originalVerify := verifyTurnstileToken
	t.Cleanup(func() {
		verifyTurnstileToken = originalVerify
	})
	calls := make([]string, 0, 2)
	verifyTurnstileToken = func(_ context.Context, secret string, token string, remoteIP string) error {
		calls = append(calls, secret+"|"+token+"|"+remoteIP)
		return errors.New("cloudflare raw failure")
	}

	missing := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/login", `{"email":"`+user.Email()+`","password":"password123"}`, "")
	if missing.Code != http.StatusBadRequest || !strings.Contains(missing.Body.String(), "TURNSTILE_REQUIRED") {
		t.Fatalf("expected missing Turnstile token to be rejected, got %d: %s", missing.Code, missing.Body.String())
	}
	if len(calls) != 0 {
		t.Fatalf("missing token should not call Siteverify, got %#v", calls)
	}

	failed := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/login", `{"email":"`+user.Email()+`","password":"password123","turnstileToken":"bad-token"}`, "")
	if failed.Code != http.StatusBadRequest || !strings.Contains(failed.Body.String(), "TURNSTILE_FAILED") {
		t.Fatalf("expected failed Turnstile token to be rejected, got %d: %s", failed.Code, failed.Body.String())
	}
	if strings.Contains(failed.Body.String(), "cloudflare raw failure") || strings.Contains(failed.Body.String(), "secret-value") {
		t.Fatalf("Turnstile failure response leaked raw upstream details: %s", failed.Body.String())
	}

	verifyTurnstileToken = func(_ context.Context, secret string, token string, remoteIP string) error {
		calls = append(calls, secret+"|"+token+"|"+remoteIP)
		return nil
	}
	success := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/auth/login", `{"email":"`+user.Email()+`","password":"password123","turnstileToken":"ok-token"}`, "", map[string]string{
		"CF-Connecting-IP": "203.0.113.9",
	})
	if success.Code != http.StatusOK {
		t.Fatalf("expected successful password login after Turnstile, got %d: %s", success.Code, success.Body.String())
	}
	if calls[len(calls)-1] != "secret-value|ok-token|203.0.113.9" {
		t.Fatalf("expected Siteverify to receive secret, token and remote IP, got %#v", calls)
	}
}
