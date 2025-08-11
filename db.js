// db.js
import pkg from 'pg';
const { Pool } = pkg;
import { getISOWeek } from 'date-fns';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------------- existing watchlist & misc ----------------

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

// ---------------- schema ----------------

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      position TEXT NOT NULL,
      team TEXT NOT NULL,
      name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      message_id TEXT,
      channel_id TEXT
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS starred_matches (
      id SERIAL PRIMARY KEY,
      match_id TEXT NOT NULL,
      match_time TIMESTAMPTZ NOT NULL,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      league TEXT,
      source TEXT,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (match_id, channel_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fixtures_cache (
      match_id TEXT PRIMARY KEY,
      match_time TIMESTAMPTZ NOT NULL,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      league TEXT,
      source TEXT,
      cached_at TIMESTAMPTZ DEFAULT NOW(),
      home_id INTEGER,
      away_id INTEGER
    );
  `);

  /* NEW: guild-scoped team follows */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_team_follows (
      guild_id  TEXT NOT NULL,
      team_id   INTEGER NOT NULL,
      team_name TEXT NOT NULL,
      source    TEXT DEFAULT 'football-data',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (guild_id, team_id)
    );
  `);

  /* NEW: reminders for followed-vs-followed matches (server-wide) */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_match_reminders (
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      match_id   TEXT NOT NULL,
      match_time TIMESTAMPTZ NOT NULL,
      home       TEXT NOT NULL,
      away       TEXT NOT NULL,
      home_id    INTEGER,
      away_id    INTEGER,
      league     TEXT,
      source     TEXT DEFAULT 'football-data',
      sent_60    BOOLEAN DEFAULT FALSE,
      sent_5     BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (guild_id, channel_id, match_id)
    );
  `);

  /* Optional helpful indexes */
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fixtures_cache_time ON fixtures_cache(match_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_guild_team_follows_guild ON guild_team_follows(guild_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gmr_time ON guild_match_reminders(match_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gmr_guild ON guild_match_reminders(guild_id);`);
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
    ALTER TABLE IF NOT EXISTS qotd_attempts ADD COLUMN IF NOT EXISTS week TEXT;
  `);

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
  const topRes = await pool.query(`
    SELECT username, total_points, user_id
    FROM qotd_scores
    ORDER BY total_points DESC
    LIMIT 10
  `);
  const top10 = topRes.rows;

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
      userRankInfo = rankRes.rows[0];
    }
  }

  return { top10, userRankInfo };
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

// ---------------- reminders / fixtures cache ----------------

export async function addMatchReminder(home, away, matchTime, channelId) {
  await pool.query(
    `INSERT INTO match_reminders (home, away, match_time, channel_id) VALUES ($1, $2, $3, $4)`,
    [home, away, matchTime, channelId]
  );
}

export async function upsertFixturesCache(rows) {
  if (!rows?.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO fixtures_cache (match_id, match_time, home, away, league, source, home_id, away_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (match_id)
         DO UPDATE SET match_time=EXCLUDED.match_time, home=EXCLUDED.home, away=EXCLUDED.away,
                       league=EXCLUDED.league, source=EXCLUDED.source, cached_at=NOW(),
                       home_id=COALESCE(EXCLUDED.home_id, fixtures_cache.home_id),
                       away_id=COALESCE(EXCLUDED.away_id, fixtures_cache.away_id)`,
        [
          r.match_id,
          r.match_time,
          r.home,
          r.away,
          r.league || null,
          r.source || null,
          r.home_id ?? null,
          r.away_id ?? null
        ]
      );
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

export async function listCachedFixtures({ dateISO }) {
  const { rows } = await pool.query(
    `SELECT * FROM fixtures_cache
     WHERE match_time >= $1::date AND match_time < ($1::date + INTERVAL '1 day')
     ORDER BY match_time ASC`,
    [dateISO]
  );
  return rows;
}

export async function starMatch({ match_id, channel_id, user_id }) {
  const { rows } = await pool.query(`SELECT * FROM fixtures_cache WHERE match_id=$1`, [match_id]);
  if (!rows.length) throw new Error('Match not found in cache');
  const m = rows[0];
  await pool.query(
    `INSERT INTO starred_matches (match_id, match_time, home, away, league, source, channel_id, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (match_id, channel_id) DO NOTHING`,
    [m.match_id, m.match_time, m.home, m.away, m.league, m.source, channel_id, user_id]
  );
  return m;
}

export async function unstarMatch({ match_id, channel_id }) {
  await pool.query(`DELETE FROM starred_matches WHERE match_id=$1 AND channel_id=$2`, [match_id, channel_id]);
}

export async function getStarredMatchesWindow({ fromISO, toISO }) {
  const { rows } = await pool.query(
    `SELECT * FROM starred_matches
     WHERE match_time >= $1 AND match_time <= $2
     ORDER BY match_time ASC`,
    [fromISO, toISO]
  );
  return rows;
}

// ---------------- guild settings ----------------

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

// ---------------- guild-scoped team follows ----------------

export async function subscribeGuildTeams(guild_id, teams /* [{id, name}] */) {
  if (!teams?.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let added = 0;
    for (const t of teams) {
      await client.query(
        `INSERT INTO guild_team_follows (guild_id, team_id, team_name)
         VALUES ($1,$2,$3)
         ON CONFLICT (guild_id, team_id) DO NOTHING`,
        [guild_id, t.id, t.name]
      );
      added++;
    }
    await client.query('COMMIT');
    return added;
  } finally {
    client.release();
  }
}

export async function listGuildSubscribedTeams(guild_id) {
  const { rows } = await pool.query(
    `SELECT team_id, team_name FROM guild_team_follows WHERE guild_id = $1 ORDER BY team_name`,
    [guild_id]
  );
  return rows; // [{team_id, team_name}]
}

export async function unsubscribeGuildTeams(guild_id, team_ids /* number[] */) {
  if (!team_ids?.length) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM guild_team_follows WHERE guild_id = $1 AND team_id = ANY($2::int[])`,
    [guild_id, team_ids]
  );
  return rowCount;
}

// ---------------- NEW: followed‑vs‑followed reminders storage ----------------

/**
 * Insert or update a reminder row for a guild/channel/match.
 */
export async function upsertGuildMatchReminder({
  guild_id,
  channel_id,
  match_id,
  match_time,
  home,
  away,
  home_id = null,
  away_id = null,
  league = null,
  source = 'football-data'
}) {
  const { rows } = await pool.query(
    `INSERT INTO guild_match_reminders
      (guild_id, channel_id, match_id, match_time, home, away, home_id, away_id, league, source, updated_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (guild_id, channel_id, match_id)
     DO UPDATE SET
       match_time = EXCLUDED.match_time,
       home       = EXCLUDED.home,
       away       = EXCLUDED.away,
       home_id    = COALESCE(EXCLUDED.home_id, guild_match_reminders.home_id),
       away_id    = COALESCE(EXCLUDED.away_id, guild_match_reminders.away_id),
       league     = COALESCE(EXCLUDED.league, guild_match_reminders.league),
       source     = COALESCE(EXCLUDED.source, guild_match_reminders.source),
       updated_at = NOW()
     RETURNING *`,
    [guild_id, channel_id, match_id, match_time, home, away, home_id, away_id, league, source]
  );
  return rows[0];
}

/**
 * Get reminders in a time window (inclusive).
 * Optionally filter out ones already marked sent at a given stage.
 */
export async function getUpcomingRemindersWindow({ fromISO, toISO, stage /* '60' | '5' | undefined */ }) {
  const whereSent =
    stage === '60' ? 'AND sent_60 = FALSE' :
    stage === '5'  ? 'AND sent_5  = FALSE' :
    '';
  const { rows } = await pool.query(
    `SELECT * FROM guild_match_reminders
     WHERE match_time >= $1 AND match_time <= $2
     ${whereSent}
     ORDER BY match_time ASC`,
    [fromISO, toISO]
  );
  return rows;
}

/**
 * Mark a reminder as sent for a specific stage ('60' or '5').
 * Safe to call multiple times.
 */
export async function markReminderSent({ guild_id, channel_id, match_id, stage /* '60' | '5' */ }) {
  if (stage !== '60' && stage !== '5') return false;
  const column = stage === '60' ? 'sent_60' : 'sent_5';
  const res = await pool.query(
    `UPDATE guild_match_reminders
     SET ${column} = TRUE, updated_at = NOW()
     WHERE guild_id = $1 AND channel_id = $2 AND match_id = $3`,
    [guild_id, channel_id, match_id]
  );
  return res.rowCount > 0;
}

/** Optional: clean up stale reminders older than N days (default 30). */
export async function purgeOldGuildReminders(days = 30) {
  await pool.query(
    `DELETE FROM guild_match_reminders
     WHERE match_time < (NOW() - ($1 || ' days')::interval)`,
    [days]
  );
}