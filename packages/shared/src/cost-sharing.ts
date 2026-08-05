import { divideMoney, moneyToNumber, type MoneyString } from "./money";

export const COST_SHARING_SPLIT_MODES = ["equal", "custom"] as const;

export type CostSharingSplitMode = (typeof COST_SHARING_SPLIT_MODES)[number];

export interface CostSharingMember {
  id: string;
  name: string;
  note?: string | undefined;
  currency?: string | undefined;
  customAmount?: MoneyString | undefined;
}

export interface CostSharing {
  enabled: boolean;
  splitMode: CostSharingSplitMode;
  members: CostSharingMember[];
}

export interface CostSharingSummary {
  enabled: boolean;
  total: number;
  yourShare: number;
  /** 成员合计是共享成员金额总和；custom 模式允许它和订阅总价不一致。 */
  memberTotal: number;
  /** 当前用户固定是付款人，成员金额就是向其他成员应收/可回收的金额。 */
  recoverableAmount: number;
  memberCount: number;
}

export type CostSharingCurrencyConverter = (amount: MoneyString | number, fromCurrency: string, toCurrency: string) => number;

export interface CostSharingCalculationOptions {
  baseCurrency?: string | undefined;
  convert?: CostSharingCurrencyConverter | undefined;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function isCostSharingEnabled(costSharing: CostSharing | undefined): costSharing is CostSharing {
  return Boolean(costSharing?.enabled && costSharing.members.length > 0);
}

function convertMemberAmountToBase(
  amount: MoneyString | number,
  member: CostSharingMember,
  options: CostSharingCalculationOptions | undefined,
): number {
  const baseCurrency = options?.baseCurrency;
  const memberCurrency = member.currency ?? baseCurrency;
  // 跨币种分摊只在调用方提供基础币种和转换器时换算；否则保留原金额，避免 shared 层猜测汇率。
  const numericAmount = moneyToNumber(amount);
  if (!baseCurrency || !memberCurrency || memberCurrency === baseCurrency || !options?.convert) return numericAmount;
  return options.convert(amount, memberCurrency, baseCurrency);
}

export function calculateCostSharingMemberAmount(
  costSharing: CostSharing,
  member: CostSharingMember,
  total: MoneyString | number,
  options?: CostSharingCalculationOptions,
): number {
  if (costSharing.splitMode === "custom") {
    return roundMoney(convertMemberAmountToBase(member.customAmount ?? 0, member, options));
  }
  const participantCount = costSharing.members.length + 1;
  if (participantCount <= 1) return 0;
  return roundMoney(moneyToNumber(divideMoney(total, participantCount)));
}

export function calculateCostSharingSummary(
  costSharing: CostSharing | undefined,
  total: MoneyString | number,
  options?: CostSharingCalculationOptions,
): CostSharingSummary {
  const numericTotal = moneyToNumber(total);
  if (!isCostSharingEnabled(costSharing)) {
    return {
      enabled: false,
      total: numericTotal,
      yourShare: numericTotal,
      memberTotal: 0,
      recoverableAmount: 0,
      memberCount: 0,
    };
  }

  // 当前用户不在 members 里：equal 按“我 + 成员”平分，custom 则把成员金额直接视作应收款，允许超过订阅总价。
  const memberTotal = costSharing.splitMode === "equal"
    ? roundMoney(Math.max(numericTotal - calculateCostSharingMemberAmount(costSharing, costSharing.members[0]!, total, options), 0))
    : roundMoney(costSharing.members.reduce(
        (sum, member) => sum + calculateCostSharingMemberAmount(costSharing, member, total, options),
        0,
      ));
  const yourShare = roundMoney(Math.max(numericTotal - memberTotal, 0));
  const recoverableAmount = memberTotal;

  return {
    enabled: true,
    total: numericTotal,
    yourShare,
    memberTotal,
    recoverableAmount,
    memberCount: costSharing.members.length,
  };
}

export function costSharingCustomAmountsAreValid(costSharing: CostSharing): boolean {
  if (costSharing.splitMode !== "custom") return true;
  return costSharing.members.every((member) => {
    return member.customAmount !== undefined && moneyToNumber(member.customAmount) >= 0;
  });
}
