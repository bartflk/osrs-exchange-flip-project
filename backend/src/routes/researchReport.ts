import type { FastifyInstance } from "fastify";
import { getResearchReport, type ReportPeriod } from "../researchReport.js";

export async function researchReportRoutes(app: FastifyInstance) {
  app.get("/api/research-report", async (req, reply) => {
    const { period, refresh } = req.query as { period?: string; refresh?: string };
    if (period !== "daily" && period !== "weekly") {
      return reply.code(400).send({ error: "period must be 'daily' or 'weekly'" });
    }
    try {
      return await getResearchReport(period as ReportPeriod, refresh === "true");
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "failed to generate research report from the model" });
    }
  });
}
