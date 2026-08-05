package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

const (
	appSessionTTL     = 30 * 24 * time.Hour
	mfaAuthTicketTTL  = 5 * time.Minute
	appSessionTokenN  = 32
	mfaTicketTokenN   = 32
	appSessionHashLen = 43
	// Docker/Go 与 Worker 共享 15 分钟审计写入窗口；这些字段不参与授权，不能因为节流改变 session/token 有效性。
	auditTouchInterval = 15 * time.Minute
)

// 本文件只签发 Renewlet 产品 session；PocketBase 原生 JWT 仅作为账号事实源存在，不能恢复为浏览器 bearer。
// appAuthMiddleware 是 Renewlet 产品 API 的唯一登录态边界。
// 它把产品 session token 提升成 e.Auth，避免前端继续依赖 PocketBase 原生 JWT 绕过 MFA。
func appAuthMiddleware(app core.App) *hook.Handler[*core.RequestEvent] {
	return &hook.Handler[*core.RequestEvent]{
		Func: func(e *core.RequestEvent) error {
			locale := requestLocale(e.Request)
			token := bearerTokenFromHeader(e.Request.Header.Get("Authorization"))
			if token == "" {
				return e.UnauthorizedError(serverText(locale, "auth.loginRequired"), nil)
			}
			user, session, err := appAuthRecordByToken(app, token)
			if err != nil || user == nil || session == nil {
				return e.UnauthorizedError(serverText(locale, "auth.sessionExpired"), err)
			}
			if user.GetBool("banned") {
				return e.UnauthorizedError(localizedDisabledBanReason(locale), nil)
			}
			now := time.Now().UTC()
			if shouldTouchAuditTimestamp(session.GetString("lastSeenAt"), now) {
				// lastSeenAt 只是会话活跃审计，不参与授权或续期；节流写入避免所有只读 API 都放大成 SQLite write。
				session.Set("lastSeenAt", now.Format(time.RFC3339Nano))
				if err := app.Save(session); err != nil {
					return e.InternalServerError(serverText(locale, "common.internalError"), err)
				}
			}
			e.Auth = user
			return e.Next()
		},
	}
}

func handleAuthLogin(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[loginRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	user, err := app.FindAuthRecordByEmail("users", body.Email)
	if err != nil || !user.ValidatePassword(body.Password) {
		return e.BadRequestError(serverText(locale, "auth.invalidEmailOrPassword"), err)
	}
	if user.GetBool("banned") {
		return e.ForbiddenError(localizedDisabledBanReason(locale), nil)
	}
	if _, _, err := ensureSettingsRecord(app, user.Id, locale); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	methods, err := authenticatorMfaMethodsForUser(app, user.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if len(methods) > 0 {
		// MFA 用户密码正确后只签短期 ticket；未完成第二因素前不能创建产品 session 或 PB JWT。
		ticket, expiresAt, err := createMfaAuthTicket(app, user.Id, methods)
		if err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		return apiSuccessJSON(e, 200, mfaRequiredResponse{
			Type:      "mfa_required",
			TicketID:  ticket,
			ExpiresAt: expiresAt,
			Methods:   methods,
		})
	}
	response, err := createAppSessionResponse(app, user)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, 200, response)
}

func handleAuthSession(app core.App, e *core.RequestEvent) error {
	token := bearerTokenFromHeader(e.Request.Header.Get("Authorization"))
	user, session, err := appAuthRecordByToken(app, token)
	if err != nil || user == nil || session == nil {
		return e.UnauthorizedError(serverText(requestLocale(e.Request), "auth.sessionExpired"), err)
	}
	return apiSuccessJSON(e, 200, sessionResponseFromRecord(token, session.GetString("expiresAt"), user))
}

func handleAuthLogout(app core.App, e *core.RequestEvent) error {
	token := bearerTokenFromHeader(e.Request.Header.Get("Authorization"))
	if token != "" {
		_ = deleteAppSessionByToken(app, token)
	}
	return apiEmptySuccessJSON(e, 200)
}

func handleMFAVerify(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[mfaVerifyRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	response, err := verifyLoginMFA(app, e.Request, body)
	if err != nil {
		// ticket 过期、方法不匹配和 OTP/恢复码错误统一为 sessionExpired，避免枚举认证器状态。
		return e.UnauthorizedError(serverText(locale, "auth.sessionExpired"), nil)
	}
	return apiSuccessJSON(e, 200, response)
}

func handleMFAStatus(app core.App, e *core.RequestEvent) error {
	status, err := mfaStatusForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	return apiSuccessJSON(e, 200, status)
}

func handleMFATOTPSetup(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	response, err := startTOTPSetup(app, e.Auth)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, 200, response)
}

func handleMFATOTPEnable(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[mfaTotpEnableRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !e.Auth.ValidatePassword(body.CurrentPassword) {
		return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
	}
	response, err := enableTOTP(app, e.Auth, body.SetupID, body.Code)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	return apiSuccessJSON(e, 200, response)
}

func handleMFARecoveryRegenerate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[mfaCurrentPasswordRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !e.Auth.ValidatePassword(body.CurrentPassword) {
		return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
	}
	enabled, _, err := authenticatorMfaEnabledForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if !enabled {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	response, err := regenerateRecoveryCodesForCurrentUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeys(app core.App, e *core.RequestEvent) error {
	response, err := listPasskeysForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeyRegisterOptions(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[passkeyRegisterOptionsRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !e.Auth.ValidatePassword(body.CurrentPassword) {
		return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
	}
	response, err := startPasskeyRegistration(app, e.Request, e.Auth)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeyRegisterVerify(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[passkeyRegisterVerifyRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	response, err := finishPasskeyRegistration(app, e.Request, e.Auth, body.ChallengeID, body.Name, body.Response)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeyAuthenticateOptions(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if _, err := decodeStrictJSON[passkeyAuthenticateOptionsRequest](e.Request, locale); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	// Passkey options 只创建无用户认证前 challenge；这里失败说明 WebAuthn/账号安全初始化不可用，不是 session 过期。
	response, err := startPasskeyAuthentication(app, e.Request)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeyAuthenticateVerify(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[passkeyAuthenticateVerifyRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	response, err := finishPasskeyAuthentication(app, e.Request, body.ChallengeID, body.Response)
	if err != nil {
		return e.UnauthorizedError(serverText(locale, "auth.sessionExpired"), nil)
	}
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeyDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[mfaCurrentPasswordRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !e.Auth.ValidatePassword(body.CurrentPassword) {
		return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
	}
	response, err := deletePasskeyCredential(app, e.Auth.Id, e.Request.PathValue("id"))
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	return apiSuccessJSON(e, 200, response)
}

func handleMFADisable(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[mfaCurrentPasswordRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !e.Auth.ValidatePassword(body.CurrentPassword) {
		return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
	}
	response, err := disableAuthenticatorMFAForCurrentUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, 200, response)
}

func createAppSessionResponse(app core.App, user *core.Record) (sessionResponse, error) {
	token, session, err := createAppSession(app, user.Id)
	if err != nil {
		return sessionResponse{}, err
	}
	return sessionResponseFromRecord(token, session.GetString("expiresAt"), user), nil
}

func createAppSession(app core.App, userID string) (string, *core.Record, error) {
	collection, err := app.FindCollectionByNameOrId("app_sessions")
	if err != nil {
		return "", nil, err
	}
	token := randomURLToken(appSessionTokenN)
	now := time.Now().UTC()
	session := core.NewRecord(collection)
	session.Set("user", userID)
	// 明文 token 只返回给浏览器；PocketBase collection 只保存 hash，数据库泄漏不能直接接管登录态。
	session.Set("tokenHash", tokenHash(token))
	session.Set("expiresAt", now.Add(appSessionTTL).Format(time.RFC3339Nano))
	session.Set("lastSeenAt", now.Format(time.RFC3339Nano))
	if err := app.Save(session); err != nil {
		return "", nil, err
	}
	return token, session, nil
}

func renewAccountSecuritySession(app core.App, userID string) (sessionResponse, error) {
	user, err := app.FindRecordById("users", userID)
	if err != nil {
		return sessionResponse{}, err
	}
	// 自助账号安全操作采用“续签当前浏览器”：PB tokenKey 废掉原生 JWT，产品新 session 保留，其它 bearer 全部失效。
	user.RefreshTokenKey()
	if err := app.Save(user); err != nil {
		return sessionResponse{}, err
	}
	token, session, err := createAppSession(app, userID)
	if err != nil {
		return sessionResponse{}, err
	}
	if err := deleteAppSessionsForUserExcept(app, userID, session.Id); err != nil {
		return sessionResponse{}, err
	}
	if err := deleteRecordsByFilter(app, "mfa_auth_tickets", "user = {:user}", dbx.Params{"user": userID}); err != nil {
		return sessionResponse{}, err
	}
	return sessionResponseFromRecord(token, session.GetString("expiresAt"), user), nil
}

func appAuthRecordByToken(app core.App, token string) (*core.Record, *core.Record, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, nil, sql.ErrNoRows
	}
	session, err := app.FindFirstRecordByFilter(
		"app_sessions",
		"tokenHash = {:hash} && expiresAt > {:now}",
		dbx.Params{"hash": tokenHash(token), "now": nowString()},
	)
	if err != nil {
		return nil, nil, err
	}
	user, err := app.FindRecordById("users", session.GetString("user"))
	if err != nil {
		return nil, nil, err
	}
	return user, session, nil
}

func deleteAppSessionByToken(app core.App, token string) error {
	session, err := app.FindFirstRecordByFilter("app_sessions", "tokenHash = {:hash}", dbx.Params{"hash": tokenHash(token)})
	if err != nil {
		return err
	}
	return app.Delete(session)
}

func deleteAppSessionsForUser(app core.App, userID string) error {
	return deleteAppSessionsForUserExcept(app, userID, "")
}

func deleteAppSessionsForUserExcept(app core.App, userID string, keepSessionID string) error {
	params := dbx.Params{"user": userID}
	filter := "user = {:user}"
	if strings.TrimSpace(keepSessionID) != "" {
		filter += " && id != {:keep}"
		params["keep"] = keepSessionID
	}
	for {
		sessions, err := app.FindRecordsByFilter("app_sessions", filter, "", 200, 0, params)
		if err != nil {
			return err
		}
		if len(sessions) == 0 {
			return nil
		}
		for _, session := range sessions {
			if err := app.Delete(session); err != nil {
				return err
			}
		}
	}
}

func sessionResponseFromRecord(token string, expiresAt string, user *core.Record) sessionResponse {
	return sessionResponse{
		Type: "session",
		Session: appSessionTokenResponse{
			ID:        token,
			ExpiresAt: expiresAt,
		},
		User: authUserResponse{
			ID:     user.Id,
			Email:  user.Email(),
			Name:   user.GetString("name"),
			Role:   normalizeRole(user.GetString("role")),
			Banned: user.GetBool("banned"),
		},
	}
}

func createMfaAuthTicket(app core.App, userID string, methods []string) (string, string, error) {
	return createMfaTicketRecord(app, userID, methods, "")
}

func bearerTokenFromHeader(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	const prefix = "Bearer "
	if strings.HasPrefix(value, prefix) {
		return strings.TrimSpace(strings.TrimPrefix(value, prefix))
	}
	return ""
}

func randomURLToken(size int) string {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func nowString() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// 审计时间戳缺失或损坏时必须修复；只有可信 RFC3339Nano 且仍新鲜的值才能跳过写库。
func shouldTouchAuditTimestamp(value string, now time.Time) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return true
	}
	lastTouchedAt, err := time.Parse(time.RFC3339Nano, trimmed)
	if err != nil {
		return true
	}
	return now.UTC().Sub(lastTouchedAt.UTC()) >= auditTouchInterval
}
