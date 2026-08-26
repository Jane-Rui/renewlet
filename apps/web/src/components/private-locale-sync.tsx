import { useEffect } from "react";
import { useSettings } from "@/hooks/use-settings";
import { useI18n } from "@/i18n/I18nProvider";

/** 登录后的 settings.locale 是远端事实源；公开首屏不应为此加载完整 settings 模型。 */
export default function PrivateLocaleSync() {
  const { data: settings } = useSettings();
  const { syncRemoteLocale } = useI18n();

  useEffect(() => {
    if (settings?.locale) {
      syncRemoteLocale(settings.locale);
    }
  }, [settings?.locale, syncRemoteLocale]);

  return null;
}
