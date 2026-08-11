import { describe, expect, it, vi } from "vitest";
import { YazioClient, type YazioApiLike } from "../src/clients/yazio.js";

function fakeApi(): YazioApiLike {
  return {
    user: {
      getConsumedItems: vi.fn(async (options) => ({ operation: "consumed", options })),
      getDailySummary: vi.fn(async (options) => ({ operation: "summary", options })),
      getWeight: vi.fn(async (options) => ({ operation: "weight", options })),
      getExercises: vi.fn(async (options) => ({ operation: "exercises", options })),
      getWaterIntake: vi.fn(async (options) => ({ operation: "water", options })),
      getGoals: vi.fn(async (options) => ({ operation: "goals", options })),
      getSettings: vi.fn(async () => ({ operation: "settings" })),
      getDietaryPreferences: vi.fn(async () => ({ operation: "preferences" })),
      getSuggestedProducts: vi.fn(async (options) => ({ operation: "suggestions", options })),
    },
    products: {
      search: vi.fn(async (options) => ({ operation: "search", options })),
      get: vi.fn(async (id) => ({ operation: "product", id })),
    },
  };
}

describe("YazioClient", () => {
  it("delegates every read operation to the verified yazio library function", async () => {
    const api = fakeApi();
    const client = new YazioClient("not-used", "not-used", api);

    await expect(client.getConsumedItems("2026-08-01")).resolves.toMatchObject({ operation: "consumed" });
    await expect(client.getDailySummary("2026-08-01")).resolves.toMatchObject({ operation: "summary" });
    await client.getWeight("2026-08-01");
    await client.getExercises("2026-08-01");
    await client.getWaterIntake("2026-08-01");
    await client.getGoals("2026-08-01");
    await client.getSettings();
    await client.getDietaryPreferences();
    await client.getSuggestedProducts("2026-08-01", "lunch");
    await client.searchProducts({
      query: "tofu",
      sex: "female",
      countries: ["FR"],
      locales: ["fr_FR"],
    });
    await client.getProduct("4ceff6e9-78ce-441b-964a-22e81c1dee92");

    expect(api.user.getConsumedItems).toHaveBeenCalledWith({ date: "2026-08-01" });
    expect(api.user.getDailySummary).toHaveBeenCalledWith({ date: "2026-08-01" });
    expect(api.user.getWeight).toHaveBeenCalledWith({ date: "2026-08-01" });
    expect(api.user.getExercises).toHaveBeenCalledWith({ date: "2026-08-01" });
    expect(api.user.getWaterIntake).toHaveBeenCalledWith({ date: "2026-08-01" });
    expect(api.user.getGoals).toHaveBeenCalledWith({ date: "2026-08-01" });
    expect(api.user.getSuggestedProducts).toHaveBeenCalledWith({
      date: "2026-08-01",
      daytime: "lunch",
    });
    expect(api.products.search).toHaveBeenCalledWith({
      query: "tofu",
      sex: "female",
      countries: ["FR"],
      locales: ["fr_FR"],
    });
    expect(api.products.get).toHaveBeenCalledWith("4ceff6e9-78ce-441b-964a-22e81c1dee92");
  });

  it("preserves the no-date variants supported by the upstream client", async () => {
    const api = fakeApi();
    const client = new YazioClient("not-used", "not-used", api);

    await client.getWeight();
    await client.getGoals();

    expect(api.user.getWeight).toHaveBeenCalledWith(undefined);
    expect(api.user.getGoals).toHaveBeenCalledWith({});
  });
});
