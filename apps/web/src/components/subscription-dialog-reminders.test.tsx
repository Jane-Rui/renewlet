// 订阅弹窗提醒测试覆盖“不提醒”显性开关和一次性买断静默契约。
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import { SubscriptionDialog } from "./subscription-dialog";

const mocks = vi.hoisted(() => ({
  config: {
    categories: [{ id: "productivity", value: "productivity", labels: { "zh-CN": "效率工具", "en-US": "Productivity" } }],
    statuses: [{ id: "active", value: "active", labels: { "zh-CN": "活跃", "en-US": "Active" } }],
    paymentMethods: [{ id: "alipay", value: "alipay", labels: { "zh-CN": "支付宝", "en-US": "Alipay" } }],
    currencies: [
      { id: "CNY", value: "CNY", labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" }, enabled: true },
      { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
    ],
  },
}));
const FIXED_DIALOG_NOW = new Date("2026-06-01T12:00:00.000Z");

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfig: () => ({ config: mocks.config }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { defaultCurrency: "USD", notificationReminderDays: 5 },
  }),
}));

vi.mock("@/hooks/use-exchange-rates", () => ({
  useExchangeRates: () => ({
    convert: (amount: number) => amount,
  }),
}));

vi.mock("@/components/logo-picker", () => ({
  LogoPicker: () => null,
}));

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FIXED_DIALOG_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function setupUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Critical SaaS",
    logo: undefined,
    price: "99",
    currency: "USD",
    billingCycle: "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
    category: "productivity",
    status: "active",
    publicHidden: false,
    paymentMethod: "alipay",
    startDate: assertDateOnly("2026-05-14"),
    nextBillingDate: assertDateOnly("2026-06-13"),
    autoCalculateNextBillingDate: false,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    reminderDays: 3,
    tags: [],
    repeatReminderEnabled: true,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    pinned: false,
    ...overrides,
  } as Subscription;
}

describe("SubscriptionDialog reminders", () => {
  it("defaults new subscriptions to the inherited reminder setting", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("combobox", { name: "到期提醒" })).toHaveTextContent("默认值从设置中获取（提前 5 天）");
  });

  it("exposes disabled reminders as a switch and restores the inherited default", async () => {
    const user = setupUser();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    const reminderSwitch = screen.getByRole("switch", { name: "到期提醒" });
    expect(reminderSwitch).toBeChecked();
    expect(screen.getByRole("combobox", { name: "到期提醒" })).toHaveTextContent("默认值从设置中获取（提前 5 天）");

    await user.click(reminderSwitch);

    expect(reminderSwitch).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: "到期提醒" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("重复提醒")).not.toBeInTheDocument();

    await user.click(reminderSwitch);

    expect(reminderSwitch).toBeChecked();
    expect(screen.getByRole("combobox", { name: "到期提醒" })).toHaveTextContent("默认值从设置中获取（提前 5 天）");
  });

  it("submits disabled reminders for recurring subscriptions from the switch", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("switch", { name: "到期提醒" }));
    await user.type(screen.getByLabelText("服务名称"), "Quiet SaaS");
    await user.type(screen.getByLabelText("价格"), "10");
    await user.click(screen.getByRole("button", { name: /到期日期.*选择日期/ }));
    await user.click(await screen.findByRole("button", { name: /2026年6月8日/ }));
    await user.click(screen.getByRole("button", { name: "添加订阅" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "Quiet SaaS",
      billingCycle: "monthly",
      reminderDays: -2,
      repeatReminderEnabled: false,
    }));
  });

  it("defaults one-time purchases to buyout and disabled reminders on submit", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("combobox", { name: "扣费周期" }));
    await user.click(await screen.findByRole("option", { name: "一次性购买" }));

    expect(screen.getByRole("button", { name: "长期有效" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("switch", { name: "到期提醒" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "到期提醒" })).not.toBeInTheDocument();
    expect(screen.getByText("不提醒")).toBeInTheDocument();
    expect(screen.getByText("长期有效没有到期日，不会发送到期提醒。")).toBeInTheDocument();

    await user.type(screen.getByLabelText("服务名称"), "Lifetime App");
    await user.type(screen.getByLabelText("价格"), "199");
    await user.click(screen.getByRole("button", { name: /购买日期.*选择日期/ }));
    await user.click(await screen.findByRole("button", { name: /2026年6月8日/ }));
    await user.click(screen.getByRole("button", { name: "添加订阅" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "Lifetime App",
      billingCycle: "one-time",
      nextBillingDate: "2026-06-08",
      oneTimeTermCount: undefined,
      oneTimeTermUnit: undefined,
      reminderDays: -2,
      repeatReminderEnabled: false,
    }));
  });

  it("disables collection reminders when an edited subscription becomes a one-time buyout", async () => {
    const user = setupUser();
    const onSubmit = vi.fn<(subscription: Subscription) => void>();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          subscription={makeSubscription({
            costSharing: {
              enabled: true,
              splitMode: "equal",
              collectionReminder: { enabled: true, reminderDays: -1 },
              members: [{
                id: "partner",
                name: "Partner",
                currency: "USD",
                joinedDate: assertDateOnly("2026-05-14"),
              }],
            },
          })}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("combobox", { name: "扣费周期" }));
    await user.click(await screen.findByRole("option", { name: "一次性购买" }));
    await waitFor(() => {
      expect(screen.getByTestId("cost-sharing-collection-reminder-summary")).toHaveTextContent("收款提醒：买断不提醒");
    });
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    const submitted = onSubmit.mock.calls.at(0)?.at(0);
    expect(submitted?.billingCycle).toBe("one-time");
    expect(submitted?.costSharing?.collectionReminder).toEqual({ enabled: false, reminderDays: -1 });
  });

  it("calculates and disables the expiry date when switching to one-time fixed term", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          subscription={makeSubscription({
            billingCycle: "monthly",
            startDate: assertDateOnly("2026-05-14"),
            nextBillingDate: assertDateOnly("2027-06-25"),
            autoCalculateNextBillingDate: false,
          })}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: /2027年6月25日/ })).not.toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "扣费周期" }));
    await user.click(await screen.findByRole("option", { name: "一次性购买" }));
    await user.click(screen.getByRole("button", { name: "固定服务期" }));

    expect(screen.getByRole("combobox", { name: "到期提醒" })).toHaveTextContent("默认值从设置中获取（提前 5 天）");
    const renewalDateButton = await screen.findByRole("button", { name: /到期日期.*2026年6月14日/ });
    expect(renewalDateButton).toBeDisabled();
    expect(screen.queryByText("2027年6月25日")).not.toBeInTheDocument();
    const termDateHelp = screen.getByText("到期日根据购买日期和服务时长自动计算。");
    expect(renewalDateButton).toHaveAttribute("aria-describedby", termDateHelp.id);

    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      id: "sub-1",
      billingCycle: "one-time",
      nextBillingDate: "2026-06-14",
      autoCalculateNextBillingDate: false,
      oneTimeTermCount: 1,
      oneTimeTermUnit: "month",
      reminderDays: -1,
    }));
  });

  it("renders buyout date help inline without disabled renewal controls", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("combobox", { name: "扣费周期" }));
    await user.click(await screen.findByRole("option", { name: "一次性购买" }));
    await user.click(screen.getByRole("button", { name: "长期有效" }));

    const purchaseDateButton = screen.getByRole("button", { name: /购买日期.*选择日期/ });
    const buyoutHelp = screen.getByText("只保存购买日期，不进入续费或到期日历。");
    expect(purchaseDateButton).toHaveAttribute("aria-describedby", buyoutHelp.id);
    expect(buyoutHelp.parentElement).not.toHaveClass("border-dashed");
    expect(screen.queryByLabelText("自动计算到期日")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /到期日期/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "到期提醒" })).not.toBeInTheDocument();
    expect(screen.getByText("长期有效没有到期日，不会发送到期提醒。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "添加订阅" }));

    const dateError = screen.getByText("请选择购买日期");
    const invalidPurchaseDateButton = screen.getByRole("button", { name: /购买日期.*选择日期/ });
    const describedBy = invalidPurchaseDateButton.getAttribute("aria-describedby");
    expect(describedBy).toContain(dateError.id);
    expect(describedBy).toContain(buyoutHelp.id);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
