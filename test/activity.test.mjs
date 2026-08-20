import assert from "node:assert/strict";
import { test } from "node:test";

import { projectWeeklyRosterSummary } from "../dist/activity.js";

test("projects weekly roster activity and vault options", () => {
  const result = projectWeeklyRosterSummary(
    {
      characters: [
        {
          id: 2,
          name: "Zed",
          realm: "Example",
          data: {
            dungeons_done: [],
            world_quests_done: null,
            vault_options: {},
          },
        },
        {
          id: 1,
          name: "Anna",
          realm: "Example",
          data: {
            dungeons_done: [
              { level: 8, dungeon: 1 },
              { level: 12, dungeon: 2 },
            ],
            world_quests_done: 7,
            vault_options: {
              raids: { option_1: 321, option_2: null, option_3: null },
              dungeons: { option_1: 324, option_2: 321, option_3: null },
              world: { option_1: 318, option_2: null, option_3: null },
            },
          },
        },
      ],
    },
    1077,
    { limit: 1 },
  );

  assert.deepEqual(result.data, {
    period: 1077,
    characters: [
      {
        characterId: 1,
        name: "Anna",
        realm: "Example",
        dungeonCount: 2,
        highestDungeonLevel: 12,
        worldQuestsDone: 7,
        vault: {
          raids: { options: [321, null, null], unlockedCount: 1 },
          dungeons: { options: [324, 321, null], unlockedCount: 2 },
          world: { options: [318, null, null], unlockedCount: 1 },
        },
      },
    ],
  });
  assert.deepEqual(result.meta, {
    endpoint: "/v1/historical_data",
    method: "GET",
    offset: 0,
    totalItems: 2,
    returnedItems: 1,
    truncated: true,
    nextOffset: 1,
  });
});

test("rejects historical data without the documented character collection", () => {
  assert.throws(
    () => projectWeeklyRosterSummary({}, 1077),
    /must contain characters/,
  );
});
