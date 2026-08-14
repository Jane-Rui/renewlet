// session 独占草稿生命周期；本层只编排 UI、自动日期和提交转换。Logo 上传中禁止 data URL 入库，新建货币一经手动选择即停止跟随设置。
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FormEvent, ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { SubscriptionFormFields } from "@/components/subscription-form-fields";
import {
  getSubscriptionFormValidationIssues,
  normalizeTagsArray,
  parseTagsInput,
  costSharingCollectionReminderIsAllowedForBillingCycle,
  subscriptionFormValidationIssuesToErrors,
  toSubscriptionDraft,
} from "@/lib/subscription-form";
import { useCustomConfig } from "@/contexts/CustomConfigContext";
import { useExchangeRates } from "@/hooks/use-exchange-rates";
import { useSubscriptionDialogSession } from "@/hooks/use-subscription-dialog-session";
import { useSubscriptionFormAutoDates } from "@/hooks/use-subscription-form-auto-dates";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { useNestedDialogCloseGuard } from "@/hooks/use-nested-dialog-close-guard";
import { useSettings } from "@/hooks/use-settings";
import type { Subscription, SubscriptionDraft } from "@/types/subscription";
import { DEFAULT_NOTIFICATION_REMINDER_DAYS } from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";
import { useI18n } from "@/i18n/I18nProvider";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import { getSystemTimeZone } from "@/lib/time/time-zone";

type CreateDialogProps = {
  mode: "create";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (subscription: SubscriptionDraft) => void;
  /** 克隆订阅时使用的源订阅快照；普通新增保持空。 */
  initialSubscription?: Subscription | null | undefined;
  availableTags?: readonly string[] | undefined;
  trigger?: ReactNode;
};

type EditDialogProps = {
  mode: "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: Subscription | null;
  onSubmit: (subscription: Subscription) => void;
  availableTags?: readonly string[] | undefined;
};

export type SubscriptionDialogProps = CreateDialogProps | EditDialogProps;

export function SubscriptionDialog(props: SubscriptionDialogProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const { config } = useCustomConfig();
  const { data: settings } = useSettings();
  const { t, locale } = useI18n();
  const initialCreateSubscription = props.mode === "create" ? props.initialSubscription ?? null : null;
  const isCloneCreateMode = Boolean(initialCreateSubscription);
  const statisticCurrency = settings?.defaultCurrency ?? "CNY";
  const notificationReminderDays = settings?.notificationReminderDays ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
  const { convert: convertCurrency } = useExchangeRates(settings?.exchangeRateProvider);

  // 新建订阅时默认货币：
  // - 优先使用“统计货币”（Settings.defaultCurrency）
  // - 若该货币被用户在「货币管理」中禁用，则回退到第一个启用的货币
  // 注意： 这里和 Settings 的“不能禁用统计货币”策略互相补位，保证新建订阅永远有可用默认货币。
  const enabledCurrencyValues = useMemo(
    () => config.currencies.filter((c) => c.enabled !== false).map((c) => c.value),
    [config.currencies],
  );
  const defaultCreateCurrency = useMemo(() => {
    if (enabledCurrencyValues.includes(statisticCurrency)) return statisticCurrency;
    return enabledCurrencyValues[0] ?? statisticCurrency;
  }, [enabledCurrencyValues, statisticCurrency]);
  const editSubscription = props.mode === "edit" ? props.subscription : null;
  const billingReferenceDate = useMemo(
    () => todayDateOnlyInTimeZone(new Date(), settings?.timezone ?? getSystemTimeZone("UTC")),
    [settings?.timezone],
  );

  const { handleNestedDialogOpenChange, handleParentOpenChange: handleOpenChange } = useNestedDialogCloseGuard(
    props.open,
    props.onOpenChange,
  );
  const {
    formData,
    setFormData,
    logoUploadStatus,
    setLogoUploadStatus,
    submitError,
    setSubmitError,
    formErrors,
    setFormErrors,
    clearFieldError,
    handleFieldChange,
  } = useSubscriptionDialogSession({
    mode: props.mode,
    open: props.open,
    editSubscription,
    initialSubscription: initialCreateSubscription,
    defaultCreateCurrency,
    enabledCurrencyValues,
  });
  const idPrefix = props.mode === "edit" ? "edit-" : "";
  // 主表单和家庭共享成员管理器复用同一选项数组，避免嵌套弹层在顺序或禁用当前项回显上分叉。
  const currencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    includeDisabledCurrent: formData.currency,
    locale,
  });

  useEffect(() => {
    if (costSharingCollectionReminderIsAllowedForBillingCycle(formData) || !formData.costSharing?.collectionReminder?.enabled) return;
    // 买断 one-time 没有可推进的收款周期；草稿进入该模式时立即关闭，避免提交阶段出现一个不会生效的开关。
    setFormData((prev) => {
      if (costSharingCollectionReminderIsAllowedForBillingCycle(prev) || !prev.costSharing?.collectionReminder?.enabled) return prev;
      return {
        ...prev,
        costSharing: {
          ...prev.costSharing,
          collectionReminder: { ...prev.costSharing.collectionReminder, enabled: false },
        },
      };
    });
  }, [formData.billingCycle, formData.oneTimeMode, formData.costSharing?.collectionReminder?.enabled, setFormData]);

  useSubscriptionFormAutoDates(formData, setFormData, billingReferenceDate);

  const getSubmissionFormData = useCallback(() => {
    const pendingTags = Array.from(
      formRef.current?.querySelectorAll<HTMLInputElement>("[data-subscription-tag-pending-input]") ?? [],
    ).flatMap((input) => parseTagsInput(input.value));
    if (pendingTags.length === 0) return formData;
    return {
      ...formData,
      tags: normalizeTagsArray([...formData.tags, ...pendingTags]),
    };
  }, [formData]);

  const validateForm = useCallback((nextFormData: SubscriptionFormState) => {
    return subscriptionFormValidationIssuesToErrors(getSubscriptionFormValidationIssues(nextFormData), t);
  }, [t]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // 彻底杜绝把临时 data URL 写入数据库：上传未完成时禁止提交
    if (logoUploadStatus === "uploading") return;

    const submissionFormData = getSubmissionFormData();
    if (submissionFormData !== formData) {
      // 提交是标签输入状态进入订阅草稿的最后边界；不能要求用户必须先按 Enter 或触发 blur。
      setFormData(submissionFormData);
    }

    const nextErrors = validateForm(submissionFormData);
    if (Object.keys(nextErrors).length > 0) {
      setFormErrors(nextErrors);
      setSubmitError(null);
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
      return;
    }

    setFormErrors({});
    const draft = toSubscriptionDraft(submissionFormData);
    if (!draft) {
      setSubmitError(t("subscription.formIncomplete"));
      return;
    }
    setSubmitError(null);

    if (props.mode === "create") {
      props.onSubmit(draft);
      handleOpenChange(false);
      return;
    }

    const base = props.subscription;
    if (!base) return;
    // 编辑时可能跨周期类型切换；按目标 billingCycle 重建互斥字段，避免旧 one-time/custom 字段被 spread 残留。
    if (draft.billingCycle === "custom") {
      props.onSubmit({
        ...base,
        ...draft,
        billingCycle: "custom",
        customDays: draft.customDays,
        customCycleUnit: draft.customCycleUnit,
        oneTimeTermCount: undefined,
        oneTimeTermUnit: undefined,
        pinned: base.pinned,
        publicHidden: draft.publicHidden,
      });
    } else if (draft.billingCycle === "one-time") {
      props.onSubmit({
        ...base,
        ...draft,
        billingCycle: "one-time",
        customDays: undefined,
        customCycleUnit: undefined,
        oneTimeTermCount: draft.oneTimeTermCount,
        oneTimeTermUnit: draft.oneTimeTermUnit,
        pinned: base.pinned,
        publicHidden: draft.publicHidden,
      });
    } else {
      props.onSubmit({
        ...base,
        ...draft,
        billingCycle: draft.billingCycle,
        customDays: undefined,
        customCycleUnit: undefined,
        oneTimeTermCount: undefined,
        oneTimeTermUnit: undefined,
        pinned: base.pinned,
        publicHidden: draft.publicHidden,
      });
    }
    setFormErrors({});
    handleOpenChange(false);
  };

  const submitDisabled = logoUploadStatus === "uploading";

  return (
    <>
      <Dialog open={props.open} onOpenChange={handleOpenChange}>
        {"trigger" in props && props.trigger ? <DialogTrigger asChild>{props.trigger}</DialogTrigger> : null}

        <DialogContent
          closeLabel={t("common.close")}
          dismissMode="explicit"
          layout="frame"
          className="h5-dialog-frame h5-subscription-dialog-panel border-border bg-card p-0 sm:max-w-2xl"
        >
          <DialogHeader data-subscription-dialog-header="" className="shrink-0 p-6 pb-0">
            <DialogTitle className="text-xl font-semibold">
              {props.mode === "create"
                ? isCloneCreateMode
                  ? t("subscription.cloneDialogTitle")
                  : t("subscription.dialogCreateTitle")
                : t("subscription.dialogEditTitle")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {props.mode === "create" && isCloneCreateMode && initialCreateSubscription
                ? t("subscription.cloneDialogDescription", { name: initialCreateSubscription.name })
                : props.mode === "create"
                ? t("subscription.dialogCreateDescription")
                : t("subscription.dialogEditDescription")}
            </DialogDescription>
          </DialogHeader>

          <form
            ref={formRef}
            onSubmit={handleSubmit}
            className="h5-subscription-dialog-form overflow-hidden"
            noValidate
          >
            <div
              data-subscription-dialog-scroll=""
              className="h5-mobile-sheet-scroll h5-subscription-dialog-scroll grid gap-5 px-6 py-4"
            >
              <SubscriptionFormFields
                idPrefix={idPrefix}
                config={config}
                formData={formData}
                setFormData={setFormData}
                currencyOptions={currencyOptions}
                availableTags={props.availableTags}
                onLogoUploadStatusChange={setLogoUploadStatus}
                onFieldChange={handleFieldChange}
                errors={formErrors}
                onClearFieldError={clearFieldError}
                notificationReminderDays={notificationReminderDays}
                costSharingCurrencyConvert={convertCurrency}
                onNestedDialogOpenChange={handleNestedDialogOpenChange}
              />
            </div>

            <div
              data-subscription-dialog-footer=""
              className="h5-subscription-dialog-footer flex shrink-0 flex-col gap-3 border-t border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end md:p-6 md:pt-4"
            >
              {submitError ? (
                <p className="w-full min-w-0 break-words text-center text-sm text-destructive sm:mr-auto sm:w-auto sm:text-left">
                  {submitError}
                </p>
              ) : null}
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} className="w-full border-border sm:w-auto">
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={submitDisabled}
                className="w-full bg-primary text-primary-foreground hover:bg-primary-glow sm:w-auto"
              >
                {logoUploadStatus === "uploading" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {props.mode === "create"
                  ? isCloneCreateMode
                    ? t("subscription.cloneSubmit")
                    : t("subscription.dialogCreateSubmit")
                  : t("subscription.dialogEditSubmit")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
