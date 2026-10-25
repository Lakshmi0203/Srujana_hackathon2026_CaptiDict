import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

export async function requireAuth(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "A bearer token is required." } });
    }
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (typeof payload !== "object" || !payload.sub) throw new Error("Invalid token payload");
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, role: true }
    });
    if (!user) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "User no longer exists." } });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: { code: "INVALID_TOKEN", message: "Token is invalid or expired." } });
  }
}
