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

The ingestion validator deliberately rejects raw arguments, results, credentials, headers and environment values. It stores only normalized metadata and hashes for idempotency; it does not independently inspect tool inputs or outputs. GET /api/runtime/monitoring exposes the recent event ledger and schema-drift history. Runtime ingestion is disabled when no token is configured. Events are trusted-adapter reports, not proof of exploitability.

Schema drift is detected when a successful Inspect server operation is repeated after a tool catalogue changes. It records additions, removals, descriptions, input/output schema and annotation changes, and automatically refreshes capability inference. This is inspection-triggered monitoring, not a background polling service. A runtime adapter must be wired into the agent execution path to report actual calls and effects.

### Live MCP inspection

Open **MCP discovery** and inspect a discovered server. AgentTrellis negotiates the current protocol or falls back to the legacy initialize handshake, then uses only metadata list methods; it never invokes a tool. Declared capabilities are checked against corresponding list operations. Capabilities not declared by the server are marked **not checked**, because the protocol client does not issue undeclared methods. Tool names, bounded JSON schemas and inspection evidence are linked to the discovered MCP server in Relate.

HTTP and SSE endpoints use the configured headers only in memory. Credentials and command arguments are not persisted or returned to the browser. A local stdio server is launched only after the dashboard's explicit confirmation. The SDK may create a short-lived probe process before the inspection process during automatic protocol negotiation.

## Scripts

- `npm run dev` — start API and Vite development server.
- `npm run build` — type-check the server and build the frontend.
- `npm test` — run unit and API tests.
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

Early implementation. The graph includes deterministic demo data, local MCP discovery, user-triggered live inspection, deterministic schema-derived capability intelligence, exposure scoring, explicit agent-to-server association, inspection-triggered schema drift detection and authenticated runtime event ingestion. An execution adapter still needs to be integrated with each agent runtime; periodic inspection scheduling and continuous policy enforcement are not yet implemented.
