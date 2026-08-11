/**
 * Custom Config 数据 Provider 的 application hook。
 *
 * 架构位置：
 * - Context 只负责把这里的能力挂到 React 树。
 * - 这里统一处理远端 API、localStorage 兜底和防抖保存。
 * - 规范化规则来自 domain，避免把脏数据处理散落在 UI 组件中。
 *
 * 数据优先级：
 * ```
 * 首屏默认值 -> localStorage 兜底 -> 已登录远端配置覆盖 -> 用户编辑 -> localStorage + debounce API
 * ```
 *
 * 注意： PocketBase JSON 字段和 localStorage 都可能携带旧结构；进入状态前必须经过 domain normalize。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_CUSTOM_CONFIG, normalizePaymentMethods, type ConfigItem, type CustomConfig } from "@/types/config";
import { normalizeCustomConfig } from "../domain/normalize-custom-config";
import { customConfigService } from "@/services/custom-config-service";
import { reportClientError } from "@/lib/report-client-error";

const LOCAL_STORAGE_KEY = "renewlet_custom_config";
const CUSTOM_CONFIG_QUERY_KEY = ["custom-config"] as const;

/**
 * 管理自定义配置的数据来源、缓存和远端防抖保存。
 *
 * 注意： 该 hook 允许未登录/离线时继续使用 localStorage 兜底。不要把 401 当作致命错误，
 * 否则登录页或 setup 前的组件树会被自定义配置查询拖垮。
 */
export function useCustomConfigState() {
  const [config, setConfig] = useState<CustomConfig>(DEFAULT_CUSTOM_CONFIG);
  const queryClient = useQueryClient();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveVersionRef = useRef(0);

  const { data: remoteConfig } = useQuery<CustomConfig | null>({
    queryKey: CUSTOM_CONFIG_QUERY_KEY,
    queryFn: async () => {
      return await customConfigService.get();
    },
    retry: false,
  });

  const saveMutation = useMutation({
    mutationFn: async (nextConfig: CustomConfig) => {
      return await customConfigService.save(nextConfig);
    },
  });

  const rememberSavedConfig = useCallback((savedConfig: CustomConfig) => {
    queryClient.setQueryData(CUSTOM_CONFIG_QUERY_KEY, savedConfig);
  }, [queryClient]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (saved) {
        // localStorage 是离线兜底，不是可信存储；旧版本或用户手改都必须被 normalize 后再进入 Context。
        setConfig(normalizeCustomConfig(JSON.parse(saved)));
      }
    } catch (e) {
      reportClientError(e, { source: "custom-config.load-local" });
    }
  }, []);

  useEffect(() => {
    if (!remoteConfig) return;
    setConfig(remoteConfig);
  }, [remoteConfig]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      reportClientError(e, { source: "custom-config.save-local" });
    }
  }, [config]);

  const scheduleRemoteSave = useCallback(
    (nextConfig: CustomConfig) => {
      // 拖拽排序会产生高频更新，防抖能显著减少 SQLite 写入和 API 抖动。
      // PERF： 配置项大量增长时，可改成“保存按钮”或批量 patch 协议。
      const saveVersion = saveVersionRef.current + 1;
      saveVersionRef.current = saveVersion;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void queryClient.cancelQueries({ queryKey: CUSTOM_CONFIG_QUERY_KEY }).finally(() => {
          saveMutation.mutate(nextConfig, {
            onSuccess: (savedConfig) => {
              // 只让最后一次保存刷新查询缓存，避免旧请求晚返回后覆盖用户刚拖拽保存的顺序。
              if (saveVersionRef.current !== saveVersion) return;
              rememberSavedConfig(savedConfig);
            },
          });
        });
      }, 500);
    },
    [queryClient, rememberSavedConfig, saveMutation],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const updateConfig = useCallback(
    (updater: (prev: CustomConfig) => CustomConfig) => {
      setConfig((prev) => {
        const next = updater(prev);
        scheduleRemoteSave(next);
        return next;
      });
    },
    [scheduleRemoteSave],
  );

  const updateCategories = useCallback(
    (items: ConfigItem[]) => {
      updateConfig((prev) => ({ ...prev, categories: items }));
    },
    [updateConfig],
  );

  const updateStatuses = useCallback(
    (items: ConfigItem[]) => {
      updateConfig((prev) => ({ ...prev, statuses: items }));
    },
    [updateConfig],
  );

  const updatePaymentMethods = useCallback(
    (items: ConfigItem[]) => {
      updateConfig((prev) => ({ ...prev, paymentMethods: normalizePaymentMethods(items) }));
    },
    [updateConfig],
  );

  const updateCurrencies = useCallback(
    (items: ConfigItem[]) => {
      updateConfig((prev) => ({ ...prev, currencies: items }));
    },
    [updateConfig],
  );

  const saveConfig = useCallback(
    async (nextConfig: CustomConfig) => {
      const normalized = normalizeCustomConfig(nextConfig);
      const saveVersion = saveVersionRef.current + 1;
      saveVersionRef.current = saveVersion;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // 保存前停止旧读取，避免晚返回的 custom-config GET 覆盖刚保存的货币管理顺序。
      await queryClient.cancelQueries({ queryKey: CUSTOM_CONFIG_QUERY_KEY });
      const savedConfig = await saveMutation.mutateAsync(normalized);
      if (saveVersionRef.current === saveVersion) {
        setConfig(savedConfig);
        rememberSavedConfig(savedConfig);
      }
      return savedConfig;
    },
    [queryClient, rememberSavedConfig, saveMutation],
  );

  return {
    config,
    updateCategories,
    updateStatuses,
    updatePaymentMethods,
    updateCurrencies,
    saveConfig,
  };
}
