import { Yazio } from "yazio";

export interface YazioApiLike {
  user: {
    getConsumedItems(options: { date: string }): Promise<unknown>;
    getDailySummary(options: { date: string }): Promise<unknown>;
    getWeight(options?: { date?: string }): Promise<unknown>;
    getExercises(options: { date: string }): Promise<unknown>;
    getWaterIntake(options: { date: string }): Promise<unknown>;
    getGoals(options: { date?: string }): Promise<unknown>;
    getSettings(): Promise<unknown>;
    getDietaryPreferences(): Promise<unknown>;
    getSuggestedProducts(options: {
      date: string;
      daytime: "breakfast" | "lunch" | "dinner" | "snack";
    }): Promise<unknown>;
  };
  products: {
    search(options: {
      query: string;
      sex?: "male" | "female";
      countries?: string[];
      locales?: string[];
    }): Promise<unknown>;
    get(id: string): Promise<unknown>;
  };
}

export class YazioClient {
  private readonly client: YazioApiLike;

  constructor(username: string, password: string, client?: YazioApiLike) {
    this.client =
      client ??
      (new Yazio({
        credentials: { username, password },
      }) as unknown as YazioApiLike);
  }

  getConsumedItems(date: string): Promise<unknown> {
    return this.client.user.getConsumedItems({ date });
  }

  getDailySummary(date: string): Promise<unknown> {
    return this.client.user.getDailySummary({ date });
  }

  getWeight(date?: string): Promise<unknown> {
    return this.client.user.getWeight(date ? { date } : undefined);
  }

  getExercises(date: string): Promise<unknown> {
    return this.client.user.getExercises({ date });
  }

  getWaterIntake(date: string): Promise<unknown> {
    return this.client.user.getWaterIntake({ date });
  }

  getGoals(date?: string): Promise<unknown> {
    return this.client.user.getGoals(date ? { date } : {});
  }

  getSettings(): Promise<unknown> {
    return this.client.user.getSettings();
  }

  getDietaryPreferences(): Promise<unknown> {
    return this.client.user.getDietaryPreferences();
  }

  getSuggestedProducts(
    date: string,
    daytime: "breakfast" | "lunch" | "dinner" | "snack",
  ): Promise<unknown> {
    return this.client.user.getSuggestedProducts({ date, daytime });
  }

  searchProducts(options: {
    query: string;
    sex?: "male" | "female";
    countries?: string[];
    locales?: string[];
  }): Promise<unknown> {
    return this.client.products.search(options);
  }

  getProduct(id: string): Promise<unknown> {
    return this.client.products.get(id);
  }
}
