// constants.js
// Centralized configuration for Discord IDs and other constants

/**
 * Discord Role IDs
 * These should be configured per-guild in production
 */
export const ROLES = {
  ADMIN: '1100369095251206194',         // Admin/Moderator/Quiz role
  MEMBERS: '1182838456720826460',       // Members role for watchlist access
  QUIZ_POSTER: '1372372259812933642',   // Quiz poster role
  QUIZ_WINNER: '1439360908588482830'    // Quiz winner role (auto-assigned)
};

/**
 * Discord Channel IDs
 * These should be configured per-guild in production
 */
export const CHANNELS = {
  WATCHLIST: '1371507335372996760',      // Watchlist channel
  MATCH_REMINDERS: '1098742662040920074', // Match reminders channel
  MOD_LOG: '1099892476627669012',        // Moderation log channel
  QUIZ: '1372225536406978640',           // Quiz channel

  // Additional watch channels for moderation
  WATCH_CHANNELS: [
    '1371677909902819360',
    '1098742662040920074',
    '1325150809104842752',
    '1273974012774711397',
    '1371507335372996760'
  ]
};

/**
 * Direct targeting allowlist for moderation
 * Words that are allowed in direct targeting patterns
 */
export const DIRECT_TARGETING_ALLOWLIST = new Set([
  'the', 'this', 'that', 'all', 'with', 'was', 'it', 'game', 'thing', 'shit'
]);

/**
 * Environment configuration with defaults
 */
export const CONFIG = {
  // AI Moderation
  ENABLE_AI_MOD: process.env.ENABLE_AI_MOD !== 'false', // Enable by default
  TOXICITY_THRESHOLD: parseFloat(process.env.TOXICITY_THRESHOLD || '0.85'),
  MOD_SAMPLE_RATE: parseFloat(process.env.MOD_SAMPLE_RATE || '1.0'),
  PERSPECTIVE_RATE_LIMIT: parseInt(process.env.PERSPECTIVE_RATE_LIMIT || '30'), // Max requests per minute

  // Cache settings
  MODERATION_CACHE_TTL: 30 * 60 * 1000, // 30 minutes
  MODERATION_CACHE_MAX_SIZE: 100,

  // Strike system
  STRIKE_RESET_MS: 3 * 24 * 60 * 60 * 1000, // 3 days

  // Node environment
  NODE_ENV: process.env.NODE_ENV || 'production'
};
