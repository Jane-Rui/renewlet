import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Brain, Sparkles, TestTube2 } from "lucide-react";
import { AIErrorDetailsDialog } from "@/components/ai-recognition/ai-error-details-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/i18n/I18nProvider";
import { createAIErrorDetails, type AIErrorDetails } from "@/lib/ai-error-details";
import { cn } from "@/lib/utils";
import {
  canonicalAIRecognitionTransportProtocol,
  type AiModelListItem,
  type AiRecognitionProviderType,
  type AiRecognitionSettings,
} from "@/lib/api/schemas/ai-recognition";
import { resolveAIProviderEndpoint } from "@renewlet/shared/ai-provider-endpoints";
import {
  getAIThinkingOptions,
  normalizeAIThinkingControl,
  thinkingControlFromOptionId,
  thinkingOptionId,
} from "@/modules/ai-recognition/domain/model-capabilities";
import { getAIRecognitionSettingsBlocker } from "@/modules/ai-recognition/domain/settings-readiness";
import { aiRecognitionService } from "@/services/ai-recognition-service";
import { AIModelCombobox, AIModelModeSwitch } from "./ai-model-combobox";
import { LoadingButtonContent } from "./settings-shared-controls";
import type { SecretMutation } from "@renewlet/shared/schemas/secrets";
import { getSettingsSectionClassName } from "./settings-layout";

const AI_PROVIDER_TYPES = ["openai", "anthropic", "gemini", "openai-compatible"] as const satisfies readonly AiRecognitionProviderType[];
const MODEL_DEFAULT_THINKING_ID = "model-default";
const AI_PROVIDER_TYPE_LABEL_KEYS = {
  openai: "aiRecognition.providerType.openai",
  anthropic: "aiRecognition.providerType.anthropic",
  gemini: "aiRecognition.providerType.gemini",
  "openai-compatible": "aiRecognition.providerType.openaiCompatible",
} as const;

interface AIModelListState {
  status: "idle" | "loading" | "success" | "error";
  models: AiModelListItem[];
  error: string | null;
  truncated: boolean;
}

const EMPTY_MODEL_LIST_STATE: AIModelListState = {
  status: "idle",
  models: [],
  error: null,
  truncated: false,
};

function canListAIModels(settings: AiRecognitionSettings, apiKeyConfigured: boolean): boolean {
  const endpoint = resolveAIProviderEndpoint(settings);
  if (endpoint.baseUrlRequired && !settings.baseUrl.trim()) return false;
  if (endpoint.apiKeyRequired && !settings.apiKey.trim() && !apiKeyConfigured) return false;
  return true;
}

interface AIRecognitionSettingsSectionProps {
  id: string;
  className?: string;
  settings: AiRecognitionSettings;
  onChange: (settings: AiRecognitionSettings) => void;
  disabled?: boolean;
  apiKeyConfigured?: boolean;
  onClearApiKey?: () => void;
}

export function AIRecognitionSettingsSection({
  id,
  className,
  settings,
  onChange,
  disabled = false,
  apiKeyConfigured = false,
  onClearApiKey = () => undefined,
}: AIRecognitionSettingsSectionProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [testing, setTesting] = useState(false);
  const [modelListState, setModelListState] = useState<AIModelListState>(EMPTY_MODEL_LIST_STATE);
  const [aiErrorDetails, setAIErrorDetails] = useState<AIErrorDetails | null>(null);
  const [aiErrorDetailsOpen, setAIErrorDetailsOpen] = useState(false);
  const modelListRequestRef = useRef(0);
  const canonicalSettings = useMemo(() => {
    const transportProtocol = canonicalAIRecognitionTransportProtocol(settings.providerType);
    return {
      ...settings,
      transportProtocol,
      defaultThinkingControl: normalizeAIThinkingControl(settings.providerType, transportProtocol, settings.model, settings.defaultThinkingControl),
    };
  }, [settings]);
  const thinkingOptions = useMemo(
    () => getAIThinkingOptions(canonicalSettings.providerType, canonicalSettings.transportProtocol, canonicalSettings.model),
    [canonicalSettings.model, canonicalSettings.providerType, canonicalSettings.transportProtocol],
  );
  const endpoint = useMemo(
    () => resolveAIProviderEndpoint({
      apiKey: canonicalSettings.apiKey,
      baseUrl: canonicalSettings.baseUrl,
      providerType: canonicalSettings.providerType,
    }),
    [canonicalSettings.apiKey, canonicalSettings.baseUrl, canonicalSettings.providerType],
  );
  const selectedThinkingId = canonicalSettings.defaultThinkingControl
    ? thinkingOptionId(canonicalSettings.defaultThinkingControl)
    : MODEL_DEFAULT_THINKING_ID;
  const testBlocker = getAIRecognitionSettingsBlocker(canonicalSettings, apiKeyConfigured);
  const apiKeyMutation = (): SecretMutation => canonicalSettings.apiKey.trim()
    ? { action: "set", value: canonicalSettings.apiKey.trim() }
    : { action: "keep" };

  useEffect(() => {
    // 模型列表来自第三方 provider，必须随凭证/地址变化失效；旧请求返回较慢时也不能覆盖新配置。
    modelListRequestRef.current += 1;
    setModelListState(EMPTY_MODEL_LIST_STATE);
    setAIErrorDetails(null);
    setAIErrorDetailsOpen(false);
  }, [canonicalSettings.apiKey, canonicalSettings.baseUrl, canonicalSettings.providerType, canonicalSettings.transportProtocol]);

  const update = (patch: Partial<AiRecognitionSettings>) => {
    if (disabled) return;
    const providerType = patch.providerType ?? settings.providerType;
    const transportProtocol = canonicalAIRecognitionTransportProtocol(providerType);
    const next = { ...settings, ...patch, providerType, transportProtocol };
    next.defaultThinkingControl = normalizeAIThinkingControl(next.providerType, next.transportProtocol, next.model, next.defaultThinkingControl);
    onChange(next);
  };

  const handleProviderTypeChange = (providerType: AiRecognitionProviderType) => {
    update({
      providerType,
      defaultThinkingControl: null,
    });
  };

  const handleThinkingChange = (id: string) => {
    update({
      defaultThinkingControl: id === MODEL_DEFAULT_THINKING_ID
        ? null
        : thinkingControlFromOptionId(thinkingOptions, id),
    });
  };

  const handleRefreshModels = async () => {
    if (disabled) return;
    const baseUrl = canonicalSettings.baseUrl.trim();
    const apiKey = canonicalSettings.apiKey.trim();
    if (endpoint.baseUrlRequired && !baseUrl) {
      setModelListState({ ...EMPTY_MODEL_LIST_STATE, status: "error", error: t("aiRecognition.baseUrlRequired") });
      return;
    }
    if (endpoint.apiKeyRequired && !apiKey && !apiKeyConfigured) {
      setModelListState({ ...EMPTY_MODEL_LIST_STATE, status: "error", error: t("aiRecognition.apiKeyRequired") });
      return;
    }

    const requestId = modelListRequestRef.current + 1;
    modelListRequestRef.current = requestId;
    setModelListState((current) => ({ ...current, status: "loading", error: null }));
    try {
      const response = await aiRecognitionService.listModels({
        providerType: canonicalSettings.providerType,
        baseUrl,
        apiKey: apiKeyMutation(),
      });
      if (modelListRequestRef.current !== requestId) return;
      setModelListState({
        status: "success",
        models: response.models,
        error: null,
        truncated: response.truncated,
      });
    } catch (error) {
      if (modelListRequestRef.current !== requestId) return;
      const details = createAIErrorDetails(error, t("aiRecognition.modelListFailedDescription"));
      setAIErrorDetails(details);
      setAIErrorDetailsOpen(true);
      setModelListState({
        ...EMPTY_MODEL_LIST_STATE,
        status: "error",
        error: null,
      });
    }
  };

  const handleModelInputModeChange = (modelInputMode: AiRecognitionSettings["modelInputMode"]) => {
    if (disabled) return;
    update({ modelInputMode });
    if (
      modelInputMode === "select"
      && canListAIModels(canonicalSettings, apiKeyConfigured)
      && modelListState.status !== "loading"
      && (modelListState.status === "idle" || modelListState.status === "error" || modelListState.models.length === 0)
    ) {
      void handleRefreshModels();
    }
  };

  const handleTestConnection = async () => {
    if (disabled) return;
    if (testBlocker) {
      toast({
        title: t("aiRecognition.testBlockedTitle"),
        description: t(testBlocker),
        variant: "destructive",
      });
      return;
    }
    setTesting(true);
    try {
      await aiRecognitionService.testConnection(canonicalSettings, apiKeyMutation());
      setAIErrorDetails(null);
      toast({
        title: t("aiRecognition.testSucceeded"),
        description: t("aiRecognition.testSucceededDescription"),
      });
    } catch (error) {
      const details = createAIErrorDetails(error, t("aiRecognition.testFailedDescription"));
      setAIErrorDetails(details);
      setAIErrorDetailsOpen(true);
    } finally {
      setTesting(false);
    }
  };

  return (
    <section id={id} className={getSettingsSectionClassName(className)}>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">{t("aiRecognition.settingsTitle")}</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("aiRecognition.settingsDescription")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="relative shrink-0 gap-2 border-border"
          onClick={() => void handleTestConnection()}
          disabled={disabled || testing}
          aria-busy={testing ? true : undefined}
        >
          <LoadingButtonContent loading={testing} loadingLabel={t("aiRecognition.testing")}>
            <TestTube2 className="h-4 w-4" />
            {t("aiRecognition.testConnection")}
          </LoadingButtonContent>
        </Button>
      </div>

      {aiErrorDetails ? (
        <div className="mb-5 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-border"
            onClick={() => setAIErrorDetailsOpen(true)}
          >
            <AlertTriangle className="h-4 w-4" />
            {t("aiRecognition.errorDetailsOpenLast")}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-5">
        <div className="grid items-start gap-5 md:grid-cols-2 md:gap-x-5 md:gap-y-2" data-testid="ai-provider-model-grid">
          <div className="grid gap-2 md:contents" data-testid="ai-provider-type-field">
            <div className="flex min-h-7 items-end md:order-1" data-testid="ai-provider-label-row">
              <Label htmlFor="ai-provider-type">{t("aiRecognition.providerType")}</Label>
            </div>
            <div className="self-start md:order-3" data-testid="ai-provider-control-row">
              <Select value={canonicalSettings.providerType} disabled={disabled} onValueChange={(value) => handleProviderTypeChange(value as AiRecognitionProviderType)}>
                <SelectTrigger id="ai-provider-type" className="border-border bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_PROVIDER_TYPES.map((providerType) => (
                    <SelectItem key={providerType} value={providerType}>{t(AI_PROVIDER_TYPE_LABEL_KEYS[providerType])}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2 md:contents" data-testid="ai-model-field">
            <div className="flex min-h-7 min-w-0 flex-wrap items-end justify-between gap-x-3 gap-y-1 md:order-2" data-testid="ai-model-label-row">
              <Label htmlFor="ai-model">{t("aiRecognition.model")}</Label>
              <AIModelModeSwitch
                mode={canonicalSettings.modelInputMode}
                disabled={disabled}
                onModeChange={handleModelInputModeChange}
              />
            </div>
            <div className="self-start md:order-4" data-testid="ai-model-control-row">
              <AIModelCombobox
                id="ai-model"
                value={canonicalSettings.model}
                onValueChange={(model) => update({ model })}
                mode={canonicalSettings.modelInputMode}
                models={modelListState.models}
                status={modelListState.status}
                error={modelListState.error}
                truncated={modelListState.truncated}
              canAutoRefreshModels={canListAIModels(canonicalSettings, apiKeyConfigured)}
                onRequestModels={() => void handleRefreshModels()}
                disabled={disabled}
                placeholder={t("aiRecognition.modelPlaceholder")}
              />
            </div>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="ai-base-url">{t("aiRecognition.baseUrl")}</Label>
            <Input
              id="ai-base-url"
              value={canonicalSettings.baseUrl}
              disabled={disabled}
              onChange={(event) => update({ baseUrl: event.target.value })}
              placeholder={endpoint.baseUrlRequired ? "https://api.example.com/v1" : t("aiRecognition.baseUrlPlaceholder")}
              className="border-border bg-secondary"
              inputMode="url"
            />
            <p className="text-xs text-muted-foreground">{t("aiRecognition.baseUrlHelp")}</p>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="ai-api-key">{t("aiRecognition.apiKey")}</Label>
              {apiKeyConfigured ? (
                <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onClearApiKey}>
                  {t("settings.turnstileClearSecret")}
                </Button>
              ) : null}
            </div>
            <Input
              id="ai-api-key"
              type="password"
              autoComplete="off"
              value={canonicalSettings.apiKey}
              disabled={disabled}
              onChange={(event) => update({ apiKey: event.target.value })}
              placeholder={apiKeyConfigured ? t("settings.turnstileSecretConfiguredPlaceholder") : endpoint.apiKeyRequired ? "sk-..." : t("aiRecognition.apiKeyOptionalPlaceholder")}
              className="border-border bg-secondary"
            />
            <p className="text-xs text-muted-foreground">{t("aiRecognition.apiKeyHelp")}</p>
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-2">
        <Label htmlFor="ai-thinking" className="inline-flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" />
          {t("aiRecognition.defaultThinking")}
        </Label>
        <Select value={selectedThinkingId} disabled={disabled} onValueChange={handleThinkingChange}>
          <SelectTrigger id="ai-thinking" className="border-border bg-secondary md:max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={MODEL_DEFAULT_THINKING_ID}>{t("aiRecognition.thinking.modelDefault")}</SelectItem>
            {thinkingOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs leading-5 text-muted-foreground">
          {thinkingOptions.length > 0
            ? t("aiRecognition.thinkingHelp")
            : t(canonicalSettings.providerType === "openai-compatible" ? "aiRecognition.thinkingUnsupportedCompatible" : "aiRecognition.thinkingUnsupportedModel")}
        </p>
      </div>
      <AIErrorDetailsDialog
        open={aiErrorDetailsOpen}
        details={aiErrorDetails}
        onOpenChange={setAIErrorDetailsOpen}
      />
    </section>
  );
}
