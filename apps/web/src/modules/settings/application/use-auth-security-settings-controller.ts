import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthSecuritySettings, useUpdateAuthSecuritySettings } from "@/hooks/use-auth-security";
import { useToast } from "@/hooks/use-toast";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { useI18n } from "@/i18n/I18nProvider";

export interface AuthSecurityTurnstileDraft {
  enabled: boolean;
  siteKey: string;
  secret: string;
}

export interface SettingsAuthSecurityController {
  canManage: boolean;
  disabled: boolean;
  isLoading: boolean;
  isSaving: boolean;
  isClearingSecret: boolean;
  secretConfigured: boolean;
  hasChanges: boolean;
  draft: AuthSecurityTurnstileDraft;
  setEnabled: (enabled: boolean) => void;
  setSiteKey: (siteKey: string) => void;
  setSecret: (secret: string) => void;
  discard: () => void;
  save: () => Promise<void>;
  clearSecret: () => Promise<void>;
}

const emptyDraft: AuthSecurityTurnstileDraft = {
  enabled: false,
  siteKey: "",
  secret: "",
};

/**
 * 访问安全是站点级管理员配置，不参与账号 settings 草稿；secret 输入始终 write-only。
 */
export function useAuthSecuritySettingsController(canManage: boolean, disabled: boolean): SettingsAuthSecurityController {
  const { t } = useI18n();
  const { toast } = useToast();
  const query = useAuthSecuritySettings(canManage);
  const update = useUpdateAuthSecuritySettings();
  const [draft, setDraft] = useState<AuthSecurityTurnstileDraft>(emptyDraft);
  const [savedDraft, setSavedDraft] = useState<AuthSecurityTurnstileDraft>(emptyDraft);
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [clearingSecret, setClearingSecret] = useState(false);
  const dirtyRef = useRef(false);

  const hasChanges = useMemo(
    // savedDraft 永远不保存真实 secret；只要 secret 输入非空就视为一次 write-only 更新。
    () => draft.enabled !== savedDraft.enabled || draft.siteKey !== savedDraft.siteKey || draft.secret.trim().length > 0,
    [draft, savedDraft],
  );

  useEffect(() => {
    dirtyRef.current = hasChanges;
  }, [hasChanges]);

  useEffect(() => {
    const remote = query.data?.turnstile;
    if (!remote || dirtyRef.current) return;
    // 远端响应只含 secretConfigured；用户编辑中时不让后台刷新覆盖本地草稿或清掉待提交 secret。
    const nextDraft = {
      enabled: remote.enabled,
      siteKey: remote.siteKey,
      secret: "",
    };
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setSecretConfigured(remote.secretConfigured);
  }, [query.data]);

  const setEnabled = useCallback((enabled: boolean) => {
    if (disabled) return;
    setDraft((current) => ({ ...current, enabled }));
  }, [disabled]);

  const setSiteKey = useCallback((siteKey: string) => {
    if (disabled) return;
    setDraft((current) => ({ ...current, siteKey }));
  }, [disabled]);

  const setSecret = useCallback((secret: string) => {
    if (disabled) return;
    setDraft((current) => ({ ...current, secret }));
  }, [disabled]);

  const discard = useCallback(() => {
    setDraft(savedDraft);
  }, [savedDraft]);

  const save = useCallback(async () => {
    if (!canManage || disabled || update.isPending) return;
    const siteKey = draft.siteKey.trim();
    const secret = draft.secret.trim();
    if (draft.enabled && (!siteKey || (!secretConfigured && !secret))) {
      toast({
        title: t("settings.turnstileSaveFailed"),
        description: t("settings.turnstileIncomplete"),
        variant: "destructive",
      });
      return;
    }
    try {
      const response = await update.mutateAsync({
        turnstile: {
          enabled: draft.enabled,
          siteKey,
          // secret 省略表示保留服务端旧值；不能把空输入当作清空，否则会误关已启用站点。
          ...(secret ? { secret } : {}),
        },
      });
      const nextDraft = {
        enabled: response.turnstile.enabled,
        siteKey: response.turnstile.siteKey,
        secret: "",
      };
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setSecretConfigured(response.turnstile.secretConfigured);
      toast({
        title: t("settings.turnstileSaved"),
        description: t("settings.turnstileSavedDescription"),
      });
    } catch (error) {
      toast({
        title: t("settings.turnstileSaveFailed"),
        description: getDisplayErrorMessage(error, t("settings.turnstileSaveFailedDescription")),
        variant: "destructive",
      });
    }
  }, [canManage, disabled, draft.enabled, draft.secret, draft.siteKey, secretConfigured, t, toast, update]);

  const clearSecret = useCallback(async () => {
    if (!canManage || disabled || update.isPending || !secretConfigured) return;
    setClearingSecret(true);
    try {
      const response = await update.mutateAsync({
        turnstile: {
          // 清空 secret 会让完整配置失效，必须同时关闭开关，避免登录页展示无法通过的挑战。
          enabled: false,
          siteKey: draft.siteKey.trim(),
          secret: "",
        },
      });
      const nextDraft = {
        enabled: response.turnstile.enabled,
        siteKey: response.turnstile.siteKey,
        secret: "",
      };
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setSecretConfigured(response.turnstile.secretConfigured);
      toast({
        title: t("settings.turnstileSecretCleared"),
        description: t("settings.turnstileSecretClearedDescription"),
      });
    } catch (error) {
      toast({
        title: t("settings.turnstileSaveFailed"),
        description: getDisplayErrorMessage(error, t("settings.turnstileSaveFailedDescription")),
        variant: "destructive",
      });
    } finally {
      setClearingSecret(false);
    }
  }, [canManage, disabled, draft.siteKey, secretConfigured, t, toast, update]);

  return {
    canManage,
    disabled,
    isLoading: query.isLoading,
    isSaving: update.isPending && !clearingSecret,
    isClearingSecret: clearingSecret,
    secretConfigured,
    hasChanges,
    draft,
    setEnabled,
    setSiteKey,
    setSecret,
    discard,
    save,
    clearSecret,
  };
}
