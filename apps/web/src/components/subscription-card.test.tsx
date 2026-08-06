// 订阅卡片测试保护有效状态、公开隐藏、菜单操作和日历入口，避免列表展示与 domain 状态计算分叉。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  baseSubscription,
  expectMetaFlowItemsInOrder,
  mediaUtilitiesCss,
  mockUserAgent,
  openMoreActionsMenu,
  originalWindowOpen,
  renderSubscriptionCard,
  setSubscriptionCardTestMocks,
} from "./subscription-card.test-utils";

const mocks = vi.hoisted(() => {
  const longCategoryLabel = "生产力平台和开发者基础设施";
  const shortCategoryLabel = "生产力";
  const creditCardLabel = "信用卡";
  const longPaymentMethodLabel = "Google Pay 企业共享付款方式";

  return {
    longCategoryLabel,
    shortCategoryLabel,
    creditCardLabel,
    longPaymentMethodLabel,
    categories: [
      {
        id: "developer-tools",
        value: "developer-tools",
        labels: { "zh-CN": longCategoryLabel, "en-US": longCategoryLabel },
        color: "hsl(200 80% 50%)",
      },
      {
        id: "productivity",
        value: "productivity",
        labels: { "zh-CN": shortCategoryLabel, "en-US": shortCategoryLabel },
        color: "hsl(200 80% 50%)",
      },
    ],
    paymentMethods: [
      {
        id: "credit-card",
        value: "credit_card",
        labels: { "zh-CN": creditCardLabel, "en-US": creditCardLabel },
        icon: "/icons/payment-methods/credit_card.svg",
      },
      {
        id: "google-pay",
        value: "google_pay",
        labels: { "zh-CN": longPaymentMethodLabel, "en-US": longPaymentMethodLabel },
        icon: "/icons/payment-methods/google_pay.svg",
      },
    ],
    createSubscriptionCalendarFeed: vi.fn(),
    deleteSubscriptionCalendarFeed: vi.fn(),
    subscriptionCalendarFeedStatus: { data: { enabled: false, feedUrl: undefined as string | undefined }, isLoading: false },
  };
});

setSubscriptionCardTestMocks(mocks);

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfig: () => ({
    config: {
      categories: mocks.categories,
      statuses: [],
      paymentMethods: mocks.paymentMethods,
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

describe("SubscriptionCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    mocks.createSubscriptionCalendarFeed.mockReset();
    mocks.deleteSubscriptionCalendarFeed.mockReset();
    mocks.subscriptionCalendarFeedStatus = { data: { enabled: false, feedUrl: undefined }, isLoading: false };
    mocks.createSubscriptionCalendarFeed.mockResolvedValue({
      enabled: true,
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z",
      feedUrl: "https://example.com/calendar/renewals.ics?token=secret",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
      headers: { "content-type": "text/calendar; charset=utf-8" },
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(window, "open", { configurable: true, value: originalWindowOpen });
  });

  it("keeps the card body free of global settings and config hooks", () => {
    const source = readFileSync(join(process.cwd(), "src/components/subscription-card.tsx"), "utf8");

    expect(source).not.toContain("useSettings");
    expect(source).not.toContain("useCustomConfig");
  });

  it("keeps the mobile card header from forcing price or meta rows into a single-column layout", () => {
    const source = readFileSync(join(process.cwd(), "src/components/subscription-card.tsx"), "utf8");

    renderSubscriptionCard({ name: "Figma Professional", paymentMethod: "credit_card" });

    const card = screen.getByTestId("subscription-card");
    const metaFlow = screen.getByTestId("subscription-card-meta-flow");
    const dateGroup = screen.getByTestId("subscription-card-meta-date-group");
    const startDateMeta = screen.getByTestId("subscription-card-meta-start-date");
    const billingDateMeta = screen.getByTestId("subscription-card-meta-billing-date");
    const paymentMethodMeta = screen.getByTestId("subscription-card-meta-payment-method");
    const badgeFlow = screen.getByTestId("subscription-card-badge-flow");

    expect(source).not.toContain("@container/subscription-card");
    expect(source).not.toContain("@max-xs/subscription-card");
    expect(card.getAttribute("class")).not.toContain("@container/subscription-card");
    expect(metaFlow).toHaveClass("flex", "flex-wrap");
    expect(metaFlow.getAttribute("class")).not.toContain("@max-xs/subscription-card");
    expect(dateGroup).toHaveClass("inline-flex", "min-w-0", "max-w-full", "flex-[0_1_auto]", "flex-wrap");
    expect(dateGroup).toContainElement(startDateMeta);
    expect(dateGroup).toContainElement(billingDateMeta);
    expect(metaFlow).toContainElement(paymentMethodMeta);
    expect(dateGroup).not.toContainElement(paymentMethodMeta);
    expect(paymentMethodMeta).toHaveClass("min-w-0", "max-w-full");
    expect(paymentMethodMeta).not.toHaveClass("shrink-0");
    expect(badgeFlow).toHaveClass("col-span-full", "flex", "flex-wrap", "gap-x-1.5", "gap-y-2", "sm:gap-2");
  });

  it("renders subscription logos through the unified theme-aware logo surface", () => {
    renderSubscriptionCard({ logo: "https://example.com/apple-tv.svg", name: "Apple TV" });

    const logo = screen.getByAltText("Apple TV");
    const logoTile = logo.closest(".subscription-logo-tile");

    expect(logo).toHaveClass("subscription-logo-image", "object-contain");
    expect(logo).not.toHaveClass("media-thumbnail-image", "invert", "brightness-125", "mix-blend-screen");
    expect(logoTile).not.toBeNull();
    expect(logoTile).not.toHaveClass("media-thumbnail-canvas");
    expect(logoTile).not.toHaveClass("bg-gradient-to-br");
    expect(logoTile?.getAttribute("style")).not.toContain("accent");
  });

  it("keeps real subscription logo styling as one plate without an inner pseudo-element", () => {
    expect(mediaUtilitiesCss).not.toContain(".subscription-logo-tile::before");
    expect(mediaUtilitiesCss).not.toContain(".dark .subscription-logo-tile::before");
    expect(mediaUtilitiesCss).not.toMatch(/\.subscription-logo-tile\s*{[^}]*media-thumbnail-canvas/s);
    expect(mediaUtilitiesCss).not.toMatch(/\.subscription-logo-tile\s*{[^}]*(::before|::after)/s);
    expect(mediaUtilitiesCss).toMatch(/\.subscription-logo-tile\s*{[^}]*background:\s*hsl\(/s);
    expect(mediaUtilitiesCss).toMatch(/\.dark \.subscription-logo-tile\s*{[^}]*background:\s*hsl\(210 18% 90% \/ 0\.88\)/s);
    expect(mediaUtilitiesCss).toMatch(/\.dark \.subscription-logo-image\s*{[^}]*drop-shadow/s);
    expect(mediaUtilitiesCss).toMatch(/\.subscription-logo-image\s*{[^}]*drop-shadow/s);
    expect(mediaUtilitiesCss).not.toMatch(/\.subscription-logo-image\s*{[^}]*(mix-blend|invert|brightness|contrast|saturate)/s);
  });

  it("uses the same unified logo surface for white transparent logos", () => {
    renderSubscriptionCard({ logo: "https://example.com/white-logo.svg", name: "ngrok" });

    const logo = screen.getByAltText("ngrok");
    const logoTile = logo.closest(".subscription-logo-tile");

    expect(logo).toHaveClass("subscription-logo-image", "object-contain");
    expect(logoTile).not.toBeNull();
    expect(logoTile).not.toHaveClass("media-thumbnail-canvas");
    expect(logoTile?.getAttribute("style")).not.toContain("accent");
  });

  it("keeps the initials fallback inside the unified logo surface", () => {
    renderSubscriptionCard({ name: "dmit", logo: undefined });

    const initials = screen.getByText("DM");
    const logoTile = initials.closest(".subscription-logo-tile");

    expect(initials).toHaveClass("subscription-logo-fallback");
    expect(logoTile).not.toBeNull();
    expect(logoTile).not.toHaveClass("bg-gradient-to-br");
  });

  it("shows pin actions from the card menu", () => {
    const onTogglePinned = vi.fn();
    renderSubscriptionCard({ pinned: false }, { onTogglePinned });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));

    expect(onTogglePinned).toHaveBeenCalledWith("sub-1");
  });

  it("shows unpin actions for pinned subscriptions", () => {
    renderSubscriptionCard({ pinned: true }, { onTogglePinned: vi.fn() });

    openMoreActionsMenu();

    expect(screen.getByRole("menuitem", { name: "取消置顶" })).toBeInTheDocument();
  });

  it("toggles public visibility from the card menu", () => {
    const onTogglePublicHidden = vi.fn();
    renderSubscriptionCard({ publicHidden: false }, { onTogglePublicHidden });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "从公开页隐藏" }));

    expect(onTogglePublicHidden).toHaveBeenCalledWith("sub-1");
  });

  it("shows a public reveal action for hidden subscriptions", () => {
    renderSubscriptionCard({ publicHidden: true }, { onTogglePublicHidden: vi.fn() });

    openMoreActionsMenu();

    expect(screen.getByRole("menuitem", { name: "在公开页展示" })).toBeInTheDocument();
  });

  it("shows a title pin without adding card-level pinned accents", () => {
    renderSubscriptionCard({ pinned: true, category: "productivity" }, { onTogglePinned: vi.fn() });

    const pinnedIcon = screen.getByTestId("subscription-pinned-title-icon");
    const subscriptionName = screen.getByText(baseSubscription.name);
    const card = screen.getByTestId("subscription-card");
    const cardContent = card.firstElementChild;

    expect(screen.queryByTestId("subscription-pinned-accent")).not.toBeInTheDocument();
    expect(pinnedIcon).toHaveClass("h-3.5", "w-3.5", "shrink-0", "text-primary");
    expect(pinnedIcon).toHaveAttribute("aria-hidden", "true");
    expect(pinnedIcon.compareDocumentPosition(subscriptionName) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("置顶")).toHaveClass("sr-only");
    expect(cardContent).toHaveClass("relative", "z-10", "flex", "items-start", "gap-4");
    expect(cardContent).not.toHaveClass("pt-7");
  });

  it("does not show pinned accents or reserve space for regular subscriptions", () => {
    renderSubscriptionCard({ pinned: false }, { onTogglePinned: vi.fn() });

    const card = screen.getByTestId("subscription-card");
    const cardContent = card.firstElementChild;

    expect(screen.queryByTestId("subscription-pinned-accent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subscription-pinned-title-icon")).not.toBeInTheDocument();
    expect(screen.queryByText("置顶")).not.toBeInTheDocument();
    expect(cardContent).not.toHaveClass("pt-7");
  });

  it("keeps category and status badges separate from the pinned state", () => {
    renderSubscriptionCard({ pinned: true, category: "productivity" }, { onTogglePinned: vi.fn() });

    const categoryBadge = screen.getByText(mocks.shortCategoryLabel).closest("div");
    const badgeGroup = categoryBadge?.parentElement;
    const statusBadge = screen.getByText("活跃").closest("div");
    if (!categoryBadge || !badgeGroup || !statusBadge) {
      throw new Error("Expected category and status badges to render.");
    }

    expect(badgeGroup).toHaveTextContent(mocks.shortCategoryLabel);
    expect(badgeGroup).toHaveTextContent("活跃");
    expect(badgeGroup).not.toHaveTextContent("置顶");
    expect(categoryBadge.compareDocumentPosition(statusBadge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides pin actions when the card is rendered without a pin handler", () => {
    renderSubscriptionCard();

    openMoreActionsMenu();

    expect(screen.queryByRole("menuitem", { name: "置顶" })).not.toBeInTheDocument();
  });

  it("falls back to initials when the subscription logo fails to load", () => {
    renderSubscriptionCard({ logo: "https://example.com/broken.svg", name: "OpenAI" });

    fireEvent.error(screen.getByAltText("OpenAI"));

    const initials = screen.getByText("OP");
    expect(initials).toHaveClass("subscription-logo-fallback");
    expect(initials.closest(".subscription-logo-tile")).not.toBeNull();
  });

  it("lets the badge group use the full header width before wrapping", () => {
    renderSubscriptionCard();

    const categoryText = screen.getByText(mocks.longCategoryLabel);
    const categoryBadge = categoryText.closest("div");
    const badgeGroup = categoryBadge?.parentElement;
    const statusBadge = screen.getByText("活跃").closest("div");
    const subscriptionName = screen.getByText(baseSubscription.name);

    expect(badgeGroup).toHaveClass("col-span-full", "flex", "flex-wrap", "items-center", "gap-x-1.5", "gap-y-2", "sm:gap-2");
    expect(badgeGroup).not.toHaveClass("overflow-hidden");
    expect(subscriptionName).toHaveAttribute("data-slot", "truncated-tooltip-text");
    expect(subscriptionName).not.toHaveAttribute("title");
    expect(categoryBadge).not.toHaveAttribute("title");
    expect(categoryBadge).toHaveClass(
      "max-w-full",
      "shrink-0",
      "overflow-hidden",
      "whitespace-nowrap",
      "px-2",
      "sm:px-2.5",
    );
    expect(categoryBadge).not.toHaveClass("min-w-[3.5rem]", "max-w-[7.5rem]");
    expect(categoryText).toHaveClass("block", "max-w-full", "truncate");
    expect(statusBadge).toHaveClass("shrink-0", "whitespace-nowrap");
  });

  it("shows short category labels inside the badge", () => {
    renderSubscriptionCard({ category: "productivity" });

    const categoryText = screen.getByText(mocks.shortCategoryLabel);
    const categoryBadge = categoryText.closest("div");

    expect(categoryBadge).toHaveTextContent(mocks.shortCategoryLabel);
    expect(categoryBadge).not.toHaveAttribute("title");
    expect(categoryBadge).not.toHaveClass("min-w-[3.5rem]", "max-w-[7.5rem]");
    expect(categoryText).toHaveAttribute("data-slot", "truncated-tooltip-text");
    expect(categoryText).toHaveClass("block", "max-w-full", "truncate");
  });

  it("always exposes the overflow menu trigger", () => {
    renderSubscriptionCard();

    const menuButton = screen.getByRole("button", { name: "更多操作" });

    expect(menuButton).toHaveClass("h-8", "w-8", "shrink-0");
    expect(menuButton).not.toHaveClass("opacity-0");
    expect(menuButton.getAttribute("class")).not.toContain("group-hover:opacity-100");
  });

  it("shows the configured reference amount under the billing cycle for foreign-currency subscriptions", () => {
    renderSubscriptionCard({ price: "10", currency: "USD" }, {}, { priceReferenceCurrency: "CNY" });

    const priceBlock = screen.getByText("US$10").parentElement;
    if (!priceBlock) throw new Error("Missing subscription price block");

    expect(within(priceBlock).getByText("每月")).toBeInTheDocument();
    expect(within(priceBlock).getByText("≈ ¥70 CNY")).toHaveClass(
      "text-xs",
      "tabular-nums",
      "text-muted-foreground",
    );
  });

  it("hides the reference amount for same-currency subscriptions, disabled settings, and while rates are not ready", () => {
    renderSubscriptionCard({ price: "10", currency: "CNY" }, {}, { priceReferenceCurrency: "CNY" });
    expect(screen.queryByText(/^≈/)).not.toBeInTheDocument();

    renderSubscriptionCard({ price: "10", currency: "USD" });
    expect(screen.queryByText("≈ ¥70 CNY")).not.toBeInTheDocument();

    renderSubscriptionCard({ price: "10", currency: "USD" }, {}, { currencyRatesReady: false, priceReferenceCurrency: "CNY" });
    expect(screen.queryByText("≈ ¥70 CNY")).not.toBeInTheDocument();
  });

  it("opens subscription details from the card primary action", () => {
    const onViewDetails = vi.fn();
    renderSubscriptionCard({ name: "Fastmail" }, { onViewDetails });

    fireEvent.click(screen.getByRole("button", { name: "查看 Fastmail 的详情" }));

    expect(onViewDetails).toHaveBeenCalledWith("sub-1");
  });

  it("opens subscription details from keyboard activation", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onViewDetails = vi.fn();
    renderSubscriptionCard({ name: "Fastmail" }, { onViewDetails });

    screen.getByRole("button", { name: "查看 Fastmail 的详情" }).focus();
    await user.keyboard("{Enter}");

    expect(onViewDetails).toHaveBeenCalledWith("sub-1");
  });

  it("orders overflow menu actions with matching icons and separates the destructive action", () => {
    renderSubscriptionCard({}, { onTogglePinned: vi.fn() });

    openMoreActionsMenu();

    expect(screen.getByRole("menu")).toHaveClass("pointer-events-auto", "w-max", "min-w-40");
    const menuItems = screen.getAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual(["编辑", "复制", "添加到日历", "置顶", "删除"]);
    const [editItem, cloneItem, calendarItem, pinItem, deleteItem] = menuItems as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    for (const item of [editItem, cloneItem, calendarItem, pinItem]) {
      expect(item).toHaveClass("gap-2.5", "px-2.5", "py-2", "text-sm", "whitespace-nowrap");
    }
    expect(deleteItem).toHaveClass(
      "gap-2.5",
      "px-2.5",
      "py-2",
      "text-sm",
      "whitespace-nowrap",
      "text-destructive",
      "focus:bg-destructive/10",
      "focus:text-destructive",
    );
    expect(editItem).not.toHaveClass("text-destructive");
    expect(cloneItem).not.toHaveClass("text-destructive");
    expect(calendarItem).not.toHaveClass("text-destructive");
    expect(pinItem).not.toHaveClass("text-destructive");

    const separator = screen.getByRole("separator");
    expect(calendarItem.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(separator.compareDocumentPosition(deleteItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps overflow actions separate from the card detail action", () => {
    const onViewDetails = vi.fn();
    const onEdit = vi.fn();
    renderSubscriptionCard({}, { onViewDetails, onEdit, onTogglePinned: vi.fn() });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));

    expect(onEdit).toHaveBeenCalledWith("sub-1");
    expect(onViewDetails).not.toHaveBeenCalled();
  });

  it("opens the add-to-calendar dialog from the overflow menu", async () => {
    const open = vi.fn();
    Object.defineProperty(window, "open", { configurable: true, value: open });
    renderSubscriptionCard({
      name: "Fastmail",
      website: "https://fastmail.example",
      notes: "Team renewal",
    });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "添加到日历" }));

    expect(screen.getByRole("dialog", { name: "添加到日历" })).toBeInTheDocument();
    expect(screen.getByText("为「Fastmail」创建单独日历订阅，只同步这一条续费。")).toBeInTheDocument();
    const generateButton = screen.getByRole("button", { name: "生成订阅链接" });
    expect(generateButton).toHaveClass("bg-primary");
    expect(screen.queryByRole("link", { name: "打开系统日历" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 ICS 文件" })).toHaveClass("border");
    expect(screen.getByText("在线日历服务")).toBeInTheDocument();
    expect(screen.getByText("事件日期")).toBeInTheDocument();
    expect(screen.getByText("2026年6月15日")).toBeInTheDocument();
    expect(screen.getByText("事件类型")).toBeInTheDocument();
    expect(screen.getByText("订阅 Feed")).toBeInTheDocument();
    expect(screen.getByText("同步状态")).toBeInTheDocument();
    expect(screen.getByText("持续同步此订阅")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "用 Google Calendar 打开" })).toHaveAttribute(
      "href",
      expect.stringContaining("calendar.google.com"),
    );
    expect(screen.queryByRole("button", { name: "用 Google Calendar 打开" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "用 Outlook.com 打开" })).not.toHaveClass("bg-primary");
    expect(screen.getByRole("link", { name: "用 Office 365 打开" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "用 Yahoo Calendar 打开" })).toBeInTheDocument();
    expect(screen.getByText("系统订阅需要日历 App 能持续访问这个 URL；下载 ICS 和在线日历入口都是一次性添加。")).toBeInTheDocument();

    vi.useRealTimers();
    fireEvent.click(generateButton);
    await waitFor(() => expect(mocks.createSubscriptionCalendarFeed).toHaveBeenCalledWith("sub-1"));
    expect(open).toHaveBeenCalledWith("webcal://example.com/calendar/renewals.ics?token=secret", "_self");
    expect(screen.getByLabelText("本次订阅 URL")).toHaveValue("https://example.com/calendar/renewals.ics?token=secret");
    expect(screen.getByRole("button", { name: "复制 URL" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成订阅链接" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "在系统日历中订阅" })).toBeInTheDocument();
  });

  it("shows an existing per-subscription feed URL without generating a new token", async () => {
    const open = vi.fn();
    Object.defineProperty(window, "open", { configurable: true, value: open });
    mocks.subscriptionCalendarFeedStatus = {
      data: {
        enabled: true,
        feedUrl: "https://example.com/calendar/renewals.ics?token=existing",
      },
      isLoading: false,
    };

    renderSubscriptionCard({ name: "Fastmail" });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "添加到日历" }));

    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "在系统日历中订阅" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("webcal://example.com/calendar/renewals.ics?token=existing", "_self"));
    expect(screen.getByLabelText("本次订阅 URL")).toHaveValue("https://example.com/calendar/renewals.ics?token=existing");
    expect(screen.queryByRole("button", { name: "生成订阅链接" })).not.toBeInTheDocument();
    expect(mocks.createSubscriptionCalendarFeed).not.toHaveBeenCalled();
  });

  it("does not open the system calendar when the feed preflight returns HTML", async () => {
    const open = vi.fn();
    Object.defineProperty(window, "open", { configurable: true, value: open });
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html></html>", {
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.subscriptionCalendarFeedStatus = {
      data: {
        enabled: true,
        feedUrl: "http://localhost:5173/calendar/renewals.ics?token=existing",
      },
      isLoading: false,
    };

    renderSubscriptionCard({ name: "Fastmail" });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "添加到日历" }));
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "在系统日历中订阅" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://localhost:5173/calendar/renewals.ics?token=existing", {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "text/calendar,*/*;q=0.1" },
    }));
    expect(open).not.toHaveBeenCalled();
  });

  it("uses an Android insert intent for the system calendar entry in Chrome on Android", () => {
    const restoreUserAgent = mockUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36");

    try {
      renderSubscriptionCard({ name: "Fastmail", website: "https://fastmail.example" });

      openMoreActionsMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "添加到日历" }));

      const androidSingleEventLink = screen.getByRole("link", { name: "添加单次事件到 Android 日历" });
      expect(androidSingleEventLink).toHaveAttribute("href", expect.stringContaining("intent://renewlet/calendar-event#Intent;"));
      expect(androidSingleEventLink).toHaveAttribute("href", expect.stringContaining("action=android.intent.action.INSERT"));
      expect(androidSingleEventLink).toHaveAttribute("href", expect.stringContaining("type=vnd.android.cursor.dir/event"));
      expect(androidSingleEventLink).toHaveAttribute("href", expect.stringContaining("S.title=Fastmail"));
    } finally {
      restoreUserAgent();
    }
  });

  it("hides the add-to-calendar entry for one-time buyouts", () => {
    renderSubscriptionCard({ billingCycle: "one-time" });

    openMoreActionsMenu();

    expect(screen.queryByRole("menuitem", { name: "添加到日历" })).not.toBeInTheDocument();
  });

  it("keeps the add-to-calendar entry available for one-time fixed terms", () => {
    renderSubscriptionCard({
      billingCycle: "one-time",
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
    });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "添加到日历" }));

    expect(screen.getByRole("dialog", { name: "添加到期日历" })).toBeInTheDocument();
    expect(screen.getByText("为「dmit」创建单独日历订阅，只同步这次服务到期。")).toBeInTheDocument();
    expect(screen.getByText("事件日期")).toBeInTheDocument();
    expect(screen.getByText("2026年6月15日")).toBeInTheDocument();
  });

  it("renders concrete custom billing cycle labels", () => {
    renderSubscriptionCard({ billingCycle: "custom", customDays: 3, customCycleUnit: "year" });

    expect(screen.getByText("每 3 年")).toBeInTheDocument();
    expect(screen.queryByText("自定义")).not.toBeInTheDocument();
  });

  it("renders future recurring subscriptions with remaining days and the target date", () => {
    renderSubscriptionCard({ nextBillingDate: assertDateOnly("2026-06-15") });

    expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/6/15", "28 天后续费");
  });

  it("hides the start-date meta item when a recurring subscription has an unknown start date", () => {
    renderSubscriptionCard({
      startDate: null,
      autoCalculateNextBillingDate: false,
      nextBillingDate: assertDateOnly("2026-06-15"),
    });

    const metaFlow = expectMetaFlowItemsInOrder("到期: 2026/6/15", "28 天后续费");

    expect(within(metaFlow).queryByText(/开始:/)).not.toBeInTheDocument();
  });

  it("keeps start date, billing date, payment method, and relative days in the intended order", () => {
    renderSubscriptionCard({
      paymentMethod: "credit_card",
      nextBillingDate: assertDateOnly("2026-06-15"),
    });

    expectMetaFlowItemsInOrder(
      "开始: 2026/5/15",
      "到期: 2026/6/15",
      mocks.creditCardLabel,
      "28 天后续费",
    );
  });

  it("keeps long payment methods after the billing date without hiding either value", () => {
    renderSubscriptionCard({
      paymentMethod: "google_pay",
      nextBillingDate: assertDateOnly("2026-06-02"),
    });

    const metaFlow = expectMetaFlowItemsInOrder("到期: 2026/6/2", mocks.longPaymentMethodLabel, "15 天后续费");
    const paymentMethodMeta = screen.getByTestId("subscription-card-meta-payment-method");
    const paymentMethodText = within(paymentMethodMeta).getByText(mocks.longPaymentMethodLabel);

    expect(metaFlow).toContainElement(paymentMethodMeta);
    expect(paymentMethodMeta).toHaveClass("min-w-0", "max-w-full");
    expect(paymentMethodMeta).not.toHaveClass("shrink-0");
    expect(paymentMethodText).toHaveClass("block", "max-w-24", "truncate", "sm:max-w-32");
  });

  it("keeps relative billing after the billing date when there is no payment method", () => {
    renderSubscriptionCard({ paymentMethod: undefined, nextBillingDate: assertDateOnly("2026-06-02") });

    const metaFlow = expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/6/2", "15 天后续费");

    expect(within(metaFlow).queryByText(mocks.creditCardLabel)).not.toBeInTheDocument();
  });

  it("renders future one-time fixed terms with remaining days and the expiry date", () => {
    renderSubscriptionCard({
      billingCycle: "one-time",
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
      nextBillingDate: assertDateOnly("2026-08-01"),
    });

    expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/8/1", "75 天后到期");
  });

  it("renders buyout purchase dates without relative renewal days", () => {
    renderSubscriptionCard({ billingCycle: "one-time" });

    const metaFlow = expectMetaFlowItemsInOrder("开始: 2026/5/15", "购买日期: 2026/5/15");

    expect(within(metaFlow).queryByText("28 天后续费")).not.toBeInTheDocument();
    expect(within(metaFlow).queryByText("到期: 2026/6/15")).not.toBeInTheDocument();
  });

  it("renders overdue active subscriptions with the expired status treatment", () => {
    renderSubscriptionCard({ status: "active", nextBillingDate: assertDateOnly("2026-05-15") });

    const statusBadge = screen.getByText("已过期").closest("div");
    const expiredDateText = screen.getByText("已过期 3 天");
    const card = statusBadge?.closest(".group");

    expect(statusBadge).toHaveClass("bg-destructive/10", "text-destructive", "border-destructive/20");
    expect(expiredDateText.closest("div")).toHaveClass("text-destructive");
    expect(card).toHaveClass("border-destructive/40");
    expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/5/15", "已过期 3 天");
  });

  it("does not render relative renewal days for overdue paused subscriptions", () => {
    renderSubscriptionCard({ status: "paused", nextBillingDate: assertDateOnly("2026-05-12") });
    const metaFlow = screen.getByTestId("subscription-card-meta-flow");

    expect(screen.getByText("已暂停")).toBeInTheDocument();
    expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/5/12");
    expect(within(metaFlow).queryByText("-6 天后续费")).not.toBeInTheDocument();
    expect(within(metaFlow).queryByText("已过期 6 天")).not.toBeInTheDocument();
  });

  it("does not render relative renewal days for overdue cancelled subscriptions", () => {
    renderSubscriptionCard({ status: "cancelled", nextBillingDate: assertDateOnly("2026-05-12") });
    const metaFlow = screen.getByTestId("subscription-card-meta-flow");

    expect(screen.getByText("已取消")).toBeInTheDocument();
    expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/5/12");
    expect(within(metaFlow).queryByText("-6 天后续费")).not.toBeInTheDocument();
    expect(within(metaFlow).queryByText("已过期 6 天")).not.toBeInTheDocument();
  });

  it("renders inherited reminder days with the current global setting", () => {
    renderSubscriptionCard({ reminderDays: -1 }, {}, { viewMode: "list" });

    expect(screen.getByText("默认提醒：提前 5 天")).toBeInTheDocument();
  });

  it("renders disabled reminder days", () => {
    renderSubscriptionCard({ reminderDays: -2 }, {}, { viewMode: "list" });

    expect(screen.getByText("不提醒")).toBeInTheDocument();
  });
});
