// 契约 fixture smoke test 确保 JSON 先经过 shared schema，再被 Go/Worker/前端测试消费。
import { describe, expect, it } from "vitest";
import {
  notificationScheduleFixtures,
  outboundUrlPolicyFixtures,
  subscriptionNormalizationFixtures,
  subscriptionPerformanceFixture,
} from "./contract-fixtures";

describe("contract fixtures", () => {
  it("loads notification schedule fixtures", () => {
    expect(notificationScheduleFixtures.length).toBeGreaterThan(0);
  });

  it("loads subscription normalization fixtures", () => {
    expect(subscriptionNormalizationFixtures.length).toBeGreaterThan(0);
  });

  it("loads outbound URL policy fixtures", () => {
    expect(outboundUrlPolicyFixtures.length).toBeGreaterThan(0);
  });

  it("loads subscription performance fixtures", () => {
    expect(subscriptionPerformanceFixture.scenarios.map(({ size }) => size)).toEqual([10, 100, 1000]);
  });
});
