import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { SubscriptionFormFields, type SubscriptionFormErrors } from "@/components/subscription-form-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import { useSubscriptionFormAutoDates } from "@/hooks/use-subscription-form-auto-dates";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import {
  aiDraftToSubscriptionFormState,
  subscriptionFormStateToAIDraftPatch,
} from "@/modules/ai-recognition/domain/ai-recognition-form";
import type { AIDraftBlockingIssue, AIDraftBlockingIssueCode } from "@/modules/ai-recognition/domain/ai-draft-preflight";
import { formatImportMessage } from "@/modules/import-export/domain/import-message-format";
import type { CustomConfig } from "@/types/config";
import type { AppSettings } from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";

interface AIDraftEditorPanelProps {
  draftId: string;
  draft: AiRecognizedSubscriptionDraft;
  draftNumber: number;
  config: CustomConfig;
  settings: AppSettings;
  availableTags?: readonly string[];
  blockingIssues: readonly AIDraftBlockingIssue[];
  onChange: (patch: Partial<AiRecognizedSubscriptionDraft>) => void;
  onRemove: () => void;
}

const ignoreLogoUploadStatus = () => undefined;
const AI_DRAFT_BLOCKING_ISSUE_LABEL_KEYS: Record<AIDraftBlockingIssueCode, MessageKey> = {
  price: "aiRecognition.draftIssuePriceRequired",
  currency: "aiRecognition.draftIssueCurrencyRequired",
  billingCycle: "aiRecognition.draftIssueBillingCycleRequired",
  purchaseDate: "subscription.validation.purchaseDateRequired",
  nextBillingDate: "subscription.validation.nextBillingDateRequired",
  autoCalculateStartDate: "subscription.validation.startDateRequiredForAutoCalculate",
  customCycle: "aiRecognition.draftIssueCustomCycleRequired",
};

export function AIDraftEditorPanel({
  draftId,
  draft,
  draftNumber,
  config,
  settings,
  availableTags = [],
  blockingIssues,
  onChange,
  onRemove,
}: AIDraftEditorPanelProps) {
  const { t, locale } = useI18n();
  const onChangeRef = useRef(onChange);
  const draftSourceRef = useRef(pickAIDraftSourceFields(draft));
  const initializedKeyRef = useRef<string | null>(null);
  const shouldSyncDraftRef = useRef(false);
  const billingReferenceDate = useMemo(
    () => todayDateOnlyInTimeZone(new Date(), settings.timezone),
    [settings.timezone],
  );
  const initializationKey = useMemo(
    () => buildEditorInitializationKey({ draftId, config, settings }),
    [config, draftId, settings],
  );
  const [formData, setFormData] = useState(() => aiDraftToSubscriptionFormState(draft, { settings, config }));
  // AI 草稿编辑器绕过 SubscriptionDialog，但货币顺序仍必须服从货币管理同一事实源。
  const currencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    includeDisabledCurrent: formData.currency,
    locale,
  });
  const blockingFormErrors = useMemo(
    () => blockingIssuesToFormErrors(blockingIssues, t),
    [blockingIssues, t],
  );

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    // 选中草稿期间 formData 承载输入中间态；父级 patch 回写会换 draft 对象，但不能重置正在输入的值。
    if (initializedKeyRef.current === initializationKey) return;
    initializedKeyRef.current = initializationKey;
    shouldSyncDraftRef.current = false;
    draftSourceRef.current = pickAIDraftSourceFields(draft);
    setFormData(aiDraftToSubscriptionFormState(draft, { settings, config }));
  }, [config, draft, initializationKey, settings]);

  const syncAutoDatePatch = useCallback((patch: Pick<Partial<SubscriptionFormState>, "autoCalculate" | "nextBillingDate">) => {
    // AI 未返回的核心字段要等用户确认；自动日期 effect 只能回写日期字段，不能顺手确认默认货币/周期。
    const draftPatch: Partial<AiRecognizedSubscriptionDraft> = {};
    if ("nextBillingDate" in patch) {
      draftPatch.nextBillingDate = patch.nextBillingDate ?? null;
    }
    if ("autoCalculate" in patch) {
      draftPatch.autoCalculateNextBillingDate = draft.billingCycle === "one-time" ? false : patch.autoCalculate ?? false;
    }
    if (Object.keys(draftPatch).length > 0) {
      onChangeRef.current(draftPatch);
    }
  }, [draft.billingCycle]);

  useSubscriptionFormAutoDates(formData, setFormData, billingReferenceDate, syncAutoDatePatch);

  useEffect(() => {
    if (!shouldSyncDraftRef.current) return;
    onChangeRef.current(subscriptionFormStateToAIDraftPatch(formData, draftSourceRef.current));
  }, [formData]);

  const confirmCurrentFormValues = useCallback(() => {
    onChangeRef.current(subscriptionFormStateToAIDraftPatch(formData, draftSourceRef.current));
  }, [formData]);

  return (
    <div className="grid gap-4 bg-background p-3">
      <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{t("aiRecognition.selectedDraftTitle", { index: draftNumber })}</h3>
            <Badge variant={draft.confidence === "high" ? "secondary" : "outline"} className="shrink-0 bg-secondary">
              {t(draft.confidence === "high" ? "aiRecognition.confidenceHigh" : "aiRecognition.confidenceLow")}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("aiRecognition.selectedDraftDescription")}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" onClick={onRemove} aria-label={t("aiRecognition.removeDraft")}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-5">
        {blockingIssues.length > 0 ? (
          <div className="grid gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-100">
            <p className="font-medium">{t("aiRecognition.draftBlockingEditorTitle", { count: blockingIssues.length })}</p>
            <div className="grid gap-1.5">
              {blockingIssues.map((issue) => (
                <div key={issue.code} className="flex min-w-0 items-center justify-between gap-2">
                  <span className="flex min-w-0 items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                    <span>{t(AI_DRAFT_BLOCKING_ISSUE_LABEL_KEYS[issue.code])}</span>
                  </span>
                  {isCurrentValueConfirmable(issue) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-xs text-amber-900 hover:bg-amber-500/15 dark:text-amber-100"
                      onClick={confirmCurrentFormValues}
                    >
                      {t("aiRecognition.useCurrentDraftValue")}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <SubscriptionFormFields
          idPrefix={`ai-draft-${draftNumber}-`}
          config={config}
          formData={formData}
          setFormData={setFormData}
          currencyOptions={currencyOptions}
          availableTags={availableTags}
          errors={blockingFormErrors}
          showLogoField={false}
          onLogoUploadStatusChange={ignoreLogoUploadStatus}
          onFieldChange={() => {
            shouldSyncDraftRef.current = true;
          }}
          notificationReminderDays={settings.notificationReminderDays}
        />
      </div>

      {draft.warnings.length > 0 ? (
        <div className="grid gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">
          {draft.warnings.slice(0, 6).map((warning, warningIndex) => (
            <p key={`${warning}:${warningIndex}`} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span>{formatImportMessage(warning, t)}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function blockingIssuesToFormErrors(
  issues: readonly AIDraftBlockingIssue[],
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): SubscriptionFormErrors {
  return issues.reduce<SubscriptionFormErrors>((errors, issue) => {
    errors[issue.field] = t(AI_DRAFT_BLOCKING_ISSUE_LABEL_KEYS[issue.code]);
    return errors;
  }, {});
}

function isCurrentValueConfirmable(issue: AIDraftBlockingIssue): boolean {
  return issue.code === "currency" || issue.code === "billingCycle";
}

function pickAIDraftSourceFields(draft: AiRecognizedSubscriptionDraft): Pick<AiRecognizedSubscriptionDraft, "website" | "notes" | "trialEndDate"> {
  return {
    website: draft.website,
    notes: draft.notes,
    trialEndDate: draft.trialEndDate,
  };
}

function buildEditorInitializationKey({
  draftId,
  config,
  settings,
}: Pick<AIDraftEditorPanelProps, "draftId" | "config" | "settings">): string {
  return JSON.stringify({
    draftId,
    defaultCurrency: settings.defaultCurrency,
    notificationReminderDays: settings.notificationReminderDays,
    timezone: settings.timezone,
    categories: config.categories.map((item) => item.value),
    paymentMethods: config.paymentMethods.map((item) => item.value),
    currencies: config.currencies.map((item) => `${item.value}:${item.enabled !== false ? "1" : "0"}`),
  });
}
