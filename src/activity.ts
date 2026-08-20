const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

interface Pagination {
  limit?: number;
  offset?: number;
}

interface VaultSummary {
  options: Array<number | null>;
  unlockedCount: number;
}

interface WeeklyRosterRow {
  characterId: number;
  name: string;
  realm: string | null;
  dungeonCount: number;
  highestDungeonLevel: number | null;
  worldQuestsDone: number | null;
  vault: {
    raids: VaultSummary;
    dungeons: VaultSummary;
    world: VaultSummary;
  };
}

export function projectWeeklyRosterSummary(
  raw: unknown,
  period: number,
  pagination: Pagination = {},
) {
  const root = record(raw);
  if (!root || !Array.isArray(root.characters)) {
    throw new Error("WoWAudit historical response must contain characters");
  }

  const rows: WeeklyRosterRow[] = [];
  for (const value of root.characters) {
    const character = record(value);
    const data = record(character?.data);
    const characterId = integer(character?.id);
    const name = text(character?.name);
    if (!character || !data || characterId === null || !name) continue;

    const dungeonLevels = array(data.dungeons_done)
      .map((dungeon) => integer(record(dungeon)?.level, true))
      .filter((level): level is number => level !== null);
    const vault = record(data.vault_options);
    rows.push({
      characterId,
      name,
      realm: text(character.realm),
      dungeonCount: dungeonLevels.length,
      highestDungeonLevel:
        dungeonLevels.length > 0 ? Math.max(...dungeonLevels) : null,
      worldQuestsDone: integer(data.world_quests_done, true),
      vault: {
        raids: vaultSummary(record(vault?.raids)),
        dungeons: vaultSummary(record(vault?.dungeons)),
        world: vaultSummary(record(vault?.world)),
      },
    });
  }

  rows.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      (left.realm ?? "").localeCompare(right.realm ?? "") ||
      left.characterId - right.characterId,
  );
  const offset = pagination.offset ?? 0;
  const limit = Math.min(pagination.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const characters = rows.slice(offset, offset + limit);
  const nextOffset = offset + characters.length;
  return {
    data: { period, characters },
    meta: {
      endpoint: "/v1/historical_data",
      method: "GET",
      offset,
      totalItems: rows.length,
      returnedItems: characters.length,
      truncated: nextOffset < rows.length,
      nextOffset: nextOffset < rows.length ? nextOffset : null,
    },
  };
}

function vaultSummary(value: Record<string, unknown> | null): VaultSummary {
  const options = [value?.option_1, value?.option_2, value?.option_3].map(
    (option) => integer(option, true),
  );
  return {
    options,
    unlockedCount: options.filter((option) => option !== null).length,
  };
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown, allowZero = false): number | null {
  return Number.isSafeInteger(value) &&
    (allowZero ? (value as number) >= 0 : (value as number) > 0)
    ? (value as number)
    : null;
}
