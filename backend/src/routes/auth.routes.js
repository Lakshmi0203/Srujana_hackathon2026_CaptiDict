import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(10).max(72)
});
const loginSchema = z.object({
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(1).max(72)
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(10).max(72)
}).refine(input => input.currentPassword !== input.newPassword, {
  message: "The new password must be different from the current password.",
  path: ["newPassword"]
});

const publicUser = user => ({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt });

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN, issuer: "srujana-api", audience: "srujana-client" });
}

router.post("/register", asyncHandler(async (req, res) => {
  const input = registerSchema.parse(req.body);
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) return res.status(409).json({ error: { code: "EMAIL_EXISTS", message: "An account with this email already exists." } });
  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await prisma.user.create({
    data: { name: input.name, email: input.email, passwordHash },
    select: { id: true, name: true, email: true, role: true, createdAt: true }
  });
  res.status(201).json({ data: { user, token: issueToken(user) } });
}));

router.post("/login", asyncHandler(async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const valid = user && await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." } });
  res.json({ data: { user: publicUser(user), token: issueToken(user) } });
}));


router.post("/change-password", requireAuth, asyncHandler(async (req, res) => {
  const input = changePasswordSchema.parse(req.body);

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, passwordHash: true }
  });

  if (!user) {
    return res.status(404).json({
      error: { code: "USER_NOT_FOUND", message: "The account could not be found." }
    });
  }

  const currentPasswordIsValid = await bcrypt.compare(
    input.currentPassword,
    user.passwordHash
  );

  if (!currentPasswordIsValid) {
    return res.status(400).json({
      error: { code: "CURRENT_PASSWORD_INCORRECT", message: "Your current password is incorrect." }
    });
  }

  const passwordHash = await bcrypt.hash(input.newPassword, 12);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash }
  });

  return res.json({
    data: { message: "Password changed successfully." }
  });
}));

router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, name: true, email: true, role: true, createdAt: true, updatedAt: true } });
  res.json({ data: { user } });
}));

export default router;