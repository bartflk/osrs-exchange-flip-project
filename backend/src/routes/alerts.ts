import type { FastifyInstance } from "fastify";
import { getRecentAlerts } from "../alerts.js";

export async function alertsRoutes(app: FastifyInstance) {
  app.get("/api/alerts", async () => {
    return { alerts: getRecentAlerts() };
  });
}
