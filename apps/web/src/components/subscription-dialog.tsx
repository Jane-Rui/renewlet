/**
 * 订阅弹窗（新增/编辑复用）。
 *
 * 架构位置：
 * - Add/Edit 适配器只负责打开方式。
 * - useSubscriptionDialogSession 负责表单草稿生命周期，本组件负责 UI、自动日期和提交转换。
 *
 * 状态链路：
 * ```
 * props(open/subscription) -> session 初始化 formData
 * 用户编辑 -> SubscriptionFormFields
 * 提交 -> toSubscriptionDraft -> onSubmit(create/update)
 * ```
 *
 * 注意： Logo 上传中的状态由 `logoUploadStatus` 控制，提交时必须阻止 data URL 进入订阅数据。
 * 注意： 新增模式的默认货币会跟随 Settings/defaultCurrency，但用户手动选择后必须停止自动同步。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode, RefObject } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2 } from "lucide-react";
import { SubscriptionFormFields, type SubscriptionFormErrors } from "@/components/subscription-form-fields";
import { CostSharingMemberManagerView } from "@/components/subscription-cost-sharing-fields";
import {
  isOptionalHttpUrl,
  getTagsValidationError,
  normalizeTagsArray,
  parseTagsInput,
  parseMoneyInput,
  parseNonNegativeIntegerInput,
  parseReminderDaysInput,
  parsePositiveIntegerInput,
  getSubscriptionDateValidationKind,
  subscriptionDateValidationMessageKey,
  toSubscriptionDraft,
} from "@/lib/subscription-form";
import { useCustomConfig } from "@/contexts/CustomConfigContext";
import { useExchangeRates } from "@/hooks/use-exchange-rates";
import { useSubscriptionDialogSession } from "@/hooks/use-subscription-dialog-session";
import { useSubscriptionFormAutoDates } from "@/hooks/use-subscription-form-auto-dates";
import { useSettings } from "@/hooks/use-settings";
import type { Subscription, SubscriptionDraft } from "@/types/subscription";
import { CURRENCY_OPTIONS, DEFAULT_NOTIFICATION_REMINDER_DAYS, DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS } from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";
import { useI18n } from "@/i18n/I18nProvider";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import { getSystemTimeZone } from "@/lib/time/time-zone";
import { costSharingCustomAmountsAreValid } from "@renewlet/shared/cost-sharing";
import { createCurrencySelectOptions } from "@/lib/searchable-options";

type CreateDialogProps = {
  mode: "create";
  /** 弹窗是否打开（由上层控制）。 */
  open: boolean;
  /** 弹窗开关回调。 */
  onOpenChange: (open: boolean) => void;
  /** 新增提交回调（不含 id）。 */
  onSubmit: (subscription: SubscriptionDraft) => void;
  /** 克隆订阅时使用的源订阅快照；普通新增保持空。 */
  initialSubscription?: Subscription | null | undefined;
  /** 当前用户已有标签建议。 */
  availableTags?: readonly string[] | undefined;
  /** 触发器（可选，通常是“添加订阅”按钮）。 */
  trigger?: ReactNode;
};

type EditDialogProps = {
  mode: "edit";
  /** 弹窗是否打开（由上层控制）。 */
  open: boolean;
  /** 弹窗开关回调。 */
  onOpenChange: (open: boolean) => void;
  /** 当前正在编辑的订阅（null 表示未选中）。 */
  subscription: Subscription | null;
  /** 保存回调（回传完整 Subscription）。 */
  onSubmit: (subscription: Subscription) => void;
  /** 当前用户已有标签建议。 */
  availableTags?: readonly string[] | undefined;
};

export type SubscriptionDialogProps = CreateDialogProps | EditDialogProps;

/** 订阅弹窗组件（新增/编辑共用）。 */
export function SubscriptionDialog(props: SubscriptionDialogProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const costSharingManageMembersButtonRef = useRef<HTMLButtonElement>(null);
  const costSharingFirstMemberNameInputRef = useRef<HTMLInputElement>(null);
  const { config } = useCustomConfig();
  const { data: settings } = useSettings();
  const { t, locale } = useI18n();
  const onDialogOpenChange = props.onOpenChange;
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

  // 父子都保持 Radix modal：FocusScope 会暂停下层焦点，避免 non-modal 父层把子层聚焦误判成外部关闭。
  const [costSharingMemberDialogOpen, setCostSharingMemberDialogOpenState] = useState(false);
  const costSharingMemberDialogOpenRef = useRef(false);
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
  const setCostSharingMemberDialogOpen = useCallback((open: boolean) => {
    costSharingMemberDialogOpenRef.current = open;
    setCostSharingMemberDialogOpenState(open);
  }, []);
  const memberDialogOpen = props.open && costSharingMemberDialogOpen;

  const idPrefix = props.mode === "edit" ? "edit-" : "";
  const id = (name: string) => `${idPrefix}${name}`;
  const currencyOptions = useMemo(
    () => createCurrencySelectOptions({
      currencies: config.currencies,
      currencyOptions: CURRENCY_OPTIONS,
      includeDisabledCurrent: formData.currency,
      locale,
    }),
    [config.currencies, formData.currency, locale],
  );

  const openCostSharingMembers = useCallback(() => {
    setCostSharingMemberDialogOpen(true);
  }, [setCostSharingMemberDialogOpen]);

  const closeCostSharingMembers = useCallback(() => {
    setCostSharingMemberDialogOpen(false);
  }, [setCostSharingMemberDialogOpen]);

  const handleCostSharingMemberDialogOpenChange = useCallback((open: boolean) => {
    setCostSharingMemberDialogOpen(open);
  }, [setCostSharingMemberDialogOpen]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && costSharingMemberDialogOpenRef.current) {
      return;
    }
    if (!open) {
      setCostSharingMemberDialogOpen(false);
    }
    onDialogOpenChange(open);
  }, [onDialogOpenChange, setCostSharingMemberDialogOpen]);

  useEffect(() => {
    if (props.open) return;
    // 父弹窗被外层关闭时，嵌套成员管理器必须同步结束，避免下次打开继承子弹窗焦点上下文。
    setCostSharingMemberDialogOpen(false);
  }, [props.open, setCostSharingMemberDialogOpen]);

  useSubscriptionFormAutoDates(formData, setFormData, billingReferenceDate);

  /** 表单提交：create → 回传 draft；edit → merge id 后回传完整 Subscription。 */
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
    const errors: SubscriptionFormErrors = {};

    if (!nextFormData.name.trim()) errors.name = t("subscription.validation.nameRequired");
    if (parseMoneyInput(nextFormData.price) === null) {
      errors.price = t("subscription.validation.amountInvalid");
    }
    const dateValidationKind = getSubscriptionDateValidationKind(nextFormData);
    if (dateValidationKind) {
      errors.dates = t(subscriptionDateValidationMessageKey(dateValidationKind));
    }
    if (nextFormData.billingCycle === "custom" && parsePositiveIntegerInput(nextFormData.customDays) === null) {
      errors.customDays = t("subscription.validation.customCycleInvalid");
    }
    if (nextFormData.billingCycle === "one-time" && nextFormData.oneTimeMode === "term" && parsePositiveIntegerInput(nextFormData.oneTimeTermCount) === null) {
      errors.oneTimeTerm = t("subscription.validation.oneTimeTermInvalid");
    }
    const reminderValue = nextFormData.billingCycle === "one-time" && nextFormData.oneTimeMode === "buyout"
      ? DISABLED_REMINDER_DAYS
      : nextFormData.reminderType === "disabled"
        ? DISABLED_REMINDER_DAYS
        : nextFormData.reminderType === "inherit"
          ? INHERIT_REMINDER_DAYS
          : nextFormData.reminderType === "custom"
            ? parseNonNegativeIntegerInput(nextFormData.customReminderDays)
            : parseReminderDaysInput(nextFormData.reminderDays);
    if (reminderValue === null) {
      errors.reminderDays = t("subscription.validation.reminderInvalid");
    }
    if (!isOptionalHttpUrl(nextFormData.website)) {
      errors.website = t("subscription.validation.websiteInvalid");
    }
    if (nextFormData.costSharing?.enabled) {
      const price = parseMoneyInput(nextFormData.price);
      if (
        price === null ||
        nextFormData.costSharing.members.length === 0 ||
        !costSharingCustomAmountsAreValid(nextFormData.costSharing)
      ) {
        errors.costSharing = t("subscription.validation.costSharingInvalid");
      }
    }
    const tagsError = getTagsValidationError(nextFormData.tags);
    if (tagsError) {
      errors.tags = tagsError;
    }

    return errors;
  }, [t]);

  const updateCostSharingFormField = useCallback(<K extends keyof SubscriptionFormState>(
    key: K,
    value: SubscriptionFormState[K],
  ) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (key === "costSharing") clearFieldError("costSharing");
  }, [clearFieldError, setFormData]);

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
                availableTags={props.availableTags}
                onLogoUploadStatusChange={setLogoUploadStatus}
                onFieldChange={handleFieldChange}
                errors={formErrors}
                onClearFieldError={clearFieldError}
                notificationReminderDays={notificationReminderDays}
                costSharingCurrencyConvert={convertCurrency}
                onManageCostSharingMembers={openCostSharingMembers}
                costSharingManageMembersButtonRef={costSharingManageMembersButtonRef}
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
      <CostSharingMemberDialog
        open={memberDialogOpen}
        restoreFocus={props.open}
        onOpenChange={handleCostSharingMemberDialogOpenChange}
        onClose={closeCostSharingMembers}
        id={id}
        formData={formData}
        update={updateCostSharingFormField}
        currencyOptions={currencyOptions}
        currencyConvert={convertCurrency}
        manageMembersButtonRef={costSharingManageMembersButtonRef}
        initialMemberNameInputRef={costSharingFirstMemberNameInputRef}
        title={t("subscription.costSharing.manageMembersTitle")}
        description={t("subscription.costSharing.manageMembersDescription")}
        backLabel={t("subscription.costSharing.backToForm")}
        doneLabel={t("subscription.costSharing.doneManagingMembers")}
        closeLabel={t("common.close")}
      />
    </>
  );
}

type CostSharingMemberDialogProps = {
  open: boolean;
  restoreFocus: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  id: (name: string) => string;
  formData: SubscriptionFormState;
  update: <K extends keyof SubscriptionFormState>(key: K, value: SubscriptionFormState[K]) => void;
  currencyOptions: ReturnType<typeof createCurrencySelectOptions>;
  currencyConvert?: ((amount: number | string, fromCurrency: string, toCurrency: string) => number) | undefined;
  manageMembersButtonRef: RefObject<HTMLButtonElement | null>;
  initialMemberNameInputRef: RefObject<HTMLInputElement | null>;
  title: string;
  description: string;
  backLabel: string;
  doneLabel: string;
  closeLabel: string;
};

function CostSharingMemberDialog({
  open,
  restoreFocus,
  onOpenChange,
  onClose,
  id,
  formData,
  update,
  currencyOptions,
  currencyConvert,
  manageMembersButtonRef,
  initialMemberNameInputRef,
  title,
  description,
  backLabel,
  doneLabel,
  closeLabel,
}: CostSharingMemberDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={closeLabel}
        dismissMode="explicit"
        layout="frame"
        className="h5-dialog-frame h5-subscription-dialog-panel border-border bg-card p-0 sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          initialMemberNameInputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (restoreFocus) {
            manageMembersButtonRef.current?.focus();
          }
        }}
      >
        <DialogHeader data-subscription-cost-sharing-manager-header="" className="shrink-0 p-6 pb-0">
          <DialogTitle className="text-xl font-semibold">
            {title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="h5-subscription-dialog-form overflow-hidden">
          <CostSharingMemberManagerView
            id={id}
            formData={formData}
            update={update}
            currencyOptions={currencyOptions}
            currencyConvert={currencyConvert}
            initialMemberNameInputRef={initialMemberNameInputRef}
          />
          <div
            data-subscription-cost-sharing-manager-footer=""
            className="flex shrink-0 flex-col gap-3 border-t border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end md:p-6 md:pt-4"
          >
            <Button type="button" variant="outline" onClick={onClose} className="w-full border-border sm:w-auto">
              <ArrowLeft className="h-4 w-4" />
              {backLabel}
            </Button>
            <Button
              type="button"
              onClick={onClose}
              className="w-full bg-primary text-primary-foreground hover:bg-primary-glow sm:w-auto"
            >
              {doneLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
