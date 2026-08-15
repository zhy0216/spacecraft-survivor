import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

await applyD1Migrations(env.RUN_LOG_QUOTA, env.TEST_MIGRATIONS);
