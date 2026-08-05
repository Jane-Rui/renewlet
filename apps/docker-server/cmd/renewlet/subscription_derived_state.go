package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type subscriptionListIndexRow struct {
	SubscriptionID        string `db:"subscription_id"`
	UserID                string `db:"user_id"`
	Name                  string `db:"name"`
	Website               string `db:"website"`
	Notes                 string `db:"notes"`
	SearchTextLower       string `db:"search_text_lower"`
	Category              string `db:"category"`
	BillingCycle          string `db:"billing_cycle"`
	Currency              string `db:"currency"`
	PaymentMethod         string `db:"payment_method"`
	Status                string `db:"status"`
	Pinned                int    `db:"pinned"`
	PublicHidden          int    `db:"public_hidden"`
	NextBillingDate       string `db:"next_billing_date"`
	TrialEndDate          string `db:"trial_end_date"`
	OneTimeTermCount      int    `db:"one_time_term_count"`
	AutoRenew             int    `db:"auto_renew"`
	ReminderDays          int    `db:"reminder_days"`
	RepeatReminderEnabled int    `db:"repeat_reminder_enabled"`
	CreatedAt             string `db:"created_at"`
	UpdatedAt             string `db:"updated_at"`
}

type subscriptionStats struct {
	Total    int
	ByStatus map[string]int
}

type subscriptionSourceSnapshot struct {
	Count     int    `db:"count"`
	UpdatedAt string `db:"source_updated_at"`
}

func ensureSubscriptionDerivedTables(app core.App) error {
	// 这些表是 Go 运行面的内部派生缓存，不是 PocketBase collection；删除后可由 subscriptions 事实源重建。
	statements := []string{
		`CREATE TABLE IF NOT EXISTS subscription_list_index (
			subscription_id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			website TEXT NOT NULL DEFAULT '',
			notes TEXT NOT NULL DEFAULT '',
			search_text_lower TEXT NOT NULL DEFAULT '',
			category TEXT NOT NULL,
			billing_cycle TEXT NOT NULL,
			currency TEXT NOT NULL,
			payment_method TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			pinned INTEGER NOT NULL DEFAULT 0,
			public_hidden INTEGER NOT NULL DEFAULT 0,
			next_billing_date TEXT NOT NULL,
			trial_end_date TEXT NOT NULL DEFAULT '',
			one_time_term_count INTEGER NOT NULL DEFAULT 0,
			auto_renew INTEGER NOT NULL DEFAULT 0,
			reminder_days INTEGER NOT NULL DEFAULT -1,
			repeat_reminder_enabled INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_order ON subscription_list_index (user_id, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_category_order ON subscription_list_index (user_id, category, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_billing_cycle_order ON subscription_list_index (user_id, billing_cycle, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_currency_order ON subscription_list_index (user_id, currency, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_payment_method_order ON subscription_list_index (user_id, payment_method, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_pinned_order ON subscription_list_index (user_id, pinned, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_public_hidden_order ON subscription_list_index (user_id, public_hidden, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_reminder_order ON subscription_list_index (user_id, reminder_days, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_repeat_order ON subscription_list_index (user_id, repeat_reminder_enabled, created_at DESC, subscription_id DESC)`,
		`CREATE TABLE IF NOT EXISTS subscription_tags (
			user_id TEXT NOT NULL,
			subscription_id TEXT NOT NULL,
			tag_norm TEXT NOT NULL,
			tag TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (user_id, subscription_id, tag_norm)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_tags_user_tag_order ON subscription_tags (user_id, tag_norm, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_tags_user_updated ON subscription_tags (user_id, updated_at DESC, tag_norm)`,
		`CREATE TABLE IF NOT EXISTS subscription_user_stats (
			user_id TEXT PRIMARY KEY,
			total_count INTEGER NOT NULL DEFAULT 0,
			status_counts_json TEXT NOT NULL DEFAULT '{}',
			source_updated_at TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
	}
	for _, statement := range statements {
		if _, err := app.DB().NewQuery(statement).Execute(); err != nil {
			return err
		}
	}
	return ensureSubscriptionUserStatsSourceColumn(app)
}

func refreshSubscriptionDerivedState(app core.App, userID string, resetAutoRenewCheck bool) error {
	if err := refreshSubscriptionListState(app, userID); err != nil {
		return err
	}
	_, err := refreshSubscriptionSchedulerState(app, userID, resetAutoRenewCheck)
	return err
}

func refreshSubscriptionListState(app core.App, userID string) error {
	if strings.TrimSpace(userID) == "" {
		return nil
	}
	source, err := readSubscriptionSourceSnapshot(app, userID)
	if err != nil {
		return err
	}
	records := []*core.Record{}
	for offset := 0; ; offset += subscriptionListScanPageSize {
		rows, err := app.FindRecordsByFilter("subscriptions", "user = {:user}", "-created,-id", subscriptionListScanPageSize, offset, dbx.Params{"user": userID})
		if err != nil {
			return err
		}
		records = append(records, rows...)
		if len(rows) < subscriptionListScanPageSize {
			break
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	stats := newSubscriptionStats()
	return app.RunInTransaction(func(txApp core.App) error {
		if _, err := txApp.DB().NewQuery("DELETE FROM subscription_list_index WHERE user_id = {:user}").Bind(dbx.Params{"user": userID}).Execute(); err != nil {
			return err
		}
		if _, err := txApp.DB().NewQuery("DELETE FROM subscription_tags WHERE user_id = {:user}").Bind(dbx.Params{"user": userID}).Execute(); err != nil {
			return err
		}
		for _, record := range records {
			stats.Total++
			if _, ok := stats.ByStatus[record.GetString("status")]; ok {
				stats.ByStatus[record.GetString("status")]++
			}
			if err := insertSubscriptionListProjection(txApp, record); err != nil {
				return err
			}
		}
		statusCounts, err := json.Marshal(stats.ByStatus)
		if err != nil {
			return err
		}
		_, err = txApp.DB().NewQuery(`INSERT INTO subscription_user_stats (user_id, total_count, status_counts_json, source_updated_at, created_at, updated_at)
			VALUES ({:user}, {:total}, {:statusCounts}, {:sourceUpdatedAt}, {:now}, {:now})
			ON CONFLICT(user_id) DO UPDATE SET total_count = excluded.total_count, status_counts_json = excluded.status_counts_json, source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at`).
			Bind(dbx.Params{"user": userID, "total": stats.Total, "statusCounts": string(statusCounts), "sourceUpdatedAt": source.UpdatedAt, "now": now}).
			Execute()
		return err
	})
}

func ensureSubscriptionListStateFresh(app core.App, userID string) error {
	if strings.TrimSpace(userID) == "" {
		return nil
	}
	source, err := readSubscriptionSourceSnapshot(app, userID)
	if err != nil {
		return err
	}
	var projection struct {
		Count int `db:"count"`
	}
	if err := app.DB().NewQuery("SELECT COUNT(*) AS count FROM subscription_list_index WHERE user_id = {:user}").
		Bind(dbx.Params{"user": userID}).
		One(&projection); err != nil {
		return err
	}
	var stats struct {
		TotalCount      int    `db:"total_count"`
		SourceUpdatedAt string `db:"source_updated_at"`
	}
	err = app.DB().NewQuery("SELECT total_count, source_updated_at FROM subscription_user_stats WHERE user_id = {:user} LIMIT 1").
		Bind(dbx.Params{"user": userID}).
		One(&stats)
	// 派生表只是热路径缓存；发现投影或 stats 与 subscriptions 事实源版本不一致时，先重建再继续列表查询。
	if errors.Is(err, sql.ErrNoRows) || source.Count != projection.Count || source.Count != stats.TotalCount || source.UpdatedAt != stats.SourceUpdatedAt {
		return refreshSubscriptionListState(app, userID)
	}
	return err
}

func readSubscriptionSourceSnapshot(app core.App, userID string) (subscriptionSourceSnapshot, error) {
	var snapshot subscriptionSourceSnapshot
	// count + max(updated) 是轻量源版本：能发现同数量订阅更新导致的旧投影，不需要每次列表都回表扫描完整字段。
	err := app.DB().NewQuery("SELECT COUNT(*) AS count, COALESCE(MAX(updated), '') AS source_updated_at FROM subscriptions WHERE user = {:user}").
		Bind(dbx.Params{"user": userID}).
		One(&snapshot)
	return snapshot, err
}

func ensureSubscriptionUserStatsSourceColumn(app core.App) error {
	var columns []struct {
		Name string `db:"name"`
	}
	// Go 内部派生表不走 PocketBase collection migration；这里幂等补列，保护已有 SQLite 数据目录升级路径。
	if err := app.DB().NewQuery("PRAGMA table_info(subscription_user_stats)").All(&columns); err != nil {
		return err
	}
	for _, column := range columns {
		if column.Name == "source_updated_at" {
			return nil
		}
	}
	_, err := app.DB().NewQuery("ALTER TABLE subscription_user_stats ADD COLUMN source_updated_at TEXT NOT NULL DEFAULT ''").Execute()
	return err
}

func insertSubscriptionListProjection(app core.App, record *core.Record) error {
	tags := subscriptionRecordStringSlice(record, "tags")
	createdAt := projectionRecordTimeString(record, "created")
	updatedAt := projectionRecordTimeString(record, "updated")
	_, err := app.DB().NewQuery(`INSERT OR REPLACE INTO subscription_list_index (
		subscription_id, user_id, name, website, notes, search_text_lower, category, billing_cycle, currency,
		payment_method, status, pinned, public_hidden, next_billing_date, trial_end_date, one_time_term_count,
		auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
	) VALUES (
		{:id}, {:user}, {:name}, {:website}, {:notes}, {:search}, {:category}, {:billingCycle}, {:currency},
		{:paymentMethod}, {:status}, {:pinned}, {:publicHidden}, {:nextBillingDate}, {:trialEndDate}, {:oneTimeTermCount},
		{:autoRenew}, {:reminderDays}, {:repeatReminderEnabled}, {:createdAt}, {:updatedAt}
	)`).Bind(dbx.Params{
		"id":                    record.Id,
		"user":                  record.GetString("user"),
		"name":                  record.GetString("name"),
		"website":               record.GetString("website"),
		"notes":                 record.GetString("notes"),
		"search":                subscriptionSearchTextLower(record, tags),
		"category":              record.GetString("category"),
		"billingCycle":          record.GetString("billingCycle"),
		"currency":              record.GetString("currency"),
		"paymentMethod":         record.GetString("paymentMethod"),
		"status":                record.GetString("status"),
		"pinned":                boolToSQLiteInt(record.GetBool("pinned")),
		"publicHidden":          boolToSQLiteInt(record.GetBool("publicHidden")),
		"nextBillingDate":       record.GetString("nextBillingDate"),
		"trialEndDate":          record.GetString("trialEndDate"),
		"oneTimeTermCount":      record.GetInt("oneTimeTermCount"),
		"autoRenew":             boolToSQLiteInt(record.GetBool("autoRenew")),
		"reminderDays":          record.GetInt("reminderDays"),
		"repeatReminderEnabled": boolToSQLiteInt(record.GetBool("repeatReminderEnabled")),
		"createdAt":             createdAt,
		"updatedAt":             updatedAt,
	}).Execute()
	if err != nil {
		return err
	}
	seen := map[string]struct{}{}
	for _, rawTag := range tags {
		tag := strings.TrimSpace(rawTag)
		tagNorm := strings.ToLower(tag)
		if tag == "" {
			continue
		}
		if _, ok := seen[tagNorm]; ok {
			continue
		}
		seen[tagNorm] = struct{}{}
		if _, err := app.DB().NewQuery(`INSERT OR REPLACE INTO subscription_tags (user_id, subscription_id, tag_norm, tag, created_at, updated_at)
			VALUES ({:user}, {:id}, {:tagNorm}, {:tag}, {:createdAt}, {:updatedAt})`).
			Bind(dbx.Params{"user": record.GetString("user"), "id": record.Id, "tagNorm": tagNorm, "tag": tag, "createdAt": createdAt, "updatedAt": updatedAt}).
			Execute(); err != nil {
			return err
		}
	}
	return nil
}

func getSubscriptionStats(app core.App, userID string) (subscriptionStats, error) {
	stats := newSubscriptionStats()
	var row struct {
		TotalCount       int    `db:"total_count"`
		StatusCountsJSON string `db:"status_counts_json"`
	}
	err := app.DB().NewQuery(`SELECT total_count, status_counts_json FROM subscription_user_stats WHERE user_id = {:user} LIMIT 1`).
		Bind(dbx.Params{"user": userID}).
		One(&row)
	if err != nil {
		if err := refreshSubscriptionListState(app, userID); err != nil {
			return stats, err
		}
		err = app.DB().NewQuery(`SELECT total_count, status_counts_json FROM subscription_user_stats WHERE user_id = {:user} LIMIT 1`).
			Bind(dbx.Params{"user": userID}).
			One(&row)
		if err != nil {
			return stats, nil
		}
	}
	stats.Total = row.TotalCount
	_ = json.Unmarshal([]byte(row.StatusCountsJSON), &stats.ByStatus)
	return stats, nil
}

func getSubscriptionRecordsByIDs(app core.App, userID string, ids []string) ([]*core.Record, error) {
	out := make([]*core.Record, 0, len(ids))
	for _, id := range ids {
		record, err := app.FindFirstRecordByFilter("subscriptions", "id = {:id} && user = {:user}", dbx.Params{"id": id, "user": userID})
		if err != nil {
			continue
		}
		out = append(out, record)
	}
	return out, nil
}

func backfillSubscriptionDerivedStates(app core.App) error {
	for offset := 0; ; offset += subscriptionRenewalMaintenancePageSize {
		users, err := app.FindRecordsByFilter("users", "id != ''", "created", subscriptionRenewalMaintenancePageSize, offset)
		if err != nil {
			return err
		}
		for _, user := range users {
			if err := refreshSubscriptionDerivedState(app, user.Id, false); err != nil {
				return err
			}
		}
		if len(users) < subscriptionRenewalMaintenancePageSize {
			return nil
		}
	}
}

func newSubscriptionStats() subscriptionStats {
	return subscriptionStats{
		ByStatus: map[string]int{
			"trial":     0,
			"active":    0,
			"expired":   0,
			"paused":    0,
			"cancelled": 0,
		},
	}
}

func subscriptionSearchTextLower(record *core.Record, tags []string) string {
	values := []string{record.GetString("name"), record.GetString("website"), record.GetString("notes")}
	values = append(values, tags...)
	return strings.ToLower(strings.Join(values, "\n"))
}

func projectionRecordTimeString(record *core.Record, field string) string {
	value := record.GetDateTime(field)
	if value.IsZero() {
		return ""
	}
	// 列表 cursor 与 Public API 共用 PocketBase DateTime 字符串排序；投影表必须保存同一格式，避免第二页游标被全量过滤。
	return value.String()
}

func boolToSQLiteInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
