/**
 * i18n Provider 与格式化能力聚合层。
 *
 * 状态链路：
 *   自动初始语言 -> Lingui catalog -> document/api
 *   私有远端同步 -> state/document/api
 *   设置页本地预览 -> 仅 state/document
 *   已保存语言 -> state/document/api + 显式偏好缓存
 *
 * 注意：locale 切换必须等 catalog 加载完成后原子激活；迟到请求不能修改任何全局语言状态。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { I18nProvider as LinguiProvider } from "@lingui/react";
import { setApiLocale } from "@/i18n/api-locale";
import { getInitialLocale, isLocale, localizedLabel, writeExplicitLocalePreference, type Locale, type LocalizedLabels } from "@/i18n/locales";
import { activateLoadedLocale, linguiI18n, loadLocaleCatalog, translate, type MessageKey, type MessageParams } from "@/i18n/messages";
import { formatCurrency as formatCurrencyValue } from "@/lib/currency";
import { toPlainDate, type DateOnly } from "@/lib/time/date-only";
import { reportClientError } from "@/lib/report-client-error";

interface I18nContextValue {
  locale: Locale;
  previewLocale: (locale: Locale) => void;
  commitLocale: (locale: Locale) => void;
  syncRemoteLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
  formatDateOnly: (date: DateOnly | string, style?: "short" | "monthDay" | "full") => string;
  formatDateTime: (date: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatCurrency: (amount: number | string, currency: string) => string;
  label: (labels: LocalizedLabels) => string;
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
    previewLocale: () => undefined,
    commitLocale: () => undefined,
    syncRemoteLocale: () => undefined,
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
  const [initialLocale] = useState(getInitialLocale);
  const [localeState, setLocaleState] = useState(() => ({ locale: initialLocale, catalogVersion: 0 }));
  const catalogRequestRef = useRef(0);

  useEffect(() => {
    applyDocumentLocale(initialLocale);
    setApiLocale(initialLocale);
  }, [initialLocale]);

  const requestLocale = useCallback((nextLocale: Locale, mode: "preview" | "commit" | "remote") => {
    if (!isLocale(nextLocale)) return;

    const requestId = catalogRequestRef.current + 1;
    catalogRequestRef.current = requestId;

    void loadLocaleCatalog(nextLocale)
      .then((messages) => {
        if (catalogRequestRef.current !== requestId) return;
        // catalog、React context、document 与 API header 必须在同一获胜请求内提交，不能暴露半切换状态。
        activateLoadedLocale(nextLocale, messages);
        setLocaleState((current) => ({
          locale: nextLocale,
          catalogVersion: current.catalogVersion + 1,
        }));
        applyDocumentLocale(nextLocale);
        if (mode !== "preview") {
          setApiLocale(nextLocale);
        }
        if (mode === "commit") {
          writeExplicitLocalePreference(nextLocale);
        }
      })
      .catch((error: unknown) => {
        if (catalogRequestRef.current !== requestId) return;
        reportClientError(error, { source: "i18n.load-catalog", locale: nextLocale });
      });
  }, []);

  const previewLocale = useCallback((nextLocale: Locale) => {
    requestLocale(nextLocale, "preview");
  }, [requestLocale]);

  const commitLocale = useCallback((nextLocale: Locale) => {
    requestLocale(nextLocale, "commit");
  }, [requestLocale]);

  const syncRemoteLocale = useCallback((nextLocale: Locale) => {
    requestLocale(nextLocale, "remote");
  }, [requestLocale]);

  const value = useMemo<I18nContextValue>(() => {
    const t = (key: MessageKey, params?: MessageParams) => translate(localeState.locale, key, params);

    return {
      locale: localeState.locale,
      previewLocale,
      commitLocale,
      syncRemoteLocale,
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
  }, [commitLocale, localeState, previewLocale, syncRemoteLocale]);

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
