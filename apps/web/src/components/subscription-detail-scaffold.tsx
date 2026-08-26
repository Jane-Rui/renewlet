import type { HTMLAttributes, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface SubscriptionDetailScaffoldProps extends HTMLAttributes<HTMLDivElement> {
  actions: ReactNode;
  extensions?: ReactNode;
  facts: ReactNode;
  identity: ReactNode;
  summary: ReactNode;
}

export type SubscriptionDetailScaffoldSlots = Pick<
  SubscriptionDetailScaffoldProps,
  "actions" | "extensions" | "facts" | "identity" | "summary"
>;

export interface SubscriptionDetailLoadingStructure {
  showCalendarAction: boolean;
  showCostSharing: boolean;
  showDailyAverage: boolean;
  showNextBillingDate: boolean;
  showPaymentMethod: boolean;
  showStartDate: boolean;
  showTrialEndDate: boolean;
}

export function SubscriptionDetailScaffold({
  actions,
  className,
  extensions,
  facts,
  identity,
  summary,
  ...props
}: SubscriptionDetailScaffoldProps) {
  return (
    <div className={cn("grid gap-5", className)} {...props}>
      <div className="flex items-start gap-3" data-dialog-region="subscription-identity">
        {identity}
      </div>
      <div
        className="flex items-center justify-between rounded-lg bg-secondary/50 p-4"
        data-dialog-region="subscription-summary"
      >
        {summary}
      </div>
      <div className="grid gap-3" data-dialog-region="subscription-facts">
        {facts}
        {extensions}
      </div>
      <div
        className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end"
        data-dialog-region="subscription-actions"
      >
        {actions}
      </div>
    </div>
  );
}

function FactSkeleton() {
  return (
    <div className="grid gap-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-5 w-full sm:ml-auto sm:w-32" />
    </div>
  );
}

export function createSubscriptionDetailLoadingSlots({
  canEdit,
  canRenew,
  label,
  structure,
}: {
  canEdit: boolean;
  canRenew: boolean;
  label: string;
  structure: SubscriptionDetailLoadingStructure;
}): SubscriptionDetailScaffoldSlots {
  return {
    identity: (
      <>
        <Skeleton className="h-12 w-12 shrink-0 rounded-lg" />
        <div className="grid min-w-0 flex-1 gap-2">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-28" />
        </div>
      </>
    ),
    summary: (
      <>
        <div className="grid min-w-0 gap-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-6 w-16 rounded-full" />
      </>
    ),
    facts: (
      <>
        <span className="sr-only">{label}</span>
        {structure.showDailyAverage ? <FactSkeleton /> : null}
        {structure.showCostSharing ? <Skeleton className="h-28 w-full rounded-lg" /> : null}
        <FactSkeleton />
        {structure.showPaymentMethod ? <FactSkeleton /> : null}
        {structure.showNextBillingDate ? <FactSkeleton /> : null}
        {structure.showStartDate ? <FactSkeleton /> : null}
        {structure.showTrialEndDate ? <FactSkeleton /> : null}
        <FactSkeleton />
        <FactSkeleton />
        <FactSkeleton />
      </>
    ),
    actions: (
      <>
        <Skeleton className="h-10 w-full sm:w-20" />
        {structure.showCalendarAction ? <Skeleton className="h-10 w-full sm:w-28" /> : null}
        {canRenew ? <Skeleton className="h-10 w-full sm:w-24" /> : null}
        {canEdit ? <Skeleton className="h-10 w-full sm:w-20" /> : null}
      </>
    ),
  };
}
