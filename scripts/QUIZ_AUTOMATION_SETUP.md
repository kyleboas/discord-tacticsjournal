# Quiz Content Auto-Generation Setup

This guide explains how to set up automated quiz content generation using GitHub Actions and Google Gemini API.

## Overview

The system automatically generates:
- **New season themes** every month with creative names, descriptions, colors, and emojis
- **Football trivia questions** aligned with the current season theme
- Runs on the 1st of every month at 00:00 UTC
- Can also be triggered manually from GitHub Actions

## Setup Instructions

### 1. Get a Free Google Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Sign in with your Google account
3. Click **"Get API Key"**
4. Click **"Create API key in new project"**
5. Copy the API key (starts with `AIza...`)

**Free tier limits:**
- 60 requests per minute
- 1,500 requests per day
- More than enough for monthly generation!

### 2. Add API Key to GitHub Secrets

1. Go to your GitHub repository
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **"New repository secret"**
4. Name: `GEMINI_API_KEY`
5. Value: Paste your API key
6. Click **"Add secret"**

### 3. Enable GitHub Actions

1. Go to your repository
2. Click the **Actions** tab
3. If prompted, click **"I understand my workflows, go ahead and enable them"**

### 4. Test the Setup (Optional)

Trigger a manual run to test:

1. Go to **Actions** tab
2. Click **"Generate Quiz Content"** workflow
3. Click **"Run workflow"** dropdown
4. Configure options:
   - Generate new questions: ✓
   - Generate new season: ✓
   - Number of questions: 20
5. Click **"Run workflow"**
6. Wait 1-2 minutes and check the results

## How It Works

### Automatic Monthly Generation

Every month on the 1st at midnight UTC:
1. GitHub Actions runs the workflow
2. Generates a new season theme for the upcoming month
3. Generates 20 new themed questions
4. Auto-commits and pushes to your repository
5. Your Discord bot automatically reloads the questions

### Manual Triggering

You can also run it anytime:
1. Go to **Actions** → **Generate Quiz Content**
2. Click **"Run workflow"**
3. Customize what to generate

## Customization

### Change Schedule

Edit `.github/workflows/generate-quiz-content.yml`:

```yaml
schedule:
  - cron: '0 0 1 * *'  # Runs 1st of month at 00:00 UTC
```

Examples:
- `'0 0 15 * *'` - 15th of every month
- `'0 0 * * 0'` - Every Sunday
- `'0 12 1 * *'` - 1st of month at noon

### Change Question Count

Default is 20 questions per run. To change:

1. Edit workflow file or
2. Use manual trigger with custom count

### Customize Question Themes

Edit `scripts/generate-quiz-content.js` and modify the prompt:

```javascript
const prompt = `Generate ${count} football trivia questions about:
- Add your custom topics here
- More specific requirements
- etc.`;
```

## Monitoring

### Check Workflow Runs

1. Go to **Actions** tab
2. View all workflow runs and their status
3. Click a run to see detailed logs

### View Generated Content

After each run, check:
- `quiz/questions.json` - All questions
- `quiz/seasons.json` - All seasons

## Troubleshooting

### Workflow fails with "GEMINI_API_KEY not set"

- Check that you added the secret correctly in GitHub Settings
- Secret name must be exactly `GEMINI_API_KEY`

### Questions are low quality

- AI generation varies; you can manually edit `questions.json`
- Adjust the prompt in `scripts/generate-quiz-content.js`
- Increase temperature for more creativity (add to model config)

### Want to disable auto-generation

1. Go to **Actions** → **Generate Quiz Content**
2. Click **⋯** (three dots) → **Disable workflow**

### Need to generate more frequently

Edit the cron schedule in the workflow file to run weekly or bi-weekly.

## Manual Content Management

You can still manually edit:
- `quiz/questions.json` - Add/edit questions
- `quiz/seasons.json` - Add/edit seasons

Changes will be preserved; automation only adds new content.

## Cost

**100% FREE** with Google Gemini API:
- Free tier: 1,500 requests/day
- This workflow uses ~2 requests per run
- Can run 750 times per day if needed
- Monthly usage: ~2 requests = FREE

## Support

If you encounter issues:
1. Check workflow logs in Actions tab
2. Verify API key is valid
3. Ensure JSON files are valid after generation
4. Check repository permissions for GitHub Actions
