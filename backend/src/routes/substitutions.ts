import type { FastifyInstance } from "fastify";
import { computeSubstitutionFlags } from "../substitutions.js";

export async function substitutionsRoutes(app: FastifyInstance) {
  app.get("/api/substitutions", async () => {
    return { flags: computeSubstitutionFlags() };
  });
}
