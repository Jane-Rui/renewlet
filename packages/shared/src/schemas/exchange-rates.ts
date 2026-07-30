import { z } from "zod";
import { normalizeExchangeRateProvider } from "../runtime";

/**
 * 汇率 provider 枚举。
 *
 * settings 里只保存 provider key；具体外部 API 响应由前端 service 层转换成统一 USD 基准数据。
 */
export const exchangeRateProviderSchema = z.enum(["frankfurter", "floatrates", "exchange-api"]);

export { normalizeExchangeRateProvider };

/** 统一汇率表以 USD 为基准，key 固定为 ISO 4217 三字母大写代码。 */
export const exchangeRatesSchema = z.record(
  z.string().regex(/^[A-Z]{3}$/),
  z.number().finite().positive(),
);

/** currency-api.pages.dev 的 USD 响应允许额外字段；只提取 date 和 usd 汇率表。 */
export const exchangeApiUsdResponseSchema = z.object({
  date: z.string().min(1),
  usd: z.record(z.string(), z.number().finite().positive()),
}).passthrough();

const positiveFiniteNumberFromProviderSchema = z.union([
  z.number().finite().positive(),
  // FloatRates 线上可能把 rate/inverseRate 返回成数字字符串；只接受普通十进制，避免 NaN/Infinity/本地化逗号混入缓存。
  z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).transform((value, context) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected a positive finite number",
      });
      return z.NEVER;
    }
    return parsed;
  }),
]);

/** Frankfurter v2 响应是数组行，不是旧版 rates map；进入缓存前会归一为 USD 大写代码表。 */
export const frankfurterRateRowSchema = z.object({
  date: z.string().min(1),
  base: z.literal("USD"),
  quote: z.string().regex(/^[A-Z]{3}$/),
  rate: z.number().finite().positive(),
}).passthrough();

export const frankfurterRatesResponseSchema = z.array(frankfurterRateRowSchema);

/** FloatRates 响应按小写货币代码分桶，进入缓存前会转换为统一大写代码表。 */
export const floatRatesRateRowSchema = z.object({
  alphaCode: z.string().regex(/^[A-Z]{3}$/),
  rate: positiveFiniteNumberFromProviderSchema,
  inverseRate: positiveFiniteNumberFromProviderSchema.optional(),
  date: z.string().min(1),
}).passthrough();

export const floatRatesResponseSchema = z.record(
  z.string().regex(/^[a-z]{3}$/),
  floatRatesRateRowSchema,
);

export const exchangeRateDataSchema = z.object({
  base: z.literal("USD"),
  date: z.string().min(1),
  rates: exchangeRatesSchema,
}).strict();

export const exchangeRateSourceSchema = z.enum(["frankfurter", "floatrates", "exchange-api", "builtin"]);

/** partial warning 只解释来源缺口；进入缓存的 rates 仍必须是完整 USD number map，统计侧不用感知补齐过程。 */
export const exchangeRateCoverageWarningSchema = z.object({
  kind: z.literal("partial"),
  provider: exchangeRateProviderSchema,
  missingCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)),
  fillSources: z.record(z.string().regex(/^[A-Z]{3}$/), exchangeRateSourceSchema),
}).strict();

/** v5 缓存记录请求 provider、实际 provider 和 warning，用于解释降级来源与 partial 补齐来源。 */
export const cachedExchangeRateDataSchema = exchangeRateDataSchema.extend({
  cachedAt: z.number().finite(),
  requestedProvider: exchangeRateProviderSchema,
  provider: exchangeRateProviderSchema,
  warning: exchangeRateCoverageWarningSchema.nullable().optional(),
}).strict();

export type ExchangeRateProvider = z.infer<typeof exchangeRateProviderSchema>;
export type ExchangeRateSource = z.infer<typeof exchangeRateSourceSchema>;
export type ExchangeRates = z.infer<typeof exchangeRatesSchema>;
export type ExchangeRateData = z.infer<typeof exchangeRateDataSchema>;
export type ExchangeRateCoverageWarning = z.infer<typeof exchangeRateCoverageWarningSchema>;
export type CachedExchangeRateData = z.infer<typeof cachedExchangeRateDataSchema>;
