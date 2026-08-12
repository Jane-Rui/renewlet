package main

// subscription_routes.go 承载绕过 PocketBase SDK 形状的订阅专用 API。
//
// 这里输出前端稳定 DTO，并把手动续订限制在当前 owner、非自动续订、非 one-time 订阅上。
import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type subscriptionResponse struct {
	Subscription map[string]interface{} `json:"subscription"`
}

// handleSubscriptionRenew 按用户选择延续或重开当前订阅；Renewlet 只更新账本状态，不生成付款流水。
func handleSubscriptionRenew(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[subscriptionRenewRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	subscriptionID := strings.TrimSpace(e.Request.PathValue("id"))
	// 手动续订是认证用户的写入边界；查询同时带 id 和 user，避免通过错误码枚举他人订阅。
	record, err := app.FindFirstRecordByFilter(
		"subscriptions",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": subscriptionID, "user": e.Auth.Id},
	)
	if err != nil || record == nil {
		return e.NotFoundError("SUBSCRIPTION_NOT_FOUND", err)
	}
	today := todayDateOnly(time.Now(), currentUserSettingsTimezone(app, e.Auth))
	input := subscriptionRenewalInputFromRecord(record)
	if !isManualRenewEligible(input) {
		return e.BadRequestError("SUBSCRIPTION_RENEW_NOT_ALLOWED", nil)
	}
	record.Set("price", body.Price)
	record.Set("currency", body.Currency)
	if body.Mode == "continue" {
		// continue 的日期字段只服务显式契约和前端预览；真正推进必须沿原订阅锚点，避免把续订误写成重开。
		result, ok, err := advanceSubscriptionRenewal(input, today, renewalModeManual)
		if err != nil {
			return e.BadRequestError(err.Error(), err)
		}
		if !ok {
			return e.BadRequestError("SUBSCRIPTION_RENEW_NOT_ALLOWED", nil)
		}
		record.Set("nextBillingDate", result.NextBillingDate)
		record.Set("status", result.Status)
	} else {
		// restart 改变开始日和收款周期边界；Save 会进入 PocketBase hook，重新校验日期、家庭共享镜像和派生状态。
		record.Set("startDate", body.StartDate.Value)
		record.Set("nextBillingDate", body.NextBillingDate)
		record.Set("autoCalculateNextBillingDate", body.AutoCalculateNextBillingDate)
		if record.GetString("status") == "expired" {
			record.Set("status", "active")
		}
	}
	if err := app.Save(record); err != nil {
		return e.BadRequestError("SUBSCRIPTION_RENEW_FAILED", err)
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionResponse{Subscription: subscriptionAPIFromRecord(record)})
}

func subscriptionAPIFromRecord(record *core.Record) map[string]interface{} {
	billingCycle := record.GetString("billingCycle")
	// API 形状与前端 Zod/shared 契约对齐；PocketBase 原始字段名和 nil JSON 不直接透出。
	out := map[string]interface{}{
		"id":                           record.Id,
		"name":                         record.GetString("name"),
		"price":                        moneyForRecord(record.Get("price")),
		"currency":                     record.GetString("currency"),
		"billingCycle":                 billingCycle,
		"category":                     record.GetString("category"),
		"status":                       record.GetString("status"),
		"pinned":                       record.GetBool("pinned"),
		"publicHidden":                 record.GetBool("publicHidden"),
		"startDate":                    nullableStringForResponse(record.GetString("startDate")),
		"nextBillingDate":              record.GetString("nextBillingDate"),
		"autoRenew":                    billingCycle != "one-time" && record.GetBool("autoRenew"),
		"autoCalculateNextBillingDate": record.GetBool("autoCalculateNextBillingDate"),
		"tags":                         jsonValueForResponse(record.Get("tags"), []string{}),
		"reminderDays":                 record.GetInt("reminderDays"),
		"repeatReminderEnabled":        record.GetBool("repeatReminderEnabled"),
		"repeatReminderInterval":       normalizeRepeatReminderInterval(record.GetString("repeatReminderInterval")),
		"repeatReminderWindow":         normalizeRepeatReminderWindow(record.GetString("repeatReminderWindow")),
		"extra":                        jsonValueForResponse(record.Get("extra"), map[string]interface{}{}),
	}
	if costSharing := jsonValueForResponse(record.Get("costSharing"), map[string]interface{}{}); nonEmptyJSONMap(costSharing) {
		out["costSharing"] = costSharing
	}
	if value := strings.TrimSpace(record.GetString("logo")); value != "" {
		out["logo"] = value
	}
	if billingCycle == "custom" {
		out["customDays"] = maxInt(1, record.GetInt("customDays"))
		out["customCycleUnit"] = normalizeCustomCycleUnit(record.GetString("customCycleUnit"))
	}
	if billingCycle == "one-time" && record.GetInt("oneTimeTermCount") > 0 {
		out["oneTimeTermCount"] = record.GetInt("oneTimeTermCount")
		out["oneTimeTermUnit"] = normalizeCustomCycleUnit(record.GetString("oneTimeTermUnit"))
	}
	for _, field := range []string{"paymentMethod", "trialEndDate", "website", "notes"} {
		if value := strings.TrimSpace(record.GetString(field)); value != "" {
			out[field] = value
		}
	}
	if !record.GetDateTime("created").IsZero() {
		out["createdAt"] = record.GetDateTime("created").Time().UTC().Format(time.RFC3339Nano)
	}
	if !record.GetDateTime("updated").IsZero() {
		out["updatedAt"] = record.GetDateTime("updated").Time().UTC().Format(time.RFC3339Nano)
	}
	return out
}

func nullableStringForResponse(value string) interface{} {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func nonEmptyJSONMap(value interface{}) bool {
	object, ok := value.(map[string]interface{})
	return ok && len(object) > 0
}

func jsonValueForResponse(value interface{}, fallback interface{}) interface{} {
	// PocketBase JSON 字段可能以字符串、[]byte 或 nil 形态出现；响应边界统一兜底成前端可解析结构。
	data, err := jsonBytesFromValue(value)
	if err != nil || len(data) == 0 {
		return fallback
	}
	var decoded interface{}
	if err := json.Unmarshal(data, &decoded); err != nil || decoded == nil {
		return fallback
	}
	return decoded
}

func currentUserSettingsTimezone(app core.App, user *core.Record) string {
	settings, err := currentUserSettings(app, user, nil)
	if err != nil {
		return defaultAppSettings().Timezone
	}
	return settings.Timezone
}
