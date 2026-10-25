export function notFound(req, res) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found.` } });
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err?.name === "ZodError") {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Request validation failed.", details: err.issues } });
  }
  if (err?.code === "P2002") {
    return res.status(409).json({ error: { code: "CONFLICT", message: "A record with that value already exists." } });
  }
  if (err?.code === "P2025") {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Record not found." } });
  }
  console.error(err);
  const status = Number.isInteger(err.status) ? err.status : 500;
  res.status(status).json({
    error: {
      code: err.codeName || "INTERNAL_ERROR",
      message: status >= 500 && process.env.NODE_ENV === "production" ? "An unexpected error occurred." : (err.message || "An unexpected error occurred.")
    }
  });
}
