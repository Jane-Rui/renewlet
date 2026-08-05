// 添加到日历弹窗测试锁住一次性 ICS 下载不再依赖浏览器端序列化。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import { AddToCalendarDialog } from "./add-to-calendar-dialog";

const mocks = vi.hoisted(() => ({
  createSubscriptionCalendarFeed: vi.fn(),
  deleteSubscriptionCalendarFeed: vi.fn(),
  downloadFile: vi.fn(),
  downloadSubscriptionIcs: vi.fn(),
  subscriptionCalendarFeedStatus: { data: { enabled: false, feedUrl: undefined as string | undefined }, isLoading: false },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfig: () => ({
    config: {
      categories: [{
        id: "productivity",
        value: "productivity",
        labels: { "zh-CN": "效率工具", "en-US": "Productivity" },
      }],
      statuses: [],
      paymentMethods: [{
        id: "credit-card",
        value: "credit_card",
        labels: { "zh-CN": "信用卡", "en-US": "Credit Card" },
      }],
      currencies: [],
    },
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { notificationReminderDays: 5 },
  }),
}));

vi.mock("@/hooks/use-calendar-feed", () => ({
  useCreateSubscriptionCalendarFeed: () => ({
    isPending: false,
    mutateAsync: mocks.createSubscriptionCalendarFeed,
  }),
  useDeleteSubscriptionCalendarFeed: () => ({
    isPending: false,
    mutateAsync: mocks.deleteSubscriptionCalendarFeed,
  }),
  useSubscriptionCalendarFeedStatus: () => mocks.subscriptionCalendarFeedStatus,
}));

vi.mock("@/services/calendar-feed-service", () => ({
  calendarFeedService: {
    downloadSubscriptionIcs: mocks.downloadSubscriptionIcs,
  },
}));

vi.mock("@/shared/browser/download-file", () => ({
  downloadFile: mocks.downloadFile,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

const subscription: Subscription = {
  id: "sub-1",
  name: "Fastmail",
  logo: undefined,
  price: "5",
  currency: "USD",
  billingCycle: "monthly",
  customDays: undefined,
  customCycleUnit: undefined,
  oneTimeTermCount: undefined,
  oneTimeTermUnit: undefined,
  category: "productivity",
  status: "active",
  paymentMethod: "credit_card",
  startDate: assertDateOnly("2026-05-15"),
  nextBillingDate: assertDateOnly("2026-06-15"),
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: "https://fastmail.example",
  notes: "Team plan",
  tags: [],
  reminderDays: 7,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  pinned: false,
  publicHidden: false,
};

function renderDialog() {
  return render(
    <AddToCalendarDialog
      open
      onOpenChange={vi.fn()}
      subscription={subscription}
    />,
  );
}

function withoutRandomUUID(callback: () => void) {
  const cryptoObject = window.crypto;
  const descriptor = Object.getOwnPropertyDescriptor(cryptoObject, "randomUUID");
  Object.defineProperty(cryptoObject, "randomUUID", { configurable: true, value: undefined });
  try {
    callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(cryptoObject, "randomUUID", descriptor);
    } else {
      Reflect.deleteProperty(cryptoObject, "randomUUID");
    }
  }
}

describe("AddToCalendarDialog", () => {
  beforeEach(() => {
    mocks.createSubscriptionCalendarFeed.mockReset();
    mocks.deleteSubscriptionCalendarFeed.mockReset();
    mocks.downloadFile.mockReset();
    mocks.downloadSubscriptionIcs.mockReset();
    mocks.subscriptionCalendarFeedStatus = { data: { enabled: false, feedUrl: undefined }, isLoading: false };
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.downloadSubscriptionIcs.mockResolvedValue(new Blob(["BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"], { type: "text/calendar;charset=utf-8" }));
  });

  afterEach(() => {
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    if (originalExecCommandDescriptor) {
      Object.defineProperty(document, "execCommand", originalExecCommandDescriptor);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("renders without crypto.randomUUID", () => {
    withoutRandomUUID(() => {
      renderDialog();
    });

    expect(screen.getByRole("dialog", { name: "添加到日历" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 ICS 文件" })).toBeInTheDocument();
  });

  it("downloads one-off ICS through the authenticated calendar service", async () => {
    const icsBlob = new Blob(["BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"], { type: "text/calendar;charset=utf-8" });
    mocks.downloadSubscriptionIcs.mockResolvedValueOnce(icsBlob);

    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "下载 ICS 文件" }));

    await waitFor(() => expect(mocks.downloadSubscriptionIcs).toHaveBeenCalledWith("sub-1"));
    expect(mocks.downloadFile).toHaveBeenCalledWith(icsBlob, "renewlet-sub-1.ics");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("ICS 文件已生成");
  });

  it("shows a recoverable toast when one-off ICS download fails", async () => {
    mocks.downloadSubscriptionIcs.mockRejectedValueOnce(new Error("download failed"));

    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "下载 ICS 文件" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("ICS 文件生成失败"));
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "添加到日历" })).toBeInTheDocument();
  });

  it("shows a localized copy failure instead of leaking missing Clipboard API errors", async () => {
    mocks.subscriptionCalendarFeedStatus = {
      data: {
        enabled: true,
        feedUrl: "https://example.com/calendar/renewals.ics?token=secret",
      },
      isLoading: false,
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });

    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "复制 URL" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("订阅 URL 复制失败", {
      description: "当前一键复制不可用，请手动选择并复制本次 URL。",
    }));
    expect(mocks.toastError).not.toHaveBeenCalledWith(expect.stringContaining("writeText"));
    expect(screen.getByLabelText("本次订阅 URL")).toHaveFocus();
  });
});
