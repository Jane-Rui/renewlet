package main

// Schema migration 测试保护启动热路径：collection schema 可以每次轻量收敛，
// 历史数据修复必须通过内部账本做到失败可重试、成功不重复扫全库。

import (
	"errors"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
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
	if err := ensureSubscriptionListStateFresh(app, user.Id); err != nil {
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
