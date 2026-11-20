export type CapabilitySensitivity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type PermissionMode = "READ" | "WRITE" | "EXECUTE" | "DESTRUCTIVE" | "MIXED" | "UNKNOWN";
export type CapabilityRiskLevel = CapabilitySensitivity | "UNKNOWN";

export interface CapabilityDefinition {
  key: string;
  graphId: string;
  name: string;
  category: string;
  sensitivity: CapabilitySensitivity;
  description: string;
  operation: "READ" | "WRITE" | "EXECUTE" | "DESTRUCTIVE";
}
export interface CapabilityEvidence {
  source: "tool_name" | "description" | "input_schema";
  matched: string;
}
export interface InferredCapability extends CapabilityDefinition {
  confidence: number;
  evidence: CapabilityEvidence[];
}
export interface DeclaredObservedComparison {
  property: "readOnlyHint" | "destructiveHint";
  declared: boolean | null;
  observed: boolean;
  status: "consistent" | "mismatch" | "not_declared";
  explanation: string;
}
export interface ToolCapabilityAnalysis {
  inferenceVersion: string;
  capabilities: InferredCapability[];
  permissionMode: PermissionMode;
  destructiveObserved: boolean;
  openWorldObserved: boolean;
  readOnlyHint: boolean | null;
  destructiveHint: boolean | null;
  comparisons: DeclaredObservedComparison[];
  riskScore: number;
  riskLevel: CapabilityRiskLevel;
  summary: string;
}
export const INFERENCE_VERSION = "1.0.0";

export const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  { key: "filesystem_read", graphId: "cap-inferred-filesystem-read", name: "Filesystem read", category: "DATA_ACCESS", sensitivity: "MEDIUM", operation: "READ", description: "Read or enumerate files, folders, documents, or filesystem paths." },
  { key: "filesystem_write", graphId: "cap-inferred-filesystem-write", name: "Filesystem write", category: "DATA_MUTATION", sensitivity: "HIGH", operation: "WRITE", description: "Create, modify, move, upload, or remove files and folders." },
  { key: "command_execution", graphId: "cap-inferred-command-execution", name: "Command execution", category: "CODE_EXECUTION", sensitivity: "CRITICAL", operation: "EXECUTE", description: "Execute shell commands, scripts, processes, or arbitrary code." },
  { key: "network_access", graphId: "cap-inferred-network-access", name: "Network access", category: "NETWORK", sensitivity: "MEDIUM", operation: "READ", description: "Make outbound HTTP, URL, API, or network requests." },
  { key: "web_search", graphId: "cap-public-web", name: "Public web access", category: "NETWORK", sensitivity: "MEDIUM", operation: "READ", description: "Search public websites or internet indexes." },
  { key: "browser_automation", graphId: "cap-inferred-browser-automation", name: "Browser automation", category: "AUTOMATION", sensitivity: "HIGH", operation: "WRITE", description: "Navigate or interact with browser pages and web sessions." },
  { key: "customer_data_read", graphId: "cap-customer-pii", name: "Customer data access", category: "SENSITIVE_DATA", sensitivity: "HIGH", operation: "READ", description: "Read customer, user, contact, or personally identifiable information." },
  { key: "credential_access", graphId: "cap-inferred-credential-access", name: "Credential access", category: "SECRETS", sensitivity: "CRITICAL", operation: "READ", description: "Read, retrieve, or expose passwords, tokens, API keys, or secrets." },
  { key: "database_read", graphId: "cap-inferred-database-read", name: "Database read", category: "DATA_ACCESS", sensitivity: "HIGH", operation: "READ", description: "Read database tables, rows, records, or execute read queries." },
  { key: "database_write", graphId: "cap-inferred-database-write", name: "Database write", category: "DATA_MUTATION", sensitivity: "CRITICAL", operation: "WRITE", description: "Insert, update, delete, or change database data and schema." },
  { key: "ticket_write", graphId: "cap-ticket-write", name: "Ticket or record mutation", category: "DATA_MUTATION", sensitivity: "HIGH", operation: "WRITE", description: "Create or modify tickets, CRM records, or business objects." },
  { key: "email_read", graphId: "cap-inferred-email-read", name: "Email read", category: "COMMUNICATIONS", sensitivity: "HIGH", operation: "READ", description: "Read mailboxes, email messages, or attachments." },
  { key: "email_send", graphId: "cap-inferred-email-send", name: "Email send", category: "EXTERNAL_COMMUNICATION", sensitivity: "HIGH", operation: "WRITE", description: "Send, forward, or reply to email messages." },
  { key: "finance_read", graphId: "cap-finance-read", name: "Financial data read", category: "FINANCIAL", sensitivity: "HIGH", operation: "READ", description: "Read balances, invoices, transactions, or financial account details." },
  { key: "payment_prepare", graphId: "cap-payment-write", name: "Financial transaction", category: "FINANCIAL", sensitivity: "CRITICAL", operation: "DESTRUCTIVE", description: "Initiate, prepare, transfer, refund, or otherwise mutate money or payments." },
  { key: "calendar_read", graphId: "cap-inferred-calendar-read", name: "Calendar read", category: "SENSITIVE_DATA", sensitivity: "MEDIUM", operation: "READ", description: "Read calendar events and availability." },
  { key: "calendar_write", graphId: "cap-inferred-calendar-write", name: "Calendar write", category: "DATA_MUTATION", sensitivity: "HIGH", operation: "WRITE", description: "Create, update, or delete calendar events." }
];

type Rule = { key: string; name: RegExp[]; description: RegExp[]; schema: RegExp[] };
const RULES: Rule[] = [
  { key: "filesystem_read", name: [/\b(read|open|list|search|view|download|get|fetch)\b.{0,35}\b(files?|folders?|directories|filesystem|documents?|paths?)\b/i, /\b(files?|folders?|directories|filesystem|documents?|paths?)\b.{0,35}\b(read|open|list|search|view|download)\b/i], description: [/\b(read|open|list|search|view|download)\b.{0,45}\b(files?|folders?|directories|documents?|filesystem|paths?)\b/i], schema: [/\b(file[_\s]?path|filepath|directory|folder|file[_\s]?name)\b/i] },
  { key: "filesystem_write", name: [/\b(write|create|edit|update|delete|remove|move|copy|upload|rename)\b.{0,35}\b(files?|folders?|directories|documents?|filesystem|paths?)\b/i, /\b(files?|folders?|directories|documents?|filesystem)\b.{0,35}\b(write|create|edit|update|delete|remove|move|copy|upload|rename)\b/i], description: [/\b(write|create|edit|update|delete|remove|move|copy|upload|rename)\b.{0,45}\b(files?|folders?|directories|documents?)\b/i], schema: [/\b(destination|target_?path|content|new_?path|overwrite|append)\b/i] },
  { key: "command_execution", name: [/\b(execute|run|spawn|shell|terminal|command|script|process|code interpreter)\b/i], description: [/\b(execute|run|spawn|shell command|terminal command|arbitrary code|script|process)\b/i], schema: [/\b(command|shell|script|executable|working_?directory)\b/i] },
  { key: "network_access", name: [/\b(fetch|request|http|url|network|api call|browse)\b/i], description: [/\b(outbound|http request|fetch a url|network request|external api|internet access|web page)\b/i], schema: [/\b(url|uri|endpoint|host|headers?)\b/i] },
  { key: "web_search", name: [/\b(web|internet|browser) search\b/i, /\bsearch (the )?(web|internet)\b/i], description: [/\b(search|query) (the )?(public )?(web|internet|websites?)\b/i], schema: [/\b(search_?query|query)\b/i] },
  { key: "browser_automation", name: [/\b(browser|navigate|click|screenshot|webpage|web page|tab|form fill)\b/i], description: [/\b(interact|navigate|click|type|submit|scrape)\b.{0,45}\b(browser|web page|website|page|form)\b/i], schema: [/\b(selector|css|xpath|tab_?id|page_?url)\b/i] },
  { key: "customer_data_read", name: [/\b(customer|user|contact|person|profile|pii|personal data)\b/i], description: [/\b(personally identifiable|customer records?|user profile|contact details|personal information|email address|phone number)\b/i], schema: [/\b(email|phone|telephone|address|ssn|social_?security|date_?of_?birth|customer_?id|user_?id)\b/i] },
  { key: "credential_access", name: [/\b(secret|secrets|credential|credentials|password|token|api key|private key|auth config)\b/i], description: [/\b(retrieve|read|list|expose|fetch)\b.{0,35}\b(secrets?|credentials?|passwords?|tokens?|api keys?)\b/i], schema: [/\b(password|token|secret|api_?key|private_?key|credential|authorization)\b/i] },
  { key: "database_read", name: [/\b(select|read|query|list|get|fetch)\b.{0,35}\b(database|sql|table|rows?|records?)\b/i, /\b(database|sql|table|rows?|records?)\b.{0,35}\b(select|read|query|list|get|fetch)\b/i], description: [/\b(read|select|query|list)\b.{0,40}\b(database|table|records?|rows?)\b/i], schema: [/\b(sql|query|database|table|where|select)\b/i] },
  { key: "database_write", name: [/\b(insert|update|delete|write|drop|alter|truncate)\b.{0,35}\b(database|sql|table|rows?|records?|schema)\b/i, /\b(database|sql|table|rows?|records?|schema)\b.{0,35}\b(insert|update|delete|write|drop|alter|truncate)\b/i], description: [/\b(insert|update|delete|modify|drop|alter|truncate)\b.{0,40}\b(database|table|records?|rows?|schema)\b/i], schema: [/\b(insert|update|delete|drop|alter|sql_?statement)\b/i] },
  { key: "ticket_write", name: [/\b(create|update|edit|delete|close|assign|comment|transition)\b.{0,35}\b(ticket|issue|task|case|crm|record)\b/i, /\b(ticket|issue|task|case|crm|record)\b.{0,35}\b(create|update|edit|delete|close|assign|comment|transition)\b/i], description: [/\b(create|modify|update|delete|assign)\b.{0,45}\b(ticket|issue|case|crm|record)\b/i], schema: [/\b(ticket_?id|issue_?id|record_?id|assignee|status)\b/i] },
  { key: "email_read", name: [/\b(read|search|list|get|fetch)\b.{0,30}\b(email|mail|message|inbox|attachment)\b/i], description: [/\b(read|search|list|retrieve)\b.{0,40}\b(emails?|mailbox|messages?|attachments?)\b/i], schema: [/\b(message_?id|mailbox|from|subject|attachment)\b/i] },
  { key: "email_send", name: [/\b(send|forward|reply|compose|draft)\b.{0,30}\b(email|mail|message)\b/i], description: [/\b(send|forward|reply to|compose)\b.{0,40}\b(emails?|messages?)\b/i], schema: [/\b(cc|bcc|recipient|subject|body)\b/i] },
  { key: "finance_read", name: [/\b(read|get|list|view|fetch)\b.{0,35}\b(balance|account|invoice|transaction|payment|finance|financial)\b/i, /\b(balance|account|invoice|transaction|finance|financial)\b.{0,35}\b(read|get|list|view|fetch)\b/i], description: [/\b(read|retrieve|view)\b.{0,45}\b(financial|balance|invoice|transaction|account)\b/i], schema: [/\b(account_?id|balance|currency|invoice_?id|transaction_?id)\b/i] },
  { key: "payment_prepare", name: [/\b(pay|payment|transfer|refund|withdraw|deposit|charge|payout|remit)\b/i], description: [/\b(initiate|prepare|submit|execute|transfer|refund|withdraw|deposit|charge)\b.{0,50}\b(payment|money|funds|payout|transaction)\b/i], schema: [/\b(amount|currency|beneficiary|destination_?account|payment_?id|transfer_?id)\b/i] },
  { key: "calendar_read", name: [/\b(read|list|search|get|view|find)\b.{0,30}\b(calendar|event|availability|schedule)\b/i], description: [/\b(read|list|find|check)\b.{0,40}\b(calendar|events?|availability|schedule)\b/i], schema: [/\b(start_?time|end_?time|calendar_?id|event_?id)\b/i] },
  { key: "calendar_write", name: [/\b(create|update|edit|delete|cancel|schedule|reschedule)\b.{0,30}\b(calendar|event|meeting|appointment)\b/i], description: [/\b(create|update|cancel|delete|schedule|reschedule)\b.{0,40}\b(calendar|events?|meetings?|appointments?)\b/i], schema: [/\b(start_?time|end_?time|attendees|invitees|event_?id)\b/i] }
];

function normalize(value: string): string {
  return value.replace(/[_./:-]+/g, " ").replace(/\s+/g, " ").trim();
}
function schemaSignals(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.slice(0, 100).flatMap((item) => schemaSignals(item, depth + 1));
  const record = value as Record<string, unknown>;
  const result: string[] = [];
  for (const [key, item] of Object.entries(record).slice(0, 200)) {
    result.push(normalize(key));
    if (key === "description" && typeof item === "string") result.push(normalize(item.slice(0, 1000)));
    if (key === "format" && typeof item === "string") result.push(normalize(item));
    if (key === "enum" && Array.isArray(item)) result.push(normalize(item.filter((v) => typeof v === "string").join(" ")));
    result.push(...schemaSignals(item, depth + 1));
  }
  return result;
}
function matched(patterns: RegExp[], value: string): string[] {
  return patterns.filter((pattern) => pattern.test(value)).map((pattern) => pattern.source);
}
function scoreFor(value: CapabilitySensitivity): number {
  return value === "CRITICAL" ? 90 : value === "HIGH" ? 70 : value === "MEDIUM" ? 45 : 20;
}
function levelFor(score: number): CapabilitySensitivity {
  return score >= 85 ? "CRITICAL" : score >= 65 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW";
}
function asBool(record: Record<string, unknown>, key: string): boolean | null {
  return typeof record[key] === "boolean" ? record[key] as boolean : null;
}

export function inferToolCapabilities(input: {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}): ToolCapabilityAnalysis {
  const name = normalize(input.name);
  const description = normalize(input.description ?? "");
  const schema = schemaSignals(input.inputSchema).join(" ") + " " + schemaSignals(input.outputSchema).join(" ");
  const annotations = input.annotations && typeof input.annotations === "object" && !Array.isArray(input.annotations)
    ? input.annotations as Record<string, unknown>
    : {};
  const capabilities: InferredCapability[] = [];

  for (const rule of RULES) {
    const definition = CAPABILITY_DEFINITIONS.find((item) => item.key === rule.key);
    if (!definition) continue;
    const evidence: CapabilityEvidence[] = [
      ...matched(rule.name, name).map((matched) => ({ source: "tool_name" as const, matched })),
      ...matched(rule.description, description).map((matched) => ({ source: "description" as const, matched })),
      ...matched(rule.schema, schema).map((matched) => ({ source: "input_schema" as const, matched }))
    ];
    if (evidence.length === 0) continue;
    const sourceCount = new Set(evidence.map((item) => item.source)).size;
    const confidence = Math.min(0.98, 0.58 + Math.max(0, sourceCount - 1) * 0.15 + Math.min(0.1, (evidence.length - sourceCount) * 0.03));
    capabilities.push({
      ...definition,
      confidence: Number(confidence.toFixed(2)),
      evidence
    });
  }

  const destructiveObserved = /\b(delete|remove|drop|truncate|destroy|purge|transfer|refund|withdraw|charge|revoke)\b/i.test(name + " " + description)
    || asBool(annotations, "destructiveHint") === true;
  const openWorldObserved = /\b(internet|public web|external url|arbitrary url|external api|untrusted website)\b/i.test(name + " " + description + " " + schema)
    || asBool(annotations, "openWorldHint") === true;
  const readOnlyHint = asBool(annotations, "readOnlyHint");
  const destructiveHint = asBool(annotations, "destructiveHint");
  const writes = capabilities.some((item) => item.operation === "WRITE" || item.operation === "DESTRUCTIVE");
  const executes = capabilities.some((item) => item.operation === "EXECUTE");
  const reads = capabilities.some((item) => item.operation === "READ");
  let permissionMode: PermissionMode = "UNKNOWN";
  if (destructiveObserved) permissionMode = "DESTRUCTIVE";
  else if (executes) permissionMode = reads || writes ? "MIXED" : "EXECUTE";
  else if (writes && reads) permissionMode = "MIXED";
  else if (writes) permissionMode = "WRITE";
  else if (reads) permissionMode = "READ";

  const writeObserved = writes || executes || destructiveObserved;
  const comparisons: DeclaredObservedComparison[] = [
    {
      property: "readOnlyHint",
      declared: readOnlyHint,
      observed: writeObserved,
      status: readOnlyHint === null ? "not_declared" : readOnlyHint && writeObserved ? "mismatch" : "consistent",
      explanation: readOnlyHint === null ? "The server did not declare readOnlyHint." : readOnlyHint && writeObserved ? "Read-only annotation conflicts with write or execution signals in tool metadata." : "No conflicting write or execution signal was inferred."
    },
    {
      property: "destructiveHint",
      declared: destructiveHint,
      observed: destructiveObserved,
      status: destructiveHint === null ? "not_declared" : !destructiveHint && destructiveObserved ? "mismatch" : "consistent",
      explanation: destructiveHint === null ? "The server did not declare destructiveHint." : !destructiveHint && destructiveObserved ? "Non-destructive annotation conflicts with destructive operation signals." : "No conflicting destructive operation signal was inferred."
    }
  ];
  const baseScore = capabilities.reduce((max, item) => Math.max(max, scoreFor(item.sensitivity)), 0);
  const mismatchCount = comparisons.filter((item) => item.status === "mismatch").length;
  const riskScore = capabilities.length === 0 && !destructiveObserved
    ? 0
    : Math.min(100, Math.max(baseScore, destructiveObserved ? 90 : 0) + (destructiveObserved ? 8 : 0) + (openWorldObserved ? 5 : 0) + mismatchCount * 10);
  const riskLevel: CapabilityRiskLevel = capabilities.length === 0 && !destructiveObserved ? "UNKNOWN" : levelFor(riskScore);
  return {
    inferenceVersion: INFERENCE_VERSION,
    capabilities,
    permissionMode,
    destructiveObserved,
    openWorldObserved,
    readOnlyHint,
    destructiveHint,
    comparisons,
    riskScore,
    riskLevel,
    summary: capabilities.length ? capabilities.map((item) => item.name).join(", ") : "No capability matched current deterministic rules; manual review required."
  };
}

export function aggregateExposure(scores: number[]): { score: number; level: CapabilityRiskLevel } {
  const knownScores = scores.filter((score) => Number.isFinite(score) && score >= 0);
  if (knownScores.length === 0) return { score: 0, level: "UNKNOWN" };
  const score = Math.min(100, Math.max(...knownScores) + Math.min(15, Math.max(0, knownScores.length - 1) * 3));
  return { score, level: levelFor(score) };
}
