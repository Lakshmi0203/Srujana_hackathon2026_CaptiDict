import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
router.use(requireAuth);

const transactionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(20),
  amount: z.number().finite().nonnegative(),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD."),
  confidence: z.number().finite().min(0).max(1).optional(),
  companyName: z.string().trim().min(1).max(120).optional(),
  userConfidence: z.number().finite().min(0).max(1).nullable().optional(),
  status: z.string().trim().min(1).max(30).optional().default("forecast"),
  key: z.string().trim().max(100).nullable().optional(),
  delayCostPerWeek: z.number().finite().nonnegative().nullable().optional(),
  canDefer: z.boolean().optional().default(false)
});

const updateSchema = transactionSchema.partial().omit({ companyName: true, userConfidence: true });
const feedbackSchema = z.object({
  outcome: z.enum(["on_time", "late", "failed", "amount_mismatch"]),
  actualDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  actualAmount: z.number().finite().nonnegative().optional()
});
const normalizeCompany = (name) => String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
const clamp = (value) => Math.max(0, Math.min(1, value));
async function companyEstimate(ownerId, companyName, amount, userConfidence, excludeId) {
  const name = normalizeCompany(companyName);
  const rows = name ? await prisma.transaction.findMany({
    where: { ownerId, companyName: { equals: name, mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { amount: true, feedbackOutcome: true }
  }) : [];
  const completed = rows.filter(row => row.feedbackOutcome);
  const points = { on_time: 1, late: 0.6, amount_mismatch: 0.35, failed: 0 };
  // A neutral prior prevents one observation from producing unjustified certainty.
  const reliability = (2 + completed.reduce((sum, row) => sum + points[row.feedbackOutcome], 0)) / (4 + completed.length);
  const amounts = rows.filter(row => row.amount > 0).map(row => row.amount).sort((a,b) => a-b);
  const median = amounts.length ? amounts[Math.floor(amounts.length / 2)] : null;
  const ratio = median && amount > 0 ? Math.max(amount / median, median / amount) : null;
  const consistency = ratio == null ? null : clamp(1 - Math.max(0, ratio - 1) / 4);
  const signals = [{ value: reliability, weight: 0.65 }];
  if (consistency != null) signals.push({ value: consistency, weight: 0.25 });
  if (userConfidence != null) signals.push({ value: userConfidence, weight: 0.10 });
  const weight = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const score = signals.reduce((sum, signal) => sum + signal.value * signal.weight, 0) / weight;
  return { confidence: Math.round(clamp(score) * 100) / 100, evidenceCount: completed.length, companyTransactions: rows.length, limitedHistory: completed.length < 5, components: { historicalReliability: reliability, billConsistency: consistency, userAssessment: userConfidence ?? null }, method: "transparent heuristic; not a calibrated probability" };
}


router.get("/", asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? "100", 10) || 100));
  const where = { ownerId: req.user.id };

  const [items, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: [{ date: "desc" }, { updatedAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.transaction.count({ where })
  ]);

  res.json({
    data: items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const input = transactionSchema.parse(req.body);
  const { companyName, userConfidence, confidence, ...rest } = input;
  const estimate = companyName ? await companyEstimate(req.user.id, companyName, input.amount, userConfidence ?? null) : null;
  const transaction = await prisma.transaction.create({
    data: { ...rest, ownerId: req.user.id, companyName: companyName ? normalizeCompany(companyName) : null,
      userConfidence: userConfidence ?? null, confidence: estimate ? estimate.confidence : (confidence ?? 1),
      confidenceSource: estimate ? "company_heuristic" : "legacy" }
  });
  res.status(201).json({ data: transaction, estimate });
}));

router.post("/confidence/estimate", asyncHandler(async (req, res) => {
  const input = z.object({ companyName: z.string().trim().min(1).max(120), amount: z.number().finite().positive(), userConfidence: z.number().min(0).max(1).nullable().optional() }).parse(req.body);
  res.json({ data: await companyEstimate(req.user.id, input.companyName, input.amount, input.userConfidence ?? null) });
}));

router.post("/:id/feedback", asyncHandler(async (req, res) => {
  const input = feedbackSchema.parse(req.body);
  const existing = await prisma.transaction.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
  if (!existing) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Transaction not found." } });
  if (!existing.companyName) return res.status(400).json({ error: { code: "COMPANY_REQUIRED", message: "Set a company name on new transactions to use learning feedback." } });
  const status = input.outcome === "failed" ? "failed" : existing.type === "inflow" ? "received" : "paid";
  const updated = await prisma.transaction.update({ where: { id: existing.id }, data: {
    feedbackOutcome: input.outcome, actualDate: input.actualDate ?? null, actualAmount: input.actualAmount ?? null, status
  } });
  const estimate = await companyEstimate(req.user.id, existing.companyName, existing.amount, null);
  res.json({ data: updated, nextEstimate: estimate });
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const transaction = await prisma.transaction.findFirst({
    where: { id: req.params.id, ownerId: req.user.id }
  });
  if (!transaction) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "Transaction not found." }
    });
  }
  res.json({ data: transaction });
}));

router.patch("/:id", asyncHandler(async (req, res) => {
  const input = updateSchema.parse(req.body);
  if (Object.keys(input).length === 0) {
    return res.status(400).json({
      error: { code: "EMPTY_UPDATE", message: "Provide at least one field to update." }
    });
  }

  const existing = await prisma.transaction.findFirst({
    where: { id: req.params.id, ownerId: req.user.id },
    select: { id: true }
  });
  if (!existing) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "Transaction not found." }
    });
  }

  const transaction = await prisma.transaction.update({
    where: { id: existing.id },
    data: input
  });
  res.json({ data: transaction });
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const result = await prisma.transaction.deleteMany({
    where: { id: req.params.id, ownerId: req.user.id }
  });
  if (!result.count) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "Transaction not found." }
    });
  }
  res.status(204).end();
}));

export default router;
