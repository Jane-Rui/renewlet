import type { Dispatch, Ref, SetStateAction } from "react";
import type { UploadStatus as LogoUploadStatus } from "@/components/logo-picker";
import type { CustomConfig } from "@/types/config";
import type { SubscriptionFormState } from "@/types/subscription-form";

export interface SubscriptionFormFieldsProps {
  /** 同一页面可能同时渲染新增/编辑弹窗，id 前缀用于保持 label 与错误提示的 a11y 关联唯一。 */
  idPrefix: string;
  config: CustomConfig;
  formData: SubscriptionFormState;
  setFormData: Dispatch<SetStateAction<SubscriptionFormState>>;
  availableTags?: readonly string[] | undefined;
  showLogoField?: boolean | undefined;
  onLogoUploadStatusChange: (status: LogoUploadStatus) => void;
  onFieldChange?: <K extends keyof SubscriptionFormState>(key: K, value: SubscriptionFormState[K]) => void;
  errors?: SubscriptionFormErrors | undefined;
  onClearFieldError?: ((field: keyof SubscriptionFormErrors) => void) | undefined;
  notificationReminderDays: number;
  costSharingCurrencyConvert?: ((amount: number | string, fromCurrency: string, toCurrency: string) => number) | undefined;
  onManageCostSharingMembers?: (() => void) | undefined;
  costSharingManageMembersButtonRef?: Ref<HTMLButtonElement> | undefined;
}

/** 表单错误按 UI 区块聚合，而不是逐 DTO 字段暴露，避免跨字段日期和提醒规则在不同输入上重复显示。 */
export type SubscriptionFormErrors = Partial<Record<
  "name" | "price" | "currency" | "billingCycle" | "dates" | "customDays" | "oneTimeTerm" | "reminderDays" | "costSharing" | "website" | "tags",
  string
>>;

export type SubscriptionFormFieldUpdater = <K extends keyof SubscriptionFormState>(
  key: K,
  value: SubscriptionFormState[K],
) => void;

// 输入态字段到错误区块的唯一映射；onChange 清错和 submit 校验共用它，避免某些字段改动后旧错误残留。
export const errorFieldByFormKey: Partial<Record<keyof SubscriptionFormState, keyof SubscriptionFormErrors>> = {
  name: "name",
  price: "price",
  currency: "currency",
  billingCycle: "billingCycle",
  customDays: "customDays",
  oneTimeMode: "oneTimeTerm",
  oneTimeTermCount: "oneTimeTerm",
  oneTimeTermUnit: "oneTimeTerm",
  startDate: "dates",
  nextBillingDate: "dates",
  reminderType: "reminderDays",
  reminderDays: "reminderDays",
  customReminderDays: "reminderDays",
  costSharing: "costSharing",
  website: "website",
  tags: "tags",
} satisfies Partial<Record<keyof SubscriptionFormState, keyof SubscriptionFormErrors>>;

const structuralErrorFieldsByFormKey: Partial<Record<keyof SubscriptionFormState, readonly (keyof SubscriptionFormErrors)[]>> = {
  // 这些字段会重塑日期、普通提醒和家庭收款提醒含义；旧提交错误必须失效，下一次提交再按当前形态重新生成。
  billingCycle: ["billingCycle", "dates", "customDays", "oneTimeTerm", "reminderDays", "costSharing"],
  oneTimeMode: ["dates", "oneTimeTerm", "reminderDays", "costSharing"],
  autoCalculate: ["dates"],
};

export function getErrorFieldsToClearForFormChange(
  key: keyof SubscriptionFormState,
): readonly (keyof SubscriptionFormErrors)[] {
  const fields = new Set<keyof SubscriptionFormErrors>();
  const directField = errorFieldByFormKey[key];
  if (directField) fields.add(directField);
  for (const structuralField of structuralErrorFieldsByFormKey[key] ?? []) {
    fields.add(structuralField);
  }
  return Array.from(fields);
}
