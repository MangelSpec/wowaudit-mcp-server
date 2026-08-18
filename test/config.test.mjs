import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseBaseUrl,
  parseBoundedInteger,
  parseWritePolicy,
} from "../dist/config.js";

test("normalizes and validates the WoWAudit base URL", () => {
  assert.equal(parseBaseUrl(undefined), "https://api.wowaudit.com");
  assert.equal(
    parseBaseUrl("https://example.com/api/"),
    "https://example.com/api",
  );
  assert.throws(
    () => parseBaseUrl("file:///tmp/api"),
    /must use HTTP or HTTPS/,
  );
  assert.throws(
    () => parseBaseUrl("https://user:secret@example.com"),
    /must not contain credentials/,
  );
});

test("validates bounded integer configuration", () => {
  assert.equal(parseBoundedInteger("VALUE", undefined, 30, 10, 60), 30);
  assert.equal(parseBoundedInteger("VALUE", "45", 30, 10, 60), 45);
  assert.throws(
    () => parseBoundedInteger("VALUE", "9", 30, 10, 60),
    /between 10 and 60/,
  );
  assert.throws(
    () => parseBoundedInteger("VALUE", "1.5", 30, 10, 60),
    /must be an integer/,
  );
});

test("accepts only the exact documented write policy", () => {
  assert.equal(parseWritePolicy(undefined), undefined);
  assert.equal(parseWritePolicy(""), undefined);
  assert.equal(
    parseWritePolicy("raidlens-create-update-v1"),
    "raidlens-create-update-v1",
  );
  assert.throws(
    () => parseWritePolicy("raidlens-create-update-v2"),
    /WOWAUDIT_WRITE_POLICY must be raidlens-create-update-v1 when set/,
  );
  assert.throws(
    () => parseWritePolicy(" raidlens-create-update-v1 "),
    /WOWAUDIT_WRITE_POLICY must be raidlens-create-update-v1 when set/,
  );
});
