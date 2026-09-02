import assert from "node:assert/strict";
import test from "node:test";
import { dailyLogFilename, formatLogEntry, sanitizeLogText } from "../src/local-logging.mjs";

test("local logs redact loopback session tokens without hiding useful context", () => {
  const text = sanitizeLogText(
    "控制与预览：http://127.0.0.1:43121/AbCdEfGhIjKlMnOpQrStUvWx/api/config\n",
  );
  assert.equal(text, "控制与预览：http://127.0.0.1:43121/[session]/api/config\n");
  assert.equal(
    sanitizeLogText('{"sessionToken":"AbCdEfGhIjKlMnOpQrStUvWx"}'),
    '{"sessionToken":"[redacted]"}',
  );
});

test("local log filenames and entries are deterministic", () => {
  const localDay = new Date(2026, 8, 3, 1, 2, 3);
  const at = new Date("2026-09-03T12:34:56.000Z");
  assert.equal(dailyLogFilename(localDay), "codex-wallpaper-2026-09-03.log");
  assert.equal(
    formatLogEntry({ stream: "stderr", text: "failed\n", at: at.toISOString() }),
    "[2026-09-03T12:34:56.000Z] [STDERR] failed\n",
  );
});
