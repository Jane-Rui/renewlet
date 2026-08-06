import { isSupportedExchangeRateCurrency } from "@/lib/currency-data";
import type { AppSettings } from "@/types/subscription";
import { moneyToNumber } from "@renewlet/shared/money";

export type SubscriptionCurrencyConverter = (
  amount: number | string,
  fromCurrency: string,
  toCurrency: string,
) => number;

export interface SubscriptionPriceReference {
  amount: number;
  currency: string;
}

export interface SubscriptionPriceReferenceOptions {
  price: number | string;
  currency: string;
  targetCurrency: string | null | undefined;
  currencyRatesReady: boolean;
  currencyConvert: SubscriptionCurrencyConverter;
}

export function resolveSubscriptionPriceReferenceCurrency(
  settings: Pick<AppSettings, "defaultCurrency" | "subscriptionPriceReferenceEnabled" | "subscriptionPriceReferenceCurrency">,
): string | null {
  if (!settings.subscriptionPriceReferenceEnabled) return null;
  const currency = settings.subscriptionPriceReferenceCurrency === "default"
    ? settings.defaultCurrency
    : settings.subscriptionPriceReferenceCurrency;
  const normalizedCurrency = currency.trim().toUpperCase();
  return normalizedCurrency.length > 0 ? normalizedCurrency : null;
}

export function getSubscriptionPriceReference({
  price,
  currency,
  targetCurrency,
  currencyRatesReady,
  currencyConvert,
}: SubscriptionPriceReferenceOptions): SubscriptionPriceReference | null {
  const sourceCurrency = currency.trim().toUpperCase();
  const referenceCurrency = targetCurrency?.trim().toUpperCase() ?? "";
  const numericPrice = moneyToNumber(price);

  if (!currencyRatesReady) return null;
  if (!referenceCurrency) return null;
  if (sourceCurrency === referenceCurrency) return null;
  if (!isSupportedExchangeRateCurrency(sourceCurrency)) return null;
  if (!isSupportedExchangeRateCurrency(referenceCurrency)) return null;
  if (numericPrice <= 0) return null;

  // convert 缺汇率时会按 1:1 兜底；只有上层确认真实 sourceDate 后才允许展示参考价。
  const convertedAmount = currencyConvert(numericPrice, sourceCurrency, referenceCurrency);
  if (!Number.isFinite(convertedAmount) || convertedAmount <= 0) return null;

  return { amount: convertedAmount, currency: referenceCurrency };
}
