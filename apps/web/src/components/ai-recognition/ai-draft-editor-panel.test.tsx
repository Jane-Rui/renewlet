// AI 草稿编辑器绕过 SubscriptionDialog，单独保护它也服从设置页货币管理顺序。
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import { configuredSettings, makeDraft } from "../ai-recognize-subscription-dialog.test-utils";
import { AIDraftEditorPanel } from "./ai-draft-editor-panel";

const currencyManagerOrderConfig: CustomConfig = {
  ...DEFAULT_CUSTOM_CONFIG,
  currencies: [
    { id: "PHP", value: "PHP", labels: { "zh-CN": "₱ 菲律宾比索 (PHP)", "en-US": "₱ Philippine Peso (PHP)" }, enabled: true },
    { id: "AED", value: "AED", labels: { "zh-CN": "AED 阿联酋迪拉姆", "en-US": "AED United Arab Emirates Dirham" }, enabled: true },
    { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
    { id: "CNY", value: "CNY", labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" }, enabled: true },
    { id: "EUR", value: "EUR", labels: { "zh-CN": "€ 欧元 (EUR)", "en-US": "€ Euro (EUR)" }, enabled: true },
  ],
};

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
});

function getCurrencyOptionTexts(): string[] {
  const listbox = screen.getByRole("listbox");
  return Array.from(listbox.querySelectorAll<HTMLElement>("[cmdk-item]"))
    .map((item) => item.textContent ?? "");
}

describe("AIDraftEditorPanel", () => {
  it("uses the currency manager order for the draft currency selector", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <AIDraftEditorPanel
          draftId="draft-1"
          draft={makeDraft({ currency: "CNY" })}
          draftNumber={1}
          config={currencyManagerOrderConfig}
          settings={configuredSettings()}
          blockingIssues={[]}
          onChange={vi.fn()}
          onRemove={vi.fn()}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("combobox", { name: /选择货币|Select currency/ }));

    const optionTexts = getCurrencyOptionTexts();
    expect(optionTexts).toHaveLength(5);
    expect(optionTexts[0]).toContain("PHP");
    expect(optionTexts[1]).toContain("AED");
    expect(optionTexts[2]).toContain("USD");
    expect(optionTexts[3]).toContain("CNY");
    expect(optionTexts[4]).toContain("EUR");
  });
});
