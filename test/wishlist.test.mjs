import assert from "node:assert/strict";
import { test } from "node:test";

import { projectWishlistItems } from "../dist/wishlist.js";

const response = {
  characters: [
    character("Zed", 2, [
      item(200, "Other Trinket", "trinket", [wish("Fire", 0.2, 18, null)]),
    ]),
    character("Anna", 1, [
      item(100, "Heart of Tests", "trinket", [
        wish("Holy", 1.25, 42, null),
        wish("Retribution", null, null, "huge"),
      ]),
      item(300, "Not a Trinket", "finger", [wish("Holy", 9, 99, null)]),
    ]),
  ],
};

test("projects deterministic compact wishlist rows with gains", () => {
  const result = projectWishlistItems(response, { slot: "trinket" });

  assert.equal(result.meta.totalItems, 3);
  assert.deepEqual(
    result.data.matches.map((row) => [
      row.characterName,
      row.itemName,
      row.specialization,
      row.percentage,
      row.absolute,
      row.upgrade,
    ]),
    [
      ["Anna", "Heart of Tests", "Holy", 1.25, 42, null],
      ["Anna", "Heart of Tests", "Retribution", null, null, "huge"],
      ["Zed", "Other Trinket", "Fire", 0.2, 18, null],
    ],
  );
});

test("filters before paginating by item ID or name", () => {
  const byId = projectWishlistItems(response, { itemId: 100, limit: 1 });
  assert.equal(byId.meta.totalItems, 2);
  assert.equal(byId.meta.nextOffset, 1);
  assert.equal(byId.data.matches[0].characterName, "Anna");

  const byName = projectWishlistItems(response, {
    itemName: "heart of",
    match: "contains",
    offset: 1,
  });
  assert.equal(byName.meta.totalItems, 2);
  assert.equal(byName.data.matches.length, 1);
  assert.equal(byName.data.matches[0].specialization, "Retribution");
});

test("rejects a response without the documented character collection", () => {
  assert.throws(() => projectWishlistItems({}), /must contain characters/);
});

function character(name, id, items) {
  return {
    id,
    name,
    realm: "Example",
    wishlists: [
      {
        name: "Raid",
        instances: [
          {
            name: "Test Raid",
            difficulties: [
              {
                difficulty: "Mythic",
                wishlist: {
                  wishlist: {
                    encounters: [{ name: "Test Boss", items }],
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function item(id, name, slot, wishes) {
  return { id, name, slot, wishes };
}

function wish(specialization, percentage, absolute, upgrade) {
  return {
    specialization,
    weight: 1,
    percentage,
    absolute,
    upgrade,
  };
}
