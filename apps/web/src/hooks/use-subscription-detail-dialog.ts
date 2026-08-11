import { useCallback, useMemo, useState } from "react";
import { useDeferredDialogCleanup } from "@/hooks/use-deferred-dialog-cleanup";
import type { Subscription } from "@/types/subscription";

export function useSubscriptionDetailDialog(subscriptions: readonly Subscription[]) {
  const [detailSubscriptionId, setDetailSubscriptionId] = useState<string | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const selectedDetailSubscription = useMemo(
    () => subscriptions.find((item) => item.id === detailSubscriptionId) ?? null,
    [detailSubscriptionId, subscriptions],
  );
  const { scheduleCleanup: scheduleDetailCleanup, cancelCleanup: cancelDetailCleanup } =
    useDeferredDialogCleanup(() => {
      // 详情弹窗关闭动画期间仍要保留内容快照，避免 Dialog/Drawer fade-out 时标题和备注闪空。
      setDetailSubscriptionId(null);
    });

  const handleViewDetails = useCallback((id: string) => {
    cancelDetailCleanup();
    setDetailSubscriptionId(id);
    setDetailDialogOpen(true);
  }, [cancelDetailCleanup]);

  const handleDetailDialogOpenChange = useCallback((nextOpen: boolean) => {
    setDetailDialogOpen(nextOpen);
    if (nextOpen) {
      cancelDetailCleanup();
      return;
    }
    scheduleDetailCleanup();
  }, [cancelDetailCleanup, scheduleDetailCleanup]);

  return {
    detailDialogOpen,
    selectedDetailSubscription,
    handleViewDetails,
    handleDetailDialogOpenChange,
  };
}
