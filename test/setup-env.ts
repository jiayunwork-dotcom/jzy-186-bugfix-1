// Runs before the test framework is installed and before any module imports
// Nest's DbModule, so the application pool always points at the test DB.
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://postgres@localhost:55432/ghg_test';
process.env.PG_POOL_MAX = '4';

export {};
