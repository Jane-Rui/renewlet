import { useCallback, useEffect, useRef, useState } from "react";
import { useBuiltInIconIndexStatus, useCheckBuiltInIconIndexProvider, useRefreshBuiltInIconIndexProvider } from "@/hooks/use-built-in-icon-index";
import { useToast } from "@/hooks/use-toast";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { createRawErrorResponseDetails, type RawErrorResponseDetails } from "@/lib/raw-error-response";
import type { BuiltInIconIndexStatus, BuiltInIconRefreshJob } from "@/lib/api/schemas/media";
import { useI18n } from "@/i18n/I18nProvider";
import { BUILT_IN_ICON_PROVIDERS, type BuiltInIconProvider } from "@renewlet/shared/built-in-icons";

export interface SettingsBuiltInIconIndexController {
  canManage: boolean;
  status: BuiltInIconIndexStatus | undefined;
  isLoading: boolean;
  checkingProviders: BuiltInIconProvider[];
  refreshingProvider: BuiltInIconProvider | null;
  errorDetails: RawErrorResponseDetails | null;
  errorDetailsOpen: boolean;
  setErrorDetailsOpen: (open: boolean) => void;
  checkAllProviders: () => Promise<void>;
  checkProvider: (provider: BuiltInIconProvider) => Promise<void>;
  refreshProvider: (provider: BuiltInIconProvider) => Promise<void>;
}

// 内置图标索引是管理员级全局状态，不能和 settings 表单草稿混在一起，否则会制造未保存提示和普通用户可见状态。
export function useSettingsBuiltInIconIndexController(canManage: boolean): SettingsBuiltInIconIndexController {
  const { t } = useI18n();
  const { toast } = useToast();
  const status = useBuiltInIconIndexStatus(canManage);
  const checkProvider = useCheckBuiltInIconIndexProvider();
  const refreshProvider = useRefreshBuiltInIconIndexProvider();
  const [checkingProviders, setCheckingProviders] = useState<BuiltInIconProvider[]>([]);
  const [refreshingProvider, setRefreshingProvider] = useState<BuiltInIconProvider | null>(null);
  const [errorDetails, setErrorDetails] = useState<RawErrorResponseDetails | null>(null);
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
  const batchCheckInFlightRef = useRef(false);
  const trackedRefreshJobsRef = useRef(new Map<string, BuiltInIconProvider>());
  const providerStatuses = status.data?.providers;

  useEffect(() => {
    if (!canManage || !status.data || trackedRefreshJobsRef.current.size === 0) return;
    for (const providerStatus of status.data.providers) {
      const job = providerStatus.job;
      if (!job || isRefreshJobActive(job)) continue;
      const provider = trackedRefreshJobsRef.current.get(job.id);
      if (provider !== providerStatus.provider) continue;
      // 只接管当前标签页主动触发的后台任务；历史终态 job 仍留在弹层详情里，不能打开页面就乱弹 toast。
      trackedRefreshJobsRef.current.delete(job.id);
      const source = t(`settings.builtInIconSourceShort.${provider}`);
      if (job.status === "succeeded") {
        toast({
          title: t("settings.builtInIconIndexRefreshSuccess"),
          description: t("settings.builtInIconIndexRefreshSuccessDescription", {
            source,
            count: providerStatus.iconCount,
          }),
        });
      } else if (job.status === "failed") {
        toast({
          title: t("settings.builtInIconIndexRefreshFailed"),
          description: job.error ?? t("settings.builtInIconIndexRefreshFailedDescription", { source }),
          variant: "destructive",
        });
      }
    }
  }, [canManage, status.data, t, toast]);

  const runProviderCheck = useCallback(async (provider: BuiltInIconProvider) => {
    setCheckingProviders((current) => current.includes(provider) ? current : [...current, provider]);
    try {
      await checkProvider.mutateAsync(provider);
    } catch (error) {
      // check 失败仍 refetch 后端状态，因为 GitHub 限流/上游错误会被记录为 provider 级摘要。
      const details = createRawErrorResponseDetails(error);
      setErrorDetails(details);
      setErrorDetailsOpen(true);
      await status.refetch();
    } finally {
      setCheckingProviders((current) => current.filter((item) => item !== provider));
    }
  }, [checkProvider, status]);

  const handleCheckProvider = useCallback(async (provider: BuiltInIconProvider) => {
    if (!canManage || checkProvider.isPending) return;
    await runProviderCheck(provider);
  }, [canManage, checkProvider.isPending, runProviderCheck]);

  const handleCheckAllProviders = useCallback(async () => {
    if (!canManage || checkProvider.isPending || batchCheckInFlightRef.current) return;
    batchCheckInFlightRef.current = true;
    const providers = BUILT_IN_ICON_PROVIDERS.filter((provider) => {
      const providerStatus = providerStatuses?.find((item) => item.provider === provider);
      return refreshingProvider !== provider && !providerStatus?.refreshing;
    });
    setCheckingProviders((current) => Array.from(new Set([...current, ...providers])));
    try {
      // 弹层级检查要串行访问 GitHub feed；并发会放大共享出口 403/429，还会让 badge 状态乱跳。
      for (const provider of providers) {
        await runProviderCheck(provider);
      }
    } finally {
      batchCheckInFlightRef.current = false;
    }
  }, [canManage, checkProvider.isPending, providerStatuses, refreshingProvider, runProviderCheck]);

  const handleRefreshProvider = useCallback(async (provider: BuiltInIconProvider) => {
    if (!canManage || refreshProvider.isPending) return;
    setRefreshingProvider(provider);
    try {
      const response = await refreshProvider.mutateAsync(provider);
      if (response.job.status === "succeeded") {
        toast({
          title: t("settings.builtInIconIndexRefreshSuccess"),
          description: t("settings.builtInIconIndexRefreshSuccessDescription", {
            source: t(`settings.builtInIconSourceShort.${provider}`),
            count: response.provider.iconCount,
          }),
        });
      } else if (isRefreshJobActive(response.job)) {
        trackedRefreshJobsRef.current.set(response.job.id, provider);
        toast({
          title: t("settings.builtInIconIndexRefreshQueued"),
          description: t("settings.builtInIconIndexRefreshQueuedDescription", {
            source: t(`settings.builtInIconSourceShort.${provider}`),
          }),
        });
      }
    } catch (error) {
      const details = createRawErrorResponseDetails(error);
      setErrorDetails(details);
      setErrorDetailsOpen(true);
      await status.refetch();
      toast({
        title: t("settings.builtInIconIndexRefreshFailed"),
        description: getDisplayErrorMessage(error, t("settings.builtInIconIndexRefreshFailedDescription", {
          source: t(`settings.builtInIconSourceShort.${provider}`),
        })),
        variant: "destructive",
      });
    } finally {
      setRefreshingProvider((current) => current === provider ? null : current);
    }
  }, [canManage, refreshProvider, status, t, toast]);

  return {
    canManage,
    status: status.data,
    isLoading: status.isLoading,
    checkingProviders,
    refreshingProvider,
    errorDetails,
    errorDetailsOpen,
    setErrorDetailsOpen,
    checkAllProviders: handleCheckAllProviders,
    checkProvider: handleCheckProvider,
    refreshProvider: handleRefreshProvider,
  };
}

function isRefreshJobActive(job: BuiltInIconRefreshJob): boolean {
  return job.status === "queued" || job.status === "running";
}
