import assert from "node:assert/strict";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  getConfig,
  parseBaseUrl,
  parseBoundedInteger,
  parseWritePolicy,
  readApiKey,
} from "../dist/config.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function withKeyFd(contents, callback) {
  const directory = mkdtempSync(path.join(tmpdir(), "wowaudit-key-"));
  const keyPath = path.join(directory, "key");
  writeFileSync(keyPath, contents);
  const fd = openSync(keyPath, "r");
  try {
    return callback(fd);
  } finally {
    closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}

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

test("preserves environment API key whitespace without normalization", () => {
  assert.equal(readApiKey(" \tteam key\r\n", undefined), " \tteam key\r\n");
  assert.throws(() => readApiKey("", undefined), /Missing WOWAUDIT_API_KEY/);
});

test("reads exact non-empty UTF-8 API key bytes from an inherited fd", () => {
  const key = "\ufeff \tWoW clé\0\r\n";
  withKeyFd(Buffer.from(key, "utf8"), (fd) => {
    delete process.env.WOWAUDIT_API_KEY;
    process.env.WOWAUDIT_API_KEY_FD = String(fd);
    assert.equal(getConfig().apiKey, key);
  });
});

test("requires exactly one API key source", () => {
  assert.throws(
    () => readApiKey("environment-key", "3"),
    /Set exactly one of WOWAUDIT_API_KEY or WOWAUDIT_API_KEY_FD/,
  );
});

test("validates the API key fd and its bytes", () => {
  for (const value of ["0", "1025", " 3", "3 ", "+3", "1.5"]) {
    assert.throws(
      () => readApiKey(undefined, value),
      /must be an integer between 1 and 1024/,
      value,
    );
  }

  withKeyFd(Buffer.alloc(0), (fd) => {
    assert.throws(() => readApiKey(undefined, String(fd)), /must not be empty/);
  });
  withKeyFd(Buffer.from([0xc3, 0x28]), (fd) => {
    assert.throws(
      () => readApiKey(undefined, String(fd)),
      /must contain valid UTF-8/,
    );
  });
});
