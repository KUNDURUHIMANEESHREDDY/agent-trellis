# AgentTrellis

**Understand every connection. Expose every risk.**

AgentTrellis is a graph-powered security intelligence workspace for AI-agent systems. It maps agents, MCP servers, tools, capabilities, policies, executions and evidence into a persistent graph using **Neo4j Relate**.

## Why a graph?

A security finding is rarely isolated. A vulnerable MCP tool can affect several agents, invalidate previous assessments and expose capabilities that are restricted by policy. AgentTrellis uses Relate and Cypher to traverse those connections and explain the blast radius.

## Current MVP

- Persistent embedded graph database powered by `@relate/relate`.
- Seeded, inspectable agent/MCP/tool/capability/policy/evidence graph.
- Dashboard with graph explorer, risk overview and agent inventory.
- Blast-radius simulation for a compromised MCP tool.
- Evidence-backed assessment records and graph query API.
- Resettable demo dataset.
- Read-only discovery of local MCP configuration from Claude Desktop/Code, Cursor, Windsurf, Copilot CLI and workspace `.mcp.json` files.
- Discovered MCP host and server definitions are normalized and persisted in Relate; credential values are excluded.
- Live MCP inspection via the official TypeScript client SDK over stdio, Streamable HTTP and legacy SSE.
- Negotiates modern `server/discover` or legacy `initialize`, inspects tool names and JSON schemas, and checks declared tools/resources/prompts support with read-only list methods.
- Persists inspection outcomes, capability comparisons and tool schemas as graph-linked evidence. Local stdio launches require explicit approval.
- Compares each successful tool inventory inspection with its persisted baseline, versions changed tool schemas and creates graph-linked drift evidence; failed/incomplete inspections never erase the last known tool inventory.
- Re-runs capability inference after successful inventory refreshes so capability edges and agent exposure summaries track the latest inspected schemas.
- Provides a token-authenticated runtime event ingestion contract for external execution adapters, with idempotent event IDs, normalized effect categories and a metadata-only payload policy. Runtime event evidence is stored separately from static capability inference.

## Requirements

- Node.js 20+ (Relate supports Node.js 18+; use an active LTS release).
- npm 10+

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173. The API runs on http://localhost:8787.

The graph is stored under `.data/agent-trellis/`. It is persistent across restarts. Delete that directory only when you intentionally want to reset the local database; the dashboard also provides a reset action for the demo graph.

### Local MCP discovery

Call `POST /api/discovery/mcp` to scan known local configuration files, then `GET /api/discovery/mcp` to read the persisted inventory. AgentTrellis reads configuration metadata only: it does not launch configured processes, connect to MCP servers, or invoke tools. Credential values, command arguments, environment values and header values are not stored. The inventory retains only command names, argument counts, endpoint origins/paths, and environment/header key names.

Discovery supports Claude Desktop, Claude Code user/local configuration, Cursor global/workspace configuration, Windsurf global configuration, GitHub Copilot CLI, and workspace-root `.mcp.json`. It scans the current working directory plus roots listed in `AGENT_TRELLIS_WORKSPACES`, separated by the operating system path delimiter. The API and development server bind to loopback because discovery reads files on the local machine.

### Runtime telemetry and schema drift

Set AGENT_TRELLIS_RUNTIME_TOKEN to a unique random secret in the API environment and restart AgentTrellis. A trusted execution adapter can then send normalized events to POST /api/runtime/events with the x-agent-trellis-token header. Use a stable, unique eventId per event and include executionId, serverId, toolName, eventType and an optional ISO timestamp/duration. Supported event types are CALL_STARTED, CALL_SUCCEEDED, CALL_FAILED, POLICY_DENIED and SIDE_EFFECT_OBSERVED. Side-effect events must include a normalized effect such as filesystem_write or database_write.

The ingestion validator deliberately rejects raw arguments, results, credentials, headers and environment values. It stores only normalized metadata and hashes for idempotency; it does not independently inspect tool inputs or outputs. POST /api/runtime/events is **adapter-reported** telemetry: the API assigns this provenance itself, even if a client adds a `sourceKind` field to its payload.

For direct observation of MCP tool-call traffic, route the agent's remote MCP connection through the local AgentTrellis gateway:

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "http://127.0.0.1:8787/api/runtime/mcp/<discovered-server-id>",
      "headers": {
        "x-agent-trellis-token": "${AGENT_TRELLIS_RUNTIME_TOKEN}"
      }
    }
  }
}
```

Discover and inspect the upstream server first so its tool inventory is linked to the graph. The gateway resolves the upstream URL and configured headers from the discovered local MCP configuration; clients cannot submit arbitrary upstream URLs. It consumes the AgentTrellis token locally and does not forward it to the upstream. Use the discovered server ID shown by MCP discovery. The gateway currently proxies Streamable HTTP configurations only; legacy SSE and stdio execution are not intercepted.

For each correlated JSON-RPC `tools/call`, the gateway records `CALL_STARTED` and, when it can parse a matching response, `CALL_SUCCEEDED` or `CALL_FAILED`. Response classification is limited to HTTP failures or JSON-RPC/tool-result errors. Large (>256 KiB), streaming or uncorrelated responses may retain only the start event. Tool arguments, result bodies and configured credentials are never written to the graph. Gateway evidence is labelled **gateway-observed** because AgentTrellis sees the request and response at its own proxy boundary; this does not prove that a remote tool performed a filesystem, database, network or other real-world side effect.

Adapters may still submit normalized `SIDE_EFFECT_OBSERVED` events, but these remain **adapter-reported** claims, not independent observations. The gateway does not infer side effects from tool names, descriptions or schemas. GET /api/runtime/monitoring exposes recent runtime events and separate counts for gateway-observed and adapter-reported records. Runtime telemetry and gateway routing are disabled when no token is configured.

Evidence provenance is intentionally split: **gateway-observed** = MCP request/response visible at the AgentTrellis proxy; **adapter-reported** = metadata asserted by an authenticated execution adapter; **heuristic** = schema/description-derived capability and permission inference. Heuristic capability drift and graph-derived blast radius do not prove execution, enforcement, exploitability or side effects.

Continuous MCP monitoring runs in the API process. By default it performs a scan at startup and every five minutes after that. Set AGENT_TRELLIS_MONITOR_INTERVAL_MS to another interval in milliseconds; set it to 0 to disable automatic scheduling. HTTP and SSE MCP servers are reinspected using read-only protocol metadata methods. Local stdio servers are skipped by default. Set AGENT_TRELLIS_MONITOR_STDIO=true only when you explicitly accept automatic local process launches; manual inspection still requires its existing confirmation flow.

Successful inspections compare tool additions/removals and description, input/output schema and annotation changes. Deterministic capability inference is then refreshed. New/removed inferred capability classes, permission-mode or risk increases are recorded as MCP_CAPABILITY_DRIFT evidence. Permission escalation here means a newly inferred permission or higher heuristic risk/mode; it is not proof that a tool was called or is exploitable.

Agent/server associations, tool counts, inferred permission sets and exposure scores are snapshotted. Changes are recorded as MCP_BLAST_RADIUS_CHANGE evidence, including expanded or reduced connected-agent sets. These are graph-derived exposure changes, not evidence that an agent exercised the capability.

GET /api/monitor/status returns scheduler configuration and the last persisted scan. POST /api/monitor/run starts an immediate cycle. GET /api/runtime/monitoring includes schema, capability, blast-radius, runtime-event and monitor-run histories, including separate runtime-event provenance counts.

### Live MCP inspection

Open **MCP discovery** and inspect a discovered server. AgentTrellis negotiates the current protocol or falls back to the legacy initialize handshake, then uses only metadata list methods; it never invokes a tool. Declared capabilities are checked against corresponding list operations. Capabilities not declared by the server are marked **not checked**, because the protocol client does not issue undeclared methods. Tool names, bounded JSON schemas and inspection evidence are linked to the discovered MCP server in Relate.

HTTP and SSE endpoints use the configured headers only in memory. Credentials and command arguments are not persisted or returned to the browser. A local stdio server is launched only after the dashboard's explicit confirmation. The SDK may create a short-lived probe process before the inspection process during automatic protocol negotiation.

## Scripts

- `npm run dev` — start API and Vite development server.
- `npm run build` — type-check the server and build the frontend.
- `npm test` — run unit and API tests.
- `npm run validate:live:mcp` — connect through the runtime gateway to DeepWiki and call its read-only `read_wiki_structure` tool (requires outbound network access).
- `npm start` — run the production server after building.

## Architecture

```text
src/
  server/
    graph.ts       Relate lifecycle, graph model, seed data and Cypher queries
    api.ts         HTTP API and blast-radius simulation
    index.ts       Server entry point
  client/
    App.tsx        Dashboard and graph explorer
    main.tsx       React entry point
    styles.css     Application styling
```

Relate is embedded in the Node.js API process. It is not a mocked graph or a remote Neo4j service. The same persistent graph powers the dashboard, impact traversal and evidence relationships.

## Contest integrity

This repository is a standalone project for the Relate by Neo4j hackathon. It is separate from the existing TrustMesh project. Any reused components or external services will be documented as they are integrated.

## Status

The graph includes local MCP discovery, read-only scheduled HTTP/SSE inspection, opt-in stdio inspection, tool-schema drift detection, heuristic capability/permission drift, historical blast-radius comparisons, an authenticated Streamable HTTP MCP runtime gateway and a separately authenticated adapter-event endpoint. Gateway observations are limited to protocol requests and responses; they do not independently verify downstream side effects. Capability inference does not establish exploitability, and no policy enforcement is claimed.
