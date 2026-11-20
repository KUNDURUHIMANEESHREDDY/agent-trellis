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

Early implementation. The graph contains a deterministic demo dataset and now supports read-only local MCP configuration discovery. Live MCP handshakes/tool inspection and real execution-evidence ingestion remain planned.
