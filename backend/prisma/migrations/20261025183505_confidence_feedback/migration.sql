-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "actualAmount" DOUBLE PRECISION,
ADD COLUMN     "actualDate" VARCHAR(10),
ADD COLUMN     "companyName" VARCHAR(120),
ADD COLUMN     "confidenceSource" VARCHAR(30) NOT NULL DEFAULT 'legacy',
ADD COLUMN     "feedbackOutcome" VARCHAR(30),
ADD COLUMN     "userConfidence" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "Transaction_ownerId_companyName_idx" ON "Transaction"("ownerId", "companyName");
