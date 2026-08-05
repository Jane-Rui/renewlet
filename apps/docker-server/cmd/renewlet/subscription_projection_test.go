package main

import (
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
)

func TestSubscriptionsProductAPIRebuildsMissingListProjection(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "subscriptions-projection-rebuild")
	target := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":    "Projection Drift Plan",
		"website": "https://projection.example.com",
		"tags":    []string{"Projection"},
	})

	if _, err := app.DB().NewQuery("DELETE FROM subscription_list_index WHERE user_id = {:user}").Bind(dbx.Params{"user": user.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	res := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?q=projection&limit=10", "", token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected projection drift list 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[subscriptionsListResponse](t, res.Body.Bytes())
	if body.Total != 1 || len(body.Subscriptions) != 1 {
		t.Fatalf("expected rebuilt projection to return one match, got %#v", body)
	}
	if got, _ := body.Subscriptions[0]["id"].(string); got != target.Id {
		t.Fatalf("expected rebuilt projection subscription %q, got %#v", target.Id, body.Subscriptions[0])
	}
}

func TestSubscriptionsProductAPIRebuildsStaleListProjection(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "subscriptions-projection-stale")
	target := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name": "Old Projection Plan",
	})

	_, err := app.DB().NewQuery("UPDATE subscriptions SET name = {:name}, updated = {:updated} WHERE id = {:id}").
		Bind(dbx.Params{
			"id":      target.Id,
			"name":    "Fresh Projection Plan",
			"updated": time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano),
		}).
		Execute()
	if err != nil {
		t.Fatal(err)
	}
	res := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?q=fresh&limit=10", "", token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected stale projection list 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[subscriptionsListResponse](t, res.Body.Bytes())
	if body.Total != 1 || len(body.Subscriptions) != 1 {
		t.Fatalf("expected source-version rebuild to return one match, got %#v", body)
	}
	if got, _ := body.Subscriptions[0]["name"].(string); got != "Fresh Projection Plan" {
		t.Fatalf("expected rebuilt projection to read fresh subscription, got %#v", body.Subscriptions[0])
	}
}
