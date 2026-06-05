/*
  Warnings:

  - You are about to drop the column `leaveType` on the `ledger` table. All the data in the column will be lost.
  - You are about to drop the column `leaveType` on the `reconciliation_logs` table. All the data in the column will be lost.
  - You are about to drop the column `leaveType` on the `requests` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ledger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "entryType" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "balanceAfter" REAL,
    "requestId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "requests" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ledger" ("amount", "balanceAfter", "createdAt", "employeeId", "entryType", "id", "note", "requestId") SELECT "amount", "balanceAfter", "createdAt", "employeeId", "entryType", "id", "note", "requestId" FROM "ledger";
DROP TABLE "ledger";
ALTER TABLE "new_ledger" RENAME TO "ledger";
CREATE INDEX "ledger_employeeId_idx" ON "ledger"("employeeId");
CREATE INDEX "ledger_requestId_idx" ON "ledger"("requestId");
CREATE TABLE "new_reconciliation_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "previousBalance" REAL NOT NULL,
    "correctedBalance" REAL NOT NULL,
    "drift" REAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'FULL_SYNC',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_reconciliation_logs" ("correctedBalance", "createdAt", "drift", "employeeId", "id", "previousBalance", "source") SELECT "correctedBalance", "createdAt", "drift", "employeeId", "id", "previousBalance", "source" FROM "reconciliation_logs";
DROP TABLE "reconciliation_logs";
ALTER TABLE "new_reconciliation_logs" RENAME TO "reconciliation_logs";
CREATE INDEX "reconciliation_logs_employeeId_idx" ON "reconciliation_logs"("employeeId");
CREATE TABLE "new_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "days" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_requests" ("createdAt", "days", "employeeId", "id", "idempotencyKey", "locationId", "reason", "status", "updatedAt") SELECT "createdAt", "days", "employeeId", "id", "idempotencyKey", "locationId", "reason", "status", "updatedAt" FROM "requests";
DROP TABLE "requests";
ALTER TABLE "new_requests" RENAME TO "requests";
CREATE UNIQUE INDEX "requests_idempotencyKey_key" ON "requests"("idempotencyKey");
CREATE INDEX "requests_employeeId_locationId_idx" ON "requests"("employeeId", "locationId");
CREATE INDEX "requests_status_idx" ON "requests"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
