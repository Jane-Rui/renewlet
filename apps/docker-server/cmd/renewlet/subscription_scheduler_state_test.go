package main

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestSchedulerDueUserIDsExcludeBannedUsers(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	activeUser, _ := createRouteTestUser(t, app, "scheduler-active")
	bannedUser, _ := createRouteTestUser(t, app, "scheduler-banned")
	createRouteTestSubscription(t, app, activeUser.Id, map[string]interface{}{"autoRenew": true, "nextBillingDate": "2026-01-01"})
	createRouteTestSubscription(t, app, bannedUser.Id, map[string]interface{}{"autoRenew": true, "nextBillingDate": "2026-01-01"})
	now := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	for _, userID := range []string{activeUser.Id, bannedUser.Id} {
		if _, err := refreshSubscriptionSchedulerStateWithOptions(app, userID, subscriptionSchedulerRefreshOptions{Now: now, ResetAutoRenewCheck: true}); err != nil {
			t.Fatal(err)
		}
	}
	bannedUser.Set("banned", true)
	if err := app.Save(bannedUser); err != nil {
		t.Fatal(err)
	}

	users, err := listAutoRenewDueUserIDs(app, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || users[0] != activeUser.Id {
		t.Fatalf("expected only active due user %q, got %#v", activeUser.Id, users)
	}
}

func TestNotificationDueUserIDsCanPagePastRetainedDueUsers(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	firstUser, _ := createRouteTestUser(t, app, "scheduler-retained-first")
	secondUser, _ := createRouteTestUser(t, app, "scheduler-retained-second")
	createDueSchedulerState(t, app, firstUser.Id, "2026-01-01T00:00:00Z")
	createDueSchedulerState(t, app, secondUser.Id, "2026-01-01T00:00:00Z")

	now := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	firstPage, err := listNotificationDueUserIDsExcluding(app, now, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstPage) != 1 {
		t.Fatalf("expected first page to contain one due user, got %#v", firstPage)
	}
	seen := map[string]struct{}{firstPage[0]: {}}
	secondPage, err := listNotificationDueUserIDsExcluding(app, now, 1, seen)
	if err != nil {
		t.Fatal(err)
	}
	if len(secondPage) != 1 || secondPage[0] == firstPage[0] {
		t.Fatalf("expected query-level exclude to page past retained due user, first=%#v second=%#v", firstPage, secondPage)
	}
}

func createDueSchedulerState(t *testing.T, app core.App, userID string, dueAt string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(subscriptionSchedulerStatesCollection)
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("nextDailyNotificationDueAtUTC", dueAt)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
}
