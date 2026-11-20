import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverMcpConfigurations } from "../src/server/discovery";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

describe("discoverMcpConfigurations", () => {
  it("discovers supported host configurations without retaining credential values", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-discovery-"));
    const homeDir = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const workspaceTwo = path.join(root, "workspace-two");
    const xdg = path.join(homeDir, ".config");
    const copilotHome = path.join(homeDir, ".copilot");

    writeJson(path.join(xdg, "Claude", "claude_desktop_config.json"), {
      mcpServers: {
        remoteDocs: {
          type: "http",
          url: "https://user:password@example.test/mcp?token=query-secret#fragment",
          headers: { Authorization: "header-secret" }
        }
      }
    });
    writeJson(path.join(homeDir, ".claude.json"), {
      mcpServers: { userTool: { command: "node", args: ["server.js"] } },
      projects: {
        [path.resolve(workspace)]: {
          mcpServers: { projectTool: { command: "python", args: ["server.py"] } }
        },
        [path.resolve(workspaceTwo)]: {
          mcpServers: { projectTool: { command: "python", args: ["other-server.py"] } }
        }
      }
    });
    writeJson(path.join(homeDir, ".cursor", "mcp.json"), {
      mcpServers: {
        cursorTool: { command: "npx", args: ["-y", "private-package"], env: { API_TOKEN: "env-secret" } }
      }
    });
    writeJson(path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"), {
      mcpServers: { windsurfTool: { command: "node", args: ["index.js"] } }
    });
    writeJson(path.join(copilotHome, "mcp-config.json"), {
      mcpServers: { copilotTool: { type: "http", url: "https://copilot.example.test/mcp" } }
    });
    writeJson(path.join(workspace, ".mcp.json"), {
      mcpServers: { workspaceTool: { command: "uvx", args: ["sample-server"] } }
    });
    writeJson(path.join(workspace, ".cursor", "mcp.json"), {
      mcpServers: { cursorWorkspaceTool: { command: "node", args: ["workspace.js"] } }
    });

    const result = discoverMcpConfigurations({
      homeDir,
      platform: "linux",
      env: { XDG_CONFIG_HOME: xdg, COPILOT_HOME: copilotHome },
      workspaceRoots: [workspace, workspaceTwo]
    });

    expect(result.scannedConfigPaths).toHaveLength(7);
    expect(result.servers.map((server) => server.name).sort()).toEqual([
      "copilotTool",
      "cursorTool",
      "cursorWorkspaceTool",
      "projectTool",
      "remoteDocs",
      "userTool",
      "windsurfTool",
      "workspaceTool"
    ]);
    expect(result.servers.find((server) => server.name === "remoteDocs")?.endpoint)
      .toBe("https://example.test/mcp");
    expect(result.servers.find((server) => server.name === "cursorTool")?.argumentCount).toBe(2);
    const projectServers = result.servers.filter((server) => server.name === "projectTool");
    expect(projectServers).toHaveLength(2);
    expect(new Set(projectServers.map((server) => server.id)).size).toBe(2);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("env-secret");
    expect(serialized).not.toContain("private-package");
  });

  it("reports malformed configuration without exposing its contents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-invalid-"));
    const homeDir = path.join(root, "home");
    const cursorConfig = path.join(homeDir, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(cursorConfig), { recursive: true });
    fs.writeFileSync(cursorConfig, "{not-json secret-value}", "utf8");

    const result = discoverMcpConfigurations({
      homeDir,
      platform: "linux",
      env: {},
      workspaceRoots: []
    });

    expect(result.servers).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});
