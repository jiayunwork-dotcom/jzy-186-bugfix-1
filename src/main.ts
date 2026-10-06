import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { runMigrations } from './database/database.module';
import { Pool } from 'pg';
import { join } from 'path';

async function bootstrap(): Promise<void> {
  // Auto-migrate on boot (idempotent).
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/ghg'
  });
  await runMigrations(pool, join(__dirname, 'migrations'));
  await pool.end();

  const app = await NestFactory.create(AppModule, { bodyParser: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`GHG accounting API listening on :${port}`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
