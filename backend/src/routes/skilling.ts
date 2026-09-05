import type { FastifyInstance } from "fastify";
import {
  getTrainingMethods,
  refreshSkillTraining,
  skillTrainingPopulated,
  TRAINABLE_SKILLS,
} from "../skillTraining.js";

export async function skillingRoutes(app: FastifyInstance) {
  app.get("/api/skilling/methods", async (req) => {
    const query = req.query as { skills?: string };
    // A cold cache means seventeen wiki requests. Doing them inline is slow once and correct,
    // which beats returning an empty board that looks like a broken feature.
    if (!skillTrainingPopulated()) await refreshSkillTraining();
    const skills = query.skills
      ? query.skills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const result = await getTrainingMethods(skills);
    return { skills: TRAINABLE_SKILLS, ...result };
  });

  app.post("/api/skilling/refresh", async (req) => {
    // Fire and forget, same shape as the money-maker and index refreshes: seventeen requests is
    // longer than a caller should hold a connection open for.
    void refreshSkillTraining(true).catch((err) => {
      req.log.error({ err }, "skill training refresh failed");
    });
    return { started: true };
  });
}
