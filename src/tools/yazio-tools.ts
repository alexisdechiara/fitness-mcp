import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isDateOnly } from "../domain/dates.js";
import type { SecretRedactor } from "../security/redaction.js";
import { runTool, unavailableService } from "./result.js";

export type YazioDaytime = "breakfast" | "lunch" | "dinner" | "snack";

export interface YazioToolClient {
  getConsumedItems(date: string): Promise<unknown>;
  getDailySummary(date: string): Promise<unknown>;
  getWeight(date?: string): Promise<unknown>;
  getExercises(date: string): Promise<unknown>;
  getWaterIntake(date: string): Promise<unknown>;
  getGoals(date?: string): Promise<unknown>;
  getSettings(): Promise<unknown>;
  getDietaryPreferences(): Promise<unknown>;
  getSuggestedProducts(date: string, daytime: YazioDaytime): Promise<unknown>;
  searchProducts(options: {
    query: string;
    sex?: "male" | "female";
    countries?: string[];
    locales?: string[];
  }): Promise<unknown>;
  getProduct(id: string): Promise<unknown>;
}

export interface YazioToolsDependencies {
  yazio?: YazioToolClient;
  redactor: SecretRedactor;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const date = z
  .string()
  .refine(isDateOnly, "Date must use the YYYY-MM-DD format.")
  .describe("Civil date in YYYY-MM-DD format");

export function registerYazioTools(server: McpServer, dependencies: YazioToolsDependencies): void {
  const { yazio, redactor } = dependencies;
  const invoke = (operation: string, call: (client: YazioToolClient) => Promise<unknown>) =>
    runTool(redactor, operation, async () => {
      if (!yazio) throw unavailableService("Yazio");
      return call(yazio);
    });

  server.registerTool(
    "yazio_get_daily_summary",
    {
      title: "Get Yazio daily summary",
      description: "Get the Yazio nutrition summary for one date, including calories and macronutrients.",
      inputSchema: { date },
      annotations: READ_ONLY,
    },
    async ({ date: requestedDate }) =>
      invoke("Yazio get daily summary", (client) => client.getDailySummary(requestedDate)),
  );

  server.registerTool(
    "yazio_get_consumed_items",
    {
      title: "Get Yazio consumed items",
      description: "Get food entries consumed on one date.",
      inputSchema: { date },
      annotations: READ_ONLY,
    },
    async ({ date: requestedDate }) =>
      invoke("Yazio get consumed items", (client) => client.getConsumedItems(requestedDate)),
  );

  server.registerTool(
    "yazio_get_weight",
    {
      title: "Get Yazio weight",
      description: "Get weight data, optionally scoped to one date when supported by the upstream API.",
      inputSchema: { date: date.optional() },
      annotations: READ_ONLY,
    },
    async ({ date: requestedDate }) =>
      invoke("Yazio get weight", (client) => client.getWeight(requestedDate)),
  );

  server.registerTool(
    "yazio_get_exercises",
    {
      title: "Get Yazio exercises",
      description: "Get exercises recorded by Yazio for one date.",
      inputSchema: { date },
      annotations: READ_ONLY,
    },
    async ({ date: requestedDate }) =>
      invoke("Yazio get exercises", (client) => client.getExercises(requestedDate)),
  );

  server.registerTool(
    "yazio_get_water_intake",
    {
      title: "Get Yazio water intake",
      description: "Get water-intake data for one date.",
      inputSchema: { date },
      annotations: READ_ONLY,
    },
    async ({ date: requestedDate }) =>
      invoke("Yazio get water intake", (client) => client.getWaterIntake(requestedDate)),
  );

  server.registerTool(
    "yazio_get_goals",
    {
      title: "Get Yazio goals",
      description: "Get nutrition and fitness goals, optionally for one date.",
      inputSchema: { date: date.optional() },
      annotations: READ_ONLY,
    },
    async ({ date: requestedDate }) =>
      invoke("Yazio get goals", (client) => client.getGoals(requestedDate)),
  );

  server.registerTool(
    "yazio_get_settings",
    {
      title: "Get Yazio settings",
      description: "Get the account's Yazio settings and preferences.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => invoke("Yazio get settings", (client) => client.getSettings()),
  );

  server.registerTool(
    "yazio_search_products",
    {
      title: "Search Yazio products",
      description:
        "Search the Yazio food-product database. Country codes and locales are passed through to the upstream client.",
      inputSchema: {
        query: z.string().trim().min(1).max(300),
        sex: z.enum(["male", "female"]).optional(),
        countries: z.array(z.string().trim().length(2)).max(20).optional(),
        locales: z.array(z.string().trim().length(5)).max(20).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ query, sex, countries, locales }) =>
      invoke("Yazio search products", (client) =>
        client.searchProducts({
          query,
          ...(sex !== undefined ? { sex } : {}),
          ...(countries !== undefined ? { countries } : {}),
          ...(locales !== undefined ? { locales } : {}),
        }),
      ),
  );

  server.registerTool(
    "yazio_get_product",
    {
      title: "Get a Yazio product",
      description: "Get detailed nutrition information for one Yazio product ID.",
      inputSchema: { id: z.string().uuid() },
      annotations: READ_ONLY,
    },
    async ({ id }) => invoke("Yazio get product", (client) => client.getProduct(id)),
  );

  server.registerTool(
    "yazio_get_dietary_preferences",
    {
      title: "Get Yazio dietary preferences",
      description: "Get dietary preferences and restrictions from Yazio.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      invoke("Yazio get dietary preferences", (client) => client.getDietaryPreferences()),
  );

  server.registerTool(
    "yazio_get_suggested_products",
    {
      title: "Get Yazio suggested products",
      description: "Get Yazio product suggestions for a date and meal.",
      inputSchema: {
        date,
        daytime: z.enum(["breakfast", "lunch", "dinner", "snack"]),
      },
      annotations: READ_ONLY,
    },
    async ({ date: requestedDate, daytime }) =>
      invoke("Yazio get suggested products", (client) =>
        client.getSuggestedProducts(requestedDate, daytime),
      ),
  );
}
