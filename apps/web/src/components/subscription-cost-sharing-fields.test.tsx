import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CostSharingFields, CostSharingMemberManagerView } from "./subscription-cost-sharing-fields";
import { createSubscriptionFormState, type SubscriptionFormState } from "@/types/subscription-form";
import type { CostSharing } from "@/types/subscription";
import type { SearchableSelectOption } from "@/lib/searchable-options";

const currencyOptions: SearchableSelectOption[] = [
  { value: "CNY", label: "人民币" },
  { value: "USD", label: "美元" },
];

const costSharing: CostSharing = {
  enabled: true,
  splitMode: "custom",
  members: [
    { id: "partner", name: "伴侣", currency: "CNY", customAmount: "50" },
    { id: "friend", name: "朋友", currency: "CNY", customAmount: "30" },
  ],
};

function CostSharingHarness() {
  const [formData, setFormData] = useState(() => createSubscriptionFormState({
    price: "50",
    currency: "CNY",
    costSharing,
  }));
  const update = <K extends keyof SubscriptionFormState>(key: K, value: SubscriptionFormState[K]) => {
    setFormData((current) => ({ ...current, [key]: value }));
  };

  return (
    <div>
      <CostSharingFields
        id={(name) => name}
        formData={formData}
        update={update}
        currencyOptions={currencyOptions}
      />
      <CostSharingMemberManagerView
        id={(name) => name}
        formData={formData}
        update={update}
        currencyOptions={currencyOptions}
      />
    </div>
  );
}

describe("Subscription cost sharing fields", () => {
  it("treats members as other people and custom amounts as recoverable money", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <CostSharingHarness />
      </TooltipProvider>,
    );

    expect(screen.queryByRole("button", { name: "设为我" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设为付款人" })).not.toBeInTheDocument();
    expect(screen.queryByText("付款人")).not.toBeInTheDocument();
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/成员合计\s*¥80/);
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/你的份额\s*¥0/);
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/可回收金额\s*¥80/);
    expect(screen.getByTestId("cost-sharing-custom-total-hint")).toHaveTextContent("成员金额是你希望回收的金额");

    const amountInputs = screen.getAllByLabelText("应收金额");
    await user.clear(amountInputs[1]!);
    await user.type(amountInputs[1]!, "10");

    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/成员合计\s*¥60/);
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/你的份额\s*¥0/);
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/可回收金额\s*¥60/);
  });
});
