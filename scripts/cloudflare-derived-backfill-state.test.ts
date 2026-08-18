import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDerivedSchema,
  executeDerivedBackfillState,
  type DerivedBackfillActions,
  type DerivedSchemaShape,
} from "./cloudflare-derived-backfill-state";

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

function v2Shape(markerPresent: boolean): DerivedSchemaShape {
  return {
    migrationApplied: true,
    statsColumns: statsV2Columns,
    repeatScheduleColumns: ["user_id", "subscription_id", "next_due_at_utc"],
    repeatScheduleIndexColumns: ["user_id", "next_due_at_utc", "subscription_id"],
    backfillColumns: ["name", "completed_at"],
    markerPresent,
  };
}

test("classifies legacy, pending, complete, and mixed schemas", () => {
  assert.equal(classifyDerivedSchema({
    migrationApplied: false,
    statsColumns: ["user_id", "total_count", "status_counts_json", "created_at", "updated_at", "source_updated_at"],
    repeatScheduleColumns: [],
    repeatScheduleIndexColumns: [],
    backfillColumns: [],
    markerPresent: false,
  }), "legacy");
  assert.equal(classifyDerivedSchema(v2Shape(false)), "v2-pending-backfill");
  assert.equal(classifyDerivedSchema(v2Shape(true)), "v2-complete");
  assert.equal(classifyDerivedSchema({
    ...v2Shape(false),
    migrationApplied: false,
  }), "invalid-mixed");
  assert.equal(classifyDerivedSchema({
    ...v2Shape(false),
    repeatScheduleIndexColumns: ["user_id", "subscription_id", "next_due_at_utc"],
  }), "invalid-mixed");
  assert.equal(classifyDerivedSchema({
    ...v2Shape(true),
    statsColumns: [...statsV2Columns, "unexpected_column"],
  }), "invalid-mixed");
});

test("pending state marks complete only after rebuild and verification", async () => {
  const calls: string[] = [];
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => { calls.push("rebuild"); },
    verify: async (): Promise<void> => { calls.push("verify"); },
    markComplete: async (): Promise<void> => { calls.push("mark"); },
  };
  await executeDerivedBackfillState("v2-pending-backfill", actions);
  assert.deepEqual(calls, ["rebuild", "verify", "mark"]);
});

test("failed pending runs remain unmarked and can be replayed", async () => {
  const calls: string[] = [];
  let verificationAttempts = 0;
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => { calls.push("rebuild"); },
    verify: async (): Promise<void> => {
      calls.push("verify");
      verificationAttempts += 1;
      if (verificationAttempts === 1) throw new Error("injected invariant failure");
    },
    markComplete: async (): Promise<void> => { calls.push("mark"); },
  };

  await assert.rejects(executeDerivedBackfillState("v2-pending-backfill", actions), /injected invariant failure/);
  assert.deepEqual(calls, ["rebuild", "verify"]);
  await executeDerivedBackfillState("v2-pending-backfill", actions);
  assert.deepEqual(calls, ["rebuild", "verify", "rebuild", "verify", "mark"]);
});

test("a write failure during rebuild never reaches verification or the marker", async () => {
  const calls: string[] = [];
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => {
      calls.push("rebuild");
      throw new Error("injected batch write failure");
    },
    verify: async (): Promise<void> => { calls.push("verify"); },
    markComplete: async (): Promise<void> => { calls.push("mark"); },
  };

  await assert.rejects(executeDerivedBackfillState("v2-pending-backfill", actions), /injected batch write failure/);
  assert.deepEqual(calls, ["rebuild"]);
});

test("complete state verifies without rebuilding or rewriting the marker", async () => {
  const calls: string[] = [];
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => { calls.push("rebuild"); },
    verify: async (): Promise<void> => { calls.push("verify"); },
    markComplete: async (): Promise<void> => { calls.push("mark"); },
  };
  await executeDerivedBackfillState("v2-complete", actions);
  assert.deepEqual(calls, ["verify"]);
});

test("a completed marker never authorizes rebuilding failed invariants", async () => {
  const calls: string[] = [];
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => { calls.push("rebuild"); },
    verify: async (): Promise<void> => {
      calls.push("verify");
      throw new Error("injected completed-state invariant failure");
    },
    markComplete: async (): Promise<void> => { calls.push("mark"); },
  };

  await assert.rejects(
    executeDerivedBackfillState("v2-complete", actions),
    /injected completed-state invariant failure/,
  );
  assert.deepEqual(calls, ["verify"]);
});

test("legacy and mixed schemas fail without invoking write actions", async () => {
  let actionCount = 0;
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => { actionCount += 1; },
    verify: async (): Promise<void> => { actionCount += 1; },
    markComplete: async (): Promise<void> => { actionCount += 1; },
  };
  await assert.rejects(executeDerivedBackfillState("legacy", actions), /apply migration 0036/);
  await assert.rejects(executeDerivedBackfillState("invalid-mixed", actions), /refusing automatic schema repair/);
  assert.equal(actionCount, 0);
});
