package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestConfigLabelLocaleContract(t *testing.T) {
	data, err := os.ReadFile("../../../../packages/shared/src/contract-fixtures/config-label-locales.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name     string               `json:"name"`
		Labels   customConfigLabels   `json:"labels"`
		Expected map[appLocale]string `json:"expected"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			for _, locale := range supportedAppLocales {
				item := customConfigItem{ID: "item", Value: "developer_tools", Labels: fixture.Labels}
				resolver := publicStatusCategoryResolver{locale: locale, byValue: map[string]customConfigItem{item.Value: item}}
				calendarLabels := calendarFeedLabelMap([]customConfigItem{item}, locale)
				aiOptions := aiRecognitionConfigOptions([]customConfigItem{item}, locale)
				for surface, got := range map[string]string{
					"public-status": resolver.Category(item.Value).Label,
					"calendar-feed": calendarLabels[item.Value],
					"ai-context":    aiOptions[0].Label,
				} {
					if want := fixture.Expected[locale]; got != want {
						t.Errorf("%s %s label = %q, want %q", surface, locale, got, want)
					}
				}
				if aiOptions[0].ZhCN != fixture.Labels.ZhCN || aiOptions[0].EnUS != fixture.Labels.EnUS {
					t.Fatal("AI context changed persisted labels")
				}
			}
		})
	}
}
