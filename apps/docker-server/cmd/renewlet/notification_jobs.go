package main

// notification_jobs.go 持久化通知任务、渠道重试状态和历史 DTO。
//
// 架构位置：notification_jobs 是调度幂等、失败重试和前端历史页面的共同事实来源。
// result 字段写入强类型 payload，但输出时保留 RawMessage，让前端 union schema 精确区分空结果和 cron 结果。
//
// 注意： 唯一索引冲突被视为并发执行已抢占；修改这里的错误处理会直接影响重复发送保护。
import (
	"bytes"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func getNotificationJob(app core.App, userID, localDate, localTime, timezone string) (*core.Record, error) {
	// 这组字段与 notification_jobs 唯一索引一致，是调度幂等的查找边界。
	return app.FindFirstRecordByFilter(
		"notification_jobs",
		"user = {:user} && scheduledLocalDate = {:date} && scheduledLocalTime = {:time} && timeZone = {:tz}",
		dbx.Params{"user": userID, "date": localDate, "time": localTime, "tz": timezone},
	)
}

// createNotificationJob 创建通知任务并返回是否由本次调用创建。
// 注意： 唯一索引冲突被视为“其他并发执行已创建”，调用方应跳过本用户。
func createNotificationJob(app core.App, userID string, schedule localScheduleDecision, status string, attempts int) (*core.Record, bool, error) {
	if existing, err := getNotificationJob(app, userID, schedule.ScheduledLocalDate, schedule.ScheduledLocalTime, schedule.TimeZone); err == nil && existing != nil {
		return existing, false, nil
	}
	collection, err := app.FindCollectionByNameOrId("notification_jobs")
	if err != nil {
		return nil, false, err
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("scheduledLocalDate", schedule.ScheduledLocalDate)
	record.Set("scheduledLocalTime", schedule.ScheduledLocalTime)
	record.Set("timeZone", schedule.TimeZone)
	record.Set("scheduledInstantUtc", schedule.ScheduledInstantUTC)
	record.Set("status", status)
	record.Set("attempts", attempts)
	record.Set("lastError", "")
	record.Set("result", emptyJSONPayload{})
	if err := app.Save(record); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return nil, false, nil
		}
		return nil, false, err
	}
	return record, true, nil
}

func markNotificationJobSending(app core.App, record *core.Record, attempts int) error {
	record.Set("status", notificationStatusSending)
	record.Set("attempts", attempts)
	record.Set("lastError", "")
	return app.Save(record)
}

// finalizeNotificationJob 写入任务最终状态和严格 result。
func finalizeNotificationJob(app core.App, record *core.Record, userID string, schedule localScheduleDecision, status string, lastError string, result notificationJobResult) error {
	if record == nil {
		existing, err := getNotificationJob(app, userID, schedule.ScheduledLocalDate, schedule.ScheduledLocalTime, schedule.TimeZone)
		if err == nil {
			record = existing
		}
	}
	if record == nil {
		created, _, err := createNotificationJob(app, userID, schedule, status, 1)
		if err != nil {
			return err
		}
		record = created
	}
	record.Set("status", status)
	record.Set("lastError", lastError)
	record.Set("result", result)
	return app.Save(record)
}

// createJobResult 构造历史面板可解析的 cron result。
// 注意： 新增字段时必须同步前端 cronJobResultResponseSchema。
func createJobResult(reason string, schedule localScheduleOccurrence, settings appSettings, locale appLocale, due notificationMessage, options notificationCronOptions, channels jobChannels) notificationJobResult {
	var reasonValue *string
	if reason != "" {
		reasonValue = &reason
	}
	return normalizeNotificationJobResult(notificationJobResult{
		Source:         "cron",
		Reason:         reasonValue,
		Force:          options.Force,
		WindowMinutes:  options.WindowMinutes,
		TriggeredAtUTC: options.Now.UTC().Format(time.RFC3339),
		Schedule:       schedule,
		Settings: notificationJobResultSettings{
			Timezone:              settings.Timezone,
			Locale:                string(locale),
			NotificationTimeLocal: settings.NotificationTimeLocal,
			EnabledChannels:       settings.EnabledChannels,
			ShowExpired:           settings.ShowExpired,
		},
		Message: notificationJobResultMessage{
			Title:      due.Title,
			Content:    due.Content,
			Timestamp:  due.Timestamp,
			HasPayload: due.HasPayload,
			Items:      due.Items,
		},
		Channels: channels,
	})
}

// readJobChannels 从历史 result 中读取渠道状态，用于失败重试合并。
func readJobChannels(record *core.Record) jobChannels {
	var result notificationJobResult
	if err := decodeJSONRecordField(record, "result", &result); err != nil {
		return normalizeJobChannels(jobChannels{})
	}
	if result.Source != "cron" {
		return normalizeJobChannels(jobChannels{})
	}
	return normalizeJobChannels(result.Channels)
}

// normalizeJobChannels 保证渠道集合输出稳定为 JSON array，而不是 nil slice 对应的 null。
func normalizeJobChannels(channels jobChannels) jobChannels {
	failedByChannel := map[string]string{}
	for _, failure := range channels.Failed {
		channel := strings.TrimSpace(failure.Channel)
		if _, ok := knownChannels[channel]; !ok {
			continue
		}
		// 同一渠道只保留最后一次错误，防止历史 result 因多次重试无限膨胀。
		failedByChannel[channel] = failure.Error
	}
	failed := make([]channelFailure, 0, len(failedByChannel))
	for channel, errText := range failedByChannel {
		// notification_jobs 是 cron 审计数据，只保存短摘要；上游 raw response 只能留在手动 API 的当前响应里。
		failed = append(failed, channelFailure{Channel: channel, Error: errText})
	}
	sort.Slice(failed, func(i, j int) bool { return failed[i].Channel < failed[j].Channel })
	return jobChannels{
		Attempted: uniqueValidChannels(channels.Attempted),
		Succeeded: uniqueValidChannels(channels.Succeeded),
		Failed:    failed,
	}
}

// normalizeNotificationJobResult 是通知历史 result 的唯一输出契约收敛点。
func normalizeNotificationJobResult(result notificationJobResult) notificationJobResult {
	result.Settings.EnabledChannels = uniqueValidChannels(result.Settings.EnabledChannels)
	if result.Message.Items == nil {
		result.Message.Items = []notificationContentItem{}
	}
	result.Channels = normalizeJobChannels(result.Channels)
	return result
}

// channelsToSend 返回本轮实际需要发送的渠道。
// 对失败重试只发送仍启用且上次失败的渠道，防止成功渠道重复通知。
func channelsToSend(existing *core.Record, previous jobChannels, enabled []string) []string {
	if existing != nil && existing.GetString("status") == notificationStatusFailed {
		enabledSet := map[string]struct{}{}
		for _, channel := range enabled {
			enabledSet[channel] = struct{}{}
		}
		out := []string{}
		for _, failure := range previous.Failed {
			if _, ok := enabledSet[failure.Channel]; ok {
				out = append(out, failure.Channel)
			}
		}
		return uniqueValidChannels(out)
	}
	return enabled
}

// mergeChannelResults 合并历史渠道结果和本轮发送结果。
// 已成功渠道优先，已禁用渠道的失败记录会被丢弃，避免历史错误阻塞新设置。
func mergeChannelResults(previous jobChannels, summary sendSummary, enabled []string) jobChannels {
	sentThisRun := map[string]struct{}{}
	for _, channel := range summary.Attempted {
		sentThisRun[channel] = struct{}{}
	}
	succeeded := uniqueValidChannels(append(previous.Succeeded, summary.Succeeded...))
	succeededSet := map[string]struct{}{}
	for _, channel := range succeeded {
		succeededSet[channel] = struct{}{}
	}
	enabledSet := map[string]struct{}{}
	for _, channel := range enabled {
		enabledSet[channel] = struct{}{}
	}
	failures := map[string]string{}
	for _, failure := range previous.Failed {
		if _, ok := enabledSet[failure.Channel]; !ok {
			continue
		}
		if _, ok := sentThisRun[failure.Channel]; ok {
			continue
		}
		if _, ok := succeededSet[failure.Channel]; ok {
			continue
		}
		failures[failure.Channel] = failure.Error
	}
	for _, failure := range summary.Failed {
		if _, ok := succeededSet[failure.Channel]; ok {
			continue
		}
		failures[failure.Channel] = failure.Error
	}
	failed := make([]channelFailure, 0, len(failures))
	for channel, errText := range failures {
		// merge 结果会进入 cron history，必须丢弃手动/本轮发送捕获的 raw details。
		failed = append(failed, channelFailure{Channel: channel, Error: errText})
	}
	sort.Slice(failed, func(i, j int) bool { return failed[i].Channel < failed[j].Channel })
	return jobChannels{
		Attempted: uniqueValidChannels(append(previous.Attempted, summary.Attempted...)),
		Succeeded: succeeded,
		Failed:    failed,
	}
}

func decodeJSONRecordField(record *core.Record, field string, target interface{}) error {
	value := record.Get(field)
	switch v := value.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return nil
		}
		return json.Unmarshal([]byte(v), target)
	case []byte:
		if len(bytes.TrimSpace(v)) == 0 {
			return nil
		}
		return json.Unmarshal(v, target)
	default:
		// PocketBase JSON 字段在 hooks/routes/tests 中可能是 map、struct 或 RawMessage；统一 marshal 后再解码到目标类型。
		data, err := json.Marshal(v)
		if err != nil {
			return err
		}
		return json.Unmarshal(data, target)
	}
}

// summarizeCronResult 汇总单次 cron 执行结果。
func summarizeCronResult(options notificationCronOptions, results []notificationCronUserResult) notificationCronResult {
	out := notificationCronResult{
		NowUTC:    options.Now.UTC().Format(time.RFC3339),
		Force:     options.Force,
		DryRun:    options.DryRun,
		Processed: len(results),
		Results:   results,
	}
	for _, result := range results {
		switch result.Action {
		case "sent":
			out.Sent++
		case "failed":
			out.Failed++
		case "skipped":
			out.Skipped++
		}
	}
	return out
}

func latestNotificationJob(app core.App, userID string, status string) (*core.Record, error) {
	filter := "user = {:user}"
	params := dbx.Params{"user": userID}
	if status != "" {
		filter += " && status = {:status}"
		params["status"] = status
	}
	rows, err := app.FindRecordsByFilter("notification_jobs", filter, "-scheduledInstantUtc,-created", 1, 0, params)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

func recordsToHistoryJobs(records []*core.Record) []notificationHistoryJob {
	out := make([]notificationHistoryJob, 0, len(records))
	for _, record := range records {
		if job := toHistoryJob(record); job != nil {
			out = append(out, *job)
		}
	}
	return out
}

// toHistoryJob 将通知任务记录转换为 history DTO。
// Result 保留原始 JSON，以便前端通过 union schema 区分 `{}` 和 cron result。
func toHistoryJob(record *core.Record) *notificationHistoryJob {
	if record == nil {
		return nil
	}
	result := json.RawMessage([]byte("{}"))
	if raw, err := notificationJobResultRaw(record); err == nil && len(raw) > 0 {
		result = raw
	}
	return &notificationHistoryJob{
		ID:                  record.Id,
		ScheduledLocalDate:  record.GetString("scheduledLocalDate"),
		ScheduledLocalTime:  record.GetString("scheduledLocalTime"),
		TimeZone:            record.GetString("timeZone"),
		ScheduledInstantUTC: record.GetString("scheduledInstantUtc"),
		Status:              record.GetString("status"),
		Attempts:            record.GetInt("attempts"),
		LastError:           nullableString(record.GetString("lastError")),
		Result:              result,
		CreatedAt:           record.GetDateTime("created").Time().UTC().Format(time.RFC3339),
		UpdatedAt:           record.GetDateTime("updated").Time().UTC().Format(time.RFC3339),
	}
}

// notificationJobResultRaw 读取任务 result 的原始 JSON。
// null/空值统一输出 `{}`，保持前端 empty result schema 稳定。
func notificationJobResultRaw(record *core.Record) (json.RawMessage, error) {
	data, err := jsonBytesFromValue(record.Get("result"))
	if err != nil || len(bytes.TrimSpace(data)) == 0 {
		return json.RawMessage([]byte("{}")), err
	}
	trimmed := bytes.TrimSpace(data)
	if bytes.Equal(trimmed, []byte("null")) {
		return json.RawMessage([]byte("{}")), nil
	}
	if bytes.Equal(trimmed, []byte("{}")) {
		return json.RawMessage([]byte("{}")), nil
	}
	var result notificationJobResult
	if err := decodeStrictJSONBytesInto(trimmed, &result, defaultAppLocale, false); err != nil {
		return json.RawMessage([]byte("{}")), err
	}
	// history 读路径只验收当前 cron result wire shape；旧/坏历史不再运行时重塑。
	if !notificationJobResultIsCurrentContract(result) {
		return json.RawMessage([]byte("{}")), nil
	}
	return json.RawMessage(trimmed), nil
}

func notificationJobResultIsCurrentContract(result notificationJobResult) bool {
	if result.Source != "cron" || result.WindowMinutes < 0 {
		return false
	}
	if !isValidDateOnly(result.Schedule.ScheduledLocalDate) ||
		!isValidLocalTime(result.Schedule.ScheduledLocalTime) ||
		strings.TrimSpace(result.Schedule.TimeZone) == "" ||
		strings.TrimSpace(result.Schedule.ScheduledInstantUTC) == "" {
		return false
	}
	if !isValidLocalTime(result.Settings.NotificationTimeLocal) ||
		result.Settings.EnabledChannels == nil ||
		result.Message.Items == nil ||
		result.Channels.Attempted == nil ||
		result.Channels.Succeeded == nil ||
		result.Channels.Failed == nil {
		return false
	}
	if !allKnownChannels(result.Settings.EnabledChannels) || !jobChannelsUseCurrentContract(result.Channels) {
		return false
	}
	for _, item := range result.Message.Items {
		if !notificationContentItemUsesCurrentContract(item) {
			return false
		}
	}
	return true
}

func jobChannelsUseCurrentContract(channels jobChannels) bool {
	if !allKnownChannels(channels.Attempted) || !allKnownChannels(channels.Succeeded) {
		return false
	}
	for _, failure := range channels.Failed {
		if _, ok := knownChannels[failure.Channel]; !ok {
			return false
		}
	}
	return true
}

func notificationContentItemUsesCurrentContract(item notificationContentItem) bool {
	switch item.Type {
	case "renewal", "trial", "expired", "expiry":
	default:
		return false
	}
	if !isValidSubscriptionStatus(item.Status) || !isValidDateOnly(item.TargetDate) || item.ReminderDays < 0 {
		return false
	}
	if item.RepeatReminder != nil &&
		(!isValidRepeatReminderInterval(item.RepeatReminder.Interval) || !isValidRepeatReminderWindow(item.RepeatReminder.Window)) {
		return false
	}
	return true
}

func allKnownChannels(channels []string) bool {
	for _, channel := range channels {
		if _, ok := knownChannels[channel]; !ok {
			return false
		}
	}
	return true
}

func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func parseInt(value string, fallback int) int {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
