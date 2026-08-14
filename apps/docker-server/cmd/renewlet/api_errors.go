package main

import (
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	pbrouter "github.com/pocketbase/pocketbase/tools/router"
)

type apiErrorEnvelope struct {
	Error apiErrorBody `json:"error"`
}

type apiErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Details   any    `json:"details,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

// apiErrorMiddleware 只挂在 Renewlet 产品 API 上；PocketBase Admin UI 和静态资源继续使用平台原生响应。
func apiErrorMiddleware(e *core.RequestEvent) error {
	err := e.Next()
	if err == nil || e.Written() {
		return err
	}
	apiErr := pbrouter.ToApiError(err)
	var details any
	if len(apiErr.Data) > 0 {
		details = apiErr.Data
	}
	return apiErrorJSON(e, apiErr.Status, defaultAPIErrorCode(apiErr.Status), apiErr.Message, details)
}

// apiErrorJSON 是 Docker/Go 产品 API 的唯一错误 envelope 出口；route 不应手写 map 或扁平 message/code。
func apiErrorJSON(e *core.RequestEvent, status int, code string, message string, details any) error {
	if code == "" {
		code = defaultAPIErrorCode(status)
	}
	return e.JSON(status, apiErrorEnvelope{
		Error: apiErrorBody{
			Code:    code,
			Message: message,
			Details: details,
		},
	})
}

func defaultAPIErrorCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "INVALID_PAYLOAD"
	case http.StatusUnauthorized:
		return "UNAUTHORIZED"
	case http.StatusForbidden:
		return "FORBIDDEN"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusMethodNotAllowed:
		return "METHOD_NOT_ALLOWED"
	case http.StatusConflict:
		return "CONFLICT"
	case http.StatusRequestEntityTooLarge:
		return "BODY_TOO_LARGE"
	case http.StatusUnprocessableEntity:
		return "VALIDATION_ERROR"
	case http.StatusTooManyRequests:
		return "RATE_LIMITED"
	case http.StatusBadGateway:
		return "UPSTREAM_FAILED"
	default:
		return "INTERNAL_ERROR"
	}
}

type apiRouteContract struct {
	Path    string
	Methods []string
}

// 这张表只服务 API catch-all 的 404/405 判断；新增产品 route 时必须同步，避免错误方法退化成 404。
var productAPIRouteContracts = []apiRouteContract{
	{Path: "/api/app/health", Methods: []string{http.MethodGet}},
	{Path: "/api/app/ready", Methods: []string{http.MethodGet}},
	{Path: "/api/app/status", Methods: []string{http.MethodGet}},
	{Path: "/api/app/setup", Methods: []string{http.MethodGet, http.MethodPost}},
	{Path: "/api/public/status/{token}", Methods: []string{http.MethodGet}},
	{Path: "/api/public/status/{token}/assets/{assetId}", Methods: []string{http.MethodGet}},
	{Path: "/api/public/v1/me", Methods: []string{http.MethodGet}},
	{Path: "/api/public/v1/subscriptions", Methods: []string{http.MethodGet}},
	{Path: "/api/public/v1/subscriptions/{id}", Methods: []string{http.MethodGet}},
	{Path: "/api/public/v1/status", Methods: []string{http.MethodGet}},
	{Path: "/api/public/v1/due", Methods: []string{http.MethodGet}},
	{Path: "/api/telegram/webhook/{bindingId}", Methods: []string{http.MethodPost}},
	{Path: "/calendar/renewals.ics", Methods: []string{http.MethodGet}},
	{Path: "/api/cron/notifications", Methods: []string{http.MethodGet}},
	{Path: "/api/app/auth/login", Methods: []string{http.MethodPost}},
	{Path: "/api/app/auth/session", Methods: []string{http.MethodGet}},
	{Path: "/api/app/auth/logout", Methods: []string{http.MethodPost}},
	{Path: "/api/app/auth/mfa/verify", Methods: []string{http.MethodPost}},
	{Path: "/api/app/auth/passkeys/authenticate/options", Methods: []string{http.MethodPost}},
	{Path: "/api/app/auth/passkeys/authenticate/verify", Methods: []string{http.MethodPost}},
	{Path: "/api/app/admin/users", Methods: []string{http.MethodGet, http.MethodPost}},
	{Path: "/api/app/admin/users/{id}", Methods: []string{http.MethodPatch, http.MethodDelete}},
	{Path: "/api/app/admin/users/{id}/mfa/reset", Methods: []string{http.MethodPost}},
	{Path: "/api/app/admin/users/{id}/passkeys/reset", Methods: []string{http.MethodPost}},
	{Path: "/api/app/admin/system/update", Methods: []string{http.MethodPost}},
	{Path: "/api/app/admin/system/update/status", Methods: []string{http.MethodGet}},
	{Path: "/api/app/admin/system/restart", Methods: []string{http.MethodPost}},
	{Path: "/api/app/admin/auth-security", Methods: []string{http.MethodGet, http.MethodPut}},
	{Path: "/api/app/admin/media/icon-index", Methods: []string{http.MethodGet}},
	{Path: "/api/app/admin/media/icon-index/providers/{provider}/check", Methods: []string{http.MethodPost}},
	{Path: "/api/app/admin/media/icon-index/providers/{provider}/refresh", Methods: []string{http.MethodPost}},
	{Path: "/api/app/system/version", Methods: []string{http.MethodGet}},
	{Path: "/api/app/account/password", Methods: []string{http.MethodPut}},
	{Path: "/api/app/account/password-reset/status", Methods: []string{http.MethodGet}},
	{Path: "/api/app/auth/mfa/status", Methods: []string{http.MethodGet}},
	{Path: "/api/app/auth/mfa/totp/setup", Methods: []string{http.MethodPost}},
	{Path: "/api/app/auth/mfa/totp/enable", Methods: []string{http.MethodPost}},
	{Path: "/api/app/auth/mfa/recovery/regenerate", Methods: []string{http.MethodPost}},
	{Path: "/api/app/auth/mfa/disable", Methods: []string{http.MethodPost}},
	{Path: "/api/app/auth/passkeys", Methods: []string{http.MethodGet}},
	{Path: "/api/app/auth/passkeys/register/options", Methods: []string{http.MethodPost}},
	{Path: "/api/app/auth/passkeys/register/verify", Methods: []string{http.MethodPost}},
	{Path: "/api/app/auth/passkeys/{id}/delete", Methods: []string{http.MethodPost}},
	{Path: "/api/app/notifications/test", Methods: []string{http.MethodPost}},
	{Path: "/api/app/notifications/history", Methods: []string{http.MethodGet}},
	{Path: "/api/app/notifications/run", Methods: []string{http.MethodPost}},
	{Path: "/api/app/import/preview", Methods: []string{http.MethodPost}},
	{Path: "/api/app/import/apply", Methods: []string{http.MethodPost}},
	{Path: "/api/app/cloud-backup/config", Methods: []string{http.MethodGet, http.MethodPut}},
	{Path: "/api/app/cloud-backup/test", Methods: []string{http.MethodPost}},
	{Path: "/api/app/cloud-backups", Methods: []string{http.MethodGet, http.MethodPost}},
	{Path: "/api/app/cloud-backups/{id}/download", Methods: []string{http.MethodGet}},
	{Path: "/api/app/cloud-backups/{id}", Methods: []string{http.MethodDelete}},
	{Path: "/api/app/ai/subscriptions/recognize/stream", Methods: []string{http.MethodPost}},
	{Path: "/api/app/ai/subscriptions/recognize", Methods: []string{http.MethodPost}},
	{Path: "/api/app/ai/subscriptions/test", Methods: []string{http.MethodPost}},
	{Path: "/api/app/ai/models/list", Methods: []string{http.MethodPost}},
	{Path: "/api/app/api-tokens", Methods: []string{http.MethodGet, http.MethodPost}},
	{Path: "/api/app/api-tokens/{id}", Methods: []string{http.MethodDelete}},
	{Path: "/api/app/telegram-bot/commands", Methods: []string{http.MethodGet, http.MethodPost, http.MethodDelete}},
	{Path: "/api/app/settings", Methods: []string{http.MethodGet, http.MethodPut}},
	{Path: "/api/app/custom-config", Methods: []string{http.MethodGet, http.MethodPut}},
	{Path: "/api/app/subscriptions", Methods: []string{http.MethodGet, http.MethodPost}},
	{Path: "/api/app/subscriptions/{id}", Methods: []string{http.MethodPatch, http.MethodDelete}},
	{Path: "/api/app/subscriptions/{id}/renew", Methods: []string{http.MethodPost}},
	{Path: "/api/app/subscriptions/{id}/calendar.ics", Methods: []string{http.MethodGet}},
	{Path: "/api/app/subscriptions/{id}/calendar-feed", Methods: []string{http.MethodGet, http.MethodPost, http.MethodDelete}},
	{Path: "/api/app/assets", Methods: []string{http.MethodGet, http.MethodPost}},
	{Path: "/api/app/assets/{id}", Methods: []string{http.MethodGet, http.MethodDelete}},
	{Path: "/api/app/calendar-feed", Methods: []string{http.MethodGet, http.MethodPost, http.MethodDelete}},
	{Path: "/api/app/public-status-page", Methods: []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodDelete}},
	{Path: "/api/app/media/candidates", Methods: []string{http.MethodPost}},
}

// API catch-all 只覆盖 Renewlet 产品 API 前缀和公开 feed，不接管 PocketBase Admin UI 或嵌入式静态资源。
func registerAPIFallbacks(api *pbrouter.RouterGroup[*core.RequestEvent]) {
	api.Any("/api/app", apiFallbackError)
	api.Any("/api/app/{path...}", apiFallbackError)
	api.Any("/api/public", apiFallbackError)
	api.Any("/api/public/{path...}", apiFallbackError)
	api.Any("/api/telegram", apiFallbackError)
	api.Any("/api/telegram/{path...}", apiFallbackError)
	api.Any("/api/cron", apiFallbackError)
	api.Any("/api/cron/{path...}", apiFallbackError)
	api.Any("/calendar/renewals.ics", apiFallbackError)
}

func apiFallbackError(e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if productAPIPathAllowsDifferentMethod(e.Request.URL.Path, e.Request.Method) {
		return apiErrorJSON(e, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", serverText(locale, "common.methodNotAllowed"), nil)
	}
	return apiErrorJSON(e, http.StatusNotFound, "NOT_FOUND", serverText(locale, "common.notFound"), nil)
}

func productAPIPathAllowsDifferentMethod(path string, method string) bool {
	for _, route := range productAPIRouteContracts {
		if !apiPathMatches(route.Path, path) {
			continue
		}
		for _, allowed := range route.Methods {
			if method == allowed || (method == http.MethodHead && allowed == http.MethodGet) {
				return false
			}
		}
		return true
	}
	return false
}

func apiPathMatches(pattern string, path string) bool {
	patternSegments := apiPathSegments(pattern)
	pathSegments := apiPathSegments(path)
	if len(patternSegments) != len(pathSegments) {
		return false
	}
	for i, segment := range patternSegments {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			continue
		}
		if segment != pathSegments[i] {
			return false
		}
	}
	return true
}

func apiPathSegments(path string) []string {
	return strings.Split(strings.Trim(path, "/"), "/")
}
