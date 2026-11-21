import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { isDynamicToolNamespace } from "./acp-client";
import { ANTIGRAVITY_ACP_FLAVOR } from "./acp-flavor-antigravity";
import { visibleDynamicTools } from "./agent/tool-catalog";
import { LocalMcpBridge } from "./local-mcp-bridge";

it("requests eager loading for the OpenBot server in Antigravity ACP sessions", () => {
  expect(ANTIGRAVITY_ACP_FLAVOR.sessionMeta).toMatchObject({
    antigravity: { eagerMcpServers: ["openbot"] },
  });
});

it.each(["antigravity", "default"] as const)(
  "lists core MCP tools with eager metadata only for Antigravity (%s)",
  async (provider) => {
    const bridge = new LocalMcpBridge(provider === "antigravity" ? ANTIGRAVITY_ACP_FLAVOR.mcpToolMetadata : undefined);
    const client = new Client({ name: "bridge-test", version: "1" });
    // The ACP client reads the catalog through the same guard (`#startThread`).
    const catalog: readonly unknown[] = visibleDynamicTools("antigravity");
    const catalogNamespaces = catalog.filter(isDynamicToolNamespace);
    try {
      const session = await Effect.runPromise(
        bridge.createSession(
          "thread",
          catalogNamespaces,
          () => null,
          () => Effect.die("Unexpected tool call"),
        ),
      );
      const server = session.servers.find(({ name }) => name === "openbot");
      if (!server) throw new Error("OpenBot MCP server is missing");
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) },
        }),
      );
      const { tools } = await client.listTools();
      const eager = tools.filter((tool) => tool._meta?.["antigravity/alwaysLoad"] === true).map((tool) => tool.name);
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "list_agents",
          "send_message",
          "routine_report_failure",
          "tool_call",
          "search_memories",
        ]),
      );
      expect(eager.sort()).toEqual(
        provider === "antigravity" ? ["list_agents", "routine_report_failure", "send_message", "tool_call"] : [],
      );
    } finally {
      await client.close();
      await Effect.runPromise(bridge.close());
    }
  },
);
