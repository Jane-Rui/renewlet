package main

import (
	"database/sql"
	"errors"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const schemaDataMigrationsTable = "renewlet_schema_data_migrations"

type schemaDataMigration struct {
	Name string
	Run  func(core.App) error
}

func runSchemaDataMigrations(app core.App) error {
	migrations := []schemaDataMigration{
		{Name: "legacy_cloud_backup_configs_v1", Run: migrateLegacyCloudBackupConfigs},
		{Name: "backfill_autodates_v1", Run: func(app core.App) error { return backfillAutodates(app, schemaAutodateCollections...) }},
		{Name: "money_strings_v1", Run: migrateMoneyStrings},
		{Name: "subscription_scheduler_states_v1", Run: backfillSubscriptionSchedulerStates},
		{Name: "legacy_hash_only_calendar_feeds_v1", Run: deleteLegacyHashOnlyCalendarFeeds},
		{Name: "cost_sharing_current_user_payer_shape_v1", Run: migrateCostSharingCurrentUserPayerShape},
		{Name: "cost_sharing_collection_reminder_mirror_v2", Run: backfillCostSharingCollectionReminderMirrors},
		{Name: "cost_sharing_collection_reminder_inherited_cycle_v3", Run: migrateCostSharingCollectionReminderInheritedCycle},
		{Name: "subscription_cycle_fields_v1", Run: migrateSubscriptionCycleFields},
		{Name: "invalid_subscription_logos_v1", Run: cleanupInvalidSubscriptionLogos},
		{Name: "orphan_subscription_calendar_feeds_v1", Run: deleteOrphanSubscriptionCalendarFeeds},
	}
	for _, migration := range migrations {
		if err := runSchemaDataMigration(app, migration.Name, migration.Run); err != nil {
			return err
		}
	}
	return nil
}

func migrateSubscriptionCycleFields(app core.App) error {
	// 历史 custom 数量的单位固定是 day；迁移完成后读写热路径只接受显式单位，不再保留运行时兼容分支。
	statements := []string{
		`UPDATE subscriptions SET customCycleUnit = 'day'
			WHERE billingCycle = 'custom' AND customDays > 0 AND TRIM(COALESCE(customCycleUnit, '')) = ''`,
		`UPDATE subscriptions SET customDays = 0, customCycleUnit = ''
			WHERE billingCycle != 'custom' AND (customDays != 0 OR TRIM(COALESCE(customCycleUnit, '')) != '')`,
		`UPDATE subscriptions SET oneTimeTermCount = 0, oneTimeTermUnit = ''
			WHERE billingCycle != 'one-time' AND (oneTimeTermCount != 0 OR TRIM(COALESCE(oneTimeTermUnit, '')) != '')`,
	}
	for _, statement := range statements {
		if _, err := app.DB().NewQuery(statement).Execute(); err != nil {
			return err
		}
	}
	return nil
}

func runSchemaDataMigration(app core.App, name string, run func(core.App) error) error {
	if err := ensureSchemaDataMigrationsTable(app); err != nil {
		return err
	}
	applied, err := schemaDataMigrationApplied(app, name)
	if err != nil || applied {
		return err
	}
	if err := run(app); err != nil {
		return err
	}
	return markSchemaDataMigrationApplied(app, name)
}

func ensureSchemaDataMigrationsTable(app core.App) error {
	// 迁移账本放在内部 SQLite 表而不是 PocketBase collection，避免把启动维护状态暴露成 REST 资源。
	_, err := app.DB().NewQuery(`CREATE TABLE IF NOT EXISTS ` + schemaDataMigrationsTable + ` (
		name TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`).Execute()
	return err
}

func schemaDataMigrationApplied(app core.App, name string) (bool, error) {
	var row struct {
		Name string `db:"name"`
	}
	err := app.DB().NewQuery("SELECT name FROM " + schemaDataMigrationsTable + " WHERE name = {:name} LIMIT 1").
		Bind(dbx.Params{"name": name}).
		One(&row)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, err
}

func markSchemaDataMigrationApplied(app core.App, name string) error {
	_, err := app.DB().NewQuery(`INSERT INTO ` + schemaDataMigrationsTable + ` (name, applied_at)
		VALUES ({:name}, {:appliedAt})
		ON CONFLICT(name) DO UPDATE SET applied_at = excluded.applied_at`).
		Bind(dbx.Params{"name": name, "appliedAt": time.Now().UTC().Format(time.RFC3339Nano)}).
		Execute()
	return err
}

func backfillSubscriptionSchedulerStates(app core.App) error {
	for offset := 0; ; offset += subscriptionRenewalMaintenancePageSize {
		users, err := app.FindRecordsByFilter("users", "id != ''", "created", subscriptionRenewalMaintenancePageSize, offset)
		if err != nil {
			return err
		}
		for _, user := range users {
			// due-index 是 cron 热路径入口；列表投影可懒重建，但缺 scheduler state 会让旧用户永远进不了定时任务候选。
			if _, err := refreshSubscriptionSchedulerState(app, user.Id, false); err != nil {
				return err
			}
		}
		if len(users) < subscriptionRenewalMaintenancePageSize {
			return nil
		}
	}
}
