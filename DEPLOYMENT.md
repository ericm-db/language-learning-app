# Deployment Guide - Railway

Step-by-step instructions to deploy this Language Learning App to Railway.

## Prerequisites

- GitHub account
- Railway account (sign up at https://railway.app)
- Git installed locally
- API keys for:
  - Anthropic Claude (https://console.anthropic.com/)
  - Cartesia (https://cartesia.ai/)

## Step 1: Initialize Git Repository

```bash
cd ~/language-learning-app

# Initialize git
git init

# Add all files
git add .

# Make first commit
git commit -m "Initial commit: Language Learning App v2"
```

## Step 2: Create GitHub Repository

### Option A: Using GitHub CLI (recommended)
```bash
# Install GitHub CLI if needed: brew install gh

# Login to GitHub
gh auth login

# Create repository and push
gh repo create language-learning-app --public --source=. --push
```

### Option B: Using GitHub Website
1. Go to https://github.com/new
2. Repository name: `language-learning-app`
3. Make it **Public** (or Private if you prefer)
4. Do NOT initialize with README (you already have one)
5. Click "Create repository"

Then push your code:
```bash
git remote add origin https://github.com/YOUR_USERNAME/language-learning-app.git
git branch -M main
git push -u origin main
```

## Step 3: Deploy to Railway

### 3.1 Connect GitHub

1. Go to https://railway.app
2. Click "Start a New Project"
3. Select "Deploy from GitHub repo"
4. Authorize Railway to access your GitHub
5. Select the `language-learning-app` repository

### 3.2 Set Environment Variables

Railway will start building immediately, but it will fail without API keys.

1. In your Railway project dashboard, click on your service
2. Go to the "Variables" tab
3. Add these environment variables:

```
ANTHROPIC_API_KEY=your-actual-anthropic-key
CARTESIA_API_KEY=your-actual-cartesia-key
```

Click "Add" for each one.

### 3.3 Redeploy

After adding environment variables:
1. Go to the "Deployments" tab
2. Click "Redeploy" on the latest deployment
   OR
   Just push a new commit to GitHub (Railway auto-deploys)

## Step 4: Access Your App

1. In Railway dashboard, click "Settings"
2. Scroll to "Networking"
3. Click "Generate Domain"
4. Railway will give you a URL like: `https://your-app-name.up.railway.app`
5. Open that URL in your browser!

## Step 5: Verify Deployment

Test that everything works:
- [ ] App loads in browser
- [ ] Language selector appears (Telugu, Tamil, Kannada)
- [ ] Mode selector appears (Guided, Conversational)
- [ ] Can start a scenario
- [ ] Audio plays (TTS)
- [ ] Microphone works (STT)
- [ ] Complexity badge updates

## Continuous Deployment

Once set up, Railway automatically deploys on every push to `main`:

```bash
# Make changes to your code
git add .
git commit -m "Add new feature"
git push origin main

# Railway automatically detects the push and deploys!
```

## Local Development

To run locally while developing:

```bash
# Set environment variables
export ANTHROPIC_API_KEY="your-key"
export CARTESIA_API_KEY="your-key"
export FLASK_ENV="development"  # Enables debug mode

# Run the app
python app.py

# Open browser to http://localhost:5000
```

## Troubleshooting

### Build Fails
- Check Railway build logs for errors
- Verify `requirements.txt` has all dependencies
- Make sure `Procfile` exists and is correct

### App Crashes on Start
- Check Railway deployment logs
- Verify environment variables are set (ANTHROPIC_API_KEY, CARTESIA_API_KEY)
- Check that port binding is correct (should use PORT from environment)

### 502 Bad Gateway
- App might be crashing - check logs
- Verify gunicorn is installed (should be in requirements.txt)
- Check that app.py runs without errors

### API Errors
- Verify API keys are correct
- Check that you have credits/quota on Anthropic and Cartesia
- Look at Railway logs for specific error messages

### Database Issues (telugu_srs.json)
- Railway has ephemeral filesystem - vocabulary data resets on redeploy
- For production, consider using Railway's PostgreSQL or persistent volume
- Current setup is fine for demo/personal use

## Costs

- **Railway**: Free tier includes 500 hours/month (enough for hobby projects)
- **Anthropic**: Pay per API call (~$0.003 per conversation turn)
- **Cartesia**: Check their pricing for TTS/STT usage

## Security Notes

- Never commit API keys to git (they're in .gitignore)
- Only set API keys in Railway environment variables
- Consider making GitHub repo private if you want to keep code private
- Railway automatically uses HTTPS

## Support

- Railway docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- This app's issues: https://github.com/YOUR_USERNAME/language-learning-app/issues

---

## Quick Command Reference

```bash
# Initial setup
git init
git add .
git commit -m "Initial commit"
gh repo create language-learning-app --public --source=. --push

# Make changes and deploy
git add .
git commit -m "Your change description"
git push origin main

# Run locally
export ANTHROPIC_API_KEY="your-key"
export CARTESIA_API_KEY="your-key"
python app.py
```

That's it! Your research-backed language learning app is now live on the internet! 🚀
