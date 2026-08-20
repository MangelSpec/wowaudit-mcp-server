const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface WishlistItemQuery {
  itemId?: number;
  itemName?: string;
  match?: "contains" | "exact";
  slot?: string;
  limit?: number;
  offset?: number;
}

export interface WishlistItemRow {
  characterId: number | null;
  characterName: string;
  realm: string | null;
  configuration: string;
  instance: string;
  difficulty: string;
  encounter: string;
  itemId: number;
  itemName: string;
  slot: string;
  specialization: string | null;
  weight: number | null;
  percentage: number | null;
  absolute: number | null;
  upgrade: string | null;
}

export interface WishlistItemResult {
  data: { matches: WishlistItemRow[] };
  meta: {
    endpoint: "/v1/wishlists";
    method: "GET";
    offset: number;
    totalItems: number;
    returnedItems: number;
    truncated: boolean;
    nextOffset: number | null;
  };
}

export function projectWishlistItems(
  raw: unknown,
  query: WishlistItemQuery = {},
): WishlistItemResult {
  const root = record(raw);
  if (!root || !Array.isArray(root.characters)) {
    throw new Error("WoWAudit wishlist response must contain characters");
  }

  const rows: WishlistItemRow[] = [];
  for (const characterValue of root.characters) {
    const character = record(characterValue);
    const characterName = text(character?.name);
    if (!character || !characterName) continue;

    for (const configurationValue of array(character.wishlists)) {
      const configuration = record(configurationValue);
      const configurationName = text(configuration?.name);
      if (!configuration || !configurationName) continue;

      for (const instanceValue of array(configuration.instances)) {
        const instance = record(instanceValue);
        const instanceName = text(instance?.name);
        if (!instance || !instanceName) continue;

        for (const difficultyValue of array(instance.difficulties)) {
          const difficulty = record(difficultyValue);
          const difficultyName = text(difficulty?.difficulty);
          const wishlistContainer = record(difficulty?.wishlist);
          const wishlist =
            record(wishlistContainer?.wishlist) ?? wishlistContainer;
          if (!difficulty || !difficultyName || !wishlist) continue;

          for (const encounterValue of array(wishlist.encounters)) {
            const encounter = record(encounterValue);
            const encounterName = text(encounter?.name);
            if (!encounter || !encounterName) continue;

            for (const itemValue of array(encounter.items)) {
              const item = record(itemValue);
              const itemId = integer(item?.id);
              const itemName = text(item?.name);
              const slot = text(item?.slot);
              if (
                !item ||
                itemId === null ||
                !itemName ||
                !slot ||
                !matchesItem(itemId, itemName, slot, query)
              ) {
                continue;
              }

              for (const wishValue of array(item.wishes)) {
                const wish = record(wishValue);
                if (!wish) continue;
                rows.push({
                  characterId: integer(character.id),
                  characterName,
                  realm: text(character.realm),
                  configuration: configurationName,
                  instance: instanceName,
                  difficulty: difficultyName,
                  encounter: encounterName,
                  itemId,
                  itemName,
                  slot,
                  specialization: text(wish.specialization),
                  weight: number(wish.weight),
                  percentage: number(wish.percentage),
                  absolute: number(wish.absolute),
                  upgrade: text(wish.upgrade),
                });
              }
            }
          }
        }
      }
    }
  }

  rows.sort(compareRows);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? DEFAULT_LIMIT;
  const matches = rows.slice(offset, offset + Math.min(limit, MAX_LIMIT));
  const nextOffset = offset + matches.length;
  return {
    data: { matches },
    meta: {
      endpoint: "/v1/wishlists",
      method: "GET",
      offset,
      totalItems: rows.length,
      returnedItems: matches.length,
      truncated: nextOffset < rows.length,
      nextOffset: nextOffset < rows.length ? nextOffset : null,
    },
  };
}

function matchesItem(
  itemId: number,
  itemName: string,
  slot: string,
  query: WishlistItemQuery,
): boolean {
  if (query.itemId !== undefined && itemId !== query.itemId) return false;
  if (query.slot !== undefined && slot !== query.slot) return false;
  if (query.itemName === undefined) return true;
  const expected = query.itemName.trim().toLocaleLowerCase("en-US");
  const actual = itemName.toLocaleLowerCase("en-US");
  return query.match === "contains"
    ? actual.includes(expected)
    : actual === expected;
}

function compareRows(left: WishlistItemRow, right: WishlistItemRow): number {
  for (const comparison of [
    left.characterName.localeCompare(right.characterName),
    (left.realm ?? "").localeCompare(right.realm ?? ""),
    left.itemName.localeCompare(right.itemName),
    left.configuration.localeCompare(right.configuration),
    left.difficulty.localeCompare(right.difficulty),
    left.encounter.localeCompare(right.encounter),
    (left.specialization ?? "").localeCompare(right.specialization ?? ""),
    left.itemId - right.itemId,
  ]) {
    if (comparison !== 0) return comparison;
  }
  return 0;
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

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
