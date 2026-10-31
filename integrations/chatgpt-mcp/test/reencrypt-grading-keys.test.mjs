import assert from "node:assert/strict";
import test from "node:test";

import { reencryptGradingKeys } from "../db/reencrypt-grading-keys.mjs";

test("grading-key maintenance rejects every spreadsheet except approved independent copy", async () => {
  await assert.rejects(reencryptGradingKeys({
    GRADING_ENCRYPTION_KEY_ID: "test-key",
    GRADING_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
    TEST_SPREADSHEET_ID: "operational-or-unapproved-sheet",
  }), /approved independent test spreadsheet/);
});
