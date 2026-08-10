import { useEffect, useState, type Ref } from "react";
import { DateOnlyPickerField } from "@/components/date-only-picker-field";
import { FieldError } from "@/components/ui/field-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumericInput } from "@/components/ui/numeric-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/I18nProvider";
import type { Locale } from "@/i18n/locales";
import type { MessageKey, MessageParams } from "@/i18n/messages";
import { formatCurrencySymbolAmount, getCurrencyAmountPrefix } from "@/lib/currency";
import type { SearchableSelectOption } from "@/lib/searchable-options";
import { formatBillingCycleLabel } from "@/lib/subscription-billing";
import { parseMoneyInput, parseNonNegativeIntegerInput, parsePositiveIntegerInput, resolveCostSharingJoinedDateRangeForForm } from "@/lib/subscription-form";
import type { CostSharing, CostSharingMember } from "@/types/subscription";
import { INHERIT_REMINDER_DAYS, REMINDER_DAYS_OPTIONS } from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";
import {
  calculateCostSharingMemberAmount,
  calculateCostSharingSummary,
  costSharingMemberJoinedDateIsWithinRange,
  isValidCostSharingCollectionReminderDays,
  type CostSharingCollectionReminder,
} from "@renewlet/shared/cost-sharing";
import { moneyToNumber } from "@renewlet/shared/money";
import { Plus, Trash2, Users } from "lucide-react";

type CostSharingFieldUpdater = <K extends keyof SubscriptionFormState>(
  key: K,
  value: SubscriptionFormState[K],
) => void;
const COLLECTION_REMINDER_CUSTOM_VALUE = "custom";

function newCostSharingId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `member-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function defaultCostSharing(t: (key: MessageKey, values?: MessageParams) => string): CostSharing {
  const firstMemberId = newCostSharingId();
  return {
    enabled: true,
    splitMode: "equal",
    members: [
      { id: firstMemberId, name: t("subscription.costSharing.memberDefault", { index: 1 }) },
    ],
  };
}

function defaultCollectionReminder(): CostSharingCollectionReminder {
  return {
    enabled: true,
    reminderDays: INHERIT_REMINDER_DAYS,
  };
}

function normalizeCostSharingSelection(costSharing: CostSharing): CostSharing {
  const members = costSharing.members.length > 0 ? costSharing.members : [{ id: newCostSharingId(), name: "Member 1" }];
  return {
    ...costSharing,
    members,
  };
}

function costSharingTotal(formData: SubscriptionFormState): number {
  const price = moneyToNumber(formData.price);
  return Number.isFinite(price) && price >= 0 ? price : 0;
}

function costSharingAmountsDiffer(a: number, b: number): boolean {
  return Math.abs(a - b) >= 0.01;
}

function setCostSharing(update: CostSharingFieldUpdater, next: CostSharing | undefined) {
  update("costSharing", next ? normalizeCostSharingSelection(next) : undefined);
}

function collectionReminderSelectValue(reminder: CostSharingCollectionReminder | undefined): string {
  const days = reminder?.reminderDays ?? INHERIT_REMINDER_DAYS;
  if (days === INHERIT_REMINDER_DAYS) return String(INHERIT_REMINDER_DAYS);
  if (REMINDER_DAYS_OPTIONS.some((option) => option.value === days)) return String(days);
  return COLLECTION_REMINDER_CUSTOM_VALUE;
}

function defaultCustomCollectionReminderDays(): number {
  return 2;
}

function collectionReminderLeadLabel(t: (key: MessageKey, values?: MessageParams) => string, reminderDays: number): string {
  return reminderDays === 0
    ? t("subscription.costSharing.collectionReminderLeadToday")
    : t("subscription.costSharing.collectionReminderLeadDays", { days: reminderDays });
}

function billingCycleLabelForForm(formData: SubscriptionFormState, locale: Locale): string {
  const customDays = formData.billingCycle === "custom" ? parsePositiveIntegerInput(formData.customDays) ?? 1 : undefined;
  return formatBillingCycleLabel({
    billingCycle: formData.billingCycle,
    customDays,
    customCycleUnit: formData.customCycleUnit,
  }, locale);
}

function collectionReminderSummaryText(
  t: (key: MessageKey, values?: MessageParams) => string,
  reminder: CostSharingCollectionReminder | undefined,
  notificationReminderDays: number,
  cycleLabel: string,
  allowed = true,
): string {
  if (!allowed) return t("subscription.costSharing.collectionReminderSummaryUnavailableForBuyout");
  if (!reminder?.enabled) return t("subscription.costSharing.collectionReminderSummaryDisabled");
  const leadDays = reminder.reminderDays === INHERIT_REMINDER_DAYS || !isValidCostSharingCollectionReminderDays(reminder.reminderDays)
    ? notificationReminderDays
    : reminder.reminderDays;
  const lead = collectionReminderLeadLabel(t, leadDays);
  return t("subscription.costSharing.collectionReminderSummary", {
    cycle: t("subscription.costSharing.collectionReminderInheritedCycle", { cycle: cycleLabel }),
    anchor: t("subscription.costSharing.collectionReminderAnchorMemberJoined"),
    lead,
  });
}

function CostSharingSummaryGrid({
  memberTotal,
  yourShare,
  recoverableAmount,
  currency,
}: {
  memberTotal: number;
  yourShare: number;
  recoverableAmount: number;
  currency: string;
}) {
  const { t, formatCurrency } = useI18n();

  return (
    <div data-testid="cost-sharing-summary" className="grid gap-2 rounded-md bg-background/60 p-3 text-sm sm:grid-cols-3">
      <div>
        <p className="text-muted-foreground">{t("subscription.costSharing.memberTotal")}</p>
        <p className="font-semibold text-warning">{formatCurrency(memberTotal, currency)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">{t("subscription.costSharing.yourShare")}</p>
        <p className="font-semibold text-primary">{formatCurrency(yourShare, currency)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">{t("subscription.costSharing.recoverableAmount")}</p>
        <p className="font-semibold text-foreground">{formatCurrency(recoverableAmount, currency)}</p>
      </div>
    </div>
  );
}

export function CostSharingFields({
  id,
  formData,
  update,
  error,
  currencyConvert,
  notificationReminderDays,
  collectionReminderAllowed,
  onManageMembers,
  manageMembersButtonRef,
}: {
  id: (name: string) => string;
  formData: SubscriptionFormState;
  update: CostSharingFieldUpdater;
  error?: string | undefined;
  currencyOptions: SearchableSelectOption[];
  currencyConvert?: ((amount: number | string, fromCurrency: string, toCurrency: string) => number) | undefined;
  notificationReminderDays: number;
  collectionReminderAllowed: boolean;
  onManageMembers?: (() => void) | undefined;
  manageMembersButtonRef?: Ref<HTMLButtonElement> | undefined;
}) {
  const { t, locale } = useI18n();
  const costSharing = formData.costSharing;
  const total = costSharingTotal(formData);
  const summary = calculateCostSharingSummary(costSharing, total, { baseCurrency: formData.currency, convert: currencyConvert });
  const enabled = Boolean(costSharing?.enabled);
  const collectionReminder = costSharing?.collectionReminder;
  const cycleLabel = billingCycleLabelForForm(formData, locale);
  const collectionReminderSummary = collectionReminderSummaryText(t, collectionReminder, notificationReminderDays, cycleLabel, collectionReminderAllowed);
  const showCustomTotalHint = Boolean(
    costSharing?.splitMode === "custom" && costSharingAmountsDiffer(summary.memberTotal, total),
  );

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-secondary/30 p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={id("costSharingEnabled")} className="cursor-pointer text-sm font-medium">
            {t("subscription.costSharing.title")}
          </Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("subscription.costSharing.help")}</p>
        </div>
        <Switch
          id={id("costSharingEnabled")}
          checked={enabled}
          onCheckedChange={(checked) => setCostSharing(update, checked ? { ...(costSharing ?? defaultCostSharing(t)), enabled: true } : undefined)}
          aria-label={t("subscription.costSharing.title")}
        />
      </div>

      {enabled && costSharing ? (
        <>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_auto] sm:items-end sm:justify-between">
            <div className="grid gap-2">
              <Label htmlFor={id("costSharingSplitMode")}>{t("subscription.costSharing.splitMode")}</Label>
              <Select value={costSharing.splitMode} onValueChange={(value) => setCostSharing(update, { ...costSharing, splitMode: value as CostSharing["splitMode"] })}>
                <SelectTrigger id={id("costSharingSplitMode")} className="border-border bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="equal">{t("subscription.costSharing.equal")}</SelectItem>
                  <SelectItem value="custom">{t("subscription.costSharing.custom")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2 sm:items-end">
              <span className="text-xs text-muted-foreground">
                {t("subscription.costSharing.memberCount", { count: summary.memberCount })}
              </span>
              {onManageMembers ? (
                <Button
                  ref={manageMembersButtonRef}
                  type="button"
                  variant="outline"
                  size="sm"
                  data-cost-sharing-manage-members-trigger=""
                  className="w-fit border-border"
                  onClick={onManageMembers}
                >
                  <Users className="h-4 w-4" />
                  {t("subscription.costSharing.manageMembers")}
                </Button>
              ) : null}
            </div>
          </div>

          <CostSharingSummaryGrid
            memberTotal={summary.memberTotal}
            yourShare={summary.yourShare}
            recoverableAmount={summary.recoverableAmount}
            currency={formData.currency}
          />
          {showCustomTotalHint ? (
            <p data-testid="cost-sharing-custom-total-hint" className="text-xs leading-5 text-muted-foreground">
              {t("subscription.costSharing.customTotalMismatchHint")}
            </p>
          ) : null}
          <p data-testid="cost-sharing-collection-reminder-summary" className="min-w-0 text-xs leading-5 text-muted-foreground">
            {collectionReminderSummary}
          </p>
          <FieldError id={id("costSharing-error")} message={error} />
        </>
      ) : null}
    </div>
  );
}

export function CostSharingMemberManagerView({
  id,
  formData,
  update,
  currencyOptions,
  currencyConvert,
  notificationReminderDays,
  collectionReminderAllowed,
  error,
  initialMemberNameInputRef,
}: {
  id: (name: string) => string;
  formData: SubscriptionFormState;
  update: CostSharingFieldUpdater;
  currencyOptions: SearchableSelectOption[];
  currencyConvert?: ((amount: number | string, fromCurrency: string, toCurrency: string) => number) | undefined;
  notificationReminderDays: number;
  collectionReminderAllowed: boolean;
  error?: string | undefined;
  initialMemberNameInputRef?: Ref<HTMLInputElement> | undefined;
}) {
  const { t, locale, label } = useI18n();
  const costSharing = formData.costSharing ?? defaultCostSharing(t);
  const members = costSharing.members;
  const total = costSharingTotal(formData);
  const summary = calculateCostSharingSummary(costSharing, total, { baseCurrency: formData.currency, convert: currencyConvert });
  const collectionReminder = costSharing.collectionReminder;
  const collectionReminderEnabled = collectionReminderAllowed && Boolean(collectionReminder?.enabled);
  const collectionReminderValue = collectionReminderSelectValue(collectionReminder);
  const collectionReminderCustomDays =
    collectionReminderValue === COLLECTION_REMINDER_CUSTOM_VALUE && collectionReminder?.reminderDays !== undefined
      ? String(collectionReminder.reminderDays)
      : "";
  const [collectionReminderCustomInput, setCollectionReminderCustomInput] = useState(collectionReminderCustomDays);
  const managerErrorId = id("costSharingMembers-error");
  useEffect(() => {
    // 数字输入要允许用户清空重输；只有外部 preset/订阅切换时才把本地草稿同步回持久值。
    setCollectionReminderCustomInput(collectionReminderCustomDays);
  }, [collectionReminderCustomDays]);
  const joinedDateRequired = collectionReminderEnabled && !formData.startDate;
  const joinedDateRange = resolveCostSharingJoinedDateRangeForForm(formData);
  const joinedDateRangeInvalid = members.some((member) => !costSharingMemberJoinedDateIsWithinRange(member, joinedDateRange));
  const displayError = error ?? (joinedDateRangeInvalid ? t("subscription.validation.costSharingMemberJoinedDateRangeInvalid") : undefined);
  const cycleLabel = billingCycleLabelForForm(formData, locale);
  const memberShareInCurrency = (member: CostSharingMember) => {
    const memberCurrency = member.currency ?? formData.currency;
    const baseShare = calculateCostSharingMemberAmount(costSharing, member, total, {
      baseCurrency: formData.currency,
      convert: currencyConvert,
    });
    return currencyConvert ? currencyConvert(baseShare, formData.currency, memberCurrency) : baseShare;
  };

  const updateMember = (memberId: string, patch: Partial<CostSharingMember>) => {
    setCostSharing(update, {
      ...costSharing,
      enabled: true,
      members: costSharing.members.map((member) => member.id === memberId ? { ...member, ...patch } : member),
    });
  };

  const updateCollectionReminder = (next: CostSharingCollectionReminder | undefined) => {
    setCostSharing(update, { ...costSharing, enabled: true, collectionReminder: next });
  };

  const removeMember = (memberId: string) => {
    if (costSharing.members.length <= 1) return;
    const nextMembers = costSharing.members.filter((member) => member.id !== memberId);
    setCostSharing(update, {
      ...costSharing,
      enabled: true,
      members: nextMembers,
    });
  };

  const addMember = () => {
    setCostSharing(update, {
      ...costSharing,
      enabled: true,
      members: [
        ...costSharing.members,
        {
          id: newCostSharingId(),
          name: t("subscription.costSharing.memberDefault", { index: costSharing.members.length + 1 }),
        },
      ],
    });
  };

  return (
    <div data-testid="cost-sharing-members-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {t("subscription.costSharing.memberCount", { count: summary.memberCount })}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("subscription.costSharing.manageMembersDescription")}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" className="w-fit border-border" onClick={addMember}>
            <Plus className="h-4 w-4" />
            {t("subscription.costSharing.addMember")}
          </Button>
        </div>
        <div className="mt-3 grid gap-3 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor={id("costSharingCollectionReminderEnabled")} className="cursor-pointer text-sm font-medium">
                {t("subscription.costSharing.collectionReminder")}
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {collectionReminderSummaryText(t, collectionReminder, notificationReminderDays, cycleLabel, collectionReminderAllowed)}
              </p>
            </div>
            <Switch
              id={id("costSharingCollectionReminderEnabled")}
              checked={collectionReminderEnabled}
              disabled={!collectionReminderAllowed}
              onCheckedChange={(checked) => {
                if (!collectionReminderAllowed) return;
                updateCollectionReminder(checked
                  ? { ...(collectionReminder ?? defaultCollectionReminder()), enabled: true }
                  : { ...(collectionReminder ?? defaultCollectionReminder()), enabled: false });
              }}
              aria-label={t("subscription.costSharing.collectionReminder")}
            />
          </div>

          {collectionReminderEnabled ? (
            <div className="grid gap-3 sm:max-w-sm">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor={id("costSharingCollectionReminderDays")}>{t("subscription.costSharing.collectionReminderBefore")}</Label>
                <Select
                  value={collectionReminderValue}
                  onValueChange={(value) => {
                    if (value === COLLECTION_REMINDER_CUSTOM_VALUE) {
                      updateCollectionReminder({
                        ...(collectionReminder ?? defaultCollectionReminder()),
                        enabled: true,
                        reminderDays: defaultCustomCollectionReminderDays(),
                      });
                      return;
                    }
                    const days = Number(value);
                    updateCollectionReminder({
                      ...(collectionReminder ?? defaultCollectionReminder()),
                      enabled: true,
                      reminderDays: isValidCostSharingCollectionReminderDays(days) ? days : INHERIT_REMINDER_DAYS,
                    });
                  }}
                >
                  <SelectTrigger
                    id={id("costSharingCollectionReminderDays")}
                    className="border-border bg-secondary"
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? managerErrorId : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={String(INHERIT_REMINDER_DAYS)}>
                      {t("subscription.costSharing.collectionReminderInherit", { days: notificationReminderDays })}
                    </SelectItem>
                    {REMINDER_DAYS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value.toString()}>
                        {label(option.labels)}
                      </SelectItem>
                    ))}
                    <SelectItem value={COLLECTION_REMINDER_CUSTOM_VALUE}>
                      {t("subscription.costSharing.collectionReminderCustom")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {collectionReminderValue === COLLECTION_REMINDER_CUSTOM_VALUE ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="whitespace-nowrap text-sm text-muted-foreground">
                    {t("subscription.costSharing.collectionReminderBefore")}
                  </span>
                  <NumericInput
                    name={id("costSharingCollectionReminderCustomDays")}
                    allowNegative={false}
                    decimalScale={0}
                    inputMode="numeric"
                    enterKeyHint="next"
                    placeholder={t("subscription.daysPlaceholder")}
                    value={collectionReminderCustomInput}
                    onRawValueChange={(value) => {
                      // 自定义输入允许空字符串过渡；真实 payload 只在可解析数字时同步到 costSharing。
                      setCollectionReminderCustomInput(value);
                      const parsed = parseNonNegativeIntegerInput(value);
                      if (parsed !== null) {
                        updateCollectionReminder({
                          ...(collectionReminder ?? defaultCollectionReminder()),
                          enabled: true,
                          reminderDays: parsed,
                        });
                      }
                    }}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? managerErrorId : undefined}
                    className="w-20 border-border bg-secondary"
                  />
                  <span className="text-sm text-muted-foreground">{t("subscription.daysUnit")}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <FieldError id={managerErrorId} message={displayError} />
        </div>
      </div>

      <div data-testid="cost-sharing-members-scroll" className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="grid gap-2.5">
          {members.map((member, index) => {
            return (
              <div
                key={member.id}
                className="grid min-w-0 gap-3 rounded-lg border border-border bg-secondary/30 p-3 sm:grid-cols-[minmax(11rem,1fr)_minmax(9rem,10rem)_minmax(12rem,14rem)_2.25rem] sm:items-end"
              >
                <div className="grid min-w-0 gap-1.5">
                  <Label htmlFor={id(`costSharingMemberName-${member.id}`)} className="text-xs text-muted-foreground">
                    {t("subscription.costSharing.memberName")}
                  </Label>
                  <Input
                    ref={index === 0 ? initialMemberNameInputRef : undefined}
                    id={id(`costSharingMemberName-${member.id}`)}
                    value={member.name}
                    onChange={(event) => updateMember(member.id, { name: event.target.value })}
                    aria-label={t("subscription.costSharing.memberName")}
                    className="h-9 border-border bg-secondary font-medium"
                  />
                  <Label htmlFor={id(`costSharingMemberNote-${member.id}`)} className="sr-only">
                    {t("subscription.costSharing.memberNote")}
                  </Label>
                  <Input
                    id={id(`costSharingMemberNote-${member.id}`)}
                    value={member.note ?? ""}
                    onChange={(event) => updateMember(member.id, { note: event.target.value })}
                    aria-label={t("subscription.costSharing.memberNote")}
                    placeholder={t("subscription.costSharing.memberNotePlaceholder")}
                    className="h-8 border-border bg-secondary text-sm text-muted-foreground placeholder:text-muted-foreground/70"
                  />
                </div>
                <MemberJoinedDateField
                  id={id}
                  member={member}
                  value={member.joinedDate}
                  onChange={(value) => updateMember(member.id, { joinedDate: value })}
                  label={t("subscription.costSharing.memberJoinedDate")}
                  placeholder={t("subscription.placeholder.date")}
                  invalid={(joinedDateRequired && !member.joinedDate) || !costSharingMemberJoinedDateIsWithinRange(member, joinedDateRange)}
                  describedBy={displayError ? managerErrorId : undefined}
                  minDate={joinedDateRange.minDate ?? undefined}
                  maxDate={joinedDateRange.maxDate ?? undefined}
                  defaultMonth={member.joinedDate ?? joinedDateRange.minDate ?? joinedDateRange.maxDate ?? undefined}
                />
                {costSharing.splitMode === "custom" ? (
                  <div className="grid min-w-0 gap-1.5">
                    <Label htmlFor={id(`costSharingMemberAmount-${member.id}`)} className="text-xs text-muted-foreground">
                      {t("subscription.costSharing.customAmount")}
                    </Label>
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] gap-1.5">
                      <NumericInput
                        id={id(`costSharingMemberAmount-${member.id}`)}
                        name={id(`costSharingMemberAmount-${member.id}`)}
                        allowNegative={false}
                        allowedDecimalSeparators={[".", "。"]}
                        inputMode="decimal"
                        placeholder="0.00"
                        prefix={getCurrencyAmountPrefix(member.currency ?? formData.currency, locale)}
                        value={member.customAmount?.toString() ?? ""}
                        onRawValueChange={(value) => updateMember(member.id, { customAmount: value.trim() === "" ? undefined : parseMoneyInput(value) ?? undefined })}
                        className="h-9 min-w-0 border-border bg-secondary px-2 font-semibold sm:text-right"
                        aria-label={t("subscription.costSharing.customAmount")}
                      />
                      <MemberCurrencySelect
                        value={member.currency ?? formData.currency}
                        onValueChange={(value) => updateMember(member.id, { currency: value })}
                        options={currencyOptions}
                        ariaLabel={t("subscription.costSharing.memberCurrency")}
                        placeholder={t("subscription.placeholder.currency")}
                        searchPlaceholder={t("subscription.search.currency")}
                        emptyMessage={t("subscription.empty.currency")}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="grid min-w-0 gap-1.5">
                    <Label className="text-xs text-muted-foreground">
                      {t("subscription.costSharing.customAmount")}
                    </Label>
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] gap-1.5">
                      <span className="flex min-h-9 min-w-0 items-center justify-end rounded-md bg-secondary px-2.5 py-2 text-right text-sm font-semibold leading-5 tabular-nums text-foreground">
                        <span className="max-w-full break-all">
                          {formatCurrencySymbolAmount(memberShareInCurrency(member), member.currency ?? formData.currency, locale)}
                        </span>
                      </span>
                      <MemberCurrencySelect
                        value={member.currency ?? formData.currency}
                        onValueChange={(value) => updateMember(member.id, { currency: value })}
                        options={currencyOptions}
                        ariaLabel={t("subscription.costSharing.memberCurrency")}
                        placeholder={t("subscription.placeholder.currency")}
                        searchPlaceholder={t("subscription.search.currency")}
                        emptyMessage={t("subscription.empty.currency")}
                      />
                    </div>
                  </div>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 justify-self-end text-destructive hover:bg-destructive/10 hover:text-destructive sm:self-end"
                  onClick={() => removeMember(member.id)}
                  disabled={members.length <= 1}
                  aria-label={t("common.delete")}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MemberJoinedDateField({
  id,
  member,
  value,
  onChange,
  label,
  placeholder,
  invalid,
  describedBy,
  minDate,
  maxDate,
  defaultMonth,
}: {
  id: (name: string) => string;
  member: CostSharingMember;
  value: CostSharingMember["joinedDate"];
  onChange: (value: CostSharingMember["joinedDate"]) => void;
  label: string;
  placeholder: string;
  invalid: boolean;
  describedBy?: string | undefined;
  minDate?: string | undefined;
  maxDate?: string | undefined;
  defaultMonth?: string | undefined;
}) {
  const fieldId = id(`costSharingMemberJoinedDate-${member.id}`);
  const labelId = id(`costSharingMemberJoinedDate-${member.id}-label`);
  const valueId = id(`costSharingMemberJoinedDate-${member.id}-value`);

  return (
    <div className="grid min-w-0 gap-1.5">
      <Label id={labelId} htmlFor={fieldId} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <DateOnlyPickerField
        id={fieldId}
        labelId={labelId}
        valueId={valueId}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        invalid={invalid}
        describedBy={describedBy}
        minDate={minDate}
        maxDate={maxDate}
        defaultMonth={defaultMonth}
        buttonClassName="h-9 text-sm"
      />
    </div>
  );
}

function MemberCurrencySelect({
  value,
  onValueChange,
  options,
  ariaLabel,
  placeholder,
  searchPlaceholder,
  emptyMessage,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  ariaLabel: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
}) {
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      options={options}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyMessage={emptyMessage}
      className="h-9 border-border bg-secondary px-2 text-sm font-semibold"
      contentClassName="min-w-[16rem]"
      aria-label={ariaLabel}
      renderValue={(option) => (
        <span className="block truncate text-center tracking-wide">{option?.value ?? value}</span>
      )}
      renderOption={(option) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-medium">{option.value}</span>
          <span className="min-w-0 truncate text-muted-foreground">{option.label}</span>
        </span>
      )}
    />
  );
}
