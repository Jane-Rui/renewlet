package main

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/pocketbase/pocketbase/core"
)

// migrateMoneyStrings 把旧 number 金额一次性提升成 canonical decimal string；之后 API/storage 都不再维持双形状。
func migrateMoneyStrings(app core.App) error {
	if err := migrateSubscriptionMoneyStrings(app); err != nil {
		return err
	}
	return migrateSettingsMoneyStrings(app)
}

func migrateSubscriptionMoneyStrings(app core.App) error {
	for offset := 0; ; offset += subscriptionCleanupPageSize {
		rows, err := app.FindRecordsByFilter("subscriptions", "id != ''", "created", subscriptionCleanupPageSize, offset)
		if err != nil {
			return err
		}
		for _, record := range rows {
			price, err := canonicalMoneyFromValue(record.Get("price"))
			if err != nil {
				return fmt.Errorf("subscription %s price: %w", record.Id, err)
			}
			changed := !recordMoneyValueEquals(record.Get("price"), price)
			record.Set("price", price)
			if costSharing, costSharingChanged, err := normalizeStoredCostSharingMoney(record.Get("costSharing")); err != nil {
				return fmt.Errorf("subscription %s costSharing: %w", record.Id, err)
			} else if costSharingChanged {
				record.Set("costSharing", costSharing)
				changed = true
			}
			if !changed {
				continue
			}
			if err := app.SaveNoValidate(record); err != nil {
				return err
			}
		}
		if len(rows) < subscriptionCleanupPageSize {
			return nil
		}
	}
}

func recordMoneyValueEquals(value interface{}, canonical string) bool {
	text, ok := value.(string)
	return ok && text == canonical
}

func migrateSettingsMoneyStrings(app core.App) error {
	for offset := 0; ; offset += subscriptionCleanupPageSize {
		rows, err := app.FindRecordsByFilter("settings", "user != ''", "created", subscriptionCleanupPageSize, offset)
		if err != nil {
			return err
		}
		for _, record := range rows {
			settings, changed, err := normalizeStoredSettingsMoney(record.Get("settings"))
			if err != nil {
				return fmt.Errorf("settings %s monthlyBudget: %w", record.Id, err)
			}
			if !changed {
				continue
			}
			record.Set("settings", settings)
			if err := app.SaveNoValidate(record); err != nil {
				return err
			}
		}
		if len(rows) < subscriptionCleanupPageSize {
			return nil
		}
	}
}

func normalizeStoredSettingsMoney(value interface{}) (map[string]interface{}, bool, error) {
	data, err := jsonBytesFromValue(value)
	if err != nil || len(bytes.TrimSpace(data)) == 0 {
		return nil, false, err
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, false, err
	}
	value, ok := payload["monthlyBudget"]
	if !ok {
		return payload, false, nil
	}
	amount, err := canonicalMoneyFromValue(value)
	if err != nil {
		return nil, false, err
	}
	if existing, ok := value.(string); ok && existing == amount {
		return payload, false, nil
	}
	payload["monthlyBudget"] = amount
	return payload, true, nil
}

func normalizeStoredCostSharingMoney(value interface{}) (map[string]interface{}, bool, error) {
	data, err := jsonBytesFromValue(value)
	if err != nil || len(bytes.TrimSpace(data)) == 0 || string(bytes.TrimSpace(data)) == "{}" {
		return nil, false, err
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, false, err
	}
	members, ok := payload["members"].([]interface{})
	if !ok {
		return payload, false, nil
	}
	changed := false
	for _, item := range members {
		member, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		value, ok := member["customAmount"]
		if !ok || value == nil {
			continue
		}
		amount, err := canonicalMoneyFromValue(value)
		if err != nil {
			return nil, false, err
		}
		if existing, ok := value.(string); ok && existing == amount {
			continue
		}
		member["customAmount"] = amount
		changed = true
	}
	return payload, changed, nil
}
