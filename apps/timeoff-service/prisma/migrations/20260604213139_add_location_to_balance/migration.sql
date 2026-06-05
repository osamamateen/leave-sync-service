/*
  Warnings:

  - You are about to drop the column `leaveType` on the `balances` table. All the data in the column will be lost.
  - Added the required column `locationId` to the `balances` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_balances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "totalBalance" REAL NOT NULL DEFAULT 0,
    "reservedBalance" REAL NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_balances" ("createdAt", "employeeId", "id", "reservedBalance", "totalBalance", "updatedAt", "version") SELECT "createdAt", "employeeId", "id", "reservedBalance", "totalBalance", "updatedAt", "version" FROM "balances";
DROP TABLE "balances";
ALTER TABLE "new_balances" RENAME TO "balances";
CREATE INDEX "balances_employeeId_idx" ON "balances"("employeeId");
CREATE UNIQUE INDEX "balances_employeeId_locationId_key" ON "balances"("employeeId", "locationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
