import type { Ref } from "react";
import { FieldError } from "@/components/ui/field-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumericInput } from "@/components/ui/numeric-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey, MessageParams } from "@/i18n/messages";
import type { SearchableSelectOption } from "@/lib/searchable-options";
import { parseMoneyInput } from "@/lib/subscription-form";
import type { CostSharing, CostSharingMember } from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";
import { calculateCostSharingMemberAmount, calculateCostSharingSummary } from "@renewlet/shared/cost-sharing";
import { moneyToNumber } from "@renewlet/shared/money";
import { Plus, Trash2, Users } from "lucide-react";

type CostSharingFieldUpdater = <K extends keyof SubscriptionFormState>(
  key: K,
  value: SubscriptionFormState[K],
) => void;

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

function normalizeCostSharingSelection(costSharing: CostSharing): CostSharing {
  const members = costSharing.members.length > 0 ? costSharing.members : [{ id: newCostSharingId(), name: "Member 1" }];
  return {
    ...costSharing,
    members,
  };
}

function costSharingMemberInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
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
  onManageMembers,
  manageMembersButtonRef,
}: {
  id: (name: string) => string;
  formData: SubscriptionFormState;
  update: CostSharingFieldUpdater;
  error?: string | undefined;
  currencyOptions: SearchableSelectOption[];
  currencyConvert?: ((amount: number | string, fromCurrency: string, toCurrency: string) => number) | undefined;
  onManageMembers?: (() => void) | undefined;
  manageMembersButtonRef?: Ref<HTMLButtonElement> | undefined;
}) {
  const { t } = useI18n();
  const costSharing = formData.costSharing;
  const total = costSharingTotal(formData);
  const summary = calculateCostSharingSummary(costSharing, total, { baseCurrency: formData.currency, convert: currencyConvert });
  const enabled = Boolean(costSharing?.enabled);
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
  initialMemberNameInputRef,
}: {
  id: (name: string) => string;
  formData: SubscriptionFormState;
  update: CostSharingFieldUpdater;
  currencyOptions: SearchableSelectOption[];
  currencyConvert?: ((amount: number | string, fromCurrency: string, toCurrency: string) => number) | undefined;
  initialMemberNameInputRef?: Ref<HTMLInputElement> | undefined;
}) {
  const { t, formatCurrency } = useI18n();
  const costSharing = formData.costSharing ?? defaultCostSharing(t);
  const members = costSharing.members;
  const total = costSharingTotal(formData);
  const summary = calculateCostSharingSummary(costSharing, total, { baseCurrency: formData.currency, convert: currencyConvert });
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
      </div>

      <div data-testid="cost-sharing-members-scroll" className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="grid gap-2">
          {members.map((member, index) => {
            return (
              <div
                key={member.id}
                className="grid gap-2.5 rounded-lg border border-border bg-background/70 p-3 shadow-sm transition-colors hover:bg-background sm:grid-cols-[minmax(0,1fr)_minmax(10.5rem,11rem)_2.25rem] sm:items-center"
              >
                <div className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-2">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-xs font-semibold text-primary shadow-inner">
                    {costSharingMemberInitial(member.name)}
                  </div>
                  <div className="grid min-w-0 gap-2">
                    <Label htmlFor={id(`costSharingMemberName-${member.id}`)} className="sr-only">
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
                </div>
                {costSharing.splitMode === "custom" ? (
                  <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-1.5">
                    <NumericInput
                      allowNegative={false}
                      allowedDecimalSeparators={[".", "。"]}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={member.customAmount?.toString() ?? ""}
                      onRawValueChange={(value) => updateMember(member.id, { customAmount: value.trim() === "" ? undefined : parseMoneyInput(value) ?? undefined })}
                      className="h-9 border-border bg-secondary px-2 font-semibold sm:text-right"
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
                ) : (
                  <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-1.5">
                    <span className="truncate rounded-md bg-secondary px-2.5 py-2 text-sm font-semibold text-foreground sm:text-right">
                      {formatCurrency(memberShareInCurrency(member), member.currency ?? formData.currency)}
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
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 justify-self-end text-destructive hover:bg-destructive/10 hover:text-destructive"
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
        <span className="block text-center tracking-wide">{option?.value ?? value}</span>
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
