import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import { DEFAULT_SETTINGS, type Subscription } from "@/types/subscription";
import Subscriptions from "./subscriptions";

interface MockInfiniteSubscriptionsResult {
  subscriptions?: Subscription[];
  isPending: boolean;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  fetchNextPage?: () => void;
}

const cloneSource = vi.hoisted(() => ({
  value: null as Subscription | null,
}));

const mocks = vi.hoisted(() => ({
  useInfiniteSubscriptions: vi.fn<() => MockInfiniteSubscriptionsResult>(),
  useSubscriptions: vi.fn(),
  useSettings: vi.fn(),
  handleAddSubscription: vi.fn(),
  handleDeleteSubscription: vi.fn(),
  handleEditSubscription: vi.fn(),
  handleCloneSubscription: vi.fn(),
  handleTogglePinnedSubscription: vi.fn(),
  handleTogglePublicHiddenSubscription: vi.fn(),
  handleRenewSubscription: vi.fn(),
  handleSaveSubscription: vi.fn(),
  handleSaveClonedSubscription: vi.fn(),
  handleEditDialogOpenChange: vi.fn(),
  handleCloneDialogOpenChange: vi.fn(),
  cloneDialogOpen: false,
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  useInfiniteSubscriptions: mocks.useInfiniteSubscriptions,
  useSubscriptions: mocks.useSubscriptions,
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: mocks.useSettings,
}));

vi.mock("@/hooks/use-exchange-rates", () => ({
  useExchangeRates: () => ({
    convert: (amount: number) => amount,
  }),
}));

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: (query: string) => query.includes("min-width"),
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfig: () => ({
    config: {
      categories: [],
      statuses: [],
      paymentMethods: [],
      currencies: [],
    },
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-crud", () => ({
  useSubscriptionCrud: () => ({
    editingSubscription: undefined,
    editDialogOpen: false,
    cloningSubscription: cloneSource.value,
    cloneDialogOpen: mocks.cloneDialogOpen,
    handleAddSubscription: mocks.handleAddSubscription,
    handleDeleteSubscription: mocks.handleDeleteSubscription,
    handleCloneSubscription: mocks.handleCloneSubscription,
    handleEditSubscription: mocks.handleEditSubscription,
    handleTogglePinnedSubscription: mocks.handleTogglePinnedSubscription,
    handleTogglePublicHiddenSubscription: mocks.handleTogglePublicHiddenSubscription,
    handleRenewSubscription: mocks.handleRenewSubscription,
    handleSaveSubscription: mocks.handleSaveSubscription,
    handleSaveClonedSubscription: mocks.handleSaveClonedSubscription,
    handleEditDialogOpenChange: mocks.handleEditDialogOpenChange,
    handleCloneDialogOpenChange: mocks.handleCloneDialogOpenChange,
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-export", () => ({
  useSubscriptionExport: () => ({
    exportToJSON: vi.fn(),
    exportToJSONWithSecrets: vi.fn(),
    exportToCSV: vi.fn(),
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-filters", () => ({
  useSubscriptionFilters: (subscriptions: Subscription[]) => ({
    searchQuery: "",
    setSearchQuery: vi.fn(),
    selectedCategories: [],
    setSelectedCategories: vi.fn(),
    statusFilter: "all",
    setStatusFilter: vi.fn(),
    renewalFilter: "all",
    setRenewalFilter: vi.fn(),
    sortOption: "default",
    setSortOption: vi.fn(),
    selectedTags: [],
    setSelectedTags: vi.fn(),
    advancedFilters: {
      selectedBillingCycles: [],
      selectedPaymentMethods: [],
      selectedCurrencies: [],
      nextBillingFrom: "",
      nextBillingTo: "",
      pinnedFilter: "all",
      publicHiddenFilter: "all",
      reminderModeFilter: "all",
      repeatReminderFilter: "all",
    },
    setAdvancedFilters: vi.fn(),
    allTags: [],
    filteredSubscriptions: subscriptions,
    filterSubscriptionsForDisplay: (items: Subscription[]) => items,
    sortSubscriptionsForDisplay: (items: Subscription[]) => items,
    subscriptionListFilters: undefined,
    hasActiveFilters: false,
    hasActiveAdvancedFilters: false,
    hasActiveControls: false,
    toggleCategory: vi.fn(),
    clearSelectedCategories: vi.fn(),
    toggleTag: vi.fn(),
    clearFilters: vi.fn(),
  }),
}));

vi.mock("@/components/ui/virtualized-list", () => ({
  VirtualizedList: ({
    count,
    renderItem,
    testId,
  }: {
    count: number;
    renderItem: (index: number, virtualItem: { index: number }) => ReactNode;
    testId?: string;
  }) => (
    <div data-testid={testId}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>{renderItem(index, { index })}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/header", () => ({
  Header: () => <header data-testid="header" />,
}));

vi.mock("@/components/back-to-top-float-button", () => ({
  BackToTopFloatButton: () => null,
}));

vi.mock("@/components/subscription-category-filter", () => ({
  SubscriptionCategoryFilter: () => null,
}));

vi.mock("@/components/subscription-tag-filter-drawer", () => ({
  SelectedTagScroller: () => null,
  SubscriptionTagFilterDrawer: () => null,
  SubscriptionTagFilterPopover: () => null,
}));

vi.mock("@/components/subscription-card", () => ({
  SubscriptionCard: ({
    subscription,
    onClone,
  }: {
    subscription: Subscription;
    onClone?: (id: string) => void;
  }) => (
    <article data-testid="subscription-card">
      <button type="button" onClick={() => onClone?.(subscription.id)}>
        复制 {subscription.name}
      </button>
    </article>
  ),
}));

vi.mock("@/components/subscription-dialog", () => ({
  SubscriptionDialog: ({
    open,
    mode,
    initialSubscription,
  }: {
    open: boolean;
    mode: "create" | "edit";
    initialSubscription?: Subscription | null;
  }) => (
    <div data-testid="clone-dialog-state" data-mode={mode}>
      {open ? initialSubscription?.name ?? "no-source" : "closed"}
    </div>
  ),
}));

vi.mock("@/components/subscription-detail-dialog", () => ({
  SubscriptionDetailDialog: () => null,
}));

vi.mock("@/components/add-subscription-dialog", () => ({
  AddSubscriptionDialog: ({ trigger }: { trigger?: ReactNode }) => trigger ?? null,
}));

vi.mock("@/components/edit-subscription-dialog", () => ({
  EditSubscriptionDialog: () => null,
}));

vi.mock("@/components/import-data-dialog", () => ({
  ImportDataDialog: () => null,
}));

vi.mock("@/components/ai-recognize-subscription-dialog", () => ({
  AIRecognizeSubscriptionDialog: () => null,
}));

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub",
    name: "Service",
    logo: undefined,
    price: "10",
    currency: "USD",
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    nextBillingDate: assertDateOnly("2026-02-01"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    startDate: assertDateOnly("2026-01-01"),
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    billingCycle: "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
    oneTimeTermCount: undefined,
    oneTimeTermUnit: undefined,
    ...overrides,
  } as Subscription;
}

function renderSubscriptionsPage() {
  return render(
    <div id="root">
      <Subscriptions />
    </div>,
  );
}

beforeEach(() => {
  cloneSource.value = null;
  mocks.cloneDialogOpen = false;
  mocks.useSettings.mockReturnValue({ data: DEFAULT_SETTINGS });
  mocks.useSubscriptions.mockImplementation(() => {
    const infinite = mocks.useInfiniteSubscriptions();
    return { data: infinite.subscriptions ?? [], isPending: false };
  });
  mocks.useInfiniteSubscriptions.mockReturnValue({
    subscriptions: [subscription({ id: "copyable", name: "Copyable Service" })],
    isPending: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
});

describe("Subscriptions page clone wiring", () => {
  it("wires subscription card clone actions to the CRUD controller", async () => {
    const user = userEvent.setup();
    renderSubscriptionsPage();

    await user.click(screen.getByRole("button", { name: "复制 Copyable Service" }));

    expect(mocks.handleCloneSubscription).toHaveBeenCalledWith("copyable");
  });

  it("renders the clone create dialog with the selected subscription snapshot", () => {
    cloneSource.value = subscription({ id: "source", name: "Clone Source" });
    mocks.cloneDialogOpen = true;

    renderSubscriptionsPage();

    expect(screen.getByTestId("clone-dialog-state")).toHaveTextContent("Clone Source");
    expect(screen.getByTestId("clone-dialog-state")).toHaveAttribute("data-mode", "create");
  });
});
