import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/srujana?schema=public";
process.env.JWT_SECRET ??= "test-only-secret-that-is-long-enough-123456";
process.env.CORS_ORIGINS ??= "http://localhost:3000,http://localhost:5173";

const { app } = await import("../src/app.js");

test("health endpoint returns service status", async () => {
  const response = await request(app).get("/api/health");
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, "ok");
});

test("unknown routes return a JSON 404", async () => {
  const response = await request(app).get("/does-not-exist");
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "NOT_FOUND");
});

test("protected projects route rejects missing token", async () => {
  const response = await request(app).get("/api/projects");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "UNAUTHORIZED");
});
