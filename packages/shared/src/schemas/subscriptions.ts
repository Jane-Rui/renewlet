import { z } from "zod";
import { COST_SHARING_SPLIT_MODES, costSharingCustomAmountsAreValid } from "../cost-sharing";
import { moneyStringSchema } from "../money";
import { apiSuccessResponseSchema } from "./api";
import { okResponseSchema } from "./common";
import {
  BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS,
  DISABLED_REMINDER_DAYS,
  MAX_REMINDER_DAYS,
  REPEAT_REMINDER_INTERVALS,
  REPEAT_REMINDER_WINDOWS,
  SUBSCRIPTION_STATUSES,
  isValidDateOnly,
  isValidReminderDays,
  type BillingCycle,
  type CustomCycleUnit,
  type RepeatReminderInterval,
  type RepeatReminderWindow,
  type SubscriptionStatus,
} from "../runtime";

/**
 * 订阅 API schema 是 Docker Go、Cloudflare Worker 和前端表单的共享边界。
 *
 * 这里表达的是 wire shape，不是 UI domain model；任何字段新增、默认值或互斥关系变化，
 * 都必须同步 PocketBase schema/hooks、D1 mapper、前端 service normalize 和契约测试。
 */
const maxLogoReferenceLength = 2048;
const privateAssetPathPattern = /^\/api\/app\/assets\/[A-Za-z0-9_-]+$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isLogoHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const dateInputSchema = z
  .string()
  .min(1)
  .refine(isValidDateOnly, "Invalid date")
  .describe("日期字符串：必须是 YYYY-MM-DD，不接受带时间或时区的 ISO datetime。");
const nullableDateInputSchema = dateInputSchema.nullable();

const optionalUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .nullable()
  .optional()
  .refine((value) => !value || isHttpUrl(value), "Invalid URL");

const logoReferenceSchema = z
  .string()
  .trim()
  .max(maxLogoReferenceLength)
  .refine((value) => {
    // Logo 持久化契约只允许私有资产代理路径或浏览器直连 http(s) 外链；服务端不抓取用户 URL。
    if (privateAssetPathPattern.test(value)) return true;
    return isLogoHttpUrl(value);
  }, "Invalid logo URL");
const optionalLogoReferenceSchema = logoReferenceSchema.nullable().optional();

const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(100).optional();
const extraSchema = z.record(z.string(), z.unknown()).optional();
export const SUBSCRIPTION_PAYMENT_METHOD_NONE = "__none";
export const SUBSCRIPTION_QUERY_RENEWALS = ["auto", "manual", "one-time"] as const;
export const SUBSCRIPTION_REMINDER_MODES = ["disabled", "inherit", "custom"] as const;
const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean());
// costSharing 是“当前用户默认付款、成员只代表其他人”的 shared wire shape；旧身份字段必须在迁移层清理，写入层拒绝。
const costSharingMemberSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  note: z.string().trim().max(500).optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  customAmount: moneyStringSchema.optional(),
}).strict();
export const costSharingSchema = z.object({
  enabled: z.boolean(),
  splitMode: z.enum(COST_SHARING_SPLIT_MODES),
  members: z.array(costSharingMemberSchema).min(1).max(20),
}).strict().refine((value) => {
  if (!value.enabled) return true;
  const ids = new Set(value.members.map((member) => member.id));
  return ids.size === value.members.length;
}, {
  path: ["members"],
  message: "Invalid cost sharing members",
}).refine((value) => !value.enabled || costSharingCustomAmountsAreValid(value), {
  path: ["members"],
  message: "Invalid custom cost sharing amounts",
});
export const reminderDaysSchema = z
  .number()
  .int()
  .min(DISABLED_REMINDER_DAYS)
  .max(MAX_REMINDER_DAYS)
  .refine(isValidReminderDays, "Invalid reminder days");

const oneTimeTermCountSchema = z.number().int().positive().max(MAX_REMINDER_DAYS);
const oneTimeTermUnitSchema = z.enum(CUSTOM_CYCLE_UNITS);

function oneTimeTermFieldsAreConsistent(value: {
  billingCycle: BillingCycle;
  oneTimeTermCount?: number | null | undefined;
  oneTimeTermUnit?: CustomCycleUnit | null | undefined;
}): boolean {
  const hasCount = value.oneTimeTermCount !== undefined && value.oneTimeTermCount !== null;
  const hasUnit = value.oneTimeTermUnit !== undefined && value.oneTimeTermUnit !== null;
  // 固定服务期必须 count/unit 成对出现；非 one-time 周期带服务期字段会污染统计摊销和到期提醒。
  if (value.billingCycle !== "one-time") return !hasCount && !hasUnit;
  return hasCount === hasUnit;
}

function startDateRequirementIsSatisfied(value: {
  billingCycle: BillingCycle;
  startDate: string | null;
  autoCalculateNextBillingDate: boolean;
}): boolean {
  // 周期订阅允许未知开始日期；one-time 和自动日期锚点仍需要真实 date-only。
  if (value.billingCycle === "one-time") return value.startDate !== null;
  return !value.autoCalculateNextBillingDate || value.startDate !== null;
}

/**
 * 订阅写入请求的跨运行面事实来源。
 *
 * Go route、Cloudflare Worker 和前端表单都应接受这组字段；新增或收窄字段时必须同步
 * PocketBase schema/hooks、D1 row 转换和前端 domain 类型，不能只改某一个运行面。
 */
const subscriptionWriteBodyShape = {
  name: z.string().trim().min(1).max(120),
  logo: optionalLogoReferenceSchema,
  price: moneyStringSchema,
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  billingCycle: z.enum(BILLING_CYCLES),
  customDays: z.number().int().positive().nullable().optional(),
  customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable().optional(),
  oneTimeTermCount: oneTimeTermCountSchema.nullable().optional(),
  oneTimeTermUnit: oneTimeTermUnitSchema.nullable().optional(),
  category: z.string().trim().min(1).max(80),
  status: z.enum(SUBSCRIPTION_STATUSES),
  pinned: z.boolean().default(false),
  publicHidden: z.boolean().default(false),
  paymentMethod: z.string().trim().min(1).max(80).nullable().optional(),
  startDate: nullableDateInputSchema,
  nextBillingDate: dateInputSchema,
  // autoRenew 默认关闭；缺省数据不能被解释成用户同意后台自动推进下一期。
  autoRenew: z.boolean().default(false),
  autoCalculateNextBillingDate: z.boolean(),
  trialEndDate: dateInputSchema.nullable().optional(),
  website: optionalUrlSchema,
  notes: z.string().max(5000).nullable().optional(),
  tags: tagsSchema,
  reminderDays: reminderDaysSchema,
  repeatReminderEnabled: z.boolean(),
  repeatReminderInterval: z.enum(REPEAT_REMINDER_INTERVALS),
  repeatReminderWindow: z.enum(REPEAT_REMINDER_WINDOWS),
  costSharing: costSharingSchema.nullable().optional(),
  // extra 是跨运行面的非展示元数据通道；seed/import 依赖它做幂等，不参与订阅 UI。
  extra: extraSchema,
} satisfies z.ZodRawShape;

export const subscriptionCreateBodySchema = z.object(subscriptionWriteBodyShape)
  .strict()
  .refine(oneTimeTermFieldsAreConsistent, {
    path: ["oneTimeTermCount"],
    message: "Invalid one-time term",
  })
  .refine(startDateRequirementIsSatisfied, {
    path: ["startDate"],
    message: "Start date is required for one-time subscriptions and automatic billing date calculation",
  });

export const subscriptionUpdateBodySchema = z.object(subscriptionWriteBodyShape)
  .strict()
  .partial()
  .refine((value) => {
    if (value.billingCycle === undefined) return true;
    return oneTimeTermFieldsAreConsistent({
      billingCycle: value.billingCycle,
      oneTimeTermCount: value.oneTimeTermCount,
      oneTimeTermUnit: value.oneTimeTermUnit,
    });
  }, {
    path: ["oneTimeTermCount"],
    message: "Invalid one-time term",
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: "Empty payload" });

/**
 * 订阅读取响应的稳定 API 形状。
 *
 * Worker 会把 D1 snake_case/int boolean 重新映射到这里，PocketBase 记录也会在前端先收敛再解析；
 * 这样 UI 只消费一种契约，运行面差异停留在 service/adapter 层。
 */
export const apiSubscriptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  logo: logoReferenceSchema.optional(),
  price: moneyStringSchema,
  currency: z.string(),
  billingCycle: z.enum(BILLING_CYCLES),
  customDays: z.number().int().optional(),
  customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).optional(),
  oneTimeTermCount: oneTimeTermCountSchema.optional(),
  oneTimeTermUnit: oneTimeTermUnitSchema.optional(),
  category: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES),
  pinned: z.boolean(),
  publicHidden: z.boolean(),
  paymentMethod: z.string().min(1).optional(),
  startDate: nullableDateInputSchema,
  // 订阅响应的 date-only 字段由 shared 统一守门；Go、Worker 和前端都不能在本地补解析 ISO datetime。
  nextBillingDate: dateInputSchema,
  autoRenew: z.boolean(),
  autoCalculateNextBillingDate: z.boolean(),
  trialEndDate: dateInputSchema.optional(),
  website: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  reminderDays: reminderDaysSchema,
  repeatReminderEnabled: z.boolean(),
  repeatReminderInterval: z.enum(REPEAT_REMINDER_INTERVALS),
  repeatReminderWindow: z.enum(REPEAT_REMINDER_WINDOWS),
  costSharing: costSharingSchema.optional(),
  extra: extraSchema,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).strict().refine(oneTimeTermFieldsAreConsistent, {
  path: ["oneTimeTermCount"],
  message: "Invalid one-time term",
}).refine(startDateRequirementIsSatisfied, {
  path: ["startDate"],
  message: "Start date is required for one-time subscriptions and automatic billing date calculation",
});

export const subscriptionsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  category: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  tag: z.array(z.string().trim().min(1).max(40)).max(100).optional(),
  billingCycle: z.array(z.enum(BILLING_CYCLES)).max(BILLING_CYCLES.length).optional(),
  paymentMethod: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
  currency: z.array(z.string().trim().regex(/^[A-Z]{3}$/)).max(50).optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  renewal: z.enum(SUBSCRIPTION_QUERY_RENEWALS).optional(),
  nextBillingFrom: dateInputSchema.optional(),
  nextBillingTo: dateInputSchema.optional(),
  pinned: queryBooleanSchema.optional(),
  publicHidden: queryBooleanSchema.optional(),
  reminderMode: z.enum(SUBSCRIPTION_REMINDER_MODES).optional(),
  repeatReminder: queryBooleanSchema.optional(),
}).strict().refine((value) => {
  if (!value.nextBillingFrom || !value.nextBillingTo) return true;
  return value.nextBillingFrom <= value.nextBillingTo;
}, {
  path: ["nextBillingTo"],
  message: "Invalid date range",
});

export const subscriptionsListPayloadSchema = z.object({
  subscriptions: z.array(apiSubscriptionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative().optional(),
}).strict();
export const subscriptionsListResponseSchema = apiSuccessResponseSchema(subscriptionsListPayloadSchema);

export const subscriptionPayloadSchema = z.object({
  subscription: apiSubscriptionSchema,
}).strict();
export const subscriptionResponseSchema = apiSuccessResponseSchema(subscriptionPayloadSchema);

export const subscriptionDeleteResponseSchema = okResponseSchema;

export type SubscriptionsListResponse = z.infer<typeof subscriptionsListPayloadSchema>;
export type SubscriptionResponse = z.infer<typeof subscriptionPayloadSchema>;

export type ApiSubscription = z.infer<typeof apiSubscriptionSchema> & {
  billingCycle: BillingCycle;
  customCycleUnit?: CustomCycleUnit | undefined;
  oneTimeTermUnit?: CustomCycleUnit | undefined;
  status: SubscriptionStatus;
  repeatReminderInterval: RepeatReminderInterval;
  repeatReminderWindow: RepeatReminderWindow;
};
export type SubscriptionsListQuery = z.infer<typeof subscriptionsListQuerySchema>;
