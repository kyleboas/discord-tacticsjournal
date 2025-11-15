// scripts/generate-quiz-content.js
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GENERATE_QUESTIONS = process.env.GENERATE_QUESTIONS === 'true';
const GENERATE_SEASON = process.env.GENERATE_SEASON === 'true';
const QUESTION_COUNT = parseInt(process.env.QUESTION_COUNT || '20', 10);

if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY environment variable not set');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

/**
 * Generate new season theme for the upcoming month
 */
async function generateSeason() {
  console.log('🎨 Generating new season theme...');

  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthAfter = new Date(now.getFullYear(), now.getMonth() + 2, 0);

  const seasonId = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`;
  const startDate = nextMonth.toISOString().split('T')[0];
  const endDate = monthAfter.toISOString().split('T')[0];

  const prompt = `Generate a creative football quiz season theme for ${nextMonth.toLocaleString('default', { month: 'long' })} ${nextMonth.getFullYear()}.

Requirements:
- Theme name: Creative, engaging, and football-related (e.g., "Golden Boot Legends", "Tactical Masterminds")
- Description: One sentence describing what this season focuses on (max 100 chars)
- Color: A hex color code in decimal format (e.g., 16766720 for gold)
- Emoji: One relevant emoji that represents the theme

Respond ONLY with valid JSON in this exact format:
{
  "theme": "Theme Name Here",
  "description": "Description here",
  "color": 16766720,
  "emoji": "⚽"
}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Extract JSON from markdown code blocks if present
  let jsonText = text;
  if (text.includes('```json')) {
    jsonText = text.match(/```json\n([\s\S]*?)\n```/)?.[1] || text;
  } else if (text.includes('```')) {
    jsonText = text.match(/```\n([\s\S]*?)\n```/)?.[1] || text;
  }

  const seasonData = JSON.parse(jsonText);

  const newSeason = {
    id: seasonId,
    theme: seasonData.theme,
    description: seasonData.description,
    startDate,
    endDate,
    color: seasonData.color,
    emoji: seasonData.emoji
  };

  console.log(`✅ Generated season: ${newSeason.emoji} ${newSeason.theme}`);
  return newSeason;
}

/**
 * Generate football trivia questions
 */
async function generateQuestions(count = 20, seasonTheme = null) {
  console.log(`📝 Generating ${count} football trivia questions...`);

  const themeContext = seasonTheme
    ? `\n\nThese questions should align with the season theme: "${seasonTheme.theme}" - ${seasonTheme.description}`
    : '';

  const prompt = `Generate ${count} high-quality football trivia questions covering various topics:
- UEFA Champions League
- UEFA Europa League
- FIFA World Cup
- Premier League
- European Championships
- Notable players and managers
- Historic matches and moments${themeContext}

Requirements:
- Mix of difficulty: some easy (5 pts), mostly medium (10 pts), some hard (15 pts)
- Questions should be factual and have clear, verifiable answers
- Cover different eras and competitions
- Each question must have exactly 4 options
- Answer index is 0-3 (0=A, 1=B, 2=C, 3=D)

Respond ONLY with a valid JSON array in this exact format:
[
  {
    "question": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answerIndex": 0,
    "points": 10
  }
]`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Extract JSON from markdown code blocks if present
  let jsonText = text;
  if (text.includes('```json')) {
    jsonText = text.match(/```json\n([\s\S]*?)\n```/)?.[1] || text;
  } else if (text.includes('```')) {
    jsonText = text.match(/```\n([\s\S]*?)\n```/)?.[1] || text;
  }

  const questions = JSON.parse(jsonText);

  console.log(`✅ Generated ${questions.length} questions`);
  return questions;
}

/**
 * Main execution
 */
async function main() {
  try {
    const questionsPath = path.resolve(__dirname, '../quiz/questions.json');
    const seasonsPath = path.resolve(__dirname, '../quiz/seasons.json');

    // Generate new season if requested
    let newSeason = null;
    if (GENERATE_SEASON) {
      newSeason = await generateSeason();

      const seasons = JSON.parse(fs.readFileSync(seasonsPath, 'utf8'));

      // Check if season already exists
      const exists = seasons.some(s => s.id === newSeason.id);
      if (!exists) {
        seasons.push(newSeason);
        seasons.sort((a, b) => a.id.localeCompare(b.id));

        fs.writeFileSync(seasonsPath, JSON.stringify(seasons, null, 2) + '\n');
        console.log(`✅ Added new season to seasons.json`);
      } else {
        console.log(`ℹ️  Season ${newSeason.id} already exists, skipping`);
      }
    }

    // Generate new questions if requested
    if (GENERATE_QUESTIONS) {
      const newQuestions = await generateQuestions(QUESTION_COUNT, newSeason);

      const existingQuestions = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
      const combinedQuestions = [...existingQuestions, ...newQuestions];

      fs.writeFileSync(questionsPath, JSON.stringify(combinedQuestions, null, 2) + '\n');
      console.log(`✅ Added ${newQuestions.length} questions to questions.json (total: ${combinedQuestions.length})`);
    }

    console.log('🎉 Content generation complete!');
  } catch (error) {
    console.error('❌ Error generating content:', error);
    process.exit(1);
  }
}

main();
