import { KeyRound, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/I18nProvider";
import type { SettingsAuthSecurityController } from "../application/use-auth-security-settings-controller";
import { getSettingsSectionClassName } from "./settings-layout";
import { CheckboxSettingRow, LoadingButtonContent } from "./settings-shared-controls";

export interface AccessSecuritySectionProps {
  id?: string;
  className?: string;
  controller: SettingsAuthSecurityController;
}

export function AccessSecuritySection({ id, className, controller }: AccessSecuritySectionProps) {
  const { t } = useI18n();
  const disabled = controller.disabled || controller.isLoading;
  const actionBusy = controller.isSaving || controller.isClearingSecret;
  // badge 展示的是可实际生效的完整配置，不是单纯开关状态；缺任一 key 都不能提示已启用。
  const enabled = controller.draft.enabled && controller.draft.siteKey.trim().length > 0 && (controller.secretConfigured || controller.draft.secret.trim().length > 0);

  if (!controller.canManage) return null;

  return (
    <section id={id} className={getSettingsSectionClassName(className)}>
      <div className="mb-6 flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-foreground">{t("settings.accessSecurity")}</h2>
      </div>

      <div className="grid gap-4 rounded-md border border-border bg-secondary/20 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{t("settings.turnstileTitle")}</h3>
              <Badge variant={enabled ? "default" : "secondary"}>
                {enabled ? t("common.enabled") : t("common.disabled")}
              </Badge>
              {controller.secretConfigured ? (
                <Badge variant="outline">{t("settings.turnstileSecretConfigured")}</Badge>
              ) : null}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{t("settings.turnstileHelp")}</p>
          </div>
        </div>

        <CheckboxSettingRow
          id="turnstile-enabled"
          checked={controller.draft.enabled}
          disabled={disabled}
          onCheckedChange={controller.setEnabled}
          label={t("settings.turnstileEnable")}
          description={t("settings.turnstileEnableHelp")}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id="turnstile-site-key"
            label={t("settings.turnstileSiteKey")}
            description={t("settings.turnstileSiteKeyHelp")}
          >
            {(field) => (
              <Input
                id={field.id}
                value={controller.draft.siteKey}
                onChange={(event) => controller.setSiteKey(event.target.value)}
                placeholder={t("settings.turnstileSiteKeyPlaceholder")}
                disabled={disabled}
                className="border-border bg-secondary"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={field.describedBy}
              />
            )}
          </FormField>

          <FormField
            id="turnstile-secret"
            label={t("settings.turnstileSecret")}
            description={controller.secretConfigured ? t("settings.turnstileSecretKeepHelp") : t("settings.turnstileSecretHelp")}
          >
            {(field) => (
              <Input
                id={field.id}
                type="password"
                value={controller.draft.secret}
                onChange={(event) => controller.setSecret(event.target.value)}
                placeholder={controller.secretConfigured ? t("settings.turnstileSecretConfiguredPlaceholder") : t("settings.turnstileSecretPlaceholder")}
                disabled={disabled}
                className="border-border bg-secondary"
                autoComplete="new-password"
                spellCheck={false}
                aria-describedby={field.describedBy}
              />
            )}
          </FormField>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={disabled || !controller.hasChanges || actionBusy}
            onClick={() => void controller.save()}
          >
            <LoadingButtonContent loading={controller.isSaving} loadingLabel={t("settings.turnstileSaving")}>
              <KeyRound className="h-4 w-4" />
              {t("settings.turnstileSave")}
            </LoadingButtonContent>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || !controller.hasChanges || actionBusy}
            onClick={controller.discard}
          >
            {t("settings.turnstileDiscard")}
          </Button>
          {controller.secretConfigured ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || actionBusy}
              onClick={() => void controller.clearSecret()}
            >
              <LoadingButtonContent loading={controller.isClearingSecret} loadingLabel={t("settings.turnstileClearing")}>
                {t("settings.turnstileClearSecret")}
              </LoadingButtonContent>
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
