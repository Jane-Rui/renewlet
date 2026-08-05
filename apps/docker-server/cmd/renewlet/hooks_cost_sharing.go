package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

type costSharingPayload struct {
	Enabled   bool                `json:"enabled"`
	SplitMode string              `json:"splitMode"`
	Members   []costSharingMember `json:"members"`
}

type costSharingMember struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Note         string   `json:"note,omitempty"`
	Currency     string   `json:"currency,omitempty"`
	CustomAmount *string  `json:"customAmount,omitempty"`
}

// normalizeCostSharing 是 Docker 持久层的 costSharing 契约门：当前用户固定付款，members 只保存其他人的应收金额。
func normalizeCostSharing(value interface{}) (interface{}, error) {
	data, err := jsonBytesFromValue(value)
	if err != nil || len(bytes.TrimSpace(data)) == 0 || string(bytes.TrimSpace(data)) == "{}" {
		return emptyJSONPayload{}, err
	}
	var payload costSharingPayload
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, errors.New("COST_SHARING_JSON_INVALID")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, errors.New("COST_SHARING_JSON_INVALID")
	}
	if !payload.Enabled {
		return emptyJSONPayload{}, nil
	}
	if payload.SplitMode != "equal" && payload.SplitMode != "custom" {
		return nil, errors.New("COST_SHARING_SPLIT_MODE_INVALID")
	}
	if len(payload.Members) == 0 || len(payload.Members) > 20 {
		return nil, errors.New("COST_SHARING_MEMBERS_INVALID")
	}
	ids := map[string]struct{}{}
	for index := range payload.Members {
		member := &payload.Members[index]
		member.ID = strings.TrimSpace(member.ID)
		member.Name = strings.TrimSpace(member.Name)
		member.Note = strings.TrimSpace(member.Note)
		member.Currency = strings.TrimSpace(member.Currency)
		if member.ID == "" || member.Name == "" || len([]rune(member.ID)) > 80 || len([]rune(member.Name)) > 80 {
			return nil, errors.New("COST_SHARING_MEMBER_INVALID")
		}
		if len([]rune(member.Note)) > 500 {
			return nil, errors.New("COST_SHARING_MEMBER_NOTE_TOO_LONG")
		}
		if member.Currency != "" && !currencyCodeRe.MatchString(member.Currency) {
			return nil, errors.New("COST_SHARING_MEMBER_CURRENCY_INVALID")
		}
		if _, exists := ids[member.ID]; exists {
			return nil, errors.New("COST_SHARING_MEMBER_DUPLICATE")
		}
		ids[member.ID] = struct{}{}
		if member.CustomAmount != nil {
			amount, err := canonicalMoneyString(*member.CustomAmount)
			if err != nil {
				return nil, errors.New("COST_SHARING_CUSTOM_AMOUNT_INVALID")
			}
			member.CustomAmount = &amount
		}
		if payload.SplitMode == "custom" {
			if member.CustomAmount == nil {
				return nil, errors.New("COST_SHARING_CUSTOM_AMOUNT_INVALID")
			}
		}
	}
	return payload, nil
}
