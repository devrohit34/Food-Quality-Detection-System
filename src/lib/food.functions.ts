import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { identifyFood } from "./ai-gateway.server";

export const identify = createServerFn({ method: "POST" })
  .validator((d) =>
    z
      .object({
        image: z
          .string()
          .max(8_000_000, "Image is too large (max ~5MB).")
          .regex(
            /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/,
            "Unsupported image format or invalid image data.",
          ),
        sensor: z
          .object({
            temperature: z.number().min(-40).max(85),
            humidity: z.number().min(0).max(100),
            avgTemperature: z.number().min(-40).max(85),
            avgHumidity: z.number().min(0).max(100),
            trend: z.string().max(200),
            ageSeconds: z.number().min(0),
          })
          .nullable()
          .default(null),
      })
      .parse(d),
  )
  .handler(async ({ data }) => identifyFood(data.image, data.sensor));
