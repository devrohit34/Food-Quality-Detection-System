import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { z } from "zod";

const freshnessStatusSchema = z.enum([
  "APPEARS_FRESH",
  "QUESTIONABLE",
  "POSSIBLE_SPOILAGE",
  "VISIBLE_SPOILAGE",
  "CANNOT_DETERMINE",
]);

const confidenceSchema = z.number().min(0).max(100);

const percentageResponseSchema: Schema = {
  type: Type.NUMBER,
  minimum: 0,
  maximum: 100,
};

const foodResultResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    isFood: { type: Type.BOOLEAN },
    name: { type: Type.STRING },
    category: { type: Type.STRING },
    emoji: { type: Type.STRING },
    confidence: percentageResponseSchema,
    alternatives: {
      type: Type.ARRAY,
      maxItems: "3",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          confidence: percentageResponseSchema,
        },
        required: ["name", "confidence"],
      },
    },
    items: {
      type: Type.ARRAY,
      maxItems: "8",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          emoji: { type: Type.STRING },
          confidence: percentageResponseSchema,
        },
        required: ["name", "emoji", "confidence"],
      },
    },
    info: { type: Type.STRING },
    nutrition: {
      type: Type.OBJECT,
      properties: {
        calories: { type: Type.STRING },
        fat: { type: Type.STRING },
        protein: { type: Type.STRING },
        carbohydrates: { type: Type.STRING },
      },
      required: ["calories", "fat", "protein", "carbohydrates"],
    },
    uncertain: { type: Type.BOOLEAN },
    warning: { type: Type.STRING },
    freshness: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          enum: [
            "APPEARS_FRESH",
            "QUESTIONABLE",
            "POSSIBLE_SPOILAGE",
            "VISIBLE_SPOILAGE",
            "CANNOT_DETERMINE",
          ],
        },
        visualScore: percentageResponseSchema,
        signs: { type: Type.ARRAY, items: { type: Type.STRING }, maxItems: "10" },
        summary: { type: Type.STRING },
        environment: { type: Type.STRING },
      },
      required: ["status", "visualScore", "signs", "summary", "environment"],
    },
  },
  required: [
    "isFood",
    "name",
    "category",
    "emoji",
    "confidence",
    "alternatives",
    "items",
    "info",
    "nutrition",
    "uncertain",
    "warning",
    "freshness",
  ],
};

const foodResultSchema = z.object({
  isFood: z.boolean(),
  name: z.string().min(1).max(100),
  category: z.string().min(1).max(100),
  emoji: z.string().max(16),
  confidence: confidenceSchema,
  alternatives: z
    .array(z.object({ name: z.string().min(1).max(100), confidence: confidenceSchema }))
    .max(3),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        emoji: z.string().max(16),
        confidence: confidenceSchema,
      }),
    )
    .max(8),
  info: z.string().min(1).max(1200),
  nutrition: z.object({
    calories: z.string().min(1).max(100),
    fat: z.string().min(1).max(100),
    protein: z.string().min(1).max(100),
    carbohydrates: z.string().min(1).max(100),
  }),
  uncertain: z.boolean(),
  warning: z.string().max(500),
  freshness: z.object({
    status: freshnessStatusSchema,
    visualScore: confidenceSchema,
    signs: z.array(z.string().min(1).max(100)).max(10),
    summary: z.string().min(1).max(1000),
    environment: z.string().min(1).max(500),
  }),
});

const SAFETY_DISCLAIMER =
  "Image analysis cannot guarantee food safety. Do not eat food that smells, feels, or looks unsafe.";
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-3.7-flash";
const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 4000;

export type FoodResult = z.infer<typeof foodResultSchema> & {
  detectedItemCount: number;
  safetyDisclaimer: string;
};

export type SensorContext = {
  temperature: number;
  humidity: number;
  avgTemperature: number;
  avgHumidity: number;
  trend: string;
  ageSeconds: number;
} | null;

const PROMPT = `Analyze the attached image for food identification and visible quality. Use only evidence visible in the image; do not invent objects or claim food is safe.
Return one JSON object matching the provided response schema exactly. Use the schema's exact field names, include every required field, and do not wrap the JSON in markdown.
Return:
- isFood, the most likely food name, food category, a suitable emoji, and an honest visual-identification confidence from 0 to 100.
- Up to 3 other plausible classifications of the main item, with confidence percentages.
- Each individual visible food item (including separate instances of the same food), with its own name, emoji and confidence, up to 8 items. Do not count non-food objects.
- A concise image analysis explanation.
- Approximate nutrition for a typical serving of the identified food. Mark estimates as approximate; use "Not available" when no food is identified.
- Whether the image or identification is uncertain and a useful warning if it is.
- A conservative visual freshness status, a 0-100 visual freshness estimate, visible deterioration indicators, and a detailed explanation. These are appearance-only estimates, not safety judgments.
Assess visible signs specific to the food type, such as bruising, mold-like regions, dark spots, shriveling, wilting, browning, leakage, or structural breakdown. Be especially conservative for meat, dairy, seafood, and cooked foods: use CANNOT_DETERMINE if an image cannot establish freshness. Temperature and humidity are context only and must never determine spoilage by themselves.
If no food is visible, set isFood=false, name="No food detected", category="Not food", confidence to a low honest value, use no items or alternatives, set freshness.status="CANNOT_DETERMINE", set visualScore to 0, and explain that no food was identified. Never claim that any food is safe, guaranteed safe, or 100% safe.`;

function analysisError(error: unknown, apiKey: string): Error {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  const message = (rawMessage || "Unknown Gemini API error")
    .replaceAll(apiKey, "[redacted API key]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted API key]")
    .slice(0, 1000);

  console.error("Gemini food image analysis request failed", {
    name: error instanceof Error ? error.name : "UnknownError",
    message,
  });
  return new Error(`Gemini API error: ${message}`);
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  const values = [
    "status" in error ? error.status : undefined,
    "statusCode" in error ? error.statusCode : undefined,
  ];
  for (const value of values) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  }

  return undefined;
}

function isTransientError(error: unknown): boolean {
  const status = httpStatus(error);
  return (
    status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600)
  );
}

function retryDelay(attempt: number): number {
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

async function generateWithRetry(
  client: GoogleGenAI,
  model: string,
  imageMimeType: string,
  imageData: string,
  prompt: string,
  signal?: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.models.generateContent({
        model,
        contents: {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: imageMimeType,
                data: imageData,
              },
            },
          ],
        },
        config: {
          temperature: 0,
          maxOutputTokens: 1200,
          responseMimeType: "application/json",
          responseSchema: foodResultResponseSchema,
        },
        ...(signal ? { abortSignal: signal } : {}),
      });
    } catch (error) {
      if (!isTransientError(error) || attempt >= MAX_RETRIES) throw error;

      const delayMs = retryDelay(attempt);
      console.warn("Transient Gemini request failed; retrying", {
        model,
        status: httpStatus(error),
        retry: attempt + 1,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function identifyFood(
  dataUrl: string,
  sensor: SensorContext,
  signal?: AbortSignal,
): Promise<FoodResult> {
  const apiKey = process.env["GEMINI_API_KEY"]?.trim();
  if (!apiKey) {
    throw new Error(
      "Gemini is not configured. Add GEMINI_API_KEY to the server environment (or your root .env file) and restart the server.",
    );
  }

  const match = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || !match[1] || !match[2]) {
    throw new Error("The uploaded image data is invalid or uses an unsupported format.");
  }

  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { retryOptions: { attempts: 1 } },
  });
  const primaryModel = process.env["GEMINI_MODEL"]?.trim() || DEFAULT_GEMINI_MODEL;
  const fallbackModel =
    process.env["GEMINI_FALLBACK_MODEL"]?.trim() || DEFAULT_GEMINI_FALLBACK_MODEL;
  const sensorDescription = sensor
    ? `Live storage sensor context: ${sensor.temperature.toFixed(1)}°C and ${sensor.humidity.toFixed(1)}% RH. Recent averages: ${sensor.avgTemperature.toFixed(1)}°C and ${sensor.avgHumidity.toFixed(1)}% RH. Trend: ${sensor.trend}. Reading age: ${Math.round(sensor.ageSeconds)} seconds.`
    : "Environmental sensor data is unavailable.";
  let response;
  try {
    response = await generateWithRetry(
      client,
      primaryModel,
      `image/${match[1]}`,
      match[2],
      `${PROMPT}\n\n${sensorDescription}`,
      signal,
    );
  } catch (error) {
    if (!isTransientError(error) || fallbackModel === primaryModel) {
      throw analysisError(error, apiKey);
    }

    console.warn("Gemini primary model exhausted transient retries; trying fallback model", {
      primaryModel,
      fallbackModel,
      status: httpStatus(error),
    });
    try {
      response = await generateWithRetry(
        client,
        fallbackModel,
        `image/${match[1]}`,
        match[2],
        `${PROMPT}\n\n${sensorDescription}`,
        signal,
      );
    } catch (fallbackError) {
      throw analysisError(fallbackError, apiKey);
    }
  }

  const responseText = response.text;
  if (!responseText) {
    throw new Error("Gemini returned an empty analysis response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("Gemini returned an invalid JSON analysis response.");
  }

  const result = foodResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Gemini returned an invalid food analysis: ${result.error.message}`);
  }

  return {
    ...result.data,
    detectedItemCount: result.data.items.length,
    safetyDisclaimer: SAFETY_DISCLAIMER,
  };
}
