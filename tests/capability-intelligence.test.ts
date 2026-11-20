import { describe, expect, it } from "vitest";
import { inferToolCapabilities } from "../src/server/capability-intelligence";

describe("MCP tool capability inference", () => {
  it("combines tool name and schema evidence for filesystem read access", () => {
    const result = inferToolCapabilities({
      name: "read_file",
      description: "Read a file from the configured workspace.",
      inputSchema: {
        type: "object",
        properties: { file_path: { type: "string", description: "Path to the file" } },
        required: ["file_path"]
      }
    });

    expect(result.capabilities.map((item) => item.key)).toContain("filesystem_read");
    const finding = result.capabilities.find((item) => item.key === "filesystem_read");
    expect(finding?.confidence).toBeGreaterThan(0.7);
    expect(finding?.evidence.map((item) => item.source)).toContain("input_schema");
    expect(result.permissionMode).toBe("READ");
    expect(finding?.key).toBe("filesystem_read");
    expect(result.capabilities.map((item) => item.key)).not.toContain("email_send");
  });

  it("identifies destructive database operations and annotation mismatches", () => {
    const result = inferToolCapabilities({
      name: "delete_database_record",
      description: "Delete a record from the database.",
      inputSchema: {
        type: "object",
        properties: { record_id: { type: "string" }, table: { type: "string" } }
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    });

    expect(result.capabilities.map((item) => item.key)).toContain("database_write");
    expect(result.destructiveObserved).toBe(true);
    expect(result.permissionMode).toBe("DESTRUCTIVE");
    expect(result.riskLevel).toBe("CRITICAL");
    expect(result.comparisons.filter((item) => item.status === "mismatch")).toHaveLength(2);
  });

  it("identifies sensitive customer and credential fields", () => {
    const customer = inferToolCapabilities({
      name: "get_customer_profile",
      inputSchema: {
        type: "object",
        properties: {
          customer_id: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string" }
        }
      }
    });
    const secret = inferToolCapabilities({
      name: "get_secret",
      description: "Retrieve an API token from the secret store.",
      inputSchema: { type: "object", properties: { secret_name: { type: "string" } } }
    });

    expect(customer.capabilities.map((item) => item.key)).toContain("customer_data_read");
    expect(secret.capabilities.map((item) => item.key)).toContain("credential_access");
    expect(secret.riskLevel).toBe("CRITICAL");
  });

  it("does not infer a concrete capability from an opaque tool", () => {
    const result = inferToolCapabilities({
      name: "perform_operation",
      description: "Performs an operation.",
      inputSchema: { type: "object", properties: { value: { type: "string" } } }
    });
    expect(result.capabilities).toHaveLength(0);
    expect(result.riskLevel).toBe("UNKNOWN");
    expect(result.permissionMode).toBe("UNKNOWN");
  });
});
