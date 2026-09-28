package main

import (
	"sort"
	"strings"
)

// 索引只收录随构建发布的分类/支付方式文案，不登记用户配置；与前端同样按双语原值识别未改名项。
var customConfigBuiltInLabelKeys = func() map[customConfigLabels]string {
	keys := make([]string, 0)
	for key := range serverI18nCatalogs[localeEnUS] {
		if strings.HasPrefix(key, "category.") || strings.HasPrefix(key, "payment.") {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	labels := make(map[customConfigLabels]string, len(keys))
	for _, key := range keys {
		labels[customConfigLabels{ZhCN: serverText(localeZhCN, key), EnUS: serverText(localeEnUS, key)}] = key
	}
	return labels
}()

// labels 存储仍是中英双字段；第三语言只翻译完全未改名的内置项，用户文本保持英文回退且不写回存储。
// 该规则与 Worker custom-config-labels 和前端 localizedLabel 同步，不能按 value 覆盖用户改名。
func localizedCustomConfigLabel(labels customConfigLabels, locale appLocale) string {
	if locale == localeZhCN {
		return firstNonBlank(labels.ZhCN, labels.EnUS)
	}
	if locale != localeEnUS {
		if key, ok := customConfigBuiltInLabelKeys[labels]; ok {
			return serverText(locale, key)
		}
	}
	return firstNonBlank(labels.EnUS, labels.ZhCN)
}
