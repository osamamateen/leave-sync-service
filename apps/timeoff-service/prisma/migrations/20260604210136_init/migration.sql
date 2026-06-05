-- CreateTable
CREATE TABLE "balances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "leaveType" TEXT NOT NULL,
    "totalBalance" REAL NOT NULL DEFAULT 0,
    "reservedBalance" REAL NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "leaveType" TEXT NOT NULL,
    "days" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ledger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "leaveType" TEXT NOT NULL,
    "entryType" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "balanceAfter" REAL,
    "requestId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "requests" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "reconciliation_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "leaveType" TEXT NOT NULL,
    "previousBalance" REAL NOT NULL,
    "correctedBalance" REAL NOT NULL,
    "drift" REAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'FULL_SYNC',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "balances_employeeId_idx" ON "balances"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "balances_employeeId_leaveType_key" ON "balances"("employeeId", "leaveType");

-- CreateIndex
CREATE UNIQUE INDEX "requests_idempotencyKey_key" ON "requests"("idempotencyKey");

-- CreateIndex
CREATE INDEX "requests_employeeId_idx" ON "requests"("employeeId");

-- CreateIndex
CREATE INDEX "requests_status_idx" ON "requests"("status");

-- CreateIndex
CREATE INDEX "ledger_employeeId_idx" ON "ledger"("employeeId");

-- CreateIndex
CREATE INDEX "ledger_requestId_idx" ON "ledger"("requestId");

-- CreateIndex
CREATE INDEX "reconciliation_logs_employeeId_idx" ON "reconciliation_logs"("employeeId");
