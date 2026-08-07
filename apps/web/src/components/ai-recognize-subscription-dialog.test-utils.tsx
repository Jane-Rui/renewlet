import { render } from "@testing-library/react";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AiRecognizedSubscriptionDraft, AiRecognizeResponse } from "@/lib/api/schemas/ai-recognition";
import type { ImportPreviewResponse } from "@/lib/api/schemas/import-export";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/subscription";
import { AIRecognizeSubscriptionDialog } from "./ai-recognize-subscription-dialog";

// 测试设置固定为“已配置 provider”，让用例聚焦 AI 弹层状态机而不是设置就绪态。
export function configuredSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    aiRecognition: {
      providerType: "openai",
      transportProtocol: "openai-chat",
      model: "gpt-5-mini",
      modelInputMode: "select",
      baseUrl: "",
      apiKey: "sk-test",
      defaultThinkingControl: null,
    },
  };
}

export function makeDraft(overrides: Partial<AiRecognizedSubscriptionDraft> = {}): AiRecognizedSubscriptionDraft {
  return {
    name: "Apple Music",
    price: "50",
    currency: "USD",
    billingCycle: "annual",
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
    category: "music",
    status: "active",
    paymentMethod: null,
    startDate: "2026-01-01",
    nextBillingDate: "2027-01-01",
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: { value: "https://www.apple.com/", source: "suggested" },
    notes: { value: "Apple subscription, service needs user confirmation.", source: "suggested" },
    tags: ["Apple", "Music"],
    reminderDays: null,
    repeatReminderEnabled: null,
    repeatReminderInterval: null,
    repeatReminderWindow: null,
    confidence: "high",
    warnings: [],
    ...overrides,
  };
}

export function makeResponse(subscriptions: AiRecognizedSubscriptionDraft[]): AiRecognizeResponse {
  return {
    providerType: "openai",
    transportProtocol: "openai-chat",
    model: "gpt-5-mini",
    subscriptions,
    warnings: [],
    // diagnostics 在成功响应里只做当前请求排障，测试 fixture 不应被导入 preview/apply 断言消费。
    diagnostics: {
      schemaVersion: "1",
      promptVersion: "test",
      schemaName: "test",
      prompt: {
        system: { value: "", truncated: false },
        user: { value: "", truncated: false },
      },
      output: {
        rawModelText: null,
        rawObjectJson: null,
      },
      request: {
        providerType: "openai",
        transportProtocol: "openai-chat",
        model: "gpt-5-mini",
        thinkingControl: null,
        maxOutputTokens: 4096,
        textCharCount: 0,
        images: [],
      },
      response: {
        usage: null,
        finishReason: null,
        providerMetadata: null,
      },
    },
  };
}

export function makePreview(): ImportPreviewResponse {
  return {
    summary: {
      total: 1,
      creates: 1,
      replaces: 0,
      skips: 0,
      errors: 0,
      warnings: 0,
    },
    items: [
      {
        index: 0,
        name: "Apple Music",
        source: "ai",
        sourceId: "apple-music",
        action: "create",
        warnings: [],
        errors: [],
      },
    ],
    includesSettings: false,
    includesCustomConfig: false,
    includesExchangeRateSnapshots: false,
    exchangeRateSnapshotsCount: 0,
  };
}

export function renderDialog(settings: AppSettings = configuredSettings(), onOpenChange = vi.fn()) {
  return {
    onOpenChange,
    ...render(
      <TooltipProvider delayDuration={0}>
        <AIRecognizeSubscriptionDialog
          open
          onOpenChange={onOpenChange}
          settings={settings}
          config={DEFAULT_CUSTOM_CONFIG}
          availableTags={["Work", "Streaming"]}
        />
      </TooltipProvider>,
    ),
  };
}

export function mockMobile(matches = true) {
  // AI 弹层在 H5 下换成 workbench 布局，测试通过 matchMedia 明确锁定移动端分支。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 639px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

export function clipboardDataWithItems(items: Array<{ file: File; kind?: string; type?: string }>): DataTransfer {
  // 粘贴图片走 DataTransferItem.getAsFile；直接 files 数组覆盖不了该浏览器路径。
  return {
    items: items.map(({ file, kind = "file", type = file.type }) => ({
      kind,
      type,
      getAsFile: () => file,
    })),
    files: [],
  } as unknown as DataTransfer;
}

export function clipboardDataWithFiles(files: File[]): DataTransfer {
  return {
    items: [],
    files,
  } as unknown as DataTransfer;
}
