import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp-server.js";
import { SecretRedactor } from "../src/security/redaction.js";
import type { FitnessToolService } from "../src/tools/fitness-tools.js";

const EXPECTED_TOOLS = [
  "fitness_daily_summary",
  "fitness_exercise_progress",
  "fitness_muscle_volume",
  "fitness_training_nutrition_summary",
  "fitness_weekly_summary",
  "lyfta_get_exercise_progress",
  "lyfta_list_clients",
  "lyfta_list_exercises",
  "lyfta_list_workout_summaries",
  "lyfta_list_workouts",
  "lyfta_search_exercise_library",
  "yazio_get_consumed_items",
  "yazio_get_daily_summary",
  "yazio_get_dietary_preferences",
  "yazio_get_exercises",
  "yazio_get_goals",
  "yazio_get_product",
  "yazio_get_settings",
  "yazio_get_suggested_products",
  "yazio_get_water_intake",
  "yazio_get_weight",
  "yazio_search_products",
] as const;

function fitnessStub(): FitnessToolService {
  const empty = (): Promise<unknown> => Promise.resolve({});
  return {
    dailySummary: empty,
    weeklySummary: empty,
    trainingNutritionSummary: empty,
    muscleVolume: empty,
    exerciseProgress: empty,
  };
}

describe("MCP tool catalogue", () => {
  it("exposes the exact 22 read-only tools over a real in-memory MCP connection", async () => {
    const server = createMcpServer({
      fitness: fitnessStub(),
      redactor: new SecretRedactor([]),
    });
    const client = new Client({ name: "fitness-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const { tools } = await client.listTools();

      expect(tools).toHaveLength(22);
      expect(tools.map(({ name }) => name).sort()).toEqual([...EXPECTED_TOOLS]);
      expect(new Set(tools.map(({ name }) => name)).size).toBe(22);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.description).toEqual(expect.any(String));
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        });
      }

      const result = await client.callTool({
        name: "fitness_daily_summary",
        arguments: { date: "2026-08-11" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({});
      expect(result.content).toEqual([{ type: "text", text: "{}" }]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
