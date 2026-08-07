package main

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const subscriptionSchedulerStatesCollection = "subscription_scheduler_states"

type subscriptionSchedulerState struct {
	AutoRenewCount                 int
	RepeatReminderCount            int
	LastAutoRenewLocalDate         string
	NextAutoRenewCheckAtUTC        string
	NextDailyNotificationDueAtUTC  string
	NextRepeatNotificationDueAtUTC string
}

type subscriptionSchedulerRefreshOptions struct {
	ResetAutoRenewCheck           bool
	Now                           time.Time
	SkipCurrentNotificationWindow bool
}

func getSubscriptionSchedulerState(app core.App, userID string) (subscriptionSchedulerState, error) {
	if userID == "" {
		return subscriptionSchedulerState{}, nil
	}
	record, err := app.FindFirstRecordByFilter(subscriptionSchedulerStatesCollection, "user = {:user}", dbx.Params{"user": userID})
	if err == nil {
		return subscriptionSchedulerStateFromRecord(record), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return subscriptionSchedulerState{}, err
	}
	return refreshSubscriptionSchedulerState(app, userID, false)
}

func refreshSubscriptionSchedulerState(app core.App, userID string, resetAutoRenewCheck bool) (subscriptionSchedulerState, error) {
	return refreshSubscriptionSchedulerStateWithOptions(app, userID, subscriptionSchedulerRefreshOptions{ResetAutoRenewCheck: resetAutoRenewCheck})
}

func refreshSubscriptionSchedulerStateWithOptions(app core.App, userID string, options subscriptionSchedulerRefreshOptions) (subscriptionSchedulerState, error) {
	if userID == "" {
		return subscriptionSchedulerState{}, nil
	}
	now := options.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	autoRenewCount, err := app.CountRecords("subscriptions", dbx.NewExp("[[user]] = {:user} AND [[autoRenew]] = true", dbx.Params{"user": userID}))
	if err != nil {
		return subscriptionSchedulerState{}, err
	}
	repeatReminderCount, err := app.CountRecords("subscriptions", dbx.NewExp("[[user]] = {:user} AND [[repeatReminderEnabled]] = true", dbx.Params{"user": userID}))
	if err != nil {
		return subscriptionSchedulerState{}, err
	}
	collection, err := app.FindCollectionByNameOrId(subscriptionSchedulerStatesCollection)
	if err != nil {
		return subscriptionSchedulerState{}, err
	}
	record, err := app.FindFirstRecordByFilter(subscriptionSchedulerStatesCollection, "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return subscriptionSchedulerState{}, err
		}
		record = core.NewRecord(collection)
		record.Set("user", userID)
	}
	lastAutoRenewLocalDate := record.GetString("lastAutoRenewLocalDate")
	if options.ResetAutoRenewCheck {
		// 订阅写入后同一天的自动续订判定必须失效；否则新增过期 autoRenew 项会被 last-date gate 跳到明天。
		lastAutoRenewLocalDate = ""
	}
	settings := schedulerSettingsForUser(app, userID)
	nextRepeat := ""
	if repeatReminderCount > 0 {
		candidates, err := listRepeatReminderCandidateSubscriptions(app, userID, settings, now)
		if err != nil {
			return subscriptionSchedulerState{}, err
		}
		nextRepeat = nextRepeatNotificationDueAt(now, settings, candidates)
	}
	record.Set("autoRenewCount", int(autoRenewCount))
	record.Set("repeatReminderCount", int(repeatReminderCount))
	record.Set("lastAutoRenewLocalDate", lastAutoRenewLocalDate)
	// next* 字段是 Cron 热路径索引，不是幂等事实源；单用户逻辑和 notification_jobs 唯一键仍负责防重。
	record.Set("nextAutoRenewCheckAtUTC", nextAutoRenewCheckAt(now, settings.Timezone, int(autoRenewCount), lastAutoRenewLocalDate))
	record.Set("nextDailyNotificationDueAtUTC", nextDailyNotificationDueAt(now, settings.Timezone, settings.NotificationTimeLocal, options.SkipCurrentNotificationWindow))
	record.Set("nextRepeatNotificationDueAtUTC", nextRepeat)
	if err := app.Save(record); err != nil {
		return subscriptionSchedulerState{}, err
	}
	return subscriptionSchedulerStateFromRecord(record), nil
}

func markSubscriptionAutoRenewChecked(app core.App, userID string, localDate string) error {
	state, err := getSubscriptionSchedulerState(app, userID)
	if err != nil {
		return err
	}
	record, err := app.FindFirstRecordByFilter(subscriptionSchedulerStatesCollection, "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		return err
	}
	if state.LastAutoRenewLocalDate == localDate {
		return nil
	}
	record.Set("lastAutoRenewLocalDate", localDate)
	record.Set("nextAutoRenewCheckAtUTC", nextAutoRenewCheckAfterLocalDate(localDate, schedulerSettingsForUser(app, userID).Timezone))
	return app.Save(record)
}

func subscriptionSchedulerStateFromRecord(record *core.Record) subscriptionSchedulerState {
	return subscriptionSchedulerState{
		AutoRenewCount:                 record.GetInt("autoRenewCount"),
		RepeatReminderCount:            record.GetInt("repeatReminderCount"),
		LastAutoRenewLocalDate:         record.GetString("lastAutoRenewLocalDate"),
		NextAutoRenewCheckAtUTC:        record.GetString("nextAutoRenewCheckAtUTC"),
		NextDailyNotificationDueAtUTC:  record.GetString("nextDailyNotificationDueAtUTC"),
		NextRepeatNotificationDueAtUTC: record.GetString("nextRepeatNotificationDueAtUTC"),
	}
}

func listAutoRenewDueUserIDs(app core.App, now time.Time, limit int) ([]string, error) {
	return listSchedulerDueUserIDs(app, "s.autoRenewCount > 0 AND (s.nextAutoRenewCheckAtUTC = '' OR s.nextAutoRenewCheckAtUTC <= {:now})", now, limit, "s.nextAutoRenewCheckAtUTC ASC, s.user ASC", nil)
}

func listNotificationDueUserIDs(app core.App, now time.Time, limit int) ([]string, error) {
	return listNotificationDueUserIDsExcluding(app, now, limit, nil)
}

func listNotificationDueUserIDsExcluding(app core.App, now time.Time, limit int, excludeUserIDs map[string]struct{}) ([]string, error) {
	filter := "(s.nextDailyNotificationDueAtUTC = '' OR s.nextDailyNotificationDueAtUTC <= {:now} OR (s.repeatReminderCount > 0 AND (s.nextRepeatNotificationDueAtUTC = '' OR s.nextRepeatNotificationDueAtUTC <= {:now})))"
	return listSchedulerDueUserIDs(app, filter, now, limit, "s.nextDailyNotificationDueAtUTC ASC, s.nextRepeatNotificationDueAtUTC ASC, s.user ASC", excludeUserIDs)
}

func listSchedulerDueUserIDs(app core.App, filter string, now time.Time, limit int, sortOrder string, excludeUserIDs map[string]struct{}) ([]string, error) {
	if limit <= 0 {
		limit = subscriptionRenewalMaintenancePageSize
	}
	var rows []struct {
		UserID string `db:"user"`
	}
	params := dbx.Params{"now": now.UTC().Format(time.RFC3339), "limit": limit}
	excludeClause := schedulerExcludeClause(params, excludeUserIDs)
	demoClause := ""
	if demoModePolicy.Enabled() {
		demoClause = " AND lower(u.email) != lower({:demoEmail})"
		params["demoEmail"] = demoModePolicy.Email
	}
	// due-index 枚举走内部 SQL join：banned/demo/本 tick seen 用户在数据库层过滤，避免一页保留 due 的用户饿住后续候选。
	err := app.DB().NewQuery(fmt.Sprintf(`SELECT s.user AS user
		FROM subscription_scheduler_states AS s
		JOIN users AS u ON u.id = s.user
		WHERE u.banned = 0%s AND %s%s
		ORDER BY %s
		LIMIT {:limit}`, demoClause, filter, excludeClause, sortOrder)).
		Bind(params).
		All(&rows)
	if err != nil {
		return nil, err
	}
	userIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		userID := row.UserID
		if userID == "" || demoModePolicy.IsUserID(app, userID) {
			continue
		}
		userIDs = append(userIDs, userID)
	}
	return userIDs, nil
}

func schedulerExcludeClause(params dbx.Params, excludeUserIDs map[string]struct{}) string {
	if len(excludeUserIDs) == 0 {
		return ""
	}
	ids := make([]string, 0, len(excludeUserIDs))
	for id := range excludeUserIDs {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	if len(ids) == 0 {
		return ""
	}
	// exclude 列表来自本 tick 内存状态，也必须走 dbx 占位参数；排序只为让 SQL 和测试输出稳定。
	sort.Strings(ids)
	placeholders := make([]string, len(ids))
	for i, id := range ids {
		key := fmt.Sprintf("excludeUser%d", i)
		placeholders[i] = "{:" + key + "}"
		params[key] = id
	}
	return " AND s.user NOT IN (" + strings.Join(placeholders, ", ") + ")"
}

func schedulerSettingsForUser(app core.App, userID string) appSettings {
	user, err := app.FindRecordById("users", userID)
	if err != nil {
		return defaultAppSettings()
	}
	settings, err := currentUserSettings(app, user, nil)
	if err != nil {
		return defaultAppSettings()
	}
	return settings
}

func nextAutoRenewCheckAt(now time.Time, timezone string, autoRenewCount int, lastAutoRenewLocalDate string) string {
	if autoRenewCount <= 0 {
		return ""
	}
	today := todayDateOnly(now, timezone)
	if lastAutoRenewLocalDate != today {
		return now.UTC().Format(time.RFC3339)
	}
	return nextAutoRenewCheckAfterLocalDate(today, timezone)
}

func nextAutoRenewCheckAfterLocalDate(localDate string, timezone string) string {
	return scheduleLocalDateTimeUTC(addDateOnly(localDate, 1), "00:00", timezone)
}

func nextDailyNotificationDueAt(now time.Time, timezone string, localTime string, skipCurrentWindow bool) string {
	if skipCurrentWindow {
		return getNextLocalScheduleOccurrence(now, timezone, localTime).ScheduledInstantUTC
	}
	current := getLocalScheduleDecision(now, timezone, localTime, maxInt(envInt("NOTIFICATION_CRON_WINDOW_MINUTES", 2), 0), false)
	if current.Due {
		return current.ScheduledInstantUTC
	}
	return getNextLocalScheduleOccurrence(now, timezone, localTime).ScheduledInstantUTC
}

func nextRepeatNotificationDueAt(now time.Time, settings appSettings, subscriptions []notificationSubscription) string {
	if len(subscriptions) == 0 {
		return ""
	}
	current := getRepeatScheduleDecision(now, settings, subscriptions, maxInt(envInt("NOTIFICATION_CRON_WINDOW_MINUTES", 2), 0))
	if current.Due {
		return current.ScheduledInstantUTC
	}
	if next, ok := getNextRepeatScheduleOccurrence(now, settings, subscriptions); ok {
		return next.ScheduledInstantUTC
	}
	return ""
}

func scheduleLocalDateTimeUTC(localDate string, localTime string, timezone string) string {
	instant, err := getScheduleInstant(localDate, localTime, timezone)
	if err != nil {
		return time.Now().UTC().Format(time.RFC3339)
	}
	return instant.Format(time.RFC3339)
}
