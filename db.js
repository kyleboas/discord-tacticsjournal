// database.js
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

export async function addToWatchlist(position, team, name, userId, username) {
  await pool.query(
    'INSERT INTO watchlist (position, team, name, user_id, username) VALUES ($1, $2, $3, $4, $5)',
    [position, team, name, userId, username]
  );
}

export async function removeFromWatchlist(name) {
  const res = await pool.query(
    'DELETE FROM watchlist WHERE LOWER(name) = LOWER($1) RETURNING *',
    [name]
  );
  return res.rowCount > 0;
}

export async function setPlayerScore(playerName, userId, username, score) {
  await pool.query(`
    INSERT INTO watchlistscore (player_name, user_id, username, score)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (player_name, user_id)
    DO UPDATE SET score = $4, username = $3
  `, [playerName, userId, username, score]);
}

export async function getAverageScores() {
  const res = await pool.query(`
    SELECT player_name, AVG(score)::numeric(4,2) AS avg_score
    FROM watchlistscore
    GROUP BY player_name
  `);
  
  return Object.fromEntries(res.rows.map(row => [row.player_name.toLowerCase(), row.avg_score]));
}

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      position TEXT NOT NULL,
      team TEXT NOT NULL,
      name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlistscores (
      id SERIAL PRIMARY KEY,
      player_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      score NUMERIC(3,1) CHECK (score >= 1.0 AND score <= 10.0),
      UNIQUE(player_name, user_id)
    );
  `);
}