// seasonUtils.js
import fs from 'fs';
import path from 'path';

const SEASONS = JSON.parse(fs.readFileSync(path.resolve('quiz/seasons.json')));

/**
 * Get the current active season based on the current date
 * @returns {Object|null} The active season object or null if no season is active
 */
export function getCurrentSeason() {
  const now = new Date();
  const todayISO = now.toISOString().split('T')[0]; // YYYY-MM-DD

  for (const season of SEASONS) {
    if (todayISO >= season.startDate && todayISO <= season.endDate) {
      return season;
    }
  }

  return null;
}

/**
 * Get a season by its ID
 * @param {string} seasonId - The season ID (e.g., "2025-11")
 * @returns {Object|null} The season object or null if not found
 */
export function getSeasonById(seasonId) {
  return SEASONS.find(s => s.id === seasonId) || null;
}

/**
 * Get all seasons
 * @returns {Array} Array of all season objects
 */
export function getAllSeasons() {
  return SEASONS;
}

/**
 * Get upcoming seasons (seasons that haven't started yet)
 * @returns {Array} Array of upcoming season objects
 */
export function getUpcomingSeasons() {
  const now = new Date();
  const todayISO = now.toISOString().split('T')[0];

  return SEASONS.filter(season => season.startDate > todayISO);
}

/**
 * Get past seasons (seasons that have ended)
 * @returns {Array} Array of past season objects
 */
export function getPastSeasons() {
  const now = new Date();
  const todayISO = now.toISOString().split('T')[0];

  return SEASONS.filter(season => season.endDate < todayISO);
}

/**
 * Check if tomorrow is the last day of the current season
 * @returns {boolean} True if tomorrow is the season end date
 */
export function isTomorrowSeasonEnd() {
  const currentSeason = getCurrentSeason();
  if (!currentSeason) return false;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = tomorrow.toISOString().split('T')[0];

  return tomorrowISO === currentSeason.endDate;
}

/**
 * Get the season that starts tomorrow
 * @returns {Object|null} The season starting tomorrow or null
 */
export function getTomorrowStartingSeason() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = tomorrow.toISOString().split('T')[0];

  return SEASONS.find(s => s.startDate === tomorrowISO) || null;
}
