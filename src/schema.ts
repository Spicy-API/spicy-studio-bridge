import { z } from "zod";

export const VERSION = "0.2.0";
export const DEFAULT_PORT = 47321;
export const DEFAULT_ORIGINS = ["https://spicyapi.ai", "https://www.spicyapi.ai"] as const;
export const MAX_BODY_BYTES = 512 * 1024;
export const SESSION_MS = 4 * 60 * 60 * 1000;
export const PAIR_MS = 10 * 60 * 1000;
export const REQUEST_MS = 30 * 60 * 1000;
export const MAX_REQUESTS = 20;

const text = (max: number, empty = false) =>
  z
    .string()
    .max(max)
    .refine(
      (s) =>
        (empty || s.trim().length > 0) &&
        !Array.from(s).some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))),
    );
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const requestIdSchema = z.string().uuid();
export const requestInputSchema = z.strictObject({
  kind: z.enum(["drama", "creative"]),
  project: z.strictObject({ id: text(128), title: text(200) }),
  prompt: z.strictObject({ system: text(16000), user: text(48000) }),
});
export type RequestInput = z.infer<typeof requestInputSchema>;

const characterSchema = z.strictObject({
  id: identifier,
  name: text(100),
  description: text(2000),
});
const shotSchema = z.strictObject({
  id: identifier,
  title: text(120),
  description: text(2000),
  prompt: text(4000),
  characterIds: z.array(identifier).max(8),
  durationSeconds: z.number().finite().min(1).max(120),
  dialogue: z.array(z.strictObject({ characterId: identifier, text: text(500) })).max(20),
  narration: text(2000, true).optional(),
});
// Match the Studio contract before applying cast references, IDs, or planned durations.
export const dramaScriptSchema = z
  .strictObject({
    version: z.literal(1),
    title: text(120),
    logline: text(1200),
    style: text(1200),
    characters: z.array(characterSchema).max(8),
    shots: z.array(shotSchema).min(1).max(24),
  })
  .superRefine((script, ctx) => {
    const characters = new Set(script.characters.map((c) => c.id));
    const shots = new Set(script.shots.map((s) => s.id));
    if (characters.size !== script.characters.length || shots.size !== script.shots.length) {
      ctx.addIssue({ code: "custom", message: "Character and scene IDs must be unique." });
    }
    if (script.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) > 600 + 1e-9) {
      ctx.addIssue({ code: "custom", message: "The story must be at most 600 seconds." });
    }
    for (const shot of script.shots) {
      if (
        new Set(shot.characterIds).size !== shot.characterIds.length ||
        shot.characterIds.some((id) => !characters.has(id)) ||
        shot.dialogue.some((line) => !shot.characterIds.includes(line.characterId))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Scene characters and dialogue must reference the cast.",
        });
      }
    }
    if (JSON.stringify(script).length > 256000) {
      ctx.addIssue({
        code: "custom",
        message: "The story is too large. Shorten the dialogue or scenes.",
      });
    }
  });
export const resultSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("drama"), script: dramaScriptSchema }),
  z.strictObject({ type: z.literal("text"), text: text(12000) }),
]);
export type CreativeResult = z.infer<typeof resultSchema>;
export const statusSchema = z.enum(["queued", "working", "completed", "failed", "cancelled"]);
export const requestSchema = requestInputSchema.extend({
  id: requestIdSchema,
  status: statusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  expiresAt: z.number(),
  result: resultSchema.optional(),
  error: z.strictObject({ code: text(80), message: text(500) }).optional(),
});
export type CreativeRequest = z.infer<typeof requestSchema>;

export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Use a complete website origin.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    value.includes("*") ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  ) {
    throw new Error("Allow one exact HTTPS origin, or a local development origin, without a path.");
  }
  return url.origin;
}
