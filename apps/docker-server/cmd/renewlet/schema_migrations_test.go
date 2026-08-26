package main

// Schema migration 测试保护启动热路径：collection schema 可以每次轻量收敛，
// 历史数据修复必须通过内部账本做到失败可重试、成功不重复扫全库。

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func TestEnsureSchemaNoopDoesNotResaveCollections(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	updates := 0
	app.OnCollectionAfterUpdateSuccess().BindFunc(func(e *core.CollectionEvent) error {
		updates++
		return e.Next()
	})

	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	if updates != 0 {
		t.Fatalf("second ensureSchema saved %d collections, want 0", updates)
	}
}

func TestSubscriptionDerivedSchemaRejectsWrongIndexDirection(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery("DROP INDEX idx_subscription_list_index_user_order").Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`CREATE INDEX idx_subscription_list_index_user_order
		ON subscription_list_index (user_id, created_at, subscription_id)`).Execute(); err != nil {
		t.Fatal(err)
	}

	current, err := subscriptionDerivedSchemaCurrent(app)
	if err != nil {
		t.Fatal(err)
	}
	if current {
		t.Fatal("ASC list index must not satisfy the DESC derived schema signature")
	}
}

func TestSubscriptionDerivedSchemaRejectsMissingStatsChecks(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery("DROP TABLE subscription_user_stats").Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`CREATE TABLE subscription_user_stats (
		user_id TEXT PRIMARY KEY,
		total_count INTEGER NOT NULL DEFAULT 0,
		trial_count INTEGER NOT NULL DEFAULT 0,
		active_count INTEGER NOT NULL DEFAULT 0,
		expired_count INTEGER NOT NULL DEFAULT 0,
		paused_count INTEGER NOT NULL DEFAULT 0,
		cancelled_count INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT ''
	)`).Execute(); err != nil {
		t.Fatal(err)
	}

	current, err := subscriptionDerivedSchemaCurrent(app)
	if err != nil {
		t.Fatal(err)
	}
	if current {
		t.Fatal("stats table without non-negative and status-sum checks must be rebuilt")
	}
}

func TestSchemaDataMigrationRunsOnceAndRetriesAfterFailure(t *testing.T) {
	app := newSchemaTestApp(t)
	attempts := 0
	migrationErr := errors.New("temporary failure")

	err := runSchemaDataMigration(app, "test_retry_after_failure", func(core.App) error {
		attempts++
		return migrationErr
	})
	if !errors.Is(err, migrationErr) {
		t.Fatalf("first migration error = %v, want %v", err, migrationErr)
	}
	if applied, err := schemaDataMigrationApplied(app, "test_retry_after_failure"); err != nil || applied {
		t.Fatalf("failed migration applied = %v err = %v, want false nil", applied, err)
	}

	err = runSchemaDataMigration(app, "test_retry_after_failure", func(core.App) error {
		attempts++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("attempts after retry = %d, want 2", attempts)
	}
	if applied, err := schemaDataMigrationApplied(app, "test_retry_after_failure"); err != nil || !applied {
		t.Fatalf("successful migration applied = %v err = %v, want true nil", applied, err)
	}

	err = runSchemaDataMigration(app, "test_retry_after_failure", func(core.App) error {
		attempts++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("attempts after applied rerun = %d, want 2", attempts)
	}
}

func TestSchemaDataMigrationsBackfillSchedulerWithoutListProjection(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureCollectionsSchema(app); err != nil {
		t.Fatal(err)
	}
	user := createSchemaTestUser(t, app, "schema-scheduler-backfill@example.com")
	createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name":      "Legacy Scheduler",
		"autoRenew": true,
	})

	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	if _, err := app.FindFirstRecordByFilter("subscription_scheduler_states", "user = {:user}", dbx.Params{"user": user.Id}); err != nil {
		t.Fatalf("expected scheduler state backfill: %v", err)
	}
	var projection struct {
		Count int `db:"count"`
	}
	if err := app.DB().NewQuery("SELECT COUNT(*) AS count FROM subscription_list_index WHERE user_id = {:user}").
		Bind(dbx.Params{"user": user.Id}).
		One(&projection); err != nil {
		t.Fatal(err)
	}
	if projection.Count != 0 {
		t.Fatalf("list projection count after startup migrations = %d, want 0", projection.Count)
	}
	if err := rebuildSubscriptionDerivedStateForUser(app, user.Id, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := app.DB().NewQuery("SELECT COUNT(*) AS count FROM subscription_list_index WHERE user_id = {:user}").
		Bind(dbx.Params{"user": user.Id}).
		One(&projection); err != nil {
		t.Fatal(err)
	}
	if projection.Count != 1 {
		t.Fatalf("list projection count after lazy refresh = %d, want 1", projection.Count)
	}
}

func TestSchemaDataMigrationsNormalizeSubscriptionCycleFieldsOnce(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureCollectionsSchema(app); err != nil {
		t.Fatal(err)
	}
	user := createSchemaTestUser(t, app, "schema-cycle-fields@example.com")
	custom := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name":            "Legacy Custom",
		"billingCycle":    "custom",
		"customDays":      45,
		"customCycleUnit": "",
	})
	fixed := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name":             "Fixed With Stale Fields",
		"billingCycle":     "monthly",
		"customDays":       30,
		"customCycleUnit":  "week",
		"oneTimeTermCount": 6,
		"oneTimeTermUnit":  "month",
	})

	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	reloadedCustom, err := app.FindRecordById("subscriptions", custom.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloadedCustom.GetInt("customDays") != 45 || reloadedCustom.GetString("customCycleUnit") != "day" {
		t.Fatalf("custom cycle = (%d, %q), want (45, day)", reloadedCustom.GetInt("customDays"), reloadedCustom.GetString("customCycleUnit"))
	}
	reloadedFixed, err := app.FindRecordById("subscriptions", fixed.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloadedFixed.GetInt("customDays") != 0 || reloadedFixed.GetString("customCycleUnit") != "" || reloadedFixed.GetInt("oneTimeTermCount") != 0 || reloadedFixed.GetString("oneTimeTermUnit") != "" {
		t.Fatalf("fixed cycle retained mutually exclusive fields: custom=(%d, %q) one-time=(%d, %q)", reloadedFixed.GetInt("customDays"), reloadedFixed.GetString("customCycleUnit"), reloadedFixed.GetInt("oneTimeTermCount"), reloadedFixed.GetString("oneTimeTermUnit"))
	}
}

func TestSchemaDataMigrationsBackfillCostSharingCollectionReminderMirrors(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureCollectionsSchema(app); err != nil {
		t.Fatal(err)
	}
	user := createSchemaTestUser(t, app, "schema-cost-sharing-backfill@example.com")
	record := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name":         "Legacy Family Collection",
		"startDate":    "2026-05-14",
		"reminderDays": disabledReminderDays,
		"costSharing": types.JSONRaw(`{
			"enabled": true,
			"splitMode": "equal",
			"collectionReminder": {"enabled": true, "intervalMonths": 1, "reminderDays": -1},
			"members": [{"id": "partner", "name": "Partner", "currency": "USD"}]
		}`),
	})
	buyout := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name":            "Legacy Buyout Collection",
		"billingCycle":    "one-time",
		"startDate":       "2026-05-14",
		"nextBillingDate": "2026-05-14",
		"reminderDays":    disabledReminderDays,
		"costSharing": types.JSONRaw(`{
			"enabled": true,
			"splitMode": "equal",
			"collectionReminder": {"enabled": true, "intervalMonths": 1, "reminderDays": -1},
			"members": [{"id": "partner", "name": "Partner", "currency": "USD"}]
		}`),
	})

	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	reloaded, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.GetBool("costSharingCollectionReminderEnabled") || reloaded.GetString("costSharingNextCollectionReminderDate") == "" {
		t.Fatalf("expected collection reminder mirror backfill, enabled=%v next=%q", reloaded.GetBool("costSharingCollectionReminderEnabled"), reloaded.GetString("costSharingNextCollectionReminderDate"))
	}
	reloadedBuyout, err := app.FindRecordById("subscriptions", buyout.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloadedBuyout.GetBool("costSharingCollectionReminderEnabled") || reloadedBuyout.GetString("costSharingNextCollectionReminderDate") != "" {
		t.Fatalf("expected buyout collection mirror disabled, enabled=%v next=%q", reloadedBuyout.GetBool("costSharingCollectionReminderEnabled"), reloadedBuyout.GetString("costSharingNextCollectionReminderDate"))
	}
	data, err := jsonBytesFromValue(reloaded.Get("costSharing"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "collectionReminder") {
		t.Fatalf("expected public costSharing JSON to remain intact, got %s", data)
	}
	if strings.Contains(string(data), "intervalMonths") {
		t.Fatalf("expected deprecated collection interval to be removed, got %s", data)
	}
	buyoutData, err := jsonBytesFromValue(reloadedBuyout.Get("costSharing"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(buyoutData), "intervalMonths") {
		t.Fatalf("expected deprecated buyout collection interval to be removed, got %s", buyoutData)
	}
}

func createSchemaTestUser(t *testing.T, app core.App, email string) *core.Record {
	t.Helper()
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.SetEmail(email)
	user.SetPassword("password123")
	user.SetVerified(true)
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	return user
}

func createSchemaTestSubscriptionNoValidate(t *testing.T, app core.App, userID string, overrides map[string]interface{}) *core.Record {
	t.Helper()
	subscriptions, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(subscriptions)
	record.Set("user", userID)
	record.Set("name", "Schema Subscription")
	record.Set("price", "1")
	record.Set("currency", "USD")
	record.Set("billingCycle", "monthly")
	record.Set("category", "productivity")
	record.Set("status", "active")
	record.Set("startDate", "2026-05-14")
	record.Set("nextBillingDate", "2026-06-14")
	record.Set("autoRenew", false)
	record.Set("autoCalculateNextBillingDate", true)
	record.Set("tags", []string{})
	record.Set("costSharing", emptyJSONPayload{})
	record.Set("extra", emptyJSONPayload{})
	record.Set("reminderDays", 3)
	record.Set("repeatReminderEnabled", false)
	record.Set("repeatReminderInterval", defaultRepeatReminderInterval)
	record.Set("repeatReminderWindow", defaultRepeatReminderWindow)
	for key, value := range overrides {
		record.Set(key, value)
	}
	if err := app.SaveNoValidate(record); err != nil {
		t.Fatal(err)
	}
	return record
}
