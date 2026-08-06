import type { FastifyInstance } from "fastify";
import { extractGeOffersFromImage } from "../vision.js";

export async function visionRoutes(app: FastifyInstance) {
  app.post("/api/vision/ge-offers", async (req, reply) => {
    const { image } = req.body as { image?: string };
    if (!image || !image.startsWith("data:image/")) {
      return reply.code(400).send({ error: "expected { image: '<data:image/...;base64,...>' }" });
    }

    try {
      const state = await extractGeOffersFromImage(image);
      return state;
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({
        error: "failed to read the screenshot with the vision model",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
