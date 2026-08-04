/**
 * 系统配置页（/settings）。
 *
 * 架构位置：
 * - app route 只装配本 screen。
 * - application controller 负责远端同步、toast、主题本地状态和通知测试。
 * - 本文件只消费 props/handlers 并渲染设置分区。
 *
 * 关键依赖：
 * - useSettingsFormController：Settings 页唯一业务入口。
 * - ConfigManagerDialog：自定义配置的模块化 presentation。
 * - ThemeSelector：外观即时预览控件。
 *
 * 注意： 如果这里直接引入 API client、auth client 或 localStorage，就会破坏
 * 依赖方向保持为 presentation -> application -> domain。
 */

import { useEffect, useState } from 'react';
import { Header } from '@/components/header';
import { BackToTopFloatButton } from '@/components/back-to-top-float-button';
import { ImportDataDialog } from '@/components/import-data-dialog';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NumericInput } from '@/components/ui/numeric-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SearchableSelect, type SearchableSelectOption } from '@/components/ui/searchable-select';
import { TimePicker } from '@/components/ui/time-picker';
import { ConfigManagerDialog } from '@/modules/custom-config/presentation/config-manager-dialog';
import { ThemeSelector } from '@/components/theme-selector';
import { RawErrorResponseDialog } from '@/components/raw-error-response-dialog';
import { NotificationHistoryPanel } from './notification-history-panel';
import { Settings2, FolderKanban, Activity, CreditCard, Coins, Palette } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CURRENCY_OPTIONS, MAX_REMINDER_DAYS, type NotificationChannel, type PublicStatusCurrency } from '@/types/subscription';
import { isBuiltInPaymentMethodValue } from '@/types/config';
import { assertLocalTime } from '@/lib/time/local-time';
import { getSupportedTimeZones } from '@/lib/time/time-zone';
import { createCurrencySelectOptions, createTimeZoneSelectOptions } from '@/lib/searchable-options';
import { useSettingsFormController } from '../application/use-settings-form-controller';
import { useI18n } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/locales';
import { AccountSettingsSection } from './account-settings-section';
import { NotificationChannelConfigPanel } from './notification-channel-config-panel';
import { NotificationChannelList } from './notification-channel-list';
import { ExchangeRatesSection } from './exchange-rates-section';
import { BuiltInIconSourcesSection } from './built-in-icon-sources-section';
import { UploadedIconsSection } from './uploaded-icons-section';
import { AIRecognitionSettingsSection } from './ai-recognition-settings-section';
import { CalendarFeedSection } from './calendar-feed-section';
import { PublicStatusPageSection } from './public-status-page-section';
import { PublicApiSection } from './public-api-section';
import { CloudBackupSection } from './cloud-backup-section';
import { CheckboxSettingRow, LoadingButtonContent } from './settings-shared-controls';
import { useCloudBackupController } from '../application/use-cloud-backup-controller';
import { useUploadedAssetsManager } from '../application/use-uploaded-assets-manager';
import {
  DesktopSettingsSectionNav,
  MobileSettingsPageHeader,
  MobileSettingsSectionDrawer,
  useSettingsSectionNavigation,
  useUnsavedChangesGuard,
} from './settings-section-navigation';
import {
  SETTINGS_SECTION_FRAME_CLASS,
  SETTINGS_SECTION_SCROLL_CLASS,
  settingsLayout,
} from './settings-layout';

/** 设置页 screen：只负责布局与展示，业务状态由 controller 提供。 */
export function SettingsScreen() {
  const { t, locale, setLocale, formatDateTime } = useI18n();
  const {
    settings,
    effectiveThemeMode,
    accountEmail,
    canManageUsers,
    canAccessPocketBaseAdmin,
    customConfig,
    subscriptionsQuery,
    categoryUsageCount,
    rates,
    activeRateProvider,
    ratesLoading,
    lastUpdated,
    ratesError,
    ratesErrorDetails,
    ratesWarning,
    getCurrencySymbol,
    updateCategories,
    updateStatuses,
    updatePaymentMethods,
    updateSetting,
    monthlyBudgetInput,
    monthlyBudgetError,
    handleMonthlyBudgetInputChange,
    toggleChannel,
    handleRefreshRates,
    handleUpdateCurrencies,
    handleDefaultCurrencyChange,
    handleExchangeRateProviderChange,
    hasUnsavedChanges,
    handleSaveChanges,
    handleDiscardChanges,
    handleThemeModeChange,
    handleThemeVariantChange,
    handleThemeCustomColorChange,
    testingChannel,
    handleTestConnection,
    notificationTestErrorDetails,
    notificationTestErrorDetailsOpen,
    setNotificationTestErrorDetailsOpen,
    isSavingSettings,
    notificationHistory,
    calendarFeed,
    builtInIconIndex,
    publicStatusPage,
    publicApi,
    telegramBotCommands,
    password,
    passwordResetEnabled,
    externalIntegrationsDisabled,
    sensitiveAccountActionsDisabled,
    sensitiveAccountActionsDemoDisabled,
  } = useSettingsFormController();

  const {
    passwordDialogOpen,
    setPasswordDialogOpen,
    handlePasswordDialogOpenChange,
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    isUpdatingPassword,
    updatePassword,
  } = password;
  const timezoneOptions = createTimeZoneSelectOptions(getSupportedTimeZones());
  const defaultCurrencyOptions = createCurrencySelectOptions({
    currencies: customConfig.currencies,
    currencyOptions: CURRENCY_OPTIONS,
    includeDisabledCurrent: settings.defaultCurrency,
    locale,
  });
  const effectivePublicStatusCurrency = settings.publicStatusCurrency === "inherit"
    ? settings.defaultCurrency
    : settings.publicStatusCurrency;
  const explicitPublicStatusCurrency = settings.publicStatusCurrency === "inherit"
    ? null
    : settings.publicStatusCurrency;
  const publicStatusCurrencyOptions: SearchableSelectOption[] = [
    {
      value: "inherit",
      label: t("settings.publicStatusCurrencyInherit", { currency: settings.defaultCurrency }),
      keywords: ["inherit", settings.defaultCurrency],
    },
    ...createCurrencySelectOptions({
      currencies: customConfig.currencies,
      currencyOptions: CURRENCY_OPTIONS,
      ...(explicitPublicStatusCurrency ? { includeDisabledCurrent: explicitPublicStatusCurrency } : {}),
      locale,
    }),
  ];
  const [selectedNotificationChannel, setSelectedNotificationChannel] = useState<NotificationChannel | null>(null);
  const [notificationReminderDaysInput, setNotificationReminderDaysInput] = useState(String(settings.notificationReminderDays));
  const [mobileSectionNavOpen, setMobileSectionNavOpen] = useState(false);
  const [cloudBackupImportOpen, setCloudBackupImportOpen] = useState(false);
  const [cloudBackupRestoreFile, setCloudBackupRestoreFile] = useState<File | null>(null);
  const { activeSectionId, handleSectionClick } = useSettingsSectionNavigation();
  const cloudBackup = useCloudBackupController((file) => {
    setCloudBackupRestoreFile(file);
    setCloudBackupImportOpen(true);
  });
  const uploadedAssets = useUploadedAssetsManager();
  const activeNotificationChannel = selectedNotificationChannel ?? settings.enabledChannels[0] ?? 'telegram';
  const handleNotificationChannelToggle = (channel: NotificationChannel) => {
    setSelectedNotificationChannel(channel);
    toggleChannel(channel);
  };
  const handleNotificationReminderDaysInputChange = (value: string) => {
    setNotificationReminderDaysInput(value);
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_REMINDER_DAYS) return;
    updateSetting("notificationReminderDays", parsed);
  };
  const handleLocaleChange = (value: string) => {
    const nextLocale = value as Locale;
    updateSetting('locale', nextLocale);
    setLocale(nextLocale, { persist: false });
  };
  useEffect(() => {
    setNotificationReminderDaysInput(String(settings.notificationReminderDays));
  }, [settings.notificationReminderDays]);
  const unsavedChangesGuard = useUnsavedChangesGuard(hasUnsavedChanges, handleDiscardChanges);

  return (
    <div className="app-page bg-background flex flex-col">
      <Header />

      <MobileSettingsSectionDrawer
        activeSectionId={activeSectionId}
        onSectionClick={handleSectionClick}
        open={mobileSectionNavOpen}
        onOpenChange={setMobileSectionNavOpen}
      />

      <main className={cn("flex-1", hasUnsavedChanges && "h5-bottom-bar-space")} data-testid="settings-main">
        <div className="app-main mx-auto max-w-7xl">
          <div className={settingsLayout.pageGrid} data-testid="settings-page-layout">
            <aside className="hidden lg:block" data-testid="settings-section-nav-aside">
              <DesktopSettingsSectionNav activeSectionId={activeSectionId} onSectionClick={handleSectionClick} />
            </aside>

            <div className={settingsLayout.content} data-testid="settings-section-content">
              <MobileSettingsPageHeader onOpen={() => setMobileSectionNavOpen(true)} />

              <div className={settingsLayout.desktopHeader}>
                <h1 className="text-2xl font-bold text-foreground">{t("settings.title")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("settings.subtitle")}</p>
              </div>

              <AccountSettingsSection
                id="settings-account"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                accountEmail={accountEmail}
                canManageUsers={canManageUsers}
                canAccessPocketBaseAdmin={canAccessPocketBaseAdmin}
                passwordResetEnabled={passwordResetEnabled}
                passwordDialogOpen={passwordDialogOpen}
                setPasswordDialogOpen={setPasswordDialogOpen}
                handlePasswordDialogOpenChange={handlePasswordDialogOpenChange}
                currentPassword={currentPassword}
                setCurrentPassword={setCurrentPassword}
                newPassword={newPassword}
                setNewPassword={setNewPassword}
                confirmPassword={confirmPassword}
                setConfirmPassword={setConfirmPassword}
                isUpdatingPassword={isUpdatingPassword}
                updatePassword={updatePassword}
                passwordDisabled={sensitiveAccountActionsDisabled}
                accountSecurityDemoDisabled={sensitiveAccountActionsDemoDisabled}
              />

              {/* 外观设置 */}
              <section id="settings-appearance" className={SETTINGS_SECTION_FRAME_CLASS}>
                <div className="flex items-center gap-2 mb-6">
                  <Palette className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold text-foreground">{t("settings.appearance")}</h2>
                </div>
                <ThemeSelector
                  mode={effectiveThemeMode}
                  variant={settings.themeVariant}
                  customColor={settings.themeCustomColor}
                  onModeChange={handleThemeModeChange}
                  onVariantChange={handleThemeVariantChange}
                  onCustomColorChange={handleThemeCustomColorChange}
                />
              </section>

              {/* 显示设置 */}
              <section id="settings-display" className={SETTINGS_SECTION_FRAME_CLASS}>
                <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.display")}</h2>
                <div className="grid gap-6">
                  <div className="grid gap-2">
                    <Label htmlFor="locale">{t("settings.language")}</Label>
                    <Select value={settings.locale} onValueChange={handleLocaleChange}>
                      <SelectTrigger id="locale" className="w-full border-border bg-secondary sm:w-[min(14rem,100%)]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="zh-CN">{t("locale.zhCN")}</SelectItem>
                        <SelectItem value="en-US">{t("locale.enUS")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t("settings.languageHelp")}</p>
                  </div>
                  <CheckboxSettingRow
                    id="showExpired"
                    checked={settings.showExpired}
                    onCheckedChange={(checked) => updateSetting('showExpired', checked)}
                    label={t("settings.showExpired")}
                    description={t("settings.showExpiredHelp")}
                  />
                </div>
              </section>

              <BuiltInIconSourcesSection
                id="settings-icon-sources"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                sources={settings.builtInIconSources}
                onChange={(sources) => updateSetting('builtInIconSources', sources)}
                onlineSources={settings.onlineIconSources}
                onOnlineChange={(sources) => updateSetting('onlineIconSources', sources)}
                iconIndex={builtInIconIndex}
              />

              <UploadedIconsSection
                id="settings-uploaded-icons"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                controller={uploadedAssets}
              />

              <AIRecognitionSettingsSection
                id="settings-ai-recognition"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                settings={settings.aiRecognition}
                onChange={(aiRecognition) => updateSetting('aiRecognition', aiRecognition)}
                disabled={externalIntegrationsDisabled}
              />

              {/* 预算设置 */}
              <section id="settings-budget" className={SETTINGS_SECTION_FRAME_CLASS}>
                <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.budget")}</h2>
                <div className="grid gap-4">
                  <FormField
                    id="monthlyBudget"
                    label={t("settings.monthlyBudget")}
                    description={t("settings.monthlyBudgetHelp")}
                    error={monthlyBudgetError}
                  >
                    {(field) => (
                      <div className="flex flex-col gap-2 min-[380px]:flex-row min-[380px]:items-center min-[380px]:gap-3">
                        <NumericInput
                          id={field.id}
                          name={field.id}
                          allowNegative={false}
                          allowedDecimalSeparators={[".", "。"]}
                          inputMode="decimal"
                          enterKeyHint="done"
                          value={monthlyBudgetInput}
                          onRawValueChange={handleMonthlyBudgetInputChange}
                          className="w-full border-border bg-secondary min-[380px]:w-[min(12.5rem,100%)]"
                          placeholder="1500"
                          thousandSeparator
                          aria-invalid={field.invalid}
                          aria-describedby={field.describedBy}
                        />
                        <span className="text-sm text-muted-foreground">
                          {getCurrencySymbol(settings.defaultCurrency)} {t("settings.perMonth")}
                        </span>
                      </div>
                    )}
                  </FormField>
                </div>
              </section>

              {/* 数据配置 */}
              <section id="settings-data-config" className={SETTINGS_SECTION_FRAME_CLASS}>
                <div className="flex items-center gap-2 mb-4">
                  <Settings2 className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold text-foreground">{t("settings.dataConfig")}</h2>
                </div>
                <p className="text-sm text-muted-foreground mb-6">
                  {t("settings.dataConfigDescription")}
                </p>

                <div className="grid gap-3 sm:grid-cols-2">
                  <ConfigManagerDialog
                    title={t("settings.categoryManager")}
                    description={t("settings.categoryManagerDescription")}
                    items={customConfig.categories}
                    onUpdate={updateCategories}
                    showColor={true}
                    maxItems={200}
                    icon={<FolderKanban className="h-4 w-4" />}
                    getDeleteBlockReason={(item) => {
                      if (customConfig.categories.length <= 1) {
                        return t("settings.categoryKeepOne");
                      }

                      // 删除校验依赖订阅数据；在加载/失败时先阻止删除，避免误判。
                      if (subscriptionsQuery.isPending) {
                        return t("settings.categoryChecking");
                      }
                      if (subscriptionsQuery.status === "error") {
                        return t("settings.categoryCheckFailed");
                      }

                      const usedCount = categoryUsageCount.get(item.value) ?? 0;
                      if (usedCount > 0) {
                        return t("settings.categoryUsed", { count: usedCount });
                      }

                      return null;
                    }}
                  />

                  <ConfigManagerDialog
                    title={t("settings.statusManager")}
                    description={t("settings.statusManagerDescription")}
                    items={customConfig.statuses}
                    onUpdate={updateStatuses}
                    showColor={true}
                    readOnly={true}
                    icon={<Activity className="h-4 w-4" />}
                  />

                  <ConfigManagerDialog
                    title={t("settings.paymentManager")}
                    description={t("settings.paymentManagerDescription")}
                    items={customConfig.paymentMethods}
                    onUpdate={updatePaymentMethods}
                    icon={<CreditCard className="h-4 w-4" />}
                    showIcon={true}
                    maxItems={200}
                    isItemReadOnly={(item) => isBuiltInPaymentMethodValue(item.value)}
                  />

                  <ConfigManagerDialog
                    title={t("settings.currencyManager")}
                    description={t("settings.currencyManagerDescription")}
                    items={customConfig.currencies}
                    onUpdate={handleUpdateCurrencies}
                    icon={<Coins className="h-4 w-4" />}
                    toggleMode={true}
                    searchable={true}
                    searchPlaceholder={t("settings.currencySearch")}
                    searchEmptyMessage={t("settings.currencyEmpty")}
                  />
                </div>
              </section>

              <CloudBackupSection
                id="settings-cloud-backup"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                controller={cloudBackup}
                disabled={externalIntegrationsDisabled}
              />

              <ExchangeRatesSection
                id="settings-exchange"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                settings={settings}
                customConfig={customConfig}
                rates={rates}
                activeRateProvider={activeRateProvider}
                ratesLoading={ratesLoading}
                ratesError={ratesError}
                ratesErrorDetails={ratesErrorDetails}
                ratesWarning={ratesWarning}
                lastUpdated={lastUpdated}
                defaultCurrencyOptions={defaultCurrencyOptions}
                handleRefreshRates={handleRefreshRates}
                handleDefaultCurrencyChange={handleDefaultCurrencyChange}
                handleExchangeRateProviderChange={handleExchangeRateProviderChange}
                getCurrencySymbol={getCurrencySymbol}
              />

              <CalendarFeedSection
                id="settings-calendar-feed"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                enabled={calendarFeed.data?.enabled ?? false}
                feedUrl={calendarFeed.feedUrl}
                isLoading={calendarFeed.isLoading}
                isCreating={calendarFeed.isCreating}
                isDeleting={calendarFeed.isDeleting}
                onCreate={calendarFeed.createOrRotate}
                onCopy={calendarFeed.copyUrl}
                onDelete={calendarFeed.revoke}
                onOpenSystem={calendarFeed.openSystem}
                onRegenerate={calendarFeed.regenerate}
              />

              <PublicStatusPageSection
                id="settings-public-status"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                enabled={publicStatusPage.enabled}
                pageUrl={publicStatusPage.pageUrl}
                showPrices={publicStatusPage.showPrices}
                publicStatusCurrency={settings.publicStatusCurrency}
                effectivePublicStatusCurrency={effectivePublicStatusCurrency}
                publicStatusCurrencyOptions={publicStatusCurrencyOptions}
                visibleCount={publicStatusPage.visibleCount}
                hiddenCount={publicStatusPage.hiddenCount}
                isLoading={publicStatusPage.isLoading}
                isCreating={publicStatusPage.isCreating}
                isDeleting={publicStatusPage.isDeleting}
                isUpdating={publicStatusPage.isUpdating}
                onCreate={publicStatusPage.createOrRotate}
                onCopy={publicStatusPage.copyUrl}
                onDelete={publicStatusPage.revoke}
                onOpenPage={publicStatusPage.openPage}
                onRegenerate={publicStatusPage.regenerate}
                onShowPricesChange={publicStatusPage.updateShowPrices}
                onPublicStatusCurrencyChange={(value) => updateSetting("publicStatusCurrency", value as PublicStatusCurrency)}
              />

              <PublicApiSection
                id="settings-public-api"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                controller={publicApi}
              />

              {/* 时区设置 */}
              <section id="settings-timezone" className={SETTINGS_SECTION_FRAME_CLASS}>
                <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.timezone")}</h2>
                <div className="grid gap-2">
                  <Label htmlFor="timezone">{t("settings.timezoneSelect")}</Label>
                  <SearchableSelect
                    value={settings.timezone}
                    onValueChange={(value) => updateSetting('timezone', value)}
                    options={timezoneOptions}
                    placeholder={t("settings.timezonePlaceholder")}
                    searchPlaceholder={t("settings.timezoneSearch")}
                    emptyMessage={t("settings.timezoneEmpty")}
                    className="w-full max-w-md border-border bg-secondary"
                    contentClassName="max-w-md"
                    aria-label={t("settings.timezoneSelect")}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("settings.timezoneHelp")}
                  </p>
                </div>
              </section>

              {/* 通知设置 */}
              <section id="settings-notifications" className={SETTINGS_SECTION_FRAME_CLASS}>
                <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.notifications")}</h2>

                <div className="grid gap-6">
                  <div className="grid gap-6 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label>{t("settings.notificationTime")}</Label>
                      <TimePicker
                        value={settings.notificationTimeLocal}
                        onChange={(value) => updateSetting('notificationTimeLocal', assertLocalTime(value))}
                        className="w-full"
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("settings.notificationTimeHelp")}
                      </p>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="notificationReminderDays">{t("settings.notificationReminderDays")}</Label>
                      <NumericInput
                        id="notificationReminderDays"
                        name="notificationReminderDays"
                        allowNegative={false}
                        decimalScale={0}
                        inputMode="numeric"
                        enterKeyHint="done"
                        value={notificationReminderDaysInput}
                        onRawValueChange={handleNotificationReminderDaysInputChange}
                        className="border-border bg-secondary"
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("settings.notificationReminderDaysHelp")}
                      </p>
                    </div>
                    <div className="grid content-start gap-2 sm:col-span-2">
                      <Label>{t("settings.tip")}</Label>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.cronTip")}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-6 lg:grid-cols-[minmax(0,280px)_1fr]">
                    <NotificationChannelList
                      settings={settings}
                      activeChannel={activeNotificationChannel}
                      onSelect={setSelectedNotificationChannel}
                      onToggle={handleNotificationChannelToggle}
                      disabled={externalIntegrationsDisabled}
                    />
                    <NotificationChannelConfigPanel
                      channel={activeNotificationChannel}
                      settings={settings}
                      enabled={settings.enabledChannels.includes(activeNotificationChannel)}
                      updateSetting={updateSetting}
                      testingChannel={testingChannel}
                      onTest={handleTestConnection}
                      disabled={externalIntegrationsDisabled}
                      telegramBotCommands={telegramBotCommands}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="testPhone">{t("settings.testPhone")}</Label>
                    <Input
                      id="testPhone"
                      name="testPhone"
                      type="tel"
                      inputMode="tel"
                      enterKeyHint="done"
                      autoComplete="tel"
                      placeholder={t("settings.testPhonePlaceholder")}
                      value={settings.testPhone}
                      disabled={externalIntegrationsDisabled}
                      onChange={(e) => updateSetting('testPhone', e.target.value)}
                      className="border-border bg-secondary"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("settings.testPhoneHelp")}
                    </p>
                  </div>

                  <NotificationHistoryPanel
                    data={notificationHistory.data}
                    isLoading={notificationHistory.isLoading}
                    isFetching={notificationHistory.isFetching}
                    error={notificationHistory.error}
                    status={notificationHistory.historyStatus}
                    setStatus={notificationHistory.setStatus}
                    loadMore={notificationHistory.loadMore}
                    refetch={notificationHistory.refetch}
                  />
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>

      {/* 未保存设置底部栏会占用右下角操作区；按钮上移，避免遮挡保存/放弃这两个关键操作。 */}
      <BackToTopFloatButton
        bottomOffsetClassName={hasUnsavedChanges
          ? "bottom-[calc(11rem+env(safe-area-inset-bottom))] sm:bottom-[calc(5.75rem+env(safe-area-inset-bottom))]"
          : undefined}
      />

      <AlertDialog open={unsavedChangesGuard.pendingLeave} onOpenChange={(open) => {
        if (!open) unsavedChangesGuard.cancelLeave();
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.unsavedLeaveTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.unsavedLeaveDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={unsavedChangesGuard.confirmLeave}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("settings.unsavedLeaveConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {hasUnsavedChanges ? (
        <div className="h5-bottom-bar fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-card/95 shadow-[0_-8px_30px_rgba(0,0,0,0.08)] backdrop-blur-sm">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium text-foreground">{t("settings.unsavedChanges")}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={handleDiscardChanges}
                disabled={isSavingSettings}
              >
                {t("settings.discardChanges")}
              </Button>
              <Button
                type="button"
                className="relative bg-primary text-primary-foreground hover:bg-primary-glow"
                onClick={handleSaveChanges}
                disabled={isSavingSettings || Boolean(monthlyBudgetError)}
                aria-busy={isSavingSettings ? true : undefined}
              >
                <LoadingButtonContent loading={isSavingSettings} loadingLabel={t("common.saving")}>
                  {t("settings.saveChanges")}
                </LoadingButtonContent>
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <ImportDataDialog
        open={cloudBackupImportOpen}
        onOpenChange={setCloudBackupImportOpen}
        settings={settings}
        config={customConfig}
        initialFile={cloudBackupRestoreFile}
        onInitialFileConsumed={() => setCloudBackupRestoreFile(null)}
      />

      <RawErrorResponseDialog
        open={notificationTestErrorDetailsOpen}
        details={notificationTestErrorDetails}
        onOpenChange={setNotificationTestErrorDetailsOpen}
        title={t("rawErrorResponse.title")}
        description={t("rawErrorResponse.description")}
        testId="notification-test-raw-error-response-dialog"
      />
    </div>
  );
}
