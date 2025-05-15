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

export async function addToWatchlist(position, team, name, userId, username, channelId, messageId) {
  await pool.query(
    'INSERT INTO watchlist (position, team, name, user_id, username, channel_id, message_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [position, team, name, userId, username, channelId, messageId]
  );
}

export async function updateWatchlistMessageMeta(name, userId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return false;

  const setClause = keys.map((key, i) => `${key} = $${i + 3}`).join(', ');
  const values = [name, userId, ...Object.values(fields)];

  const res = await pool.query(
    `UPDATE watchlist SET ${setClause} WHERE LOWER(name) = LOWER($1) AND user_id = $2`,
    values
  );

  return res.rowCount > 0;
}

export async function removeFromWatchlist(name) {
  const res = await pool.query(
    'DELETE FROM watchlist WHERE LOWER(name) = LOWER($1) RETURNING *',
    [name]
  );
  return res.rowCount > 0;
}

export async function updateWatchlistPlayer(originalName, userId, updates) {
  const fields = [];
  const values = [originalName, userId];
  let index = 3;

  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = $${index++}`);
    values.push(val);
  }

  if (fields.length === 0) return false;

  const res = await pool.query(
    `UPDATE watchlist SET ${fields.join(', ')} WHERE LOWER(name) = LOWER($1) AND user_id = $2 RETURNING *`,
    values
  );

  return res.rowCount > 0;
}

export async function setPlayerScore(playerName, userId, username, score) {
  await pool.query(`
    INSERT INTO watchlistScores (player_name, user_id, username, score)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (player_name, user_id)
    DO UPDATE SET score = $4, username = $3
  `, [playerName, userId, username, score]);
}

export async function getAverageScores() {
  const res = await pool.query(`
    SELECT player_name, AVG(score)::numeric(4,2) AS avg_score
    FROM watchlistScores
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
    CREATE TABLE IF NOT EXISTS watchlistScores (
      id SERIAL PRIMARY KEY,
      player_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      score NUMERIC(3,1) CHECK (score >= 1.0 AND score <= 10.0),
      UNIQUE(player_name, user_id)
    );
  `);
  
  await pool.query(`
    ALTER TABLE watchlist
    ADD COLUMN IF NOT EXISTS message_id TEXT,
    ADD COLUMN IF NOT EXISTS channel_id TEXT;
  `);
}

export async function ensureQuizSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qotd_scores (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      total_points INTEGER DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS qotd_attempts (
      date DATE NOT NULL,
      time TIMESTAMP NOT NULL,
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      selected_index INTEGER,
      points INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, message_id)
    );
  `);
}


export async function recordQuizAnswerDetailed({ userId, username, selectedIndex, messageId, isCorrect, points }) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];

  await pool.query(`
    INSERT INTO qotd_attempts (date, time, message_id, user_id, username, selected_index, points)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id, message_id)
    DO UPDATE SET time = $2, selected_index = $6, points = $7, username = $5
  `, [date, now, messageId, userId, username, selectedIndex, isCorrect ? points : 0]);

  if (isCorrect) {
    await pool.query(`
      INSERT INTO qotd_scores (user_id, username, total_points)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id)
      DO UPDATE SET total_points = qotd_scores.total_points + $3, username = $2
    `, [userId, username, points]);
  }
}

export async function getQuizLeaderboard() {
  const res = await pool.query(`
    SELECT username, correct_count FROM qotd_scores
    ORDER BY correct_count DESC LIMIT 10
  `);
  return res.rows;
}