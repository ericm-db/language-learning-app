# Language Learning Science: Research Summary

This document synthesizes current research on effective second language acquisition to guide app design.

---

## Core Principles from SLA Research

### 1. **Comprehensible Input (Krashen's Input Hypothesis)**

**Key Finding**: Learners acquire language when they understand messages that are slightly above their current level (i+1).

**Evidence**:
- Krashen (1985): "We acquire language when we understand messages"
- Input that is too easy (i+0) = no growth
- Input that is too hard (i+3) = incomprehensible, frustrating, no acquisition

**Implementation**:
- ✅ Track user performance to estimate current level
- ✅ Dynamically adjust vocabulary complexity
- ✅ Start simple, gradually increase difficulty
- ✅ Use context and visual cues to make input comprehensible
- ❌ Don't use random difficulty - adapt to user

---

### 2. **Output Hypothesis (Swain)**

**Key Finding**: Producing language (speaking/writing) helps learners:
- Notice gaps in their knowledge
- Test hypotheses about the language
- Develop automaticity

**Evidence**:
- Swain (1985): Output forces learners to move from semantic to syntactic processing
- Production reveals what you don't know (the "noticing" trigger)

**Implementation**:
- ✅ Require spoken responses, not just listening
- ✅ Create opportunities for extended output (not just one-word answers)
- ✅ Use prompts that require language production to complete tasks
- ❌ Don't let users passively consume - must produce

---

### 3. **Interaction Hypothesis (Long)**

**Key Finding**: Conversational interaction, especially negotiation of meaning, promotes acquisition.

**Evidence**:
- Long (1996): When learners negotiate meaning (ask for clarification, rephrase), they:
  - Get comprehensible input
  - Produce output
  - Receive feedback
  - Notice gaps

**Implementation**:
- ✅ Create real conversational exchanges, not scripted drills
- ✅ Tutor can ask for clarification when user makes errors
- ✅ Encourage negotiation ("What do you mean?", "Can you say that again?")
- ✅ Natural back-and-forth conversation

---

### 4. **Spaced Repetition (Ebbinghaus, Pimsleur)**

**Key Finding**: Review at increasing intervals dramatically improves long-term retention.

**Evidence**:
- Ebbinghaus (1885): Forgetting curve shows optimal review timing
- Pimsleur (1967): 5-second recall, 25-second, 2-minute, 10-minute, 1-hour, 5-hour, 1-day, 5-day, 25-day intervals
- Modern research: SM-2 algorithm (Anki) with 1, 3, 7, 14, 30, 60 day intervals

**Current Implementation**: ✅ Already implemented
**Improvements**:
- ✅ Track actual performance, not just reviews
- ✅ Re-encounter words in new contexts (not just flashcards)

---

### 5. **Task-Based Language Teaching (TBLT)**

**Key Finding**: Learning through meaningful tasks is more effective than grammar drills.

**Evidence**:
- Ellis (2003): Tasks should be:
  - Meaning-focused (communicate real information)
  - Have a clear outcome
  - Require use of language to complete
  - Engage learners' own resources

**Implementation**:
- ✅ Scenario-based learning (ordering coffee, asking directions)
- ✅ Focus on completing communicative goals
- ❌ Avoid decontextualized grammar exercises

---

### 6. **Focus on Form vs Focus on Meaning**

**Key Finding**: Both are needed, but timing matters.

**Evidence**:
- Doughty & Williams (1998): Implicit learning (acquiring through use) + explicit instruction (grammar explanation) work together
- BUT: Focus on form should be **incidental** - arise from communication breakdown, not pre-planned lessons

**Implementation**:
- ✅ Primary mode: Focus on meaning (conversation)
- ✅ Strategic mode: Brief grammar explanations when user struggles
- ✅ "Noticing" triggers: Highlight forms in context
- ❌ Don't front-load grammar before communication

---

### 7. **Corrective Feedback**

**Key Finding**: Implicit feedback (recasts) often better than explicit correction for fluency.

**Evidence**:
- Lyster & Ranta (1997): Different feedback types:
  - **Recast**: Tutor repeats correctly ("You: 'I go yesterday' → Tutor: 'Oh, you went yesterday?'")
  - **Explicit correction**: "No, you should say 'went'"
  - **Clarification request**: "What do you mean?"
  - **Metalinguistic**: "That's not the right tense"

- Recasts preserve conversation flow while modeling correct form
- Explicit correction can interrupt communication

**Implementation**:
- ✅ Default: Use recasts (tutor naturally models correct form)
- ✅ For persistent errors: Brief explicit explanation in L1
- ✅ Track error patterns to provide targeted review
- ❌ Don't interrupt every error - prioritize communication

---

### 8. **Narrow Listening/Reading (Cho & Krashen)**

**Key Finding**: Multiple inputs on the same topic (with vocabulary recycling) accelerates acquisition.

**Evidence**:
- Cho & Krashen (2019): Narrow reading (many texts on same topic) > wide reading
- Repeated exposure to vocabulary in varied contexts aids retention

**Implementation**:
- ✅ Stick with a scenario for multiple turns (recycle vocabulary)
- ✅ Follow-up questions that reuse previous vocabulary
- ✅ Thematic conversations, not random topics

---

### 9. **Affective Filter Hypothesis (Krashen)**

**Key Finding**: Anxiety, low motivation, and low self-confidence block acquisition.

**Evidence**:
- Krashen (1982): Comprehensible input won't be acquired if affective filter is high
- Low-stress environments → better acquisition

**Implementation**:
- ✅ Encouraging, non-judgmental tutor
- ✅ User controls difficulty (autonomy)
- ✅ Celebrate progress, normalize errors
- ✅ No time pressure, no public performance anxiety
- ❌ Avoid demotivating corrections or frustration

---

### 10. **Multimodal Learning**

**Key Finding**: Combining audio, text, and visuals enhances retention.

**Evidence**:
- Paivio (1971): Dual coding theory - verbal + visual = stronger memory
- Mayer (2009): Multimedia learning principles

**Current Implementation**:
- ✅ Audio (TTS)
- ✅ Text (script + transliteration)
- ⚠️  Could add: Images for vocabulary, visual scenarios

---

## Feature Design Based on Research

### Mode 1: **Guided Immersion Mode** (Current improved version)
- **For**: Beginners to intermediate
- **Characteristics**:
  - Shows target language + transliteration + English
  - Tutor uses recasts for errors
  - Brief L1 explanations when stuck
  - Comprehensible input with scaffolding

### Mode 2: **Pure Conversational Mode** (NEW)
- **For**: Intermediate to advanced
- **Characteristics**:
  - Target language only, no translations shown
  - Tutor speaks naturally, no "tutorspeak"
  - Implicit feedback only (recasts, not corrections)
  - Adapts complexity based on user performance
  - Focus 100% on meaning, form only if communication breaks down

### Mode 3: **Review Mode** (Current - already good)
- Spaced repetition based
- Re-encounter phrases in new contexts

---

## Adaptive Difficulty System

### Track User Performance
```python
performance_metrics = {
    'comprehension_rate': 0.0,  # Do they understand tutor?
    'production_fluency': 0.0,  # How quickly/easily they respond
    'error_rate': 0.0,          # Grammatical/vocabulary errors
    'vocabulary_level': 1,      # 1=beginner, 2=intermediate, 3=advanced
    'recent_successes': [],     # Track last 10 exchanges
}
```

### Adjust Input Difficulty
- **High success rate (>80%)**: Increase complexity
  - Introduce new vocabulary
  - Use more complex grammar
  - Speak faster (longer utterances)

- **Medium success (50-80%)**: Maintain (optimal i+1 zone)
  - Continue at current level
  - Recycle recent vocabulary

- **Low success (<50%)**: Simplify
  - Use only known vocabulary
  - Shorter sentences
  - More repetition
  - Code-switch to English for clarity

---

## Conversation Prompts

### For Guided Mode (with scaffolding):
```
You are a friendly {language} tutor. Have a natural conversation about {scenario}.

PEDAGOGICAL APPROACH:
1. Use comprehensible input - adjust complexity to user's level
2. Recycle vocabulary across multiple turns
3. Use recasts to correct errors naturally
4. Provide brief English explanations ONLY when user is stuck
5. Ask follow-up questions that require meaningful responses

FORMAT:
{Language} text
(transliteration)
[English translation]

Start with very simple greetings and build slowly.
```

### For Pure Conversational Mode (immersion):
```
You are a native {language} speaker having a casual conversation about {scenario}.

CRITICAL RULES:
1. Speak ONLY in {language} - no English, no translations, no tutorspeak
2. Adapt your language complexity based on the user's responses:
   - If they struggle: simplify, use gestures/context, rephrase
   - If they succeed: gradually increase sophistication
3. Respond naturally to what they say, like a real conversation
4. Use implicit correction: if they make an error, naturally use the correct form in your next response
5. Stay in character - you're not a teacher, you're a conversation partner

DO NOT:
- Explain grammar
- Translate to English
- Say things like "good job" or "try to say..."
- Use formatted translations

Just have a real conversation.
```

---

## Implementation Priority

1. ✅ Fix TTS to properly read all conversational phrases
2. ✅ Add conversational mode toggle
3. ✅ Implement adaptive difficulty tracking
4. ✅ Update prompts for both modes
5. ⚠️  Consider: Visual aids (future enhancement)
6. ⚠️  Consider: Error pattern analysis for targeted review (future)

---

## References

- Krashen, S. (1985). *The Input Hypothesis*
- Swain, M. (1985). Communicative competence: Some roles of comprehensible input and output
- Long, M. (1996). The role of the linguistic environment in second language acquisition
- Ellis, R. (2003). *Task-based Language Learning and Teaching*
- Lyster, R., & Ranta, L. (1997). Corrective feedback and learner uptake
- Cho, K. S., & Krashen, S. (2019). Pleasure reading in a foreign language and competence in speaking, listening, reading and writing
