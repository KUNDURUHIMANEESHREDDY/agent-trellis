import { createHash } from "node:crypto";

export interface McpToolSnapshot {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface SchemaDriftChange {
  toolName: string;
  changeType: "ADDED" | "REMOVED" | "MODIFIED";
  changedFields: string[];
  previousFingerprint?: string;
  currentFingerprint?: string;
}

export const RUNTIME_EVENT_TYPES = [
  "CALL_STARTED",
  "CALL_SUCCEEDED",
  "CALL_FAILED",
  "POLICY_DENIED",
  "SIDE_EFFECT_OBSERVED"
] as const;

export const RUNTIME_EFFECTS = [
  "filesystem_read",
  "filesystem_write",
  "network_egress",
  "database_read",
  "database_write",
  "credential_access",
  "email_send",
  "ticket_write",
  "payment_prepare",
  "unknown"
] as const;

export type RuntimeEventType = typeof RUNTIME_EVENT_TYPES[number];
export type RuntimeEffect = typeof RUNTIME_EFFECTS[number];

export interface NormalizedRuntimeEvent {
  eventId: string;
  executionId: string;
  serverId: string;
  toolName: string;
  eventType: RuntimeEventType;
  observedAt: string;
  agentId?: string;
  durationMs?: number;
  effect?: RuntimeEffect;
  policyName?: string;
  errorCode?: string;
}

export type RuntimeEventValidation =
  | { ok: true; event: NormalizedRuntimeEvent }
  | { ok: false; error: string };

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(record[key])
  ).join(",") + "}";
}

export function fingerprintToolSnapshot(tool: McpToolSnapshot): string {
  const normalized = {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? null
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

export function fingerprintToolInventory(tools: McpToolSnapshot[]): string {
  const rows = tools
    .map((tool) => [tool.name, fingerprintToolSnapshot(tool)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(canonicalJson(rows)).digest("hex");
}

export function compareToolInventory(
  previous: McpToolSnapshot[],
  current: McpToolSnapshot[]
): SchemaDriftChange[] {
  const previousByName = new Map(previous.map((tool) => [tool.name, tool]));
  const currentByName = new Map(current.map((tool) => [tool.name, tool]));
  const changes: SchemaDriftChange[] = [];

  for (const [name, tool] of currentByName) {
    const before = previousByName.get(name);
    const currentFingerprint = fingerprintToolSnapshot(tool);
    if (!before) {
      changes.push({ toolName: name, changeType: "ADDED", changedFields: ["tool"], currentFingerprint });
      continue;
    }
    const changedFields = ([
      ["description", before.description ?? "", tool.description ?? ""],
      ["inputSchema", before.inputSchema ?? null, tool.inputSchema ?? null],
      ["outputSchema", before.outputSchema ?? null, tool.outputSchema ?? null],
      ["annotations", before.annotations ?? null, tool.annotations ?? null]
    ] as Array<[string, unknown, unknown]>)
      .filter(([, left, right]) => canonicalJson(left) !== canonicalJson(right))
      .map(([field]) => field);
    if (changedFields.length > 0) {
      changes.push({
        toolName: name,
        changeType: "MODIFIED",
        changedFields,
        previousFingerprint: fingerprintToolSnapshot(before),
        currentFingerprint
      });
    }
  }

  for (const [name, tool] of previousByName) {
    if (!currentByName.has(name)) {
      changes.push({
        toolName: name,
        changeType: "REMOVED",
        changedFields: ["tool"],
        previousFingerprint: fingerprintToolSnapshot(tool)
      });
    }
  }
  return changes.sort((left, right) =>
    left.toolName.localeCompare(right.toolName) || left.changeType.localeCompare(right.changeType)
  );
}

function boundedText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    throw new Error("Invalid " + field + ".");
  }
  return value;
}

export function validateRuntimeEvent(value: unknown): RuntimeEventValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "A JSON object is required." };
  }
  const record = value as Record<string, unknown>;
  const forbidden = Object.keys(record).find((key) =>
    /^(?:args?|arguments|input|inputs|output|outputs|result|response|payload|headers?|authorization|credentials?|secrets?|tokens?|environment|env)$/i.test(key)
  );
  if (forbidden) {
    return {
      ok: false,
      error: "Raw tool arguments, results, credentials and request metadata are not accepted. Send event metadata only."
    };
  }

  try {
    const eventId = boundedText(record.eventId, "eventId", 128);
    const executionId = boundedText(record.executionId, "executionId", 128);
    const serverId = boundedText(record.serverId, "serverId", 200);
    const toolName = boundedText(record.toolName, "toolName", 200);
    if (!eventId || !executionId || !serverId || !toolName) {
      throw new Error("eventId, executionId, serverId and toolName are required.");
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(eventId) || !/^[A-Za-z0-9._:-]+$/.test(executionId)) {
      throw new Error("eventId and executionId may contain only letters, numbers, dot, underscore, colon and hyphen.");
    }
    if (typeof record.eventType !== "string" || !RUNTIME_EVENT_TYPES.includes(record.eventType as RuntimeEventType)) {
      throw new Error("eventType is not supported.");
    }

    const observedAtInput = record.observedAt === undefined ? new Date().toISOString() : record.observedAt;
    if (typeof observedAtInput !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(observedAtInput)) {
      throw new Error("observedAt must be an ISO-8601 timestamp.");
    }
    const observedAtDate = new Date(observedAtInput);
    if (!Number.isFinite(observedAtDate.getTime())) throw new Error("observedAt is invalid.");

    let durationMs: number | undefined;
    if (record.durationMs !== undefined) {
      if (!Number.isInteger(record.durationMs) || Number(record.durationMs) < 0 || Number(record.durationMs) > 3_600_000) {
        throw new Error("durationMs must be an integer from 0 to 3600000.");
      }
      durationMs = Number(record.durationMs);
    }

    let effect: RuntimeEffect | undefined;
    if (record.effect !== undefined) {
      if (typeof record.effect !== "string" || !RUNTIME_EFFECTS.includes(record.effect as RuntimeEffect)) {
        throw new Error("effect is not supported.");
      }
      effect = record.effect as RuntimeEffect;
    }
    const eventType = record.eventType as RuntimeEventType;
    if (eventType === "SIDE_EFFECT_OBSERVED" && !effect) {
      throw new Error("SIDE_EFFECT_OBSERVED requires a normalized effect.");
    }

    const agentId = boundedText(record.agentId, "agentId", 200);
    const policyName = boundedText(record.policyName, "policyName", 120);
    const errorCode = boundedText(record.errorCode, "errorCode", 80);
    if (errorCode && !/^[A-Za-z0-9_.:-]+$/.test(errorCode)) {
      throw new Error("errorCode contains unsupported characters.");
    }
    return {
      ok: true,
      event: {
        eventId,
        executionId,
        serverId,
        toolName,
        eventType,
        observedAt: observedAtDate.toISOString(),
        ...(agentId ? { agentId } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(effect ? { effect } : {}),
        ...(policyName ? { policyName } : {}),
        ...(errorCode ? { errorCode } : {})
      }
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid runtime event." };
  }
}

export function isHighImpactEffect(effect?: RuntimeEffect): boolean {
  return effect !== undefined && [
    "filesystem_write",
    "database_write",
    "credential_access",
    "email_send",
    "ticket_write",
    "payment_prepare"
  ].includes(effect);
}
