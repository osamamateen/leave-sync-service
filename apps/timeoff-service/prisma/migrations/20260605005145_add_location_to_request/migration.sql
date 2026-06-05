/*
  Warnings:

  - Added the required column `locationId` to the `requests` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "leaveType" TEXT NOT NULL,
    "days" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_requests" ("createdAt", "days", "employeeId", "id", "idempotencyKey", "leaveType", "reason", "status", "updatedAt") SELECT "createdAt", "days", "employeeId", "id", "idempotencyKey", "leaveType", "reason", "status", "updatedAt" FROM "requests";
DROP TABLE "requests";
ALTER TABLE "new_requests" RENAME TO "requests";
CREATE UNIQUE INDEX "requests_idempotencyKey_key" ON "requests"("idempotencyKey");
CREATE INDEX "requests_employeeId_locationId_idx" ON "requests"("employeeId", "locationId");
CREATE INDEX "requests_status_idx" ON "requests"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
