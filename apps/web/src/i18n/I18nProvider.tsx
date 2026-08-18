/**
 * i18n Provider 与格式化能力聚合层。
 *
 * 状态链路：
 *   自动初始语言 -> Lingui catalog -> document/api
 *   远端 settings.locale -> state/document/api
 *   设置页本地预览 -> 仅 state/document
 *   已保存语言 -> settings API + 显式偏好缓存
 *
 * 注意： 外观设置页会用 `persist=false` 做本地预览；不要把预览态提前写入远端或本地显式偏好。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { I18nProvider as LinguiProvider } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { setApiLocale } from "@/i18n/api-locale";
import { getInitialLocale, isLocale, localizedLabel, writeExplicitLocalePreference, type Locale, type LocalizedLabels } from "@/i18n/locales";
import { activateLinguiLocale, linguiI18n, translate, type MessageKey, type MessageParams } from "@/i18n/messages";
import { SETTINGS_QUERY_KEY, useSettings, useUpdateSettings } from "@/hooks/use-settings";
import { getCurrentUserId } from "@/lib/pocketbase";
import { formatCurrency as formatCurrencyValue } from "@/lib/currency";
import { toPlainDate, type DateOnly } from "@/lib/time/date-only";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale, options?: SetLocaleOptions) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
  formatDateOnly: (date: DateOnly | string, style?: "short" | "monthDay" | "full") => string;
  formatDateTime: (date: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatCurrency: (amount: number | string, currency: string) => string;
  label: (labels: LocalizedLabels) => string;
}

interface SetLocaleOptions {
  persist?: boolean;
  markAsSaved?: boolean;
  rememberPreference?: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function applyDocumentLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}

/** 构建 Provider 外调用 `useI18n` 时的保守兜底，避免错误边界二次崩溃。 */
function createFallbackI18nValue(): I18nContextValue {
  const locale = getInitialLocale();
  const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
  return {
    locale,
    setLocale: () => undefined,
    t,
    formatDateOnly: (date, style = "short") => {
      const value = toPlainDate(date);
      const parts = {
        year: value.year,
        month: String(value.month).padStart(style === "full" && locale === "en-US" ? 2 : 1, "0"),
        day: String(value.day).padStart(style === "full" && locale === "en-US" ? 2 : 1, "0"),
      };
      if (style === "monthDay") return t("date.monthDay", parts);
      if (style === "full") return t("date.full", parts);
      return t("date.short", parts);
    },
    formatDateTime: (date, options) => {
      const valueDate = date instanceof Date ? date : new Date(date);
      if (Number.isNaN(valueDate.getTime())) return String(date);
      return new Intl.DateTimeFormat(locale, options).format(valueDate);
    },
    formatNumber: (valueNumber, options) => new Intl.NumberFormat(locale, options).format(valueNumber),
    formatCurrency: (amount, currency) => formatCurrencyValue(amount, currency, locale),
    label: (labelSet) => localizedLabel(labelSet, locale),
  };
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [localeState, setLocaleState] = useState(() => ({ locale: getInitialLocale(), catalogVersion: 0 }));
  const locale = localeState.locale;
  const catalogRequestRef = useRef(0);
  const hasLocalPreviewRef = useRef(false);
  const { data: settings } = useSettings();
  const { mutate: updateSettings } = useUpdateSettings();

  useEffect(() => {
    const requestId = catalogRequestRef.current + 1;
    catalogRequestRef.current = requestId;
    // Lingui catalog 动态加载是切换多语言后的核心状态机：只让最后一次 locale 选择激活，避免快速切换时旧请求回写 UI。
    void activateLinguiLocale(locale).then(() => {
      if (catalogRequestRef.current !== requestId) return;
      setLocaleState((current) => (
        current.locale === locale
          ? { ...current, catalogVersion: current.catalogVersion + 1 }
          : current
      ));
    });
  }, [locale]);

  useEffect(() => {
    // 自动探测只服务本次会话；本地显式偏好只能来自用户保存语言。
    applyDocumentLocale(locale);
    if (hasLocalPreviewRef.current) return;
    setApiLocale(locale);
  }, [locale]);

  useEffect(() => {
    // 远端设置是登录后真相来源，但不能覆盖用户正在预览的未保存语言。
    if (!settings?.locale || settings.locale === locale) return;
    if (hasLocalPreviewRef.current) return;
    setLocaleState((current) => ({ locale: settings.locale, catalogVersion: current.catalogVersion }));
  }, [locale, settings?.locale]);

  const setLocale = useCallback(
    (nextLocale: Locale, options: SetLocaleOptions = {}) => {
      if (!isLocale(nextLocale)) return;
      const shouldPersist = options.persist ?? true;
      setLocaleState((current) => ({ locale: nextLocale, catalogVersion: current.catalogVersion }));

      if (!shouldPersist) {
        hasLocalPreviewRef.current = !options.markAsSaved;
        if (options.markAsSaved) {
          setApiLocale(nextLocale);
          if (options.rememberPreference) writeExplicitLocalePreference(nextLocale);
          applyDocumentLocale(nextLocale);
        }
        return;
      }

      hasLocalPreviewRef.current = false;
      setApiLocale(nextLocale);
      writeExplicitLocalePreference(nextLocale);
      applyDocumentLocale(nextLocale);
      queryClient.setQueryData(SETTINGS_QUERY_KEY, (current: unknown) => {
        // 先更新缓存可以让 Settings 页和 Header 立即看到新语言，失败回滚交给保存流程处理。
        if (!current || typeof current !== "object") return current;
        const envelope = current as { settings?: Record<string, unknown> };
        if (!envelope.settings) return current;
        return { ...envelope, settings: { ...envelope.settings, locale: nextLocale } };
      });

      if (getCurrentUserId()) {
        updateSettings({ locale: nextLocale });
      }
    },
    [queryClient, updateSettings],
  );

  const value = useMemo<I18nContextValue>(() => {
    const t = (key: MessageKey, params?: MessageParams) => translate(localeState.locale, key, params);

    return {
      locale: localeState.locale,
      setLocale,
      t,
      formatDateOnly: (date, style = "short") => {
        const value = toPlainDate(date);
        const parts = {
          year: value.year,
          month: String(value.month).padStart(style === "full" && localeState.locale === "en-US" ? 2 : 1, "0"),
          day: String(value.day).padStart(style === "full" && localeState.locale === "en-US" ? 2 : 1, "0"),
        };
        if (style === "monthDay") return t("date.monthDay", parts);
        if (style === "full") return t("date.full", parts);
        return t("date.short", parts);
      },
      formatDateTime: (date, options) => {
        const valueDate = date instanceof Date ? date : new Date(date);
        if (Number.isNaN(valueDate.getTime())) return String(date);
        return new Intl.DateTimeFormat(localeState.locale, options).format(valueDate);
      },
      formatNumber: (valueNumber, options) => new Intl.NumberFormat(localeState.locale, options).format(valueNumber),
      formatCurrency: (amount, currency) => formatCurrencyValue(amount, currency, localeState.locale),
      label: (labelSet) => localizedLabel(labelSet, localeState.locale),
    };
  }, [localeState, setLocale]);

  return (
    <LinguiProvider i18n={linguiI18n}>
      <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
    </LinguiProvider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    return createFallbackI18nValue();
  }
  return context;
}
