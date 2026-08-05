package main

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	subscriptionListDefaultLimit       = 50
	subscriptionListMaxLimit           = 100
	subscriptionListScanPageSize       = 500
	subscriptionListSearchMaxLength    = 200
	subscriptionPaymentMethodNoneValue = "__none"
)

type subscriptionListQuery struct {
	Limit           int
	Cursor          *subscriptionCursorPayload
	Search          string
	Categories      []string
	Tags            []string
	BillingCycles   []string
	PaymentMethods  []string
	Currencies      []string
	Status          string
	Renewal         string
	NextBillingFrom string
	NextBillingTo   string
	Pinned          *bool
	PublicHidden    *bool
	ReminderMode    string
	RepeatReminder  *bool
}

type subscriptionListPage struct {
	Rows       []*core.Record
	NextCursor *string
	Total      int64
}

func parseSubscriptionListQuery(values url.Values) (subscriptionListQuery, error) {
	limit, err := parsePositiveQueryInt(values.Get("limit"), subscriptionListDefaultLimit, 1, subscriptionListMaxLimit)
	if err != nil {
		return subscriptionListQuery{}, err
	}
	query := subscriptionListQuery{Limit: limit}
	if rawCursor := strings.TrimSpace(values.Get("cursor")); rawCursor != "" {
		cursor, err := parseSubscriptionCursorPayload(rawCursor)
		if err != nil {
			return subscriptionListQuery{}, err
		}
		query.Cursor = &cursor
	}
	if search := strings.TrimSpace(values.Get("q")); search != "" {
		if len(search) > subscriptionListSearchMaxLength {
			return subscriptionListQuery{}, errors.New("invalid search query")
		}
		query.Search = search
	}
	if query.Categories, err = parseSubscriptionListStrings(values["category"], 50, 80, nil); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Tags, err = parseSubscriptionListStrings(values["tag"], 100, 40, nil); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.BillingCycles, err = parseSubscriptionListStrings(values["billingCycle"], 7, 40, isValidBillingCycle); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.PaymentMethods, err = parseSubscriptionListStrings(values["paymentMethod"], 200, 80, isValidSubscriptionListPaymentMethod); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Currencies, err = parseSubscriptionListStrings(values["currency"], 50, 3, isSubscriptionListCurrency); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Status, err = parseSubscriptionListSingle(values, "status", 40, isValidSubscriptionStatus); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Renewal, err = parseSubscriptionListSingle(values, "renewal", 20, isSubscriptionListRenewal); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.NextBillingFrom, err = parseSubscriptionListSingle(values, "nextBillingFrom", 10, isValidDateOnly); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.NextBillingTo, err = parseSubscriptionListSingle(values, "nextBillingTo", 10, isValidDateOnly); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.NextBillingFrom != "" && query.NextBillingTo != "" && query.NextBillingFrom > query.NextBillingTo {
		return subscriptionListQuery{}, errors.New("invalid next billing range")
	}
	if query.Pinned, err = parseSubscriptionListBool(values, "pinned"); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.PublicHidden, err = parseSubscriptionListBool(values, "publicHidden"); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.ReminderMode, err = parseSubscriptionListSingle(values, "reminderMode", 20, isSubscriptionListReminderMode); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.RepeatReminder, err = parseSubscriptionListBool(values, "repeatReminder"); err != nil {
		return subscriptionListQuery{}, err
	}
	return query, nil
}

func listSubscriptionRecordsForQuery(app core.App, userID string, query subscriptionListQuery, today string) (subscriptionListPage, error) {
	if err := ensureSubscriptionListStateFresh(app, userID); err != nil {
		return subscriptionListPage{}, err
	}
	if !query.hasFilters() {
		return listProjectedDefaultSubscriptionRecords(app, userID, query)
	}
	total, pageIDs, err := collectProjectedSubscriptionPageIDs(app, userID, query, today)
	if err != nil {
		return subscriptionListPage{}, err
	}
	rows, err := getSubscriptionRecordsByIDs(app, userID, pageIDs)
	if err != nil {
		return subscriptionListPage{}, err
	}
	var nextCursor *string
	if len(rows) > query.Limit {
		rows = rows[:query.Limit]
		cursor := encodeSubscriptionCursor(rows[len(rows)-1])
		nextCursor = &cursor
	}
	return subscriptionListPage{Rows: rows, NextCursor: nextCursor, Total: total}, nil
}

func listProjectedDefaultSubscriptionRecords(app core.App, userID string, query subscriptionListQuery) (subscriptionListPage, error) {
	pageIDs, err := projectedSubscriptionPageIDs(app, userID, query)
	if err != nil {
		return subscriptionListPage{}, err
	}
	rows, err := getSubscriptionRecordsByIDs(app, userID, pageIDs)
	if err != nil {
		return subscriptionListPage{}, err
	}
	var nextCursor *string
	if len(rows) > query.Limit {
		rows = rows[:query.Limit]
		cursor := encodeSubscriptionCursor(rows[len(rows)-1])
		nextCursor = &cursor
	}
	stats, err := getSubscriptionStats(app, userID)
	if err != nil {
		return subscriptionListPage{}, err
	}
	return subscriptionListPage{Rows: rows, NextCursor: nextCursor, Total: int64(stats.Total)}, nil
}

func projectedSubscriptionPageIDs(app core.App, userID string, query subscriptionListQuery) ([]string, error) {
	base := subscriptionProjectionBaseQuery(userID, query)
	if query.Cursor != nil {
		base.conditions = append(base.conditions, "(idx.created_at < {:cursorCreatedAt} OR (idx.created_at = {:cursorCreatedAt} AND idx.subscription_id < {:cursorID}))")
		base.params["cursorCreatedAt"] = query.Cursor.CreatedAt
		base.params["cursorID"] = query.Cursor.ID
	}
	rows, err := runSubscriptionProjectionScan(app, base, query.Limit+1, nil)
	if err != nil {
		return nil, err
	}
	return subscriptionProjectionIDs(rows), nil
}

func collectProjectedSubscriptionPageIDs(app core.App, userID string, query subscriptionListQuery, today string) (int64, []string, error) {
	base := subscriptionProjectionBaseQuery(userID, query)
	total := int64(0)
	pageIDs := make([]string, 0, query.Limit+1)
	var scanCursor *subscriptionCursorPayload
	// 业务 cursor 只影响当前页收集，不影响 total；否则筛选页 total 会随着滚动递减。
	for {
		rows, err := runSubscriptionProjectionScan(app, base, subscriptionListScanPageSize, scanCursor)
		if err != nil {
			return 0, nil, err
		}
		for _, row := range rows {
			if !subscriptionIndexRowMatchesPostFilters(row, query, today) {
				continue
			}
			total++
			if len(pageIDs) <= query.Limit && subscriptionIndexRowIsAfterCursor(row, query.Cursor) {
				pageIDs = append(pageIDs, row.SubscriptionID)
			}
		}
		if len(rows) < subscriptionListScanPageSize {
			return total, pageIDs, nil
		}
		last := rows[len(rows)-1]
		scanCursor = &subscriptionCursorPayload{CreatedAt: last.CreatedAt, ID: last.SubscriptionID}
	}
}

type subscriptionProjectionBase struct {
	conditions []string
	params     dbx.Params
}

func subscriptionProjectionBaseQuery(userID string, query subscriptionListQuery) subscriptionProjectionBase {
	base := subscriptionProjectionBase{
		conditions: []string{"idx.user_id = {:user}"},
		params:     dbx.Params{"user": userID},
	}
	appendSQLInCondition(&base, "idx.category", "category", query.Categories)
	appendSQLInCondition(&base, "idx.billing_cycle", "billingCycle", query.BillingCycles)
	appendSQLInCondition(&base, "idx.currency", "currency", query.Currencies)
	appendSQLPaymentMethodCondition(&base, query.PaymentMethods)
	appendSQLRenewalCondition(&base, query.Renewal)
	appendSQLTagCondition(&base, query.Tags)
	if query.NextBillingFrom != "" {
		base.conditions = append(base.conditions, "idx.next_billing_date >= {:nextBillingFrom}")
		base.params["nextBillingFrom"] = query.NextBillingFrom
	}
	if query.NextBillingTo != "" {
		base.conditions = append(base.conditions, "idx.next_billing_date <= {:nextBillingTo}")
		base.params["nextBillingTo"] = query.NextBillingTo
	}
	if query.Pinned != nil {
		base.conditions = append(base.conditions, "idx.pinned = {:pinned}")
		base.params["pinned"] = boolToSQLiteInt(*query.Pinned)
	}
	if query.PublicHidden != nil {
		base.conditions = append(base.conditions, "idx.public_hidden = {:publicHidden}")
		base.params["publicHidden"] = boolToSQLiteInt(*query.PublicHidden)
	}
	appendSQLReminderModeCondition(&base, query.ReminderMode)
	if query.RepeatReminder != nil {
		base.conditions = append(base.conditions, "idx.repeat_reminder_enabled = {:repeatReminder}")
		base.params["repeatReminder"] = boolToSQLiteInt(*query.RepeatReminder)
	}
	return base
}

func runSubscriptionProjectionScan(app core.App, base subscriptionProjectionBase, limit int, cursor *subscriptionCursorPayload) ([]subscriptionListIndexRow, error) {
	conditions := append([]string{}, base.conditions...)
	params := dbx.Params{}
	for key, value := range base.params {
		params[key] = value
	}
	if cursor != nil {
		conditions = append(conditions, "(idx.created_at < {:scanCreatedAt} OR (idx.created_at = {:scanCreatedAt} AND idx.subscription_id < {:scanID}))")
		params["scanCreatedAt"] = cursor.CreatedAt
		params["scanID"] = cursor.ID
	}
	params["limit"] = limit
	var rows []subscriptionListIndexRow
	// 搜索不是公开全文检索；所有查询先按 idx.user_id 限定，再在当前 owner 的轻量投影内 contains。
	err := app.DB().NewQuery(fmt.Sprintf(`SELECT subscription_id, user_id, name, website, notes, search_text_lower, category, billing_cycle, currency,
		payment_method, status, pinned, public_hidden, next_billing_date, trial_end_date, one_time_term_count,
		auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
		FROM subscription_list_index AS idx
		WHERE %s
		ORDER BY idx.created_at DESC, idx.subscription_id DESC
		LIMIT {:limit}`, strings.Join(conditions, " AND "))).
		Bind(params).
		All(&rows)
	return rows, err
}

func appendSQLInCondition(base *subscriptionProjectionBase, column string, prefix string, values []string) {
	if len(values) == 0 {
		return
	}
	placeholders := make([]string, 0, len(values))
	for index, value := range values {
		key := prefix + strconv.Itoa(index)
		placeholders = append(placeholders, "{:"+key+"}")
		base.params[key] = value
	}
	base.conditions = append(base.conditions, column+" IN ("+strings.Join(placeholders, ", ")+")")
}

func appendSQLPaymentMethodCondition(base *subscriptionProjectionBase, values []string) {
	if len(values) == 0 {
		return
	}
	parts := []string{}
	concrete := []string{}
	for _, value := range values {
		if value == subscriptionPaymentMethodNoneValue {
			parts = append(parts, "idx.payment_method = ''")
		} else {
			concrete = append(concrete, value)
		}
	}
	if len(concrete) > 0 {
		placeholders := make([]string, 0, len(concrete))
		for index, value := range concrete {
			key := "paymentMethod" + strconv.Itoa(index)
			placeholders = append(placeholders, "{:"+key+"}")
			base.params[key] = value
		}
		parts = append(parts, "idx.payment_method IN ("+strings.Join(placeholders, ", ")+")")
	}
	base.conditions = append(base.conditions, "("+strings.Join(parts, " OR ")+")")
}

func appendSQLRenewalCondition(base *subscriptionProjectionBase, renewal string) {
	switch renewal {
	case "auto":
		base.conditions = append(base.conditions, "idx.billing_cycle != 'one-time' AND idx.auto_renew = 1")
	case "manual":
		base.conditions = append(base.conditions, "idx.billing_cycle != 'one-time' AND idx.auto_renew = 0")
	case "one-time":
		base.conditions = append(base.conditions, "idx.billing_cycle = 'one-time'")
	}
}

func appendSQLTagCondition(base *subscriptionProjectionBase, values []string) {
	if len(values) == 0 {
		return
	}
	parts := make([]string, 0, len(values))
	for index, tag := range values {
		keyNorm := "tagNorm" + strconv.Itoa(index)
		keyValue := "tag" + strconv.Itoa(index)
		parts = append(parts, "(tag.tag_norm = {:"+keyNorm+"} AND tag.tag = {:"+keyValue+"})")
		base.params[keyNorm] = strings.ToLower(tag)
		base.params[keyValue] = tag
	}
	base.conditions = append(base.conditions, `EXISTS (
		SELECT 1 FROM subscription_tags AS tag
		WHERE tag.user_id = idx.user_id
			AND tag.subscription_id = idx.subscription_id
			AND (`+strings.Join(parts, " OR ")+`)
	)`)
}

func appendSQLReminderModeCondition(base *subscriptionProjectionBase, mode string) {
	switch mode {
	case "disabled":
		base.conditions = append(base.conditions, "idx.reminder_days = -2")
	case "inherit":
		base.conditions = append(base.conditions, "idx.reminder_days = -1")
	case "custom":
		base.conditions = append(base.conditions, "idx.reminder_days >= 0")
	}
}

func subscriptionProjectionIDs(rows []subscriptionListIndexRow) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.SubscriptionID)
	}
	return ids
}

func subscriptionIndexRowMatchesPostFilters(row subscriptionListIndexRow, query subscriptionListQuery, today string) bool {
	if query.Status != "" && effectiveSubscriptionIndexStatus(row, today) != query.Status {
		return false
	}
	if query.Search != "" && !subscriptionIndexSearchMatches(row, query.Search) {
		return false
	}
	return true
}

func effectiveSubscriptionIndexStatus(row subscriptionListIndexRow, today string) string {
	if row.Status == "expired" {
		return "expired"
	}
	if row.BillingCycle == "one-time" && row.OneTimeTermCount <= 0 {
		return row.Status
	}
	if (row.Status == "active" || row.Status == "trial") && isValidDateOnly(row.NextBillingDate) && row.NextBillingDate < today {
		return "expired"
	}
	return row.Status
}

func subscriptionIndexSearchMatches(row subscriptionListIndexRow, search string) bool {
	query := strings.ToLower(strings.TrimSpace(search))
	if query == "" {
		return true
	}
	return strings.Contains(row.SearchTextLower, query)
}

func subscriptionIndexRowIsAfterCursor(row subscriptionListIndexRow, cursor *subscriptionCursorPayload) bool {
	if cursor == nil {
		return true
	}
	return row.CreatedAt < cursor.CreatedAt || (row.CreatedAt == cursor.CreatedAt && row.SubscriptionID < cursor.ID)
}

func subscriptionRecordStringSlice(record *core.Record, name string) []string {
	value := jsonValueForResponse(record.Get(name), []string{})
	switch typed := value.(type) {
	case []string:
		return typed
	case []interface{}:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				out = append(out, text)
			}
		}
		return out
	default:
		return []string{}
	}
}

func (query subscriptionListQuery) hasFilters() bool {
	return query.Search != "" ||
		len(query.Categories) > 0 ||
		len(query.Tags) > 0 ||
		len(query.BillingCycles) > 0 ||
		len(query.PaymentMethods) > 0 ||
		len(query.Currencies) > 0 ||
		query.Status != "" ||
		query.Renewal != "" ||
		query.NextBillingFrom != "" ||
		query.NextBillingTo != "" ||
		query.Pinned != nil ||
		query.PublicHidden != nil ||
		query.ReminderMode != "" ||
		query.RepeatReminder != nil
}

func parseSubscriptionListStrings(values []string, maxItems int, maxLength int, validate func(string) bool) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > maxItems {
		return nil, errors.New("too many query values")
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" || len(value) > maxLength {
			return nil, errors.New("invalid query value")
		}
		if validate != nil && !validate(value) {
			return nil, errors.New("invalid query value")
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out, nil
}

func parseSubscriptionListSingle(values url.Values, name string, maxLength int, validate func(string) bool) (string, error) {
	rawValues := values[name]
	if len(rawValues) == 0 {
		return "", nil
	}
	if len(rawValues) > 1 {
		return "", errors.New("duplicate query value")
	}
	value := strings.TrimSpace(rawValues[0])
	if value == "" || len(value) > maxLength {
		return "", errors.New("invalid query value")
	}
	if validate != nil && !validate(value) {
		return "", errors.New("invalid query value")
	}
	return value, nil
}

func parseSubscriptionListBool(values url.Values, name string) (*bool, error) {
	rawValues := values[name]
	if len(rawValues) == 0 {
		return nil, nil
	}
	if len(rawValues) > 1 {
		return nil, errors.New("duplicate boolean query value")
	}
	var parsed bool
	switch strings.TrimSpace(rawValues[0]) {
	case "true", "1":
		parsed = true
	case "false", "0":
		parsed = false
	default:
		return nil, errors.New("invalid boolean query value")
	}
	return &parsed, nil
}

func isValidSubscriptionListPaymentMethod(value string) bool {
	return value == subscriptionPaymentMethodNoneValue || (strings.TrimSpace(value) == value && value != "")
}

func isSubscriptionListCurrency(value string) bool {
	if len(value) != 3 {
		return false
	}
	for _, char := range value {
		if char < 'A' || char > 'Z' {
			return false
		}
	}
	return true
}

func isSubscriptionListRenewal(value string) bool {
	switch value {
	case "auto", "manual", "one-time":
		return true
	default:
		return false
	}
}

func isSubscriptionListReminderMode(value string) bool {
	switch value {
	case "disabled", "inherit", "custom":
		return true
	default:
		return false
	}
}
