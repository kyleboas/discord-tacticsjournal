import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export async function getWatchlist() {
  const res = await pool.query('SELECT * FROM watchlist');
  return res.rows;
}

export async function addToWatchlist(position, team, name) {
  await pool.query(
    'INSERT INTO watchlist (position, team, name) VALUES ($1, $2, $3)',
    [position, team, name]
  );
}

export async function removeFromWatchlist(name) {
  const res = await pool.query(
    'DELETE FROM watchlist WHERE LOWER(name) = LOWER($1) RETURNING *',
    [name]
  );
  return res.rowCount > 0;
}

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      position TEXT NOT NULL,
      team TEXT NOT NULL,
      name TEXT NOT NULL
    )
  `);
}