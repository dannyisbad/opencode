import { describe, expect, test } from "bun:test"
import { DateTime } from "luxon"
import { buildHomeActivity, HOME_ACTIVITY_DAYS, type HomeActivityRecord } from "./activity"

const now = DateTime.fromISO("2026-06-06T12:00:00", { zone: "utc" })
const DAY = 24 * 60 * 60 * 1000

function record(
  daysAgo: number,
  options: {
    updatedOffset?: number
    tokens?: HomeActivityRecord["session"]["tokens"]
  } = {},
): HomeActivityRecord {
  const created = now.minus({ days: daysAgo }).toMillis()
  return {
    session: {
      time: {
        created,
        updated: options.updatedOffset ? created + options.updatedOffset : undefined,
      },
      tokens: options.tokens,
    },
  }
}

describe("home activity graph", () => {
  test("builds a token heatmap window", () => {
    const activity = buildHomeActivity(
      [
        record(0, { tokens: { input: 100, output: 50 } }),
        record(0, { tokens: { input: 250 } }),
        record(2, { tokens: { input: 40 } }),
        record(HOME_ACTIVITY_DAYS - 1, { tokens: { input: 10 } }),
        record(HOME_ACTIVITY_DAYS, { tokens: { input: 999 } }),
      ],
      "en",
      now,
    )

    expect(activity.days).toHaveLength(HOME_ACTIVITY_DAYS)
    expect(activity.weekCount).toBe(40)
    expect(activity.totalTokens).toBe(450)
    expect(activity.peakTokens).toBe(400)
    expect(activity.hasActivity).toBe(true)
    expect(activity.days[0]?.count).toBe(1)
    expect(activity.days[HOME_ACTIVITY_DAYS - 3]?.tokens).toBe(40)
    expect(activity.days[HOME_ACTIVITY_DAYS - 1]?.count).toBe(2)
    expect(activity.days[HOME_ACTIVITY_DAYS - 1]?.level).toBe(4)
    expect(activity.months.length).toBeGreaterThan(0)
  })

  test("uses updated time when present", () => {
    const activity = buildHomeActivity([record(20, { updatedOffset: 20 * DAY, tokens: { input: 20 } })], "en", now)

    expect(activity.totalTokens).toBe(20)
    expect(activity.days[HOME_ACTIVITY_DAYS - 1]?.tokens).toBe(20)
    expect(activity.longestTaskMs).toBe(20 * DAY)
  })

  test("calculates current and longest streaks", () => {
    const activity = buildHomeActivity(
      [
        record(0, { tokens: { input: 1 } }),
        record(1, { tokens: { input: 1 } }),
        record(3, { tokens: { input: 1 } }),
        record(4, { tokens: { input: 1 } }),
        record(5, { tokens: { input: 1 } }),
      ],
      "en",
      now,
    )

    expect(activity.currentStreak).toBe(2)
    expect(activity.longestStreak).toBe(3)
  })
})
