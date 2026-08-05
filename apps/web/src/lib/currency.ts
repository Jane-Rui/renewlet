/**
 * 货币展示工具（前端 UI 用）。
 *
 * 背景：
 * - 多个组件里都有 `new Intl.NumberFormat(...).format(...)` 的重复实现
 * - 集中到这里方便统一展示规则与异常兜底
 */
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { moneyToNumber } from "@renewlet/shared/money";

/** currency 来自用户配置和导入数据，非法值只能降级展示，不能让统计页崩溃。 */
export function formatCurrency(amount: number | string, currency: string, locale = DEFAULT_LOCALE): string {
  const numericAmount = moneyToNumber(amount);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(numericAmount);
  } catch {
    return `${currency} ${Number.isInteger(numericAmount) ? numericAmount.toFixed(0) : numericAmount.toFixed(2)}`;
  }
}
