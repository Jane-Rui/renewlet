import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildRenewalCalendarEvent, type RenewalCalendarEvent } from "@renewlet/shared/calendar-events";
import { google, office365, outlook, yahoo, type CalendarEvent } from "calendar-link";
import { CalendarDays, CalendarPlus, Clipboard, Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MobileBottomDrawerContent, MobileDrawerRoot } from "@/components/ui/mobile-drawer";
import { toast } from "@/components/ui/sonner";
import { useCustomConfig } from "@/contexts/CustomConfigContext";
import { useCreateSubscriptionCalendarFeed, useDeleteSubscriptionCalendarFeed, useSubscriptionCalendarFeedStatus } from "@/hooks/use-calendar-feed";
import { useSettings } from "@/hooks/use-settings";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useI18n } from "@/i18n/I18nProvider";
import { addDateOnly } from "@/lib/time/date-only";
import { formatBillingCycleLabel } from "@/lib/subscription-billing";
import { buildAndroidCalendarIntentUrl, isAndroidChromeUserAgent, openValidatedWebcalUrl } from "@/shared/browser/calendar-links";
import { copyTextToClipboard, type ClipboardCopyTarget } from "@/shared/browser/clipboard";
import { downloadFile } from "@/shared/browser/download-file";
import { calendarFeedService } from "@/services/calendar-feed-service";
import {
  DEFAULT_NOTIFICATION_REMINDER_DAYS,
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  type Subscription,
} from "@/types/subscription";

interface AddToCalendarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null 表示上层详情已被清理；此时不能渲染会创建 token 的子弹窗。 */
  subscription: Subscription | null;
}

interface ResolvedAddToCalendarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: Subscription;
}

interface CalendarProviderLink {
  href: string;
  label: string;
}

interface AddToCalendarContentProps {
  androidCalendarHref: string | undefined;
  androidCalendarLabel: string;
  copyFeedUrlLabel: string;
  downloadLabel: string;
  eventDate: string;
  eventDateLabel: string;
  eventTypeLabel: string;
  eventTypeValue: string;
  feedUrl: string | null;
  feedUrlLabel: string;
  isDownloading: boolean;
  isSubscribing: boolean;
  links: CalendarProviderLink[];
  notice: string;
  onCopyFeedUrl: (target?: ClipboardCopyTarget | null) => void;
  onDownload: () => void;
  onRegenerate: () => void;
  onSubscribe: () => void;
  regenerateLabel: string;
  servicesLabel: string;
  subscribeLabel: string;
  subscribeLoadingLabel: string;
  syncStatusLabel: string;
  syncStatusValue: string;
}

export function AddToCalendarDialog({ open, onOpenChange, subscription }: AddToCalendarDialogProps) {
  if (!subscription) return null;
  return (
    <ResolvedAddToCalendarDialog
      open={open}
      onOpenChange={onOpenChange}
      subscription={subscription}
    />
  );
}

/**
 * ResolvedAddToCalendarDialog 管理单订阅日历入口。
 *
 * Feed URL 是低权限 bearer secret；创建/再生成都必须走 React Query mutation，
 * 本地 `feedUrl` 只缓存本次新 token，避免等待状态接口刷新时用户复制旧地址。
 */
function ResolvedAddToCalendarDialog({ open, onOpenChange, subscription }: ResolvedAddToCalendarDialogProps) {
  const isMobile = useMediaQuery("(max-width: 639px)");
  const { t, locale, label, formatCurrency, formatDateOnly } = useI18n();
  const { config } = useCustomConfig();
  const { data: settings } = useSettings();
  const subscriptionFeedStatus = useSubscriptionCalendarFeedStatus(subscription.id, open);
  const createSubscriptionFeed = useCreateSubscriptionCalendarFeed();
  const deleteSubscriptionFeed = useDeleteSubscriptionCalendarFeed();
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const [confirmRegenerateOpen, setConfirmRegenerateOpen] = useState(false);
  const [isDownloadingCalendar, setIsDownloadingCalendar] = useState(false);
  const [isOpeningSystemCalendar, setIsOpeningSystemCalendar] = useState(false);
  const visibleFeedUrl = feedUrl ?? subscriptionFeedStatus.data?.feedUrl ?? null;
  useEffect(() => {
    // 切换订阅时清掉刚生成的本地 token，防止上一张卡片的私有 feed URL 短暂展示到新弹窗。
    setFeedUrl(null);
  }, [subscription.id]);
  const category = config.categories.find((item) => item.value === subscription.category);
  const paymentMethod = subscription.paymentMethod
    ? config.paymentMethods.find((item) => item.value === subscription.paymentMethod)
    : undefined;
  const categoryLabel = category ? label(category.labels) : subscription.category;
  const paymentMethodLabel = paymentMethod ? label(paymentMethod.labels) : subscription.paymentMethod;
  const billingCycleLabel = formatBillingCycleLabel(subscription, locale);
  const isExpiryEvent = subscription.billingCycle === "one-time";
  const globalReminderDays = settings?.notificationReminderDays ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
  const reminderDays = subscription.reminderDays === DISABLED_REMINDER_DAYS
    ? undefined
    : subscription.reminderDays === INHERIT_REMINDER_DAYS
      ? globalReminderDays
      : subscription.reminderDays;

  const renewalEvent = useMemo<RenewalCalendarEvent>(() => buildRenewalCalendarEvent({
    subscription,
    labels: {
      amount: formatCurrency(subscription.price, subscription.currency),
      billingCycle: billingCycleLabel,
      category: categoryLabel,
      paymentMethod: paymentMethodLabel,
    },
    // “不提醒”只影响 ICS alarm；一次性下载仍保留这条续费/到期事件本身。
    reminderDays,
    text: {
      amount: ({ amount }) => t("subscription.addToCalendar.description.amount", { amount }),
      billingCycle: (cycle) => t("subscription.addToCalendar.description.billingCycle", { cycle }),
      category: (category) => t("subscription.addToCalendar.description.category", { category }),
      paymentMethod: (paymentMethod) => t("subscription.addToCalendar.description.paymentMethod", { paymentMethod }),
      notes: (notes) => t("subscription.addToCalendar.description.notes", { notes }),
    },
  }), [
    billingCycleLabel,
    categoryLabel,
    formatCurrency,
    paymentMethodLabel,
    reminderDays,
    subscription,
    t,
  ]);

  const calendarEvent = useMemo<CalendarEvent>(() => {
    const event: CalendarEvent = {
      allDay: true,
      busy: false,
      description: renewalEvent.description,
      end: addDateOnly(subscription.nextBillingDate, { days: 1 }),
      start: subscription.nextBillingDate,
      title: subscription.name,
      uid: renewalEvent.uid,
    };
    if (subscription.website) {
      event.url = subscription.website;
    }
    return event;
  }, [
    renewalEvent.description,
    renewalEvent.uid,
    subscription.name,
    subscription.nextBillingDate,
    subscription.website,
  ]);

  const links = useMemo<CalendarProviderLink[]>(() => [
    { href: google(calendarEvent), label: t("subscription.addToCalendarGoogle") },
    { href: outlook(calendarEvent), label: t("subscription.addToCalendarOutlook") },
    { href: office365(calendarEvent), label: t("subscription.addToCalendarOffice365") },
    { href: yahoo(calendarEvent), label: t("subscription.addToCalendarYahoo") },
  ], [calendarEvent, t]);

  const isAndroidChrome = isAndroidChromeUserAgent();
  const androidSystemCalendarHref = useMemo(() => buildAndroidCalendarIntentUrl({
    title: subscription.name,
    description: renewalEvent.description,
    startDate: subscription.nextBillingDate,
    endDate: addDateOnly(subscription.nextBillingDate, { days: 1 }),
    fallbackUrl: links[0]?.href,
  }), [links, renewalEvent.description, subscription.name, subscription.nextBillingDate]);

  const handleSubscribe = useCallback(async () => {
    let createdFeedUrl: string | null = null;
    setIsOpeningSystemCalendar(true);
    try {
      const created = await createSubscriptionFeed.mutateAsync(subscription.id);
      createdFeedUrl = created.feedUrl;
      setFeedUrl(created.feedUrl);
      await openValidatedWebcalUrl(created.feedUrl);
      toast.success(t("subscription.addToCalendarSubscribed"), {
        description: t("subscription.addToCalendarSubscribedDescription"),
      });
    } catch {
      if (createdFeedUrl) {
        toast.error(t("subscription.addToCalendarOpenSystemFailed"), {
          description: t("subscription.addToCalendarOpenSystemFailedDescription"),
        });
      } else {
        toast.error(t("subscription.addToCalendarSubscribeFailed"));
      }
    } finally {
      setIsOpeningSystemCalendar(false);
    }
  }, [createSubscriptionFeed, subscription.id, t]);

  const handleOpenExistingFeed = useCallback(async () => {
    if (!visibleFeedUrl) return;
    setIsOpeningSystemCalendar(true);
    try {
      await openValidatedWebcalUrl(visibleFeedUrl);
      toast.success(t("subscription.addToCalendarSubscribed"), {
        description: t("subscription.addToCalendarSubscribedDescription"),
      });
    } catch {
      toast.error(t("subscription.addToCalendarOpenSystemFailed"), {
        description: t("subscription.addToCalendarOpenSystemFailedDescription"),
      });
    } finally {
      setIsOpeningSystemCalendar(false);
    }
  }, [visibleFeedUrl, t]);

  const handleRegenerate = useCallback(async () => {
    try {
      // 再生成通过删除旧 token 后重新创建完成，保证误分享的旧公开链接立即失效。
      await deleteSubscriptionFeed.mutateAsync(subscription.id);
      const created = await createSubscriptionFeed.mutateAsync(subscription.id);
      setFeedUrl(created.feedUrl);
      setConfirmRegenerateOpen(false);
      toast.success(t("subscription.addToCalendarRegenerated"), {
        description: t("subscription.addToCalendarRegeneratedDescription"),
      });
    } catch {
      toast.error(t("subscription.addToCalendarRegenerateFailed"));
    }
  }, [createSubscriptionFeed, deleteSubscriptionFeed, subscription.id, t]);

  const handleCopyFeedUrl = useCallback(async (target?: ClipboardCopyTarget | null) => {
    if (!visibleFeedUrl) return;
    const copyResult = await copyTextToClipboard(visibleFeedUrl, { target });
    if (copyResult.ok) {
      toast.success(t("subscription.addToCalendarFeedUrlCopied"));
      return;
    }
    toast.error(t("subscription.addToCalendarFeedUrlCopyFailed"), {
      description: t("subscription.addToCalendarFeedUrlCopyFailedDescription"),
    });
  }, [visibleFeedUrl, t]);

  const handleDownload = useCallback(async () => {
    setIsDownloadingCalendar(true);
    try {
      const ics = await calendarFeedService.downloadSubscriptionIcs(subscription.id);
      downloadFile(ics, `renewlet-${safeCalendarFilename(subscription.id)}.ics`);
      toast.success(t("subscription.addToCalendarDownloaded"));
    } catch {
      toast.error(t("subscription.addToCalendarDownloadFailed"));
    } finally {
      setIsDownloadingCalendar(false);
    }
  }, [subscription.id, t]);

  const title = isExpiryEvent ? t("subscription.addToCalendarExpiryTitle") : t("subscription.addToCalendarTitle");
  const description = isExpiryEvent
    ? t("subscription.addToCalendarExpiryDescription", { name: subscription.name })
    : t("subscription.addToCalendarDescription", { name: subscription.name });
  const content = (
    <AddToCalendarContent
      androidCalendarHref={isAndroidChrome ? androidSystemCalendarHref : undefined}
      androidCalendarLabel={t("subscription.addToCalendarAndroidSingleEvent")}
      copyFeedUrlLabel={t("subscription.addToCalendarCopyFeedUrl")}
      downloadLabel={t("subscription.addToCalendarDownloadIcs")}
      eventDate={formatDateOnly(subscription.nextBillingDate, "full")}
      eventDateLabel={t("subscription.addToCalendarEventDate")}
      eventTypeLabel={t("subscription.addToCalendarEventType")}
      eventTypeValue={isExpiryEvent ? t("subscription.addToCalendarExpiryFeed") : t("subscription.addToCalendarSubscriptionFeed")}
      feedUrl={visibleFeedUrl}
      feedUrlLabel={t("subscription.addToCalendarFeedUrl")}
      isDownloading={isDownloadingCalendar}
      isSubscribing={isOpeningSystemCalendar || createSubscriptionFeed.isPending || deleteSubscriptionFeed.isPending || subscriptionFeedStatus.isLoading}
      links={links}
      notice={isExpiryEvent ? t("subscription.addToCalendarExpiryEventNotice") : t("subscription.addToCalendarSingleEventNotice")}
      onCopyFeedUrl={handleCopyFeedUrl}
      onDownload={handleDownload}
      onRegenerate={() => setConfirmRegenerateOpen(true)}
      onSubscribe={visibleFeedUrl ? handleOpenExistingFeed : handleSubscribe}
      regenerateLabel={t("subscription.addToCalendarRegenerate")}
      servicesLabel={t("subscription.addToCalendarOnlineServices")}
      subscribeLabel={visibleFeedUrl ? t("subscription.addToCalendarSubscribeSystem") : t("subscription.addToCalendarGenerateFeed")}
      subscribeLoadingLabel={t("subscription.addToCalendarSubscribeLoading")}
      syncStatusLabel={t("subscription.addToCalendarSyncStatus")}
      syncStatusValue={t("subscription.addToCalendarSubscriptionSync")}
    />
  );

  if (isMobile) {
    return (
      <>
        <MobileDrawerRoot open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
          {open && (
            <MobileBottomDrawerContent
              title={title}
              description={description}
              closeLabel={t("common.close")}
              icon={<CalendarPlus className="h-5 w-5 shrink-0 text-primary" />}
              className="max-h-[calc(var(--app-viewport-height)-1rem)]"
              headerClassName="border-b border-border pb-4"
              bodyClassName="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
            >
              {content}
            </MobileBottomDrawerContent>
          )}
        </MobileDrawerRoot>
        <CalendarFeedRegenerateDialog
          open={confirmRegenerateOpen}
          onOpenChange={setConfirmRegenerateOpen}
          onConfirm={handleRegenerate}
        />
      </>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="overflow-hidden border-border bg-card p-0 sm:max-w-md">
          <DialogHeader className="border-b border-border px-5 py-4 pr-12 text-left">
            <DialogTitle className="flex items-center gap-2 text-base leading-6">
              <CalendarPlus className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <span className="min-w-0 wrap-break-word">{title}</span>
            </DialogTitle>
            <DialogDescription className="text-left leading-5">{description}</DialogDescription>
          </DialogHeader>
          <div className="px-5 py-4">
            {content}
          </div>
        </DialogContent>
      </Dialog>
      <CalendarFeedRegenerateDialog
        open={confirmRegenerateOpen}
        onOpenChange={setConfirmRegenerateOpen}
        onConfirm={handleRegenerate}
      />
    </>
  );
}

function AddToCalendarContent({
  androidCalendarHref,
  androidCalendarLabel,
  copyFeedUrlLabel,
  downloadLabel,
  eventDate,
  eventDateLabel,
  eventTypeLabel,
  eventTypeValue,
  feedUrl,
  feedUrlLabel,
  isDownloading,
  isSubscribing,
  links,
  notice,
  onCopyFeedUrl,
  onDownload,
  onRegenerate,
  onSubscribe,
  regenerateLabel,
  servicesLabel,
  subscribeLabel,
  subscribeLoadingLabel,
  syncStatusLabel,
  syncStatusValue,
}: AddToCalendarContentProps) {
  const feedUrlInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="grid gap-5">
      <dl className="grid divide-y divide-border rounded-md border border-border bg-background/50 text-sm">
        <CalendarMetaRow icon={<CalendarDays className="h-4 w-4 text-primary" />} label={eventDateLabel} value={eventDate} strong />
        <CalendarMetaRow label={eventTypeLabel} value={eventTypeValue} />
        <CalendarMetaRow label={syncStatusLabel} value={syncStatusValue} />
      </dl>

      <div className="grid gap-3">
        <Button type="button" variant="default" className="h-10 w-full justify-center" onClick={onSubscribe} disabled={isSubscribing}>
          {isSubscribing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />}
          {isSubscribing ? subscribeLoadingLabel : subscribeLabel}
        </Button>
        {feedUrl ? (
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input ref={feedUrlInputRef} value={feedUrl} readOnly className="border-border bg-secondary font-mono text-xs" aria-label={feedUrlLabel} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-center border-border"
              onClick={() => {
                onCopyFeedUrl(feedUrlInputRef.current);
              }}
            >
              <Clipboard className="h-4 w-4" />
              {copyFeedUrlLabel}
            </Button>
            <div className="sm:col-span-2">
              <Button type="button" variant="ghost" size="sm" className="h-8 justify-center gap-2 px-2 text-xs text-muted-foreground hover:text-destructive" onClick={onRegenerate}>
                <RefreshCw className="h-3.5 w-3.5" />
                {regenerateLabel}
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {androidCalendarHref ? (
            <Button variant="outline" size="sm" asChild className="justify-center border-border">
              <a href={androidCalendarHref} rel="noopener noreferrer">
                <CalendarPlus className="h-4 w-4" />
                {androidCalendarLabel}
              </a>
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" className="justify-center border-border" onClick={onDownload} disabled={isDownloading}>
            {isDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {downloadLabel}
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{notice}</p>
      </div>

      <div className="grid gap-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">{servicesLabel}</p>
        <div className="overflow-hidden rounded-md border border-border bg-background/50">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-10 items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm text-foreground transition-colors last:border-b-0 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <span className="truncate">{link.label}</span>
              <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function CalendarMetaRow({
  icon,
  label,
  strong = false,
  value,
}: {
  icon?: ReactNode;
  label: string;
  strong?: boolean;
  value: string;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 px-3 py-2">
      <dt className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </dt>
      <dd className={strong ? "min-w-0 text-right font-medium text-foreground" : "min-w-0 text-right text-foreground"}>
        {value}
      </dd>
    </div>
  );
}

function safeCalendarFilename(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "subscription";
}

function CalendarFeedRegenerateDialog({
  onConfirm,
  onOpenChange,
  open,
}: {
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("subscription.addToCalendarRegenerateTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("subscription.addToCalendarRegenerateDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t("subscription.addToCalendarRegenerate")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
