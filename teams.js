// teams.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const teamsDir = path.join(__dirname, 'teams');

export function getAllTeams() {
  const files = fs.readdirSync(teamsDir).filter(f => f.endsWith('.json'));
  const allTeams = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(teamsDir, file), 'utf-8');
    try {
      const data = JSON.parse(content);
      allTeams.push(...data);
    } catch (err) {
      console.error(`Failed to parse ${file}`, err);
    }
  }

  return allTeams;
}

export function isValidTeam(teamName) {
  const teams = getAllTeams();
  return teams.some(t => t.team_name.toLowerCase() === teamName.toLowerCase());
}