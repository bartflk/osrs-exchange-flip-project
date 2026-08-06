import type { FastifyInstance } from "fastify";
import { getPlayerSnapshot, PlayerNotFoundError, type PlayerSnapshot } from "../wiseoldman.js";
import { computeSessionPlan } from "../sessionPlanner.js";

// DESIGN.md §14.13: cache per username -- skills/bosses don't change meaningfully minute to
// minute, and there's no reason to hit WOM's API on every render of a settings/player panel.
// Same TTL-map pattern as routes/llm.ts's explanation cache. Shared by both routes below so the
// session-plan endpoint doesn't pay for a separate WOM call right after the player panel already
// fetched the same username.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: PlayerSnapshot }>();

async function getCachedSnapshot(username: string): Promise<PlayerSnapshot> {
  const key = username.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;
  const snapshot = await getPlayerSnapshot(username);
  cache.set(key, { at: Date.now(), data: snapshot });
  return snapshot;
}

export async function playerRoutes(app: FastifyInstance) {
  app.get("/api/player/:username", async (req, reply) => {
    const { username } = req.params as { username: string };
    try {
      const snapshot = await getCachedSnapshot(username);
      return snapshot;
    } catch (err) {
      if (err instanceof PlayerNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      req.log.error(err);
      return reply.code(502).send({ error: "failed to fetch player from Wise Old Man" });
    }
  });

  // DESIGN.md §14.15: bankstand/session planner -- filters activities.ts down to what this
  // player's skill levels actually unlock, with live GP profit where computable.
  app.get("/api/session-plan", async (req, reply) => {
    const query = req.query as { username?: string; minutes?: string };
    if (!query.username) {
      return reply.code(400).send({ error: "username is required" });
    }
    const minutes = query.minutes ? Number(query.minutes) : 30;

    try {
      const snapshot = await getCachedSnapshot(query.username);
      const plan = computeSessionPlan(snapshot.skills, minutes);
      return { username: snapshot.displayName, availableMinutes: minutes, plan };
    } catch (err) {
      if (err instanceof PlayerNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      req.log.error(err);
      return reply.code(502).send({ error: "failed to build session plan" });
    }
  });
}
