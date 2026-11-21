import { describe, expect, it } from "vitest";
import {
  compareToolInventory,
  fingerprintToolSnapshot,
  validateRuntimeEvent
} from "../src/server/runtime-security";

describe("runtime security evidence contracts", () => {
  it("fingerprints schema objects independently of key order", () => {
    const first = { name: "read_file", inputSchema: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } } };
    const second = { name: "read_file", inputSchema: { properties: { limit: { type: "number" }, path: { type: "string" } }, type: "object" } };
    expect(fingerprintToolSnapshot(first)).toBe(fingerprintToolSnapshot(second));
  });

  it("detects added, removed and field-level modified tools", () => {
    const previous = [
      { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "delete_record", description: "Delete a record", inputSchema: { type: "object" } }
    ];
    const current = [
      { name: "read_file", description: "Read a file and return metadata", inputSchema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } } } },
      { name: "write_file", description: "Write a file", inputSchema: { type: "object" } }
    ];
    expect(compareToolInventory(previous, current)).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "read_file", changeType: "MODIFIED", changedFields: ["description", "inputSchema"] }),
      expect.objectContaining({ toolName: "write_file", changeType: "ADDED" }),
      expect.objectContaining({ toolName: "delete_record", changeType: "REMOVED" })
    ]));
  });

  it("normalizes valid adapter events and requires an effect for side-effect reports", () => {
    const valid = validateRuntimeEvent({
      eventId: "evt-01",
      executionId: "run-01",
      serverId: "server-01",
      toolName: "write_file",
      eventType: "SIDE_EFFECT_OBSERVED",
      effect: "filesystem_write",
      observedAt: "2026-11-20T10:00:00.000Z",
      durationMs: 20
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.event.observedAt).toBe("2026-11-20T10:00:00.000Z");

    expect(validateRuntimeEvent({
      eventId: "evt-02",
      executionId: "run-01",
      serverId: "server-01",
      toolName: "write_file",
      eventType: "SIDE_EFFECT_OBSERVED"
    })).toEqual({ ok: false, error: "SIDE_EFFECT_OBSERVED requires a normalized effect." });
  });

  it("rejects raw tool payloads and malformed event identifiers", () => {
    const base = {
      eventId: "evt-03",
      executionId: "run-01",
      serverId: "server-01",
      toolName: "read_file",
      eventType: "CALL_STARTED"
    };
    expect(validateRuntimeEvent({ ...base, arguments: { path: "/secret" } }).ok).toBe(false);
    expect(validateRuntimeEvent({ ...base, eventId: "bad id" }).ok).toBe(false);
  });
});
