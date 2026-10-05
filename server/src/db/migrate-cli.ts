import { migrate } from './migrate';
import { pool } from './pool';

// CLI entry (kept separate so bundling can't move the "run" check into a shared chunk).
migrate()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
