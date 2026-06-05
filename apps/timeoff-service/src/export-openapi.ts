import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';

// Writes the static OpenAPI spec to docs/. Boots the app without listening; the
// document is built from route/DTO metadata (no HTTP server needed). Run via
// `npm run export:openapi`.
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const config = new DocumentBuilder()
    .setTitle('Time-Off Service')
    .setDescription('Time-off request lifecycle, balances, and HCM reconciliation')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);

  // cwd is apps/timeoff-service when run through the npm script.
  const out = join(process.cwd(), '..', '..', 'docs', 'openapi.timeoff.json');
  writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
  await app.close();
  // eslint-disable-next-line no-console
  console.log(`wrote ${out}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
