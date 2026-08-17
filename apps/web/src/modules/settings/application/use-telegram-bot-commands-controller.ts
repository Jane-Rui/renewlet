import { useCallback, useMemo } from "react";
import {
  useDeleteTelegramBotCommands,
  useInstallTelegramBotCommands,
  useTelegramBotCommands,
} from "@/hooks/use-telegram-bot-commands";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";
import type { TelegramBotCommandsResponse } from "@/lib/api/schemas/telegram-bot";
import type { AppSettings } from "@/types/subscription";

export interface SettingsTelegramBotCommandsController {
  data: TelegramBotCommandsResponse | undefined;
  isLoading: boolean;
  isInstalling: boolean;
  isDeleting: boolean;
  installDisabledReason: string | null;
  deleteDisabledReason: string | null;
  install: () => Promise<void>;
  deleteCommands: () => Promise<void>;
  refetch: () => void | Promise<unknown>;
}

export function useTelegramBotCommandsController({
  settings,
  savedSettings,
  telegramTokenConfigured,
  externalIntegrationsDisabled,
}: {
  settings: AppSettings;
  savedSettings: AppSettings;
  telegramTokenConfigured: boolean;
  externalIntegrationsDisabled: boolean;
}): SettingsTelegramBotCommandsController {
  const { t } = useI18n();
  const { toast } = useToast();
  const commands = useTelegramBotCommands();
  const installMutation = useInstallTelegramBotCommands();
  const deleteMutation = useDeleteTelegramBotCommands();
  // 管理 API 只读取已保存的 Telegram 凭据；草稿变更必须先保存，避免 webhook 安装到用户未提交的 token/chat。
  const savedConfigComplete = Boolean(telegramTokenConfigured && savedSettings.telegramChatId.trim());
  const telegramConfigDirty = Boolean(settings.telegramBotToken.trim())
    || settings.telegramChatId.trim() !== savedSettings.telegramChatId.trim();
  const currentOriginHttps = typeof window === "undefined" || window.location.protocol === "https:";
  const isInstalling = commands.data?.status === "installing" || installMutation.isPending;

  const installDisabledReason = useMemo(() => {
    if (externalIntegrationsDisabled) return t("settings.telegramBotCommandsDemoDisabled");
    if (!currentOriginHttps) return t("settings.telegramBotCommandsHttpsRequired");
    if (!savedConfigComplete) return t("settings.telegramBotCommandsConfigMissing");
    if (telegramConfigDirty) return t("settings.telegramBotCommandsSaveFirst");
    return null;
  }, [
    currentOriginHttps,
    externalIntegrationsDisabled,
    savedConfigComplete,
    t,
    telegramConfigDirty,
  ]);

  const deleteDisabledReason = useMemo(() => {
    if (externalIntegrationsDisabled) return t("settings.telegramBotCommandsDemoDisabled");
    if (!savedConfigComplete) return t("settings.telegramBotCommandsConfigMissing");
    if (deleteMutation.isPending) return t("settings.telegramBotCommandsDeleting");
    return null;
  }, [deleteMutation.isPending, externalIntegrationsDisabled, savedConfigComplete, t]);

  const install = useCallback(async () => {
    if (installDisabledReason || isInstalling) return;
    try {
      await installMutation.mutateAsync();
      toast({
        title: t("settings.telegramBotCommandsInstalled"),
        description: t("settings.telegramBotCommandsInstalledDescription"),
      });
    } catch (error) {
      toast({
        title: t("settings.telegramBotCommandsInstallFailed"),
        description: getDisplayErrorMessage(error, t("settings.telegramBotCommandsInstallFailedDescription")),
        variant: "destructive",
      });
    }
  }, [installDisabledReason, installMutation, isInstalling, t, toast]);

  const deleteCommands = useCallback(async () => {
    if (deleteDisabledReason) return;
    try {
      await deleteMutation.mutateAsync();
      toast({
        title: t("settings.telegramBotCommandsDeleted"),
        description: t("settings.telegramBotCommandsDeletedDescription"),
      });
    } catch (error) {
      toast({
        title: t("settings.telegramBotCommandsDeleteFailed"),
        description: getDisplayErrorMessage(error, t("settings.telegramBotCommandsDeleteFailedDescription")),
        variant: "destructive",
      });
    }
  }, [deleteDisabledReason, deleteMutation, t, toast]);

  return {
    data: commands.data,
    isLoading: commands.isLoading,
    isInstalling,
    isDeleting: deleteMutation.isPending,
    installDisabledReason,
    deleteDisabledReason,
    install,
    deleteCommands,
    refetch: commands.refetch,
  };
}
