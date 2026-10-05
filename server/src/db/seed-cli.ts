import { main } from './seed';
import { pool } from './pool';

// CLI entry: migrations + base data (+ demo data when the database is empty).
main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
