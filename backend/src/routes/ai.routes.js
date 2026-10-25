import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { generateAnswer } from "../services/ai.service.js";

const router = Router();
router.use(requireAuth);
const schema = z.object({ prompt: z.string().trim().min(1).max(4000) });

router.post("/generate", asyncHandler(async (req, res) => {
  const { prompt } = schema.parse(req.body);
  const answer = await generateAnswer(prompt);
  res.json({ data: { answer } });
}));

export default router;
