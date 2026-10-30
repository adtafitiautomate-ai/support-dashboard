import { z } from "zod";

export const MAX_AUDIENCE = 10_000;

/** Who a campaign goes to (validated input for the campaign APIs). */
export const AudienceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("selected"), contactIds: z.array(z.guid()).min(1).max(MAX_AUDIENCE) }),
  z.object({ mode: z.literal("waiting"), clear: z.boolean().optional() }), // clear: take them off the list once sent
  z.object({ mode: z.literal("id_untold") }),
  z.object({ mode: z.literal("id_arrived") }),
  z.object({ mode: z.literal("appointments"), date: z.iso.date() }),
]);
