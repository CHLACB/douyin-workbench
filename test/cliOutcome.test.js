import test from "node:test";
import assert from "node:assert/strict";

import { actionExitCode } from "../src/app/cliOutcome.js";

test("unconfirmed or failed actions produce a non-zero CLI exit code", () => {
  assert.equal(actionExitCode({ ok: false, confirmed: false }), 1);
  assert.equal(actionExitCode({ ok: true, confirmed: true }), 0);
});
