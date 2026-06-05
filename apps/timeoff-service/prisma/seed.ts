import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client';

// Seed the local balance projection to mirror the mock HCM's seed data, so the
// time-off APIs have pooled balances to reserve against in development. Pooled
// per (employeeId, locationId); idempotent via upsert.
const DATABASE_URL = process.env.DATABASE_URL ?? 'file:./dev.db';

const SEED = [
  { employeeId: 'EMP-001', locationId: 'LOC-NYC', totalBalance: 30 },
  { employeeId: 'EMP-002', locationId: 'LOC-LON', totalBalance: 23 },
  { employeeId: 'EMP-100', locationId: 'LOC-SF', totalBalance: 37 },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: DATABASE_URL }),
  });
  try {
    for (const s of SEED) {
      await prisma.balance.upsert({
        where: {
          employeeId_locationId: {
            employeeId: s.employeeId,
            locationId: s.locationId,
          },
        },
        update: { totalBalance: s.totalBalance },
        create: {
          employeeId: s.employeeId,
          locationId: s.locationId,
          totalBalance: s.totalBalance,
          reservedBalance: 0,
        },
      });
    }
    console.log(`Seeded ${SEED.length} local balance(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
