import { backfillLocationCoords, migrate, pool } from '../config/db.js';

migrate()
  .then(() => backfillLocationCoords())
  .then((c) => console.log(`[migrate] done; locations with coordinates: ${c.withCoords}/${c.total}`))
  .catch((e) => { console.error('[migrate] failed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
