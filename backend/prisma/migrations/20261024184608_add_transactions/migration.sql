-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "status" VARCHAR(30) NOT NULL DEFAULT 'forecast',
    "key" VARCHAR(100),
    "delayCostPerWeek" DOUBLE PRECISION,
    "canDefer" BOOLEAN NOT NULL DEFAULT false,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Transaction_ownerId_date_idx" ON "Transaction"("ownerId", "date");

-- CreateIndex
CREATE INDEX "Transaction_ownerId_updatedAt_idx" ON "Transaction"("ownerId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
