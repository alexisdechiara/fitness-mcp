import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SecretRedactor } from "./security/redaction.js";
import {
  registerFitnessTools,
  type FitnessToolService,
} from "./tools/fitness-tools.js";
import { registerLyftaTools, type LyftaToolClient } from "./tools/lyfta-tools.js";
import { registerYazioTools, type YazioToolClient } from "./tools/yazio-tools.js";

export interface McpServerDependencies {
  lyfta?: LyftaToolClient;
  yazio?: YazioToolClient;
  fitness: FitnessToolService;
  redactor: SecretRedactor;
}

/** Create an isolated, fully configured server. The HTTP layer intentionally calls
 * this once per stateless Streamable HTTP request.
 */
export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const server = new McpServer({
    name: "fitness-mcp",
    version: "0.1.0",
  });

  registerLyftaTools(server, dependencies);
  registerYazioTools(server, dependencies);
  registerFitnessTools(server, dependencies);

  return server;
}
