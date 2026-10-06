import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          strict: true,
          esModuleInterop: true,
          target: 'ES2022',
          module: 'commonjs',
          moduleResolution: 'node',
          skipLibCheck: true
        }
      }
    ]
  },
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup-after-env.ts'],
  // Integration files share one PostgreSQL database while each owning a
  // separate connection pool; concurrency across files makes TRUNCATE
  // RESTART IDENTITY deadlock with open DML transactions. One worker makes
  // the whole suite deterministic (also guarantees identical summation order).
  maxWorkers: 1,
  testTimeout: 30000,
  verbose: true
};

export default config;
