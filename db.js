// db.js
import pkg from 'pg';
const { Pool } = pkg;
import { getISOWeek } from 'date-fns';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------------- existing watchlist & misc ----------------

// --- util ---
function slug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function makeManualMatchId({ guild_id, match_time, home, away }) {
  // deterministic per (guild, time, teams)
  const t = new Date(match_time).toISOString().replace(/[:.]/g, '');
  return `manual:${guild_id}:${t}:${slug(home)}-vs-${slug(away)}`;
}

// --- NEW: add manual match (persists in fixtures_cache + guild_match_reminders) ---
export async function addManualGuildMatch({
  guild_id,
  channel_id,
  match_time,      // Date or ISO
  home,
  away,
  league = 'Manual',
  source = 'manual'
}) {
  const match_id = makeManualMatchId({ guild_id, match_time, home, away });

  // 1) ensure it’s in fixtures_cache so /fixtures upcoming can display it
  await upsertFixturesCache([{
    match_id,
    match_time: new Date(match_time),
    home,
    away,
    league,
    source,
    home_id: null,
    away_id: null
  }]);

  // 2) store in guild_match_reminders so the dispatcher will alert
  await pool.query(
    `INSERT INTO guild_match_reminders (guild_id, channel_id, match_id, match_time, home, away, league, source, is_manual)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, TRUE)
     ON CONFLICT (guild_id, match_id)
     DO UPDATE SET channel_id = EXCLUDED.channel_id,
                   match_time = EXCLUDED.match_time,
                   home       = EXCLUDED.home,
                   away       = EXCLUDED.away,
                   league     = EXCLUDED.league,
                   source     = EXCLUDED.source,
                   is_manual  = TRUE`,
    [guild_id, channel_id, match_id, match_time, home, away, league, source]
  );

  return { match_id };
}

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

/**
 * Per-guild cleanup: remove upcoming reminders that aren't for followed teams.
 * If keepTeamIds is empty, it removes ALL upcoming reminders for that guild.
 * NOTE: This version does NOT preserve manual reminders.
 */
export async function pruneUpcomingForUnfollowed(guildId, keepTeamIds = []) {
  // If nothing is followed, delete all upcoming guild reminders
  if (!Array.isArray(keepTeamIds) || keepTeamIds.length === 0) {
    const res = await pool.query(
      `DELETE FROM guild_match_reminders g
       WHERE g.guild_id = $1
         AND g.match_time >= NOW()`,
      [guildId]
    );
    return res.rowCount || 0;
  }

  // 1) Remove upcoming reminders with a fixtures_cache row where neither side is followed.
  //    Use COALESCE so NULL team IDs are treated as "not followed".
  const res1 = await pool.query(
    `DELETE FROM guild_match_reminders g
     USING fixtures_cache f
     WHERE g.guild_id = $1
       AND g.match_time >= NOW()
       AND g.match_id = f.match_id
       AND NOT (
         COALESCE(f.home_id, -1) = ANY($2::int[])
         OR COALESCE(f.away_id, -1) = ANY($2::int[])
       )`,
    [guildId, keepTeamIds]
  );

  // 2) Also remove upcoming reminders that have no fixtures_cache row (orphans).
  const res2 = await pool.query(
    `DELETE FROM guild_match_reminders g
     WHERE g.guild_id = $1
       AND g.match_time >= NOW()
       AND NOT EXISTS (SELECT 1 FROM fixtures_cache f WHERE f.match_id = g.match_id)`,
    [guildId]
  );

  return (res1.rowCount || 0) + (res2.rowCount || 0);
}

/**
 * GLOBAL cleanup: remove all upcoming reminders across all guilds where
 * neither side is followed by that guild. By default preserves manual entries.
 * Returns number of rows deleted.
 */
export async function pruneAllUpcomingForUnfollowedGlobal({ keepManual = true } = {}) {
  const sql = `
    DELETE FROM guild_match_reminders g
    USING fixtures_cache f
    WHERE g.match_id = f.match_id
      AND g.match_time >= NOW()
      ${keepManual ? `AND COALESCE(g.is_manual, FALSE) = FALSE` : ``}
      AND NOT EXISTS (
        SELECT 1
        FROM guild_team_follows t
        WHERE t.guild_id = g.guild_id
          AND (t.team_id = f.home_id OR t.team_id = f.away_id)
      );
  `;
  const res = await pool.query(sql);
  return res.rowCount || 0;
}

/**
 * Remove upcoming reminders that have no corresponding fixtures_cache row (orphans).
 * By default preserves manual entries.
 */
export async function pruneOrphanUpcomingReminders({ keepManual = true } = {}) {
  const sql = `
    DELETE FROM guild_match_reminders g
    WHERE g.match_time >= NOW()
      ${keepManual ? `AND COALESCE(g.is_manual, FALSE) = FALSE` : ``}
      AND NOT EXISTS (
        SELECT 1 FROM fixtures_cache f WHERE f.match_id = g.match_id
      );
  `;
  const res = await pool.query(sql);
  return res.rowCount || 0;
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

  /* guild-scoped team follows */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_team_follows (
      guild_id TEXT NOT NULL,
      team_id  INTEGER NOT NULL,
      team_name TEXT NOT NULL,
      source TEXT DEFAULT 'football-data',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (guild_id, team_id)
    );
  `);

  /* guild-scoped match reminders (followed vs followed or followed vs anyone) */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_match_reminders (
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      match_id   TEXT NOT NULL,
      match_time TIMESTAMPTZ NOT NULL,
      home       TEXT NOT NULL,
      away       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (guild_id, match_id)
    );
  `);

  // add new columns if missing
  await pool.query(`
    ALTER TABLE guild_match_reminders
    ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS league TEXT,
    ADD COLUMN IF NOT EXISTS source TEXT
  `);

  // Helpful indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gmr_is_manual ON guild_match_reminders(is_manual);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fixtures_cache_time ON fixtures_cache(match_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fixtures_cache_ids ON fixtures_cache(home_id, away_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_guild_team_follows_guild ON guild_team_follows(guild_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_guild_team_follows_guild_team ON guild_team_follows(guild_id, team_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_guild_match_reminders_time ON guild_match_reminders(match_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_guild_match_reminders_guild_time ON guild_match_reminders(guild_id, match_time);`);
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

  // Add season column to qotd_attempts if it doesn't exist
  await pool.query(`
    ALTER TABLE qotd_attempts ADD COLUMN IF NOT EXISTS season TEXT;
  `);

  // Create seasonal leaderboard table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qotd_seasonal_scores (
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      season TEXT NOT NULL,
      total_points INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, season)
    );
  `);

  // Create index for faster seasonal queries
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seasonal_scores_season ON qotd_seasonal_scores(season);
  `);
}

export async function clearActiveQuizInDB() {
  await pool.query(`DELETE FROM active_quiz`);
}

export async function listGuildUpcomingRemindersForGuild(guild_id, limit = 50) {
  const { rows } = await pool.query(
    `SELECT match_id, match_time, home, away, league, is_manual
     FROM guild_match_reminders
     WHERE guild_id = $1 AND match_time > NOW() - INTERVAL '1 minute'
     ORDER BY match_time ASC
     LIMIT $2`,
    [guild_id, limit]
  );
  return rows;
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

export async function recordQuizAnswerDetailed({ userId, username, selectedIndex, messageId, isCorrect, points, season }) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const isoWeek = `${now.getUTCFullYear()}-W${getISOWeek(now).toString().padStart(2, '0')}`;

  await pool.query(`
    ALTER TABLE qotd_attempts ADD COLUMN IF NOT EXISTS week TEXT;
  `);

  await pool.query(`
    INSERT INTO qotd_attempts (date, time, message_id, user_id, username, selected_index, points, week, season)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (user_id, message_id)
    DO UPDATE SET time = $2, selected_index = $6, points = $7, username = $5, week = $8, season = $9
  `, [date, now, messageId, userId, username, selectedIndex, isCorrect ? points : 0, isoWeek, season]);

  if (isCorrect) {
    await pool.query(`
      INSERT INTO qotd_scores (user_id, username, total_points)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id)
      DO UPDATE SET total_points = qotd_scores.total_points + $3, username = $2
    `, [userId, username, points]);

    // Also update seasonal scores
    if (season) {
      await pool.query(`
        INSERT INTO qotd_seasonal_scores (user_id, username, season, total_points)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, season)
        DO UPDATE SET total_points = qotd_seasonal_scores.total_points + $4, username = $2
      `, [userId, username, season, points]);
    }
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

export async function getSeasonalLeaderboard(userId, seasonId) {
  const topRes = await pool.query(`
    SELECT username, total_points, user_id
    FROM qotd_seasonal_scores
    WHERE season = $1
    ORDER BY total_points DESC
    LIMIT 10
  `, [seasonId]);

  const top10 = topRes.rows;

  const isInTop10 = top10.some(row => row.user_id === userId);
  let userRankInfo = null;

  if (!isInTop10) {
    const rankRes = await pool.query(`
      SELECT username, total_points, rank FROM (
        SELECT user_id, username, total_points,
               RANK() OVER (ORDER BY total_points DESC) AS rank
        FROM qotd_seasonal_scores
        WHERE season = $1
      ) ranked
      WHERE user_id = $2
    `, [seasonId, userId]);

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

export async function getLastTrackedSeason() {
  const result = await pool.query(`
    SELECT season_id FROM last_tracked_season LIMIT 1
  `);
  return result.rows[0]?.season_id || null;
}

export async function setLastTrackedSeason(seasonId) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS last_tracked_season (
      id INTEGER PRIMARY KEY DEFAULT 1,
      season_id TEXT NOT NULL
    );
  `);

  await pool.query(`
    INSERT INTO last_tracked_season (id, season_id)
    VALUES (1, $1)
    ON CONFLICT (id)
    DO UPDATE SET season_id = $1
  `, [seasonId]);
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

// ---------------- guild match reminders API ----------------

/**
 * Upsert a followed-vs-followed (or followed-vs-anyone) match reminder for a guild.
 * Unique per (guild_id, match_id). Channel can be updated if needed.
 */
export async function upsertGuildMatchReminder({ guild_id, channel_id, match_id, match_time, home, away }) {
  await pool.query(
    `INSERT INTO guild_match_reminders (guild_id, channel_id, match_id, match_time, home, away)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (guild_id, match_id)
     DO UPDATE SET channel_id = EXCLUDED.channel_id,
                   match_time = EXCLUDED.match_time,
                   home = EXCLUDED.home,
                   away = EXCLUDED.away`,
    [guild_id, channel_id, match_id, match_time, home, away]
  );
}

/**
 * Bulk-upsert upcoming reminders for a guild by selecting from fixtures_cache
 * for any matches involving the provided team_ids within [fromISO, toISO].
 * Returns the number of rows inserted/updated for this guild.
 */
export async function bulkUpsertGuildRemindersFromCache({ guild_id, channel_id, team_ids, fromISO, toISO }) {
  if (!Array.isArray(team_ids) || team_ids.length === 0) return 0;

  const res = await pool.query(
    `INSERT INTO guild_match_reminders (guild_id, channel_id, match_id, match_time, home, away, league, source)
     SELECT $1 AS guild_id,
            $2 AS channel_id,
            f.match_id,
            f.match_time,
            f.home,
            f.away,
            f.league,
            f.source
     FROM fixtures_cache f
     WHERE f.match_time >= $3
       AND f.match_time <  $4
       AND (
         COALESCE(f.home_id, -1) = ANY($5::int[])
         OR COALESCE(f.away_id, -1) = ANY($5::int[])
       )
     ON CONFLICT (guild_id, match_id)
     DO UPDATE SET channel_id = EXCLUDED.channel_id,
                   match_time = EXCLUDED.match_time,
                   home       = EXCLUDED.home,
                   away       = EXCLUDED.away,
                   league     = EXCLUDED.league,
                   source     = EXCLUDED.source`,
    [guild_id, channel_id, fromISO, toISO, team_ids]
  );
  return res.rowCount || 0;
}

/**
 * Delete old reminders so the table doesn't grow forever.
 * Keeps anything with kickoff >= now() - 1 day.
 */
export async function purgeOldReminders() {
  await pool.query(
    `DELETE FROM guild_match_reminders
     WHERE match_time < (NOW() - INTERVAL '1 day')`
  );
}

/**
 * Get all reminders in a time window (inclusive).
 * Used by the scheduler to send 60-min and 5-min alerts.
 */
export async function getUpcomingRemindersWindow({ fromISO, toISO }) {
  const { rows } = await pool.query(
    `SELECT guild_id, channel_id, match_id, match_time, home, away
     FROM guild_match_reminders
     WHERE match_time >= $1 AND match_time <= $2
     ORDER BY match_time ASC`,
    [fromISO, toISO]
  );
  return rows;
}