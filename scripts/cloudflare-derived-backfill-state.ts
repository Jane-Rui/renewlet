/** 派生 schema 的四态模型；任何非完整 legacy/v2 形状都归入拒绝自动修复的 mixed 状态。 */
export type DerivedBackfillState = "legacy" | "v2-pending-backfill" | "v2-complete" | "invalid-mixed";

/** migration 记录、完整列签名和 completion marker 共同组成可部署状态，不能只信任其中一个信号。 */
export interface DerivedSchemaShape {
  migrationApplied: boolean;
  statsColumns: readonly string[];
  repeatScheduleColumns: readonly string[];
  repeatScheduleIndexColumns: readonly string[];
  backfillColumns: readonly string[];
  markerPresent: boolean;
}

/** 状态机将可重放写入、全量不变量校验和 marker 提交拆开，强制完成证据最后落库。 */
export interface DerivedBackfillActions {
  rebuild(): Promise<void>;
  verify(): Promise<void>;
  markComplete(): Promise<void>;
}

const statsV2Columns = [
  "user_id",
  "total_count",
  "trial_count",
  "active_count",
  "expired_count",
  "paused_count",
  "cancelled_count",
  "created_at",
  "updated_at",
] as const;

const repeatScheduleColumns = ["user_id", "subscription_id", "next_due_at_utc"] as const;
const repeatScheduleIndexColumns = ["user_id", "next_due_at_utc", "subscription_id"] as const;
const backfillColumns = ["name", "completed_at"] as const;
const statsV2ExclusiveColumns = [
  "trial_count",
  "active_count",
  "expired_count",
  "paused_count",
  "cancelled_count",
] as const;

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/** 按完整有序列签名识别 schema，避免同名但列顺序/形状漂移的表被误判为可用。 */
export function classifyDerivedSchema(shape: DerivedSchemaShape): DerivedBackfillState {
  const completeV2Shape = sameOrderedValues(shape.statsColumns, statsV2Columns)
    && sameOrderedValues(shape.repeatScheduleColumns, repeatScheduleColumns)
    && sameOrderedValues(shape.repeatScheduleIndexColumns, repeatScheduleIndexColumns)
    && sameOrderedValues(shape.backfillColumns, backfillColumns);
  if (shape.migrationApplied && completeV2Shape) {
    return shape.markerPresent ? "v2-complete" : "v2-pending-backfill";
  }

  const hasAnyV2Object = shape.repeatScheduleColumns.length > 0
    || shape.repeatScheduleIndexColumns.length > 0
    || shape.backfillColumns.length > 0
    || shape.statsColumns.some((column) => statsV2ExclusiveColumns.some((expected) => expected === column));
  const hasLegacyStats = shape.statsColumns.length === 0 || shape.statsColumns.includes("status_counts_json");
  if (!shape.migrationApplied && !hasAnyV2Object && hasLegacyStats && !shape.markerPresent) {
    return "legacy";
  }
  return "invalid-mixed";
}

/** 执行唯一允许的状态迁移；complete 仍需复验，legacy/mixed 不做现场 ALTER 修补。 */
export async function executeDerivedBackfillState(
  state: DerivedBackfillState,
  actions: DerivedBackfillActions,
): Promise<void> {
  switch (state) {
    case "legacy":
      throw new Error("Cloudflare subscription derived-state schema is legacy; apply migration 0036 before backfill");
    case "invalid-mixed":
      throw new Error("Cloudflare subscription derived-state schema is invalid or mixed; refusing automatic schema repair");
    case "v2-complete":
      await actions.verify();
      return;
    case "v2-pending-backfill":
      // pending 可能来自进程中断或 REST 响应丢失；只重放幂等派生写入，marker 永远排在完整校验之后。
      await actions.rebuild();
      await actions.verify();
      await actions.markComplete();
      return;
    default: {
      const unsupportedState: never = state;
      throw new Error(`Unsupported derived backfill state: ${unsupportedState}`);
    }
  }
}
