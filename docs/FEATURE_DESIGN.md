# Feature Design: Research-Backed Language Learning App

Based on `LANGUAGE_LEARNING_RESEARCH.md`, here's the concrete feature specification.

---

## Learning Modes

### Mode 1: **Guided Immersion** (Scaffolded Learning)
**Target Users**: Beginners to intermediate learners

**What the user sees**:
```
🗣️ TUTOR SAYS:
నమస్కారం! మీరు ఎలా ఉన్నారు?
(namaskāraṁ! mīru elā unnāru?)
[Hello! How are you?]

🔊 [Audio plays automatically]
🎤 [Recording starts after audio]
```

**Tutor behavior**:
- Shows target language + transliteration + English
- Uses recasts for corrections
- Can use English for brief clarifications when user is stuck
- Adjusts difficulty based on performance

---

### Mode 2: **Pure Conversation** (Immersion)
**Target Users**: Intermediate to advanced learners

**What the user sees**:
```
🗣️ CONVERSATION PARTNER:
నమస్కారం! మీరు ఎలా ఉన్నారు?

🔊 [Audio plays automatically]
🎤 [Recording starts after audio]
```

**Conversation partner behavior**:
- Target language ONLY - no transliteration, no English translations
- Speaks naturally like a real person
- Uses context/gestures/rephrasing when user doesn't understand
- Implicit corrections only (recasts)
- Adapts complexity based on how user responds
- No "tutorspeak" (no "good job!", "try saying...")

**Example of adaptive difficulty**:
- User responds well → Partner uses more complex vocabulary, longer sentences
- User struggles → Partner simplifies, uses more context clues, shorter sentences

---

## Adaptive Difficulty System

### Performance Tracking

Track per session:
```python
session_metrics = {
    'exchanges': 0,
    'successful_responses': 0,  # User responded appropriately
    'struggled_responses': 0,   # User couldn't respond or needed help
    'current_complexity': 1,    # 1=beginner, 2=intermediate, 3=advanced
}
```

### Complexity Levels

**Level 1: Beginner**
- Very simple present tense
- High-frequency vocabulary (100-500 most common words)
- Short sentences (3-7 words)
- Lots of repetition and recycling
- Example: "నమస్కారం. మీ పేరు ఏమిటి?" (Hello. What is your name?)

**Level 2: Intermediate**
- Past/future tenses
- Broader vocabulary (500-2000 words)
- Longer sentences with clauses
- More varied expressions
- Example: "మీరు ఈ రోజు ఏమి చేశారు?" (What did you do today?)

**Level 3: Advanced**
- Complex grammar, idioms
- Full vocabulary range
- Natural native speed
- Sophisticated expressions
- Example: "మీకు తెలుగు సినిమాలు చూడడం ఇష్టమా? ఏ రకమైన సినిమాలు?" (Do you like watching Telugu movies? What kind?)

### Adaptation Logic

Every 3-5 exchanges, evaluate:

```python
success_rate = successful_responses / total_exchanges

if success_rate > 0.8:
    # Too easy - increase complexity
    current_complexity = min(3, current_complexity + 1)
    instruction = "Increase vocabulary sophistication and sentence length"

elif success_rate < 0.5:
    # Too hard - decrease complexity
    current_complexity = max(1, current_complexity - 1)
    instruction = "Simplify: use shorter sentences, basic vocabulary, more repetition"

else:
    # Just right (i+1 zone) - maintain
    instruction = "Maintain current complexity"
```

---

## System Prompts

### Guided Immersion Mode Prompt

```
You are a friendly {language} tutor helping a learner practice in a "{scenario}" situation.

PEDAGOGICAL PRINCIPLES:
1. COMPREHENSIBLE INPUT: Match complexity to user's level (currently: {complexity_level})
2. NARROW FOCUS: Recycle vocabulary across multiple turns - don't introduce too many new words at once
3. IMPLICIT CORRECTION: When user makes errors, naturally use the correct form in your response (recast)
4. STRATEGIC L1: Use English explanations ONLY when user is clearly stuck or asks for help
5. MEANINGFUL INTERACTION: Ask follow-up questions that require substantive responses

COMPLEXITY LEVEL {complexity_level}:
{complexity_instructions}

FORMAT (IMPORTANT):
{Language} text
(transliteration)
[English translation]

EXAMPLE:
నమస్కారం!
(namaskāraṁ!)
[Hello!]

మీరు ఎలా ఉన్నారు?
(mīru elā unnāru?)
[How are you?]

Keep each turn SHORT (1-3 sentences maximum). Let the conversation develop naturally.

Start the conversation now.
```

### Pure Conversational Mode Prompt

```
You are a native {language} speaker having a casual, natural conversation about "{scenario}".

CRITICAL RULES:
1. SPEAK ONLY IN {LANGUAGE} - absolutely no English, no translations, no transliterations
2. BE A REAL PERSON, NOT A TUTOR:
   - No "Good job!", "Try saying...", "Let me help you..."
   - No teaching language like "In {language}, we say..."
   - Just respond naturally like you're texting a friend
3. ADAPT TO USER'S LEVEL:
   - If they respond fluently → match their sophistication, introduce variety
   - If they seem confused → simplify, rephrase, use context clues
   - If they make errors → naturally use the correct form in your reply (don't point it out)
4. STAY IN SCENARIO: You're a real person in this situation, not a language teacher

CURRENT COMPLEXITY ADJUSTMENT: {complexity_level}
{complexity_instructions}

DO NOT USE ANY FORMATTING. Just write naturally in {language}.

Example of what TO DO:
నమస్కారం! మీరు ఎలా ఉన్నారు?

Example of what NOT to do:
నమస్కారం! (namaskāraṁ!) [Hello!]  ← NO! This is tutorspeak!
"Good! Now try to ask me..." ← NO! Not a teacher!

You are having a real conversation. Start naturally.
```

---

## TTS Handling

### Problem
Current code might not handle multi-sentence conversations well if tutor says multiple things.

### Solution

```python
def extract_target_language_text(text, script_start, script_end):
    """
    Extract ALL target language text from conversation, handling multiple sentences.

    For Guided Mode: Extract all lines containing target script
    For Pure Conversational Mode: The entire response should be in target language
    """
    lines = text.split('\n')
    language_parts = []

    for line in lines:
        line = line.strip()

        # Skip empty lines
        if not line:
            continue

        # Skip annotation-only lines (transliteration/translation)
        if (line.startswith('(') and line.endswith(')')) or \
           (line.startswith('[') and line.endswith(']')):
            continue

        # Check if line contains target language script
        if any(script_start <= c <= script_end for c in line):
            # For guided mode, might have inline annotations - extract just the text
            # For conversational mode, whole line should be target language
            language_parts.append(line)

    # Join with natural pauses (sentence boundaries)
    return ' '.join(language_parts)
```

---

## UI Changes

### Mode Selector

Add to header next to language selector:

```html
<div class="mode-selector">
    <label for="modeSelect">Mode:</label>
    <select id="modeSelect" onchange="changeMode()">
        <option value="guided">📚 Guided (with translations)</option>
        <option value="conversational">💬 Pure Conversation</option>
    </select>
</div>
```

### Conversation Display

**Guided Mode** (current):
```
🗣️ TUTOR SAYS:
నమస్కారం!
(namaskāraṁ!)
[Hello!]

[🔊 Listen Again] [💾 Save]
```

**Conversational Mode** (simplified):
```
💬:
నమస్కారం!

[🔊 Listen Again]
```

No translations, no Save button (immersion focus)

---

## Performance Tracking API

New endpoints:

### `POST /api/track-performance`
```json
{
    "session_id": "abc123",
    "success": true,  // Did user respond appropriately?
    "user_text": "నేను బాగున్నాను"
}
```

Returns updated complexity level and instructions for AI.

---

## Implementation Checklist

Backend (`app.py`):
- [ ] Add conversation mode to session state ("guided" | "conversational")
- [ ] Add performance tracking to session state
- [ ] Create adaptive prompt generator based on mode + complexity
- [ ] Improve TTS text extraction
- [ ] Add `/api/track-performance` endpoint
- [ ] Update `/api/start-conversation` to accept mode parameter
- [ ] Update AI prompts based on mode

Frontend:
- [ ] Add mode selector UI
- [ ] Adjust conversation display based on mode (hide translations in conversational)
- [ ] Track user response quality (did they respond? need help?)
- [ ] Call performance tracking API
- [ ] Update status messages for conversational mode

---

## Success Metrics

### For Guided Mode:
- User stays engaged (doesn't quit early)
- Success rate stays in 50-80% range (i+1 zone)
- Vocabulary retention in spaced repetition

### For Conversational Mode:
- User produces extended utterances (not just 1-word answers)
- Conversation feels natural (measured by turn length)
- Complexity naturally increases over time

---

## Future Enhancements (Not MVP)

1. **Error Pattern Analysis**: Track common errors → generate targeted review
2. **Visual Context**: Show images relevant to scenario
3. **Listening-Only Mode**: Practice comprehension without production
4. **Recording Playback**: Let users hear their own pronunciation
5. **Multi-Turn Planning**: Tutor remembers conversation context across sessions
