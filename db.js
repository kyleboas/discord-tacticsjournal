// db.js
import pkg from 'pg';
const { Pool } = pkg;
import { getISOWeek } from 'date-fns';

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_reminders (
      id SERIAL PRIMARY KEY,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      match_time TIMESTAMP NOT NULL,
      channel_id TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      match_channel_id TEXT
    );
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_quiz (
      message_id TEXT NOT NULL,
      question_index INTEGER NOT NULL,
      correct_index INTEGER NOT NULL,
      points INTEGER NOT NULL,
      channel_id TEXT NOT NULL
    );
  `);
}

export async function clearActiveQuizInDB() {
  await pool.query(`DELETE FROM active_quiz`);
}

export async function setActiveQuizInDB({ messageId, questionIndex, correctIndex, points, channelId }) {
  await pool.query(`DELETE FROM active_quiz`);

  await pool.query(
    `INSERT INTO active_quiz (message_id, question_index, correct_index, points, channel_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [messageId, questionIndex, correctIndex, points, channelId]
  );
}

export async function getActiveQuizFromDB() {
  const res = await pool.query('SELECT * FROM active_quiz LIMIT 1');
  return res.rows[0] || null;
}

export async function recordQuizAnswerDetailed({ userId, username, selectedIndex, messageId, isCorrect, points }) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const isoWeek = `${now.getUTCFullYear()}-W${getISOWeek(now).toString().padStart(2, '0')}`;

  await pool.query(`
    INSERT INTO qotd_attempts (date, time, message_id, user_id, username, selected_index, points, week)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (user_id, message_id)
    DO UPDATE SET time = $2, selected_index = $6, points = $7, username = $5, week = $8
  `, [date, now, messageId, userId, username, selectedIndex, isCorrect ? points : 0, isoWeek]);

  if (isCorrect) {
    await pool.query(`
      INSERT INTO qotd_scores (user_id, username, total_points)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id)
      DO UPDATE SET total_points = qotd_scores.total_points + $3, username = $2
    `, [userId, username, points]);
  }
}

export async function getQuizLeaderboard(userId) {
  // Get top 10
  const topRes = await pool.query(`
    SELECT username, total_points, user_id
    FROM qotd_scores
    ORDER BY total_points DESC
    LIMIT 10
  `);

  const top10 = topRes.rows;

  // Check if requester is in top 10
  const isInTop10 = top10.some(row => row.user_id === userId);

  let userRankInfo = null;

  if (!isInTop10) {
    const rankRes = await pool.query(`
      SELECT username, total_points, rank FROM (
        SELECT user_id, username, total_points,
               RANK() OVER (ORDER BY total_points DESC) AS rank
        FROM qotd_scores
      ) ranked
      WHERE user_id = $1
    `, [userId]);

    if (rankRes.rows.length > 0) {
      userRankInfo = rankRes.rows[0]; // { username, total_points, rank }
    }
  }

  return {
    top10,
    userRankInfo
  };
}

export async function getWeeklyLeaderboard(userId) {
  const now = new Date();
  const isoWeek = `${now.getUTCFullYear()}-W${getISOWeek(now).toString().padStart(2, '0')}`;

  const topRes = await pool.query(`
    SELECT username, SUM(points) AS total_points, user_id
    FROM qotd_attempts
    WHERE week = $1
    GROUP BY user_id, username
    ORDER BY total_points DESC
    LIMIT 10
  `, [isoWeek]);

  const top10 = topRes.rows;

  const isInTop10 = top10.some(row => row.user_id === userId);

  let userRankInfo = null;

  if (!isInTop10) {
    const rankRes = await pool.query(`
      SELECT username, total_points, rank FROM (
        SELECT user_id, username, SUM(points) AS total_points,
               RANK() OVER (ORDER BY SUM(points) DESC) AS rank
        FROM qotd_attempts
        WHERE week = $1
        GROUP BY user_id, username
      ) ranked
      WHERE user_id = $2
    `, [isoWeek, userId]);

    if (rankRes.rows.length > 0) {
      userRankInfo = rankRes.rows[0];
    }
  }

  return { top10, userRankInfo };
}

export async function ensureWeeklyLeaderboardSchema() {
  await pool.query(`
    ALTER TABLE qotd_attempts
    ADD COLUMN IF NOT EXISTS week TEXT;
  `);
}

export async function ensureStrikeSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strikes (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      last_strike_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export async function getStrikeCount(userId) {
  const res = await pool.query('SELECT count FROM strikes WHERE user_id = $1', [userId]);
  return res.rows.length ? res.rows[0].count : 0;
}

export async function incrementStrike(userId, username) {
  const now = new Date();

  const { rows } = await pool.query(`
    SELECT count, last_strike_at FROM strikes WHERE user_id = $1
  `, [userId]);

  let count = 1;

  if (rows.length > 0) {
    const lastStrikeTime = new Date(rows[0].last_strike_at);
    const timeDiff = now - lastStrikeTime;

    if (timeDiff <= 24 * 60 * 60 * 1000) {
      count = rows[0].count + 1;
    }

    await pool.query(`
      UPDATE strikes SET count = $1, last_strike_at = $2, username = $3 WHERE user_id = $4
    `, [count, now, username, userId]);
  } else {
    await pool.query(`
      INSERT INTO strikes (user_id, username, count, last_strike_at)
      VALUES ($1, $2, $3, $4)
    `, [userId, username, count, now]);
  }

  return count;
}

export async function incrementMajorStrike(userId, username) {
  const now = new Date();
  const res = await pool.query(`
    INSERT INTO major_strikes (user_id, username, count, last_strike_at)
    VALUES ($1, $2, 1, $3)
    ON CONFLICT (user_id)
    DO UPDATE SET count = major_strikes.count + 1, last_strike_at = $3, username = $2
    RETURNING count
  `, [userId, username, now]);
  return res.rows[0].count;
}

export async function ensureMajorStrikeSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS major_strikes (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      last_strike_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}


export async function addMatchReminder(home, away, matchTime, channelId) {
  await pool.query(
    `INSERT INTO match_reminders (home, away, match_time, channel_id) VALUES ($1, $2, $3, $4)`,
    [home, away, matchTime, channelId]
  );
}

export async function getMatchReminders() {
  const res = await pool.query(`SELECT * FROM match_reminders WHERE match_time > NOW() ORDER BY match_time`);
  return res.rows;
}

export async function setReminderChannel(guildId, channelId) {
  await pool.query(`
    INSERT INTO guild_settings (guild_id, match_channel_id)
    VALUES ($1, $2)
    ON CONFLICT (guild_id) DO UPDATE SET match_channel_id = $2
  `, [guildId, channelId]);
}

export async function getReminderChannel(guildId) {
  const res = await pool.query(`SELECT match_channel_id FROM guild_settings WHERE guild_id = $1`, [guildId]);
  return res.rows[0]?.match_channel_id || null;
}