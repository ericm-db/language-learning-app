# Language Learning App v2 - Research-Backed Edition

An advanced language learning web application built on **second language acquisition research**. Features adaptive difficulty, two learning modes, and intelligent conversation partners.

🚀 **[See DEPLOYMENT.md for Railway deployment instructions](DEPLOYMENT.md)**

## Quick Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/YOUR_USERNAME/language-learning-app)

1. Click the button above (or see [DEPLOYMENT.md](DEPLOYMENT.md) for manual steps)
2. Set environment variables: `ANTHROPIC_API_KEY` and `CARTESIA_API_KEY`
3. Deploy!

**Live Demo**: Coming soon after you deploy!

## 🆕 What's New in V2

### Research-Based Features
- **Comprehensible Input (i+1)**: Automatically adjusts difficulty to stay just above your level
- **Adaptive Complexity**: Tracks your performance and adjusts in real-time
- **Two Learning Modes**: Choose between guided scaffolding or pure immersion
- **Implicit Correction**: Uses recasts (natural corrections) instead of explicit error marking
- **Narrow Focus**: Recycles vocabulary across turns for better retention

### Technical Improvements
- **Performance Tracking**: Monitors success rate to optimize difficulty
- **Better TTS**: Reads all conversation phrases, not just first one
- **Mode-Specific Prompts**: Different AI behavior for each learning mode

---

## 📚 Learning Modes

### Mode 1: Guided Immersion 📚
**Best for**: Beginners to intermediate learners

**Features**:
- Shows target language + transliteration + English translation
- Tutor provides scaffolding and explanations when needed
- Can use English for clarifications
- Save phrases to vocabulary for spaced repetition

**Example**:
```
🗣️ TUTOR SAYS:
నమస్కారం!
(namaskāraṁ!)
[Hello!]

మీరు ఎలా ఉన్నారు?
(mīru elā unnāru?)
[How are you?]

[🔊 Listen Again] [💾 Save]
```

### Mode 2: Pure Conversation 💬
**Best for**: Intermediate to advanced learners

**Features**:
- **Target language ONLY** - no translations, no transliterations
- Natural conversation partner (not a teacher)
- Adapts complexity based on how you respond
- Uses implicit corrections (recasts)
- No "tutorspeak" (no "good job!", "try saying...")

**Example**:
```
💬:
నమస్కారం! మీరు ఎలా ఉన్నారు?

[🔊 Listen Again]
```

**Adaptive Behavior**:
- If you respond well → Partner uses more sophisticated language
- If you struggle → Partner simplifies, uses context clues, shorter sentences

---

## 🎯 Adaptive Difficulty System

The app tracks your performance and automatically adjusts complexity:

### Level 1: Beginner
- Present tense only
- High-frequency vocabulary (top 500 words)
- Short sentences (3-7 words)
- Lots of repetition
- Example: "నమస్కారం. మీ పేరు ఏమిటి?" (Hello. What is your name?)

### Level 2: Intermediate
- Past/future tenses
- Broader vocabulary (500-2000 words)
- Longer sentences with clauses
- More varied expressions
- Example: "మీరు ఈ రోజు ఏమి చేశారు?" (What did you do today?)

### Level 3: Advanced
- Complex grammar, idioms
- Full vocabulary range
- Natural native speed
- Sophisticated expressions
- Example: "మీకు తెలుగు సినిమాలు చూడడం ఇష్టమా?" (Do you like watching Telugu movies?)

### How It Works
- **Success rate > 80%**: Difficulty increases (you're ready for more challenge)
- **Success rate 50-80%**: Maintains current level (optimal learning zone - i+1)
- **Success rate < 50%**: Simplifies (too hard, need to build foundation)

Evaluation happens every 5 exchanges automatically.

---

## 🌍 Supported Languages

- **Telugu** (తెలుగు)
- **Tamil** (தமிழ்)
- **Kannada** (ಕನ್ನಡ)

Easy to add more! See implementation guide below.

---

## 🚀 Setup & Installation

### Prerequisites
- Python 3.8+
- `uv` (fast Python package manager)
- Microphone for voice features

### Installation

1. **Install uv**:
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

2. **Set API keys**:
   ```bash
   export ANTHROPIC_API_KEY="your-anthropic-key"
   export CARTESIA_API_KEY="your-cartesia-key"
   ```

3. **Install dependencies**:
   ```bash
   uv sync
   ```

4. **Run the app**:
   ```bash
   uv run python app_v2.py
   ```

5. **Open browser**: Navigate to `http://localhost:5000`

---

## 📖 How to Use

### 1. Select Your Language & Mode
- Choose your target language from the dropdown (Telugu, Tamil, or Kannada)
- Select learning mode:
  - **📚 Guided**: For beginners, shows translations
  - **💬 Conversation**: For intermediate+, pure immersion

### 2. Practice Scenarios
- Pick a real-world scenario (café, market, etc.)
- Conversation starts automatically
- **Guided mode**: See translations, save phrases
- **Conversation mode**: Pure immersion, no English

### 3. Automatic Flow
1. Tutor speaks (audio plays automatically)
2. Recording starts when tutor finishes
3. You speak (5 seconds or click to stop)
4. Your speech is transcribed
5. Tutor responds
6. Repeat!

### 4. Watch Complexity Level
- Top right shows current level (Beginner/Intermediate/Advanced)
- Adjusts automatically based on your performance
- Green = Beginner, Yellow = Intermediate, Red = Advanced

### 5. Review with Spaced Repetition
- Phrases you save appear in review queue
- System schedules optimal review times (1, 3, 7, 14, 30, 60 days)
- Mark if you remembered or forgot
- Difficulty adjusts based on performance

---

## 🧠 Research Foundation

Based on these proven principles:

1. **Comprehensible Input (Krashen)**: Input should be i+1 (just above current level)
2. **Output Hypothesis (Swain)**: Production helps notice gaps and build automaticity
3. **Interaction Hypothesis (Long)**: Conversational negotiation promotes acquisition
4. **Spaced Repetition**: Optimal review timing improves long-term retention
5. **Task-Based Learning**: Real communication tasks > grammar drills
6. **Implicit Feedback**: Recasts (natural corrections) > explicit error correction
7. **Affective Filter**: Low anxiety, high motivation environment

For full research summary, see `LANGUAGE_LEARNING_RESEARCH.md`

---

## 📁 File Structure

```
.
├── app_v2.py                       # V2 backend (research-backed)
├── app.py                          # V1 backend (original)
├── templates/
│   ├── index_v2.html              # V2 frontend
│   └── index.html                 # V1 frontend
├── static/
│   ├── css/style.css              # Shared styles
│   └── js/
│       ├── app_v2.js              # V2 JavaScript
│       └── app.js                 # V1 JavaScript
├── telugu_srs.json                # Your vocabulary data
├── LANGUAGE_LEARNING_RESEARCH.md  # Research summary
├── FEATURE_DESIGN.md              # Feature specifications
└── README_V2.md                   # This file
```

---

## 🔧 Adding New Languages

Edit `app_v2.py` and add to the `LANGUAGES` dictionary:

```python
LANGUAGES = {
    # Existing languages...
    'hindi': {
        'name': 'Hindi',
        'code': 'hi',  # Cartesia language code
        'script_range': ('\u0900', '\u097F'),  # Unicode range for Devanagari
        'native_name': 'हिन्दी'
    }
}
```

The app automatically:
- Shows the language in the selector
- Uses correct language code for TTS/STT
- Detects the script range for audio extraction
- Generates appropriate prompts

---

## 💡 Tips for Effective Learning

### General
1. **Practice daily**: 10-15 minutes daily > 1 hour weekly
2. **Speak out loud**: Don't just think it - say it
3. **Stay in the i+1 zone**: If success rate is 50-80%, you're in the sweet spot
4. **Review regularly**: Check your spaced repetition queue daily

### For Guided Mode
- Save challenging phrases immediately
- Read transliterations to understand pronunciation
- Use English explanations when stuck
- Build confidence before switching to conversation mode

### For Conversation Mode
- Don't worry about understanding every word
- Use context clues when confused
- Respond naturally, even if imperfect
- Let the conversation flow - immerse yourself

### For Optimal Results
- Start with Guided mode as a beginner
- Switch to Conversation mode once comfortable (50%+ success rate)
- Mix both modes: Guided for new scenarios, Conversation for practice
- Review saved phrases regularly

---

## 🆚 V1 vs V2 Comparison

| Feature | V1 (Original) | V2 (Research-Backed) |
|---------|--------------|---------------------|
| Learning Modes | One (guided only) | Two (guided + conversational) |
| Difficulty | Static | Adaptive (tracks performance) |
| Prompts | Fixed | Research-optimized, mode-specific |
| TTS | May miss phrases | Reads all conversation |
| Feedback | Mixed | Implicit recasts (researched-backed) |
| Complexity Tracking | No | Yes (3 levels, auto-adjusts) |
| Success Tracking | No | Yes (informs difficulty) |

**Recommendation**: Use V2 for better learning outcomes.

---

## 🐛 Troubleshooting

### Complexity not changing
- Make sure you're responding (not just listening)
- It evaluates every 5 exchanges
- Check that responses are appropriate to the conversation

### Conversation mode too hard
- Switch to Guided mode temporarily
- The system will adapt down if success rate < 50%
- Try simpler responses to signal difficulty

### TTS not playing all phrases
- Check browser console for errors
- Verify Cartesia API key is set
- Try refreshing the page

### Microphone issues
- Check browser permissions (allow microphone access)
- Try a different browser if issues persist
- Use text input as fallback

---

## 📊 Success Metrics

Track your progress:
- **Exchanges**: How many conversation turns you've had
- **Success Rate**: Percentage of appropriate responses (aim for 50-80%)
- **Complexity Level**: Current difficulty (1-3)
- **Mastered Phrases**: Vocabulary reviewed 5+ times

---

## 🙏 Credits

Built on research by:
- Stephen Krashen (Comprehensible Input Hypothesis)
- Merrill Swain (Output Hypothesis)
- Michael Long (Interaction Hypothesis)
- Rod Ellis (Task-Based Learning)
- Roy Lyster & Leila Ranta (Corrective Feedback)

Powered by:
- **Anthropic Claude** (conversational AI)
- **Cartesia** (TTS/STT)
- **Flask** (web framework)

---

## 📝 License

Personal learning tool. Enjoy learning languages! 🌍
