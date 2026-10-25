import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional().default(""),
  status: z.enum(["active", "paused", "completed"]).optional().default("active")
});
const updateSchema = createSchema.partial();

router.get("/", asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? "20", 10) || 20));
  const [items, total] = await Promise.all([
    prisma.project.findMany({ where: { ownerId: req.user.id }, orderBy: { updatedAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.project.count({ where: { ownerId: req.user.id } })
  ]);
  res.json({ data: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}));

router.post("/", asyncHandler(async (req, res) => {
  const input = createSchema.parse(req.body);
  const project = await prisma.project.create({ data: { ...input, ownerId: req.user.id } });
  res.status(201).json({ data: project });
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const project = await prisma.project.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
  if (!project) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found." } });
  res.json({ data: project });
}));

router.patch("/:id", asyncHandler(async (req, res) => {
  const input = updateSchema.parse(req.body);
  if (Object.keys(input).length === 0) return res.status(400).json({ error: { code: "EMPTY_UPDATE", message: "Provide at least one field to update." } });
  const existing = await prisma.project.findFirst({ where: { id: req.params.id, ownerId: req.user.id }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found." } });
  const project = await prisma.project.update({ where: { id: existing.id }, data: input });
  res.json({ data: project });
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const result = await prisma.project.deleteMany({ where: { id: req.params.id, ownerId: req.user.id } });
  if (!result.count) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found." } });
  res.status(204).end();
}));

export default router;
