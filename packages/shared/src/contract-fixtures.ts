import { z } from "zod";
import notificationScheduleFixturesJson from "./contract-fixtures/notification-schedule-fixtures.json";
import outboundUrlPolicyFixturesJson from "./contract-fixtures/outbound-url-policy-fixtures.json";
import subscriptionNormalizationFixturesJson from "./contract-fixtures/subscription-normalization-fixtures.json";
import {
  BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS,
  REPEAT_REMINDER_INTERVALS,
  REPEAT_REMINDER_WINDOWS,
  SUBSCRIPTION_STATUSES,
  isValidDateOnly,
} from "./runtime";
import { moneyStringSchema } from "./money";

const dateOnlyFixtureSchema = z.string().refine(isValidDateOnly, "Invalid date");

const notificationSubscriptionFixtureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: moneyStringSchema,
  currency: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES),
  billingCycle: z.enum(BILLING_CYCLES),
  oneTimeTermCount: z.number().int().positive().optional(),
  oneTimeTermUnit: z.enum(CUSTOM_CYCLE_UNITS).optional(),
  nextBillingDate: dateOnlyFixtureSchema,
  trialEndDate: dateOnlyFixtureSchema.optional(),
  reminderDays: z.number().int(),
  repeatReminderEnabled: z.boolean(),
  repeatReminderInterval: z.enum(REPEAT_REMINDER_INTERVALS),
  repeatReminderWindow: z.enum(REPEAT_REMINDER_WINDOWS),
}).strict();

const notificationScheduleFixtureSchema = z.object({
  name: z.string().min(1),
  nowUtc: z.string().min(1),
  settings: z.object({
    timezone: z.string().min(1),
    notificationTimeLocal: z.string().min(1),
    notificationReminderDays: z.number().int(),
  }).strict(),
  subscriptions: z.array(notificationSubscriptionFixtureSchema),
  windowMinutes: z.number().int().nonnegative(),
  force: z.boolean(),
  expected: z.object({
    due: z.boolean(),
    reason: z.string().min(1),
    scheduledLocalDate: z.string().optional(),
    scheduledLocalTime: z.string().optional(),
    timeZone: z.string().optional(),
    scheduledInstantUtc: z.string().optional(),
    itemTypes: z.array(z.enum(["renewal", "trial", "expired", "expiry"])),
    repeatReminder: z.object({
      interval: z.enum(REPEAT_REMINDER_INTERVALS),
      window: z.enum(REPEAT_REMINDER_WINDOWS),
    }).optional(),
  }).strict(),
}).strict();

const subscriptionNormalizationFixtureSchema = z.object({
  name: z.string().min(1),
  input: z.object({
    billingCycle: z.enum(BILLING_CYCLES),
    customDays: z.number().int().positive().nullable(),
    customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable(),
    oneTimeTermCount: z.number().int().positive().nullable(),
    oneTimeTermUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable(),
    autoRenew: z.boolean(),
    autoCalculateNextBillingDate: z.boolean(),
  }).strict(),
  expected: z.object({
    customDays: z.number().int().positive().nullable(),
    customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable(),
    oneTimeTermCount: z.number().int().positive().nullable(),
    oneTimeTermUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable(),
    autoRenew: z.boolean(),
    autoCalculateNextBillingDate: z.boolean(),
  }).strict(),
}).strict();

const outboundUrlPolicyFixtureSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  resolvedIps: z.array(z.string()),
  safe: z.boolean(),
  expectedUrl: z.string().optional(),
}).strict();

/**
 * 这些 fixture 是 Docker Go、Cloudflare Worker 和前端边界测试的共同样例；
 * 策略解释留在 harness 文档，产品仓库只保留可执行契约数据。
 */
export const notificationScheduleFixtures = z.array(notificationScheduleFixtureSchema).parse(notificationScheduleFixturesJson);
export const subscriptionNormalizationFixtures = z.array(subscriptionNormalizationFixtureSchema).parse(subscriptionNormalizationFixturesJson);
export const outboundUrlPolicyFixtures = z.array(outboundUrlPolicyFixtureSchema).parse(outboundUrlPolicyFixturesJson);

export type NotificationScheduleFixture = (typeof notificationScheduleFixtures)[number];
export type SubscriptionNormalizationFixture = (typeof subscriptionNormalizationFixtures)[number];
export type OutboundUrlPolicyFixture = (typeof outboundUrlPolicyFixtures)[number];
