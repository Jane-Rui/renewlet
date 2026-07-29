package main

// 媒体候选测试保护内置 provider 排序、用户来源开关、favicon fallback 预算和认证限流边界。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
)

type mediaResolverFixture struct {
	ID                            string  `json:"id"`
	Kind                          string  `json:"kind"`
	Mode                          string  `json:"mode"`
	Name                          string  `json:"name"`
	Website                       string  `json:"website"`
	Limit                         *int    `json:"limit"`
	ExpectedAutoLabel             *string `json:"expectedAutoLabel"`
	ExpectedFirstBuiltInLabel     string  `json:"expectedFirstBuiltInLabel"`
	ExpectedMatchedQuery          string  `json:"expectedMatchedQuery"`
	ExpectedFirstFaviconProvider  string  `json:"expectedFirstFaviconProvider"`
	ExpectedFirstFaviconLabel     string  `json:"expectedFirstFaviconLabel"`
	ExpectedFaviconAutoAssignable *bool   `json:"expectedFaviconAutoAssignable"`
}

func loadMediaResolverFixtures(t *testing.T) []mediaResolverFixture {
	t.Helper()
	// 这份 fixture 与 shared 包共用，锁住 Go embedded static 和 Worker resolver 对同一查询的排序语义。
	data, err := os.ReadFile("../../../../packages/shared/data/media-resolver-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []mediaResolverFixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	return fixtures
}

func intPtr(value int) *int {
	return &value
}

func TestMediaCandidatesRequiresAuthAndValidatesInput(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "user")

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/media/candidates", `{"kind":"logo","mode":"search","items":[{"id":"1","name":"Netflix"}]}`, "")
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("expected media candidates 401, got %d: %s", res.Code, res.Body.String())
	}

	res = serveTestRequest(t, app, http.MethodPost, "/api/app/media/candidates", `{}`, token)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected empty media candidates payload 400, got %d: %s", res.Code, res.Body.String())
	}

	body := fmt.Sprintf(`{"kind":"logo","mode":"search","items":[{"id":"1","name":%q}]}`, strings.Repeat("a", 121))
	res = serveTestRequest(t, app, http.MethodPost, "/api/app/media/candidates", body, token)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected long media candidate query 400, got %d: %s", res.Code, res.Body.String())
	}
}

func TestMediaCandidatesAutoMatchesBuiltInWithTokenReduction(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "user")

	items := []mediaCandidateResolveItem{}
	labels := map[string]*string{}
	matchedQueries := map[string]string{}
	for _, fixture := range loadMediaResolverFixtures(t) {
		if fixture.Mode != "auto" {
			continue
		}
		items = append(items, mediaCandidateResolveItem{ID: fixture.ID, Name: fixture.Name, Website: fixture.Website})
		labels[fixture.ID] = fixture.ExpectedAutoLabel
		matchedQueries[fixture.ID] = fixture.ExpectedMatchedQuery
	}
	bodyBytes, err := json.Marshal(mediaCandidateResolveRequest{Kind: "logo", Mode: "auto", Items: items, Limit: intPtr(8)})
	if err != nil {
		t.Fatal(err)
	}
	res := serveTestRequest(t, app, http.MethodPost, "/api/app/media/candidates", string(bodyBytes), token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected media candidates 200, got %d: %s", res.Code, res.Body.String())
	}
	response := decodeAPISuccessDataForTest[mediaCandidateResolveResponse](t, res.Body.Bytes())
	byID := map[string]mediaCandidateResolveItemResponse{}
	for _, item := range response.Items {
		byID[item.ID] = item
	}
	for id, expectedLabel := range labels {
		candidate := byID[id].AutoCandidate
		if expectedLabel == nil {
			if candidate != nil {
				t.Fatalf("expected %s to have no auto match, got %#v", id, candidate)
			}
			continue
		}
		if candidate == nil || candidate.Label != *expectedLabel || candidate.MatchedQuery != matchedQueries[id] || !candidate.AutoAssignable {
			t.Fatalf("expected %s auto match %q/%q, got %#v", id, *expectedLabel, matchedQueries[id], candidate)
		}
	}
}

func TestMediaCandidatesSearchReturnsBuiltInAndFaviconFallback(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "user")

	for _, item := range loadMediaResolverFixtures(t) {
		if item.Mode != "search" || item.ExpectedFirstFaviconProvider == "" {
			continue
		}
		fixture := item
		t.Run(fixture.ID, func(t *testing.T) {
			bodyBytes, err := json.Marshal(mediaCandidateResolveRequest{
				Kind:  fixture.Kind,
				Mode:  fixture.Mode,
				Items: []mediaCandidateResolveItem{{ID: fixture.ID, Name: fixture.Name, Website: fixture.Website}},
				Limit: fixture.Limit,
			})
			if err != nil {
				t.Fatal(err)
			}
			res := serveTestRequest(t, app, http.MethodPost, "/api/app/media/candidates", string(bodyBytes), token)
			if res.Code != http.StatusOK {
				t.Fatalf("expected media candidates 200, got %d: %s", res.Code, res.Body.String())
			}
			if cache := res.Header().Get("Cache-Control"); cache != "private, max-age=300" {
				t.Fatalf("unexpected cache-control %q", cache)
			}
			response := decodeAPISuccessDataForTest[mediaCandidateResolveResponse](t, res.Body.Bytes())
			if len(response.Items) != 1 {
				t.Fatalf("expected one response item, got %#v", response.Items)
			}
			item := response.Items[0]
			if item.AutoCandidate != nil {
				t.Fatalf("search mode should not auto assign, got %#v", item.AutoCandidate)
			}
			if fixture.ExpectedFirstBuiltInLabel == "" && len(item.Candidates.BuiltIn) != 0 {
				t.Fatalf("expected fixture search to avoid built-in candidates, got %#v", item.Candidates.BuiltIn)
			}
			if fixture.ExpectedFirstBuiltInLabel != "" {
				if len(item.Candidates.BuiltIn) == 0 || item.Candidates.BuiltIn[0].Label != fixture.ExpectedFirstBuiltInLabel || item.Candidates.BuiltIn[0].MatchedQuery != fixture.ExpectedMatchedQuery {
					t.Fatalf("expected built-in %q/%q before favicon fallback, got %#v", fixture.ExpectedFirstBuiltInLabel, fixture.ExpectedMatchedQuery, item.Candidates.BuiltIn)
				}
			}
			if len(item.Candidates.Favicon) == 0 || item.Candidates.Favicon[0].Provider != fixture.ExpectedFirstFaviconProvider || item.Candidates.Favicon[0].Label != fixture.ExpectedFirstFaviconLabel || item.Candidates.Favicon[0].AutoAssignable != *fixture.ExpectedFaviconAutoAssignable {
				t.Fatalf("expected one non-auto favicon candidate for %s, got %#v", fixture.ID, item.Candidates.Favicon)
			}
		})
	}
}

func TestMediaCandidatesSearchUsesReducedBuiltInQuery(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "user")

	for _, item := range loadMediaResolverFixtures(t) {
		if item.Mode != "search" || item.ExpectedFirstBuiltInLabel == "" {
			continue
		}
		fixture := item
		t.Run(fixture.ID, func(t *testing.T) {
			bodyBytes, err := json.Marshal(mediaCandidateResolveRequest{
				Kind:  fixture.Kind,
				Mode:  fixture.Mode,
				Items: []mediaCandidateResolveItem{{ID: fixture.ID, Name: fixture.Name, Website: fixture.Website}},
				Limit: fixture.Limit,
			})
			if err != nil {
				t.Fatal(err)
			}
			res := serveTestRequest(t, app, http.MethodPost, "/api/app/media/candidates", string(bodyBytes), token)
			if res.Code != http.StatusOK {
				t.Fatalf("expected media candidates 200, got %d: %s", res.Code, res.Body.String())
			}
			response := decodeAPISuccessDataForTest[mediaCandidateResolveResponse](t, res.Body.Bytes())
			if len(response.Items) != 1 {
				t.Fatalf("expected one response item, got %#v", response.Items)
			}
			item := response.Items[0]
			if item.AutoCandidate != nil {
				t.Fatalf("search mode should not auto assign, got %#v", item.AutoCandidate)
			}
			if len(item.Candidates.BuiltIn) == 0 {
				t.Fatalf("expected built-in candidates from reduced query, got %#v", item.Candidates)
			}
			candidate := item.Candidates.BuiltIn[0]
			if candidate.Label != fixture.ExpectedFirstBuiltInLabel || candidate.MatchedQuery != fixture.ExpectedMatchedQuery {
				t.Fatalf("expected first built-in %q/%q candidate, got %#v", fixture.ExpectedFirstBuiltInLabel, fixture.ExpectedMatchedQuery, candidate)
			}
		})
	}
}

func TestMediaCandidatesSearchUsesBuiltInMatchForFaviconFallback(t *testing.T) {
	resolver := buildBuiltInResolverIndex([]builtInIcon{{
		Provider:  "thesvg",
		Slug:      "acme",
		Title:     "Acme",
		Variants:  []builtInIconVariant{{Name: "default", Path: "/public/icons/acme/default.svg"}},
		ExactKeys: []string{"acme"},
		TokenKeys: []string{"acme"},
	}})

	item := resolveMediaCandidateItem(resolver, "logo", "search", mediaCandidateResolveItem{
		ID:   "synthetic-long-plan",
		Name: "Acme Alpha Beta Gamma",
	}, 8, defaultBuiltInIconSourceSettings())

	if len(item.Candidates.BuiltIn) == 0 || item.Candidates.BuiltIn[0].Label != "Acme" || item.Candidates.BuiltIn[0].MatchedQuery != "acme" {
		t.Fatalf("expected synthetic built-in candidate to reduce to acme, got %#v", item.Candidates.BuiltIn)
	}
	if len(item.Candidates.Favicon) == 0 || item.Candidates.Favicon[0].Label != "acme.com" || item.Candidates.Favicon[0].AutoAssignable {
		t.Fatalf("expected favicon fallback to use reduced built-in query, got %#v", item.Candidates.Favicon)
	}
}

func TestMediaCandidatesSearchReservesFaviconFallbackBudget(t *testing.T) {
	icons := make([]builtInIcon, 0, 8)
	for index := 0; index < 8; index++ {
		slug := fmt.Sprintf("acme-%d", index)
		icons = append(icons, builtInIcon{
			Provider:  "thesvg",
			Slug:      slug,
			Title:     fmt.Sprintf("Acme %d", index),
			Variants:  []builtInIconVariant{{Name: "default", Path: "/public/icons/" + slug + "/default.svg"}, {Name: "mono", Path: "/public/icons/" + slug + "/mono.svg"}},
			TokenKeys: []string{"acme"},
		})
	}
	resolver := buildBuiltInResolverIndex(icons)

	limit := 8
	item := resolveMediaCandidateItem(resolver, "logo", "search", mediaCandidateResolveItem{
		ID:   "synthetic-many-built-in",
		Name: "Acme",
	}, limit, defaultBuiltInIconSourceSettings())

	expectedBuiltIn := limit - mediaResolverCfg.CandidateGroups.SearchFaviconReserve
	if len(item.Candidates.BuiltIn) != expectedBuiltIn {
		t.Fatalf("expected %d built-in candidates after favicon reserve, got %#v", expectedBuiltIn, item.Candidates.BuiltIn)
	}
	if len(item.Candidates.Favicon) != mediaResolverCfg.CandidateGroups.SearchFaviconReserve || item.Candidates.Favicon[0].Label != "acme.com" {
		t.Fatalf("expected reserved favicon fallback candidates, got %#v", item.Candidates.Favicon)
	}
	if item.Candidates.Best == nil || item.Candidates.Best.ID != item.Candidates.BuiltIn[0].ID {
		t.Fatalf("expected best to remain first built-in candidate, got %#v", item.Candidates.Best)
	}
}

func TestMediaCandidatesSearchUsesExplicitDomainBeforeWebsiteAndExpandsDirectPaths(t *testing.T) {
	resolver := buildBuiltInResolverIndex([]builtInIcon{})
	item := resolveMediaCandidateItem(resolver, "logo", "search", mediaCandidateResolveItem{
		ID:      "explicit-url",
		Name:    "https://query.example/pricing",
		Website: "https://stored.example",
	}, 5, defaultBuiltInIconSourceSettings())

	expectedURLs := []string{
		"https://query.example/favicon.ico",
		"https://query.example/favicon.svg",
		"https://query.example/icon.svg",
		"https://query.example/icon-32x32.png",
		"https://query.example/apple-touch-icon.png",
	}
	if len(item.Candidates.Favicon) != len(expectedURLs) {
		t.Fatalf("expected explicit favicon candidates, got %#v", item.Candidates.Favicon)
	}
	for index, expectedURL := range expectedURLs {
		candidate := item.Candidates.Favicon[index]
		if candidate.URL != expectedURL || candidate.AutoAssignable {
			t.Fatalf("unexpected explicit favicon candidate at %d: %#v", index, candidate)
		}
	}
}

func TestMediaCandidatesSearchKeepsGuessedDomainsOnCompactFallbackProviders(t *testing.T) {
	resolver := buildBuiltInResolverIndex([]builtInIcon{})
	item := resolveMediaCandidateItem(resolver, "logo", "search", mediaCandidateResolveItem{
		ID:   "guessed-domain",
		Name: "Acme",
	}, 4, defaultBuiltInIconSourceSettings())

	expectedURLs := []string{
		"https://acme.com/favicon.ico",
		"https://acme.com/apple-touch-icon.png",
		"https://www.google.com/s2/favicons?domain=acme.com&sz=128",
		"https://icons.duckduckgo.com/ip3/acme.com.ico",
	}
	if len(item.Candidates.Favicon) != len(expectedURLs) {
		t.Fatalf("expected compact favicon candidates, got %#v", item.Candidates.Favicon)
	}
	for index, expectedURL := range expectedURLs {
		if item.Candidates.Favicon[index].URL != expectedURL {
			t.Fatalf("unexpected compact favicon candidate at %d: %#v", index, item.Candidates.Favicon[index])
		}
	}
}

func TestMediaCandidatesSearchExpandsBuiltInVariants(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "user")

	bodyBytes, err := json.Marshal(mediaCandidateResolveRequest{
		Kind:  "logo",
		Mode:  "search",
		Items: []mediaCandidateResolveItem{{ID: "google", Name: "Google"}},
		Limit: intPtr(8),
	})
	if err != nil {
		t.Fatal(err)
	}
	res := serveTestRequest(t, app, http.MethodPost, "/api/app/media/candidates", string(bodyBytes), token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected media candidates 200, got %d: %s", res.Code, res.Body.String())
	}

	response := decodeAPISuccessDataForTest[mediaCandidateResolveResponse](t, res.Body.Bytes())
	if len(response.Items) != 1 {
		t.Fatalf("expected one response item, got %#v", response.Items)
	}
	item := response.Items[0]
	if item.AutoCandidate != nil {
		t.Fatalf("search mode should not auto assign, got %#v", item.AutoCandidate)
	}
	expectedIDs := []string{
		"builtin:thesvg:google:default",
		"builtin:thesvg:google:mono",
		"builtin:thesvg:google:wordmark",
	}
	expectedVariants := []string{"default", "mono", "wordmark"}
	expectedURLs := []string{
		"https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google/default.svg",
		"https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google/mono.svg",
		"https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google/wordmark.svg",
	}
	if len(item.Candidates.BuiltIn) < len(expectedIDs) {
		t.Fatalf("expected at least %d built-in candidates, got %#v", len(expectedIDs), item.Candidates.BuiltIn)
	}
	for index := range expectedIDs {
		candidate := item.Candidates.BuiltIn[index]
		if candidate.ID != expectedIDs[index] || candidate.Variant == nil || *candidate.Variant != expectedVariants[index] || candidate.URL != expectedURLs[index] || candidate.Rank != index {
			t.Fatalf("unexpected google variant candidate at %d: %#v", index, candidate)
		}
	}
	if item.Candidates.Best == nil || item.Candidates.Best.ID != expectedIDs[0] {
		t.Fatalf("expected best candidate to be default google variant, got %#v", item.Candidates.Best)
	}
}

func TestMediaCandidatesRespectsBuiltInIconSourceSettings(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "user")
	settings := defaultAppSettings()
	settings.BuiltInIconSources = defaultBuiltInIconSourceSettings()
	settings.BuiltInIconSources["thesvg"] = builtInIconSourceSetting{Enabled: false, VariantsEnabled: true}
	settings.BuiltInIconSources["dashboardIcons"] = builtInIconSourceSetting{Enabled: false, VariantsEnabled: true}
	settings.BuiltInIconSources["selfhst"] = builtInIconSourceSetting{Enabled: true, VariantsEnabled: false}
	createNotificationCronRouteTestSettings(t, app, user, settings)

	bodyBytes, err := json.Marshal(mediaCandidateResolveRequest{
		Kind:  "logo",
		Mode:  "search",
		Items: []mediaCandidateResolveItem{{ID: "actual-budget", Name: "Actual Budget"}},
		Limit: intPtr(8),
	})
	if err != nil {
		t.Fatal(err)
	}
	res := serveTestRequest(t, app, http.MethodPost, "/api/app/media/candidates", string(bodyBytes), token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected media candidates 200, got %d: %s", res.Code, res.Body.String())
	}

	response := decodeAPISuccessDataForTest[mediaCandidateResolveResponse](t, res.Body.Bytes())
	builtIn := response.Items[0].Candidates.BuiltIn
	if len(builtIn) == 0 {
		t.Fatalf("expected selfh.st candidates, got %#v", response.Items[0].Candidates)
	}
	for _, candidate := range builtIn {
		if candidate.Provider != "selfhst" {
			t.Fatalf("expected only selfh.st candidates, got %#v", builtIn)
		}
		if candidate.Variant == nil || *candidate.Variant != "default" {
			t.Fatalf("expected variants disabled to keep default only, got %#v", builtIn)
		}
	}
}

func TestMediaCandidatesAutoKeepsPreferredBuiltInVariant(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "user")

	bodyBytes, err := json.Marshal(mediaCandidateResolveRequest{
		Kind:  "logo",
		Mode:  "auto",
		Items: []mediaCandidateResolveItem{{ID: "google", Name: "Google"}},
		Limit: intPtr(8),
	})
	if err != nil {
		t.Fatal(err)
	}
	res := serveTestRequest(t, app, http.MethodPost, "/api/app/media/candidates", string(bodyBytes), token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected media candidates 200, got %d: %s", res.Code, res.Body.String())
	}

	response := decodeAPISuccessDataForTest[mediaCandidateResolveResponse](t, res.Body.Bytes())
	item := response.Items[0]
	if item.AutoCandidate == nil || item.AutoCandidate.Variant == nil || item.AutoCandidate.ID != "builtin:thesvg:google:default" || *item.AutoCandidate.Variant != "default" {
		t.Fatalf("expected auto candidate to keep google default variant, got %#v", item.AutoCandidate)
	}
	if len(item.Candidates.BuiltIn) != 1 {
		t.Fatalf("expected auto mode to return only preferred built-in variant, got %#v", item.Candidates.BuiltIn)
	}
}
