#!/usr/bin/env python3
"""
Language Learning Web App v2 - Research-Backed Edition

Based on second language acquisition research, implements:
- Comprehensible input (i+1)
- Output hypothesis
- Adaptive difficulty
- Two learning modes: Guided vs Pure Conversational
- Implicit corrective feedback (recasts)
"""

import os
import sys
import json
import wave
import tempfile
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path
import re

from flask import Flask, render_template, request, jsonify, send_file
import anthropic
from cartesia import Cartesia

# Load environment variables from .env file
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    print("Warning: python-dotenv not installed. Using system environment variables only.")

# Language configuration
LANGUAGES = {
    'telugu': {
        'name': 'Telugu',
        'code': 'te',
        'script_range': ('\u0C00', '\u0C7F'),
        'native_name': 'తెలుగు'
    },
    'tamil': {
        'name': 'Tamil',
        'code': 'ta',
        'script_range': ('\u0B80', '\u0BFF'),
        'native_name': 'தமிழ்'
    },
    'kannada': {
        'name': 'Kannada',
        'code': 'kn',
        'script_range': ('\u0C80', '\u0CFF'),
        'native_name': 'ಕನ್ನಡ'
    }
}

# Complexity levels for adaptive difficulty
COMPLEXITY_INSTRUCTIONS = {
    1: """BEGINNER LEVEL:
- Use ONLY present tense, simple sentences (3-7 words)
- High-frequency vocabulary (top 500 most common words)
- Lots of repetition - recycle the same words in different sentences
- Examples: greetings, numbers, colors, basic actions""",

    2: """INTERMEDIATE LEVEL:
- Introduce past and future tenses
- Broader vocabulary (500-2000 common words)
- Longer sentences with simple clauses
- More varied expressions
- Ask questions that require explanations, not just yes/no""",

    3: """ADVANCED LEVEL:
- Complex grammar structures, conditional sentences
- Full vocabulary range including idioms
- Natural native speaking speed
- Sophisticated expressions and cultural references
- Discuss abstract topics and opinions"""
}

# Scenarios
SCENARIOS = [
    "ordering coffee at a café",
    "buying vegetables at the market",
    "greeting a family member",
    "asking for directions",
    "introducing yourself to someone new",
    "ordering food at a restaurant",
    "shopping for clothes"
]


# Spaced Repetition System
class SpacedRepetitionSystem:
    """Simple spaced repetition system for vocabulary tracking"""

    def __init__(self):
        self.vocab_file = 'vocabulary.json'
        self.vocabulary = self._load_vocabulary()

    def _load_vocabulary(self):
        """Load vocabulary from file"""
        if os.path.exists(self.vocab_file):
            try:
                with open(self.vocab_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                return []
        return []

    def _save_vocabulary(self):
        """Save vocabulary to file"""
        try:
            with open(self.vocab_file, 'w', encoding='utf-8') as f:
                json.dump(self.vocabulary, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"Error saving vocabulary: {e}")

    def add_difficult_phrase(self, telugu: str, transliteration: str, english: str, context: str = ''):
        """Add a difficult phrase to vocabulary"""
        phrase = {
            'telugu': telugu,
            'transliteration': transliteration,
            'english': english,
            'context': context,
            'added': datetime.now().isoformat(),
            'next_review': datetime.now().isoformat(),
            'interval': 1,  # days
            'ease_factor': 2.5,
            'reviews': 0,
            'correct': 0
        }
        self.vocabulary.append(phrase)
        self._save_vocabulary()

    def get_due_reviews(self):
        """Get phrases due for review"""
        now = datetime.now()
        due = []
        for phrase in self.vocabulary:
            next_review = datetime.fromisoformat(phrase['next_review'])
            if next_review <= now:
                due.append(phrase)
        return sorted(due, key=lambda x: x['next_review'])

    def mark_reviewed(self, telugu: str, success: bool):
        """Mark a phrase as reviewed and update its schedule"""
        for phrase in self.vocabulary:
            if phrase['telugu'] == telugu:
                phrase['reviews'] += 1
                if success:
                    phrase['correct'] += 1
                    # Increase interval (SM-2 algorithm simplified)
                    phrase['interval'] = max(1, int(phrase['interval'] * phrase['ease_factor']))
                    phrase['ease_factor'] = max(1.3, phrase['ease_factor'] + 0.1)
                else:
                    # Reset interval on failure
                    phrase['interval'] = 1
                    phrase['ease_factor'] = max(1.3, phrase['ease_factor'] - 0.2)

                phrase['next_review'] = (datetime.now() + timedelta(days=phrase['interval'])).isoformat()
                self._save_vocabulary()
                break

    def get_all_vocab(self):
        """Get all vocabulary items"""
        return self.vocabulary

    def get_stats(self):
        """Get vocabulary statistics"""
        total = len(self.vocabulary)
        due = len(self.get_due_reviews())
        mastered = sum(1 for p in self.vocabulary if p.get('ease_factor', 0) > 2.5 and p.get('reviews', 0) > 3)

        return {
            'total': total,
            'due': due,
            'mastered': mastered
        }


class VocabularyTracker:
    """Tracks user's vocabulary knowledge based on CEFR levels"""

    def __init__(self, language='telugu'):
        self.language = language
        self.vocab_dir = Path('vocabulary')
        self.user_vocab_file = f'user_vocabulary_{language}.json'

        # Load tier vocabulary
        self.tiers = self._load_tiers()

        # Load user's vocabulary knowledge
        self.user_vocab = self._load_user_vocabulary()

    def _load_tiers(self):
        """Load vocabulary tiers from JSON files"""
        tiers = {}
        for level in ['a1', 'a2', 'b1']:
            tier_file = self.vocab_dir / f'{self.language}_{level}.json'
            if tier_file.exists():
                try:
                    with open(tier_file, 'r', encoding='utf-8') as f:
                        tier_data = json.load(f)
                        # Flatten words from all categories
                        all_words = []
                        for category_data in tier_data['categories'].values():
                            all_words.extend(category_data['words'])
                        tiers[level.upper()] = {
                            'words': all_words,
                            'total': len(all_words),
                            'requirements': tier_data.get('scenario_requirements', {}),
                            'minimum_mastery': tier_data.get(f'minimum_mastery_before_{chr(ord(level[0])+1)}2' if level != 'b1' else 'minimum_mastery_before_b2', 0)
                        }
                except Exception as e:
                    print(f"Error loading tier {level}: {e}")
        return tiers

    def _load_user_vocabulary(self):
        """Load user's vocabulary progress"""
        if os.path.exists(self.user_vocab_file):
            try:
                with open(self.user_vocab_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                return self._init_user_vocab()
        return self._init_user_vocab()

    def _init_user_vocab(self):
        """Initialize user vocabulary tracking"""
        return {
            'current_level': 'A1',
            'words': {},  # {telugu_word: {encounters: int, successes: int, last_seen: iso_datetime}}
            'level_progress': {
                'A1': {'exposed': 0, 'mastered': 0},
                'A2': {'exposed': 0, 'mastered': 0},
                'B1': {'exposed': 0, 'mastered': 0}
            }
        }

    def _save_user_vocabulary(self):
        """Save user's vocabulary progress"""
        try:
            with open(self.user_vocab_file, 'w', encoding='utf-8') as f:
                json.dump(self.user_vocab, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"Error saving user vocabulary: {e}")

    def record_word_exposure(self, telugu_word: str, understood: bool):
        """Record that user encountered a word"""
        if telugu_word not in self.user_vocab['words']:
            self.user_vocab['words'][telugu_word] = {
                'encounters': 0,
                'successes': 0,
                'last_seen': datetime.now().isoformat()
            }

        word_data = self.user_vocab['words'][telugu_word]
        word_data['encounters'] += 1
        if understood:
            word_data['successes'] += 1
        word_data['last_seen'] = datetime.now().isoformat()

        self._save_user_vocabulary()

    def is_word_mastered(self, telugu_word: str) -> bool:
        """Check if a word is mastered (3+ successful encounters, 80%+ success rate)"""
        if telugu_word not in self.user_vocab['words']:
            return False

        word_data = self.user_vocab['words'][telugu_word]
        if word_data['encounters'] < 3:
            return False

        success_rate = word_data['successes'] / word_data['encounters']
        return success_rate >= 0.8

    def get_allowed_vocabulary_for_level(self, level: str) -> list:
        """Get list of words allowed at this level"""
        allowed_words = []

        # Include all words from current and previous levels
        level_order = ['A1', 'A2', 'B1']
        current_idx = level_order.index(level) if level in level_order else 0

        for i in range(current_idx + 1):
            tier_level = level_order[i]
            if tier_level in self.tiers:
                allowed_words.extend([w['telugu'] for w in self.tiers[tier_level]['words']])

        return allowed_words

    def calculate_known_word_percentage(self, conversation_text: str, level: str) -> float:
        """Calculate what % of words in text are known to user"""
        # Extract Telugu words from text
        words = re.findall(r'[\u0C00-\u0C7F]+', conversation_text)
        if not words:
            return 0.0

        known_count = sum(1 for w in words if self.is_word_mastered(w))
        return known_count / len(words)

    def get_vocabulary_instructions_for_level(self, level: str) -> str:
        """Generate vocabulary instructions for Claude based on user's level"""
        allowed_words = self.get_allowed_vocabulary_for_level(level)
        mastered_words = [w for w in allowed_words if self.is_word_mastered(w)]

        level_info = self.tiers.get(level, {})

        # Build explicit word list instruction
        instruction = f"""VOCABULARY CONSTRAINTS FOR {level}:
- You MUST use primarily words the user has already mastered: {len(mastered_words)} words
- You may introduce 1-3 NEW words per conversation turn from the {level} tier
- RECYCLE previously used words across multiple turns (minimum 6-10 encounters per new word)
- Target: User should know 95%+ of words in each utterance

"""

        if level == 'A1':
            instruction += """A1 CORE VOCABULARY (300 words):
- Concrete, survival vocabulary only
- Greetings, pronouns, basic verbs (go, come, eat, drink)
- Numbers 1-10, immediate family, basic food items
- High-frequency words only"""
        elif level == 'A2':
            instruction += """A2 EXPANDED VOCABULARY (700 additional words):
- Past and future tense forms
- Expanded food vocabulary, clothing, weather
- Days of week, time expressions
- Transportation and places"""
        elif level == 'B1':
            instruction += """B1 INTERMEDIATE VOCABULARY (1000 additional words):
- Abstract concepts (thought, problem, solution)
- Conditional expressions
- Common idioms and formal language
- Technology and activities"""

        return instruction

    def get_current_cefr_level(self) -> str:
        """Determine user's current CEFR level based on mastery"""
        progress = self.user_vocab['level_progress']

        # Check if ready for B1
        if progress['A2']['mastered'] >= self.tiers.get('A2', {}).get('minimum_mastery', 600):
            return 'B1'

        # Check if ready for A2
        if progress['A1']['mastered'] >= self.tiers.get('A1', {}).get('minimum_mastery', 240):
            return 'A2'

        return 'A1'

    def update_level_progress(self):
        """Update progress statistics for each level"""
        for level in ['A1', 'A2', 'B1']:
            if level not in self.tiers:
                continue

            tier_words = [w['telugu'] for w in self.tiers[level]['words']]
            exposed = sum(1 for w in tier_words if w in self.user_vocab['words'])
            mastered = sum(1 for w in tier_words if self.is_word_mastered(w))

            self.user_vocab['level_progress'][level] = {
                'exposed': exposed,
                'mastered': mastered
            }

        self._save_user_vocabulary()

    def get_stats(self) -> dict:
        """Get vocabulary statistics"""
        self.update_level_progress()
        return {
            'current_level': self.get_current_cefr_level(),
            'progress': self.user_vocab['level_progress'],
            'total_words_known': len([w for w in self.user_vocab['words'] if self.is_word_mastered(w)])
        }


# Initialize Flask
app = Flask(__name__)

# Initialize API clients
anthropic_client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
cartesia_client = Cartesia(api_key=os.getenv("CARTESIA_API_KEY"))

# Initialize SRS
srs = SpacedRepetitionSystem()

# Initialize vocabulary tracker
vocab_tracker = VocabularyTracker(language='telugu')

# Conversation state
conversation_state = {}


class PerformanceTracker:
    """Tracks user performance to adapt difficulty"""

    def __init__(self, vocab_tracker=None):
        self.exchanges = 0
        self.successful = 0
        self.struggled = 0
        self.current_complexity = 1  # Start at beginner
        self.vocab_tracker = vocab_tracker
        self.consecutive_successes = 0
        self.consecutive_failures = 0
        self.exchanges_at_current_level = 0

    def record_exchange(self, success: bool):
        """Record an exchange and update complexity"""
        self.exchanges += 1
        self.exchanges_at_current_level += 1

        if success:
            self.successful += 1
            self.consecutive_successes += 1
            self.consecutive_failures = 0
        else:
            self.struggled += 1
            self.consecutive_failures += 1
            self.consecutive_successes = 0

        # Evaluate every 15 exchanges (was 5 - research-backed change)
        if self.exchanges % 15 == 0:
            self._adjust_complexity()

    def _adjust_complexity(self):
        """
        Adjust complexity based on success rate and mastery requirements.
        Research-backed: Requires sustained performance and minimum exposure time.
        """
        if self.exchanges == 0:
            return

        success_rate = self.successful / self.exchanges

        # LEVEL UP REQUIREMENTS (stricter - research-backed)
        # Requires: 80%+ success rate, 3+ consecutive successes, 15+ exchanges at current level
        can_level_up = (
            success_rate > 0.8 and
            self.consecutive_successes >= 3 and
            self.exchanges_at_current_level >= 15 and
            self.current_complexity < 3
        )

        # LEVEL DOWN REQUIREMENTS (to prevent frustration)
        # Requires: <50% success rate OR 3+ consecutive failures
        should_level_down = (
            (success_rate < 0.5 or self.consecutive_failures >= 3) and
            self.current_complexity > 1
        )

        if can_level_up:
            self.current_complexity += 1
            self.exchanges_at_current_level = 0
            self.consecutive_successes = 0
            print(f"📈 Increasing complexity to level {self.current_complexity} (CEFR: {self.get_cefr_level()})")
        elif should_level_down:
            self.current_complexity -= 1
            self.exchanges_at_current_level = 0
            self.consecutive_failures = 0
            print(f"📉 Decreasing complexity to level {self.current_complexity} (CEFR: {self.get_cefr_level()})")
        # else: maintain current complexity (50-80% is ideal i+1 zone)

    def get_complexity_instruction(self):
        """Get instructions for current complexity level"""
        return COMPLEXITY_INSTRUCTIONS.get(self.current_complexity, COMPLEXITY_INSTRUCTIONS[1])

    def get_cefr_level(self):
        """Map complexity level (1-3) to CEFR level (A1-B1)"""
        mapping = {1: 'A1', 2: 'A2', 3: 'B1'}
        return mapping.get(self.current_complexity, 'A1')

    def get_vocabulary_instruction(self):
        """Get vocabulary instructions based on CEFR level"""
        if self.vocab_tracker:
            cefr_level = self.get_cefr_level()
            return self.vocab_tracker.get_vocabulary_instructions_for_level(cefr_level)
        return ""

    def get_stats(self):
        """Get performance statistics"""
        return {
            'exchanges': self.exchanges,
            'successful': self.successful,
            'struggled': self.struggled,
            'complexity': self.current_complexity,
            'cefr_level': self.get_cefr_level(),
            'success_rate': self.successful / self.exchanges if self.exchanges > 0 else 0
        }


def generate_guided_prompt(language_name: str, scenario: str, complexity_tracker: PerformanceTracker):
    """Generate prompt for guided immersion mode"""
    complexity_instruction = complexity_tracker.get_complexity_instruction()
    vocabulary_instruction = complexity_tracker.get_vocabulary_instruction()

    return f"""You are a friendly {language_name} tutor helping a learner practice in a "{scenario}" situation.

PEDAGOGICAL PRINCIPLES:
1. COMPREHENSIBLE INPUT (i+1): Match complexity to user's level
2. VOCABULARY RECYCLING: Reuse words across turns - introduce new words gradually
3. IMPLICIT CORRECTION: When user makes errors, naturally model the correct form in your response
4. STRATEGIC L1: Use English explanations ONLY when user is clearly stuck
5. MEANINGFUL INTERACTION: Ask follow-up questions that require substantive responses

CURRENT COMPLEXITY LEVEL: {complexity_tracker.current_complexity} ({complexity_tracker.get_cefr_level()})
{complexity_instruction}

{vocabulary_instruction}

FORMAT (CRITICAL - FOLLOW EXACTLY):
{language_name} text
(transliteration)
[English translation]

EXAMPLE TURN:
నమస్కారం!
(namaskāraṁ!)
[Hello!]

మీరు ఎలా ఉన్నారు?
(mīru elā unnāru?)
[How are you?]

IMPORTANT:
- Keep each turn SHORT (1-3 sentences maximum)
- Each {language_name} sentence on its own line
- Transliteration in parentheses on next line
- English translation in brackets on next line
- Maintain this structure for EVERY sentence

Start the conversation naturally. Greet the user."""


def generate_conversational_prompt(language_name: str, scenario: str, complexity_tracker: PerformanceTracker):
    """Generate prompt for pure conversational mode"""
    complexity_instruction = complexity_tracker.get_complexity_instruction()
    vocabulary_instruction = complexity_tracker.get_vocabulary_instruction()

    return f"""You are a native {language_name} speaker having a casual, natural conversation about "{scenario}".

CRITICAL RULES:
1. SPEAK ONLY IN {language_name.upper()} - absolutely NO English, NO translations, NO transliterations
2. BE A REAL PERSON, NOT A TUTOR:
   - NO teaching language: No "good job!", "try saying...", "in {language_name} we say..."
   - Just respond naturally like you're talking to a friend
3. ADAPT TO USER'S LEVEL:
   - If they respond fluently → match their sophistication
   - If they seem confused → simplify, rephrase, use context
   - If they make errors → naturally use correct form in your reply (don't point it out)
4. STAY IN CHARACTER: You're a real person in this situation

COMPLEXITY ADJUSTMENT: Level {complexity_tracker.current_complexity} ({complexity_tracker.get_cefr_level()})
{complexity_instruction}

{vocabulary_instruction}

DO NOT FORMAT YOUR RESPONSE. Just write pure {language_name} text naturally.

WRONG (DO NOT DO THIS):
నమస్కారం! (namaskāraṁ!) [Hello!]  ← NO TRANSLATIONS!
"Good job! Now try..." ← NOT A TEACHER!

RIGHT (DO THIS):
నమస్కారం! మీరు ఎలా ఉన్నారు?

Start the conversation now. Be natural."""


def extract_target_language_for_tts(text: str, script_start: str, script_end: str, mode: str):
    """
    Extract target language text for TTS, handling both modes.

    For guided mode: Extract all target language lines (skip transliterations/translations)
    For conversational mode: The entire text should be target language
    """
    lines = text.split('\n')
    language_parts = []

    for line in lines:
        line = line.strip()

        if not line:
            continue

        # Skip annotation lines (parentheses = transliteration, brackets = translation)
        if (line.startswith('(') and line.endswith(')')) or \
           (line.startswith('[') and line.endswith(']')):
            continue

        # Check if line contains target script
        if any(script_start <= c <= script_end for c in line):
            language_parts.append(line)

    return ' '.join(language_parts)


# Routes

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/languages')
def get_languages():
    return jsonify(LANGUAGES)


@app.route('/api/scenarios')
def get_scenarios():
    """Get scenarios with difficulty ratings based on vocabulary requirements"""
    user_level = vocab_tracker.get_current_cefr_level()
    mastered_count = len([word for word in vocab_tracker.user_vocab['words'].keys() if vocab_tracker.is_word_mastered(word)])

    # Map scenarios to difficulty
    scenario_info = []
    for scenario in SCENARIOS:
        # Determine difficulty based on scenario
        if scenario in ["greeting a family member", "introducing yourself to someone new"]:
            required_level = "A1"
            required_words = 0  # Complete beginners can start here
        elif scenario in ["ordering coffee at a café"]:
            required_level = "A1"
            required_words = 20  # After basic greetings
        elif scenario in ["buying vegetables at the market", "ordering food at a restaurant", "shopping for clothes"]:
            required_level = "A2"
            required_words = 100
        elif scenario in ["asking for directions"]:
            required_level = "A2"
            required_words = 80
        else:
            required_level = "A1"
            required_words = 0  # Default: allow beginners

        # Check if user is ready
        level_order = {'A1': 1, 'A2': 2, 'B1': 3}
        user_level_num = level_order.get(user_level, 1)
        required_level_num = level_order.get(required_level, 1)

        is_ready = (user_level_num >= required_level_num and mastered_count >= required_words)

        scenario_info.append({
            'name': scenario,
            'required_level': required_level,
            'required_words': required_words,
            'is_ready': is_ready,
            'user_progress': mastered_count
        })

    return jsonify(scenario_info)


@app.route('/api/stats')
def get_stats():
    stats = srs.get_stats()
    return jsonify(stats)


@app.route('/api/start-conversation', methods=['POST'])
def start_conversation():
    """Start a new conversation with mode and adaptive difficulty"""
    data = request.json
    scenario = data.get('scenario', SCENARIOS[0])
    session_id = data.get('session_id', 'default')
    language_key = data.get('language', 'telugu')
    mode = data.get('mode', 'guided')  # 'guided' or 'conversational'

    # Get language config
    lang_config = LANGUAGES.get(language_key, LANGUAGES['telugu'])
    lang_name = lang_config['name']

    # Initialize performance tracker with vocabulary tracker
    tracker = PerformanceTracker(vocab_tracker=vocab_tracker)

    # Generate appropriate prompt based on mode
    if mode == 'conversational':
        system_prompt = generate_conversational_prompt(lang_name, scenario, tracker)
    else:  # guided
        system_prompt = generate_guided_prompt(lang_name, scenario, tracker)

    # Initialize conversation state
    conversation_state[session_id] = {
        'scenario': scenario,
        'language': language_key,
        'mode': mode,
        'tracker': tracker,
        'history': [{
            "role": "user",
            "content": f"Let's practice {scenario}. Start the conversation in {lang_name}."
        }],
        'system_prompt': system_prompt
    }

    # Get first AI response
    try:
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=1024,
            system=system_prompt,
            messages=conversation_state[session_id]['history']
        )
        ai_text = response.content[0].text

        conversation_state[session_id]['history'].append({
            "role": "assistant",
            "content": ai_text
        })

        return jsonify({
            'success': True,
            'message': ai_text,
            'mode': mode,
            'complexity': tracker.current_complexity
        })

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/evaluate-response', methods=['POST'])
def evaluate_response():
    """Evaluate if user's response was appropriate using Claude"""
    data = request.json
    user_text = data.get('user_text', '')
    session_id = data.get('session_id', 'default')
    ai_previous_message = data.get('ai_message', '')

    if session_id not in conversation_state:
        return jsonify({'success': False, 'error': 'Session not found'}), 404

    session = conversation_state[session_id]
    lang_name = LANGUAGES[session['language']]['name']

    # Use Claude to evaluate if response was appropriate
    evaluation_prompt = f"""You are evaluating a language learner's response in {lang_name}.

TUTOR'S PREVIOUS MESSAGE: {ai_previous_message}
USER'S RESPONSE: {user_text}

Evaluate if the user's response:
1. Is contextually appropriate (makes sense as a reply)
2. Shows they understood the tutor's message
3. Uses correct grammar/vocabulary OR makes minor errors that don't impede comprehension

Respond with ONLY one of these:
- SUCCESS if the response is appropriate and shows comprehension
- PARTIAL if the response has significant errors but shows some understanding
- FAIL if the response is completely inappropriate, gibberish, or shows no comprehension

One word only: SUCCESS, PARTIAL, or FAIL."""

    try:
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=20,
            messages=[{
                "role": "user",
                "content": evaluation_prompt
            }]
        )
        evaluation = response.content[0].text.strip().upper()

        # Map evaluation to success boolean
        success = evaluation in ['SUCCESS', 'PARTIAL']

        # Extract words from conversation and track vocabulary exposure
        lang_config = LANGUAGES[session['language']]
        script_start, script_end = lang_config['script_range']
        telugu_words = re.findall(f'[{script_start}-{script_end}]+', ai_previous_message + ' ' + user_text)

        for word in telugu_words:
            vocab_tracker.record_word_exposure(word, success)

        return jsonify({
            'success': True,
            'understood': success,
            'evaluation': evaluation,
            'comprehension_rate': vocab_tracker.calculate_known_word_percentage(
                ai_previous_message, session['tracker'].get_cefr_level()
            )
        })

    except Exception as e:
        print(f"Error evaluating response: {e}")
        # Default to success if evaluation fails
        return jsonify({'success': True, 'understood': True, 'evaluation': 'SUCCESS'})


@app.route('/api/help-request', methods=['POST'])
def help_request():
    """Handle English help requests during conversation"""
    data = request.json
    question = data.get('question', '')
    session_id = data.get('session_id', 'default')

    if session_id not in conversation_state:
        return jsonify({'success': False, 'error': 'Session not found'}), 404

    session = conversation_state[session_id]
    lang_name = LANGUAGES[session['language']]['name']

    # Create a help prompt
    help_prompt = f"""The learner is practicing {lang_name} and has asked an English question: "{question}"

Respond helpfully in the format appropriate for {session['mode']} mode.

If they asked "how do I say X?":
- Give them the {lang_name} phrase
- Show transliteration (if guided mode)
- Show English translation (if guided mode)
- Keep it simple and encourage them to practice saying it

If they asked "what does X mean?":
- Explain the {lang_name} word/phrase
- Give examples of usage
- Keep explanation clear

Stay in character and be encouraging. This is a teaching moment within the conversation."""

    # Add to conversation history
    session['history'].append({
        "role": "user",
        "content": f"[Learner asks in English: {question}]"
    })

    try:
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=512,
            system=session['system_prompt'],
            messages=session['history']
        )
        ai_text = response.content[0].text

        session['history'].append({
            "role": "assistant",
            "content": ai_text
        })

        return jsonify({
            'success': True,
            'message': ai_text
        })

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/continue-conversation', methods=['POST'])
def continue_conversation():
    """Continue conversation and track performance"""
    data = request.json
    user_text = data.get('user_text', '')
    session_id = data.get('session_id', 'default')
    success = data.get('success', True)  # Did user respond appropriately?

    if session_id not in conversation_state:
        return jsonify({'success': False, 'error': 'Session not found'}), 404

    session = conversation_state[session_id]
    tracker = session['tracker']

    # Track performance
    tracker.record_exchange(success)

    # Update system prompt if complexity changed (check every 15 exchanges)
    if tracker.exchanges % 15 == 0:
        lang_name = LANGUAGES[session['language']]['name']
        if session['mode'] == 'conversational':
            session['system_prompt'] = generate_conversational_prompt(
                lang_name, session['scenario'], tracker
            )
        else:
            session['system_prompt'] = generate_guided_prompt(
                lang_name, session['scenario'], tracker
            )

    # Add user response
    session['history'].append({
        "role": "user",
        "content": f"[User said in {LANGUAGES[session['language']]['name']}: {user_text}]"
    })

    # Get AI response
    try:
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=1024,
            system=session['system_prompt'],
            messages=session['history']
        )
        ai_text = response.content[0].text

        session['history'].append({
            "role": "assistant",
            "content": ai_text
        })

        return jsonify({
            'success': True,
            'message': ai_text,
            'complexity': tracker.current_complexity,
            'performance': tracker.get_stats()
        })

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/tts', methods=['POST'])
def text_to_speech():
    """Convert text to speech - handles both modes"""
    data = request.json
    text = data.get('text', '')
    language_key = data.get('language', 'telugu')
    mode = data.get('mode', 'guided')

    if not text:
        return jsonify({'success': False, 'error': 'No text provided'}), 400

    lang_config = LANGUAGES.get(language_key, LANGUAGES['telugu'])
    lang_code = lang_config['code']
    script_start, script_end = lang_config['script_range']

    try:
        # Extract target language text
        main_text = extract_target_language_for_tts(text, script_start, script_end, mode)

        if not main_text:
            return jsonify({'success': False, 'error': f'No {lang_config["name"]} text found'}), 400

        # Generate audio
        output_generator = cartesia_client.tts.bytes(
            model_id="sonic-3",
            transcript=main_text,
            voice={
                "mode": "id",
                "id": "694f9389-aac1-45b6-b726-9d9369183238"
            },
            language=lang_code,
            output_format={
                "container": "wav",
                "sample_rate": 44100,
                "encoding": "pcm_f32le"
            }
        )

        audio_data = b''.join(output_generator)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_data)
            temp_file = f.name

        return send_file(temp_file, mimetype='audio/wav')

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/stt', methods=['POST'])
def speech_to_text():
    """Speech to text"""
    if 'audio' not in request.files:
        return jsonify({'success': False, 'error': 'No audio file provided'}), 400

    audio_file = request.files['audio']
    language_key = request.form.get('language', 'telugu')

    lang_config = LANGUAGES.get(language_key, LANGUAGES['telugu'])
    lang_code = lang_config['code']

    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            audio_file.save(f.name)
            temp_file = f.name

        with open(temp_file, 'rb') as f:
            transcript = cartesia_client.stt.transcribe(
                model="ink-whisper",
                file=f,
                language=lang_code
            )

        try:
            os.unlink(temp_file)
        except:
            pass

        text = transcript.text if hasattr(transcript, 'text') else ''

        return jsonify({'success': True, 'text': text})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# SRS routes (from original app)
@app.route('/api/reviews/due')
def get_due_reviews():
    due = srs.get_due_reviews()[:10]
    return jsonify(due)


@app.route('/api/reviews/mark', methods=['POST'])
def mark_reviewed():
    data = request.json
    telugu = data.get('telugu')
    success = data.get('success', False)
    srs.mark_reviewed(telugu, success)
    return jsonify({'success': True})


@app.route('/api/vocabulary')
def get_vocabulary():
    vocab = srs.get_all_vocab()
    return jsonify(vocab)


@app.route('/api/save-phrase', methods=['POST'])
def save_phrase():
    data = request.json
    text = data.get('text', '')
    context = data.get('context', 'practice')

    lines = [line.strip() for line in text.split('\n') if line.strip()]

    telugu = None
    transliteration = None
    english = None

    for line in lines:
        if line.startswith('(') and line.endswith(')'):
            transliteration = line[1:-1]
        elif line.startswith('[') and line.endswith(']'):
            english = line[1:-1]
        elif any('\u0C00' <= c <= '\u0C7F' for c in line):  # Telugu detection
            if telugu is None:
                telugu = line

    if telugu and transliteration and english:
        srs.add_difficult_phrase(
            telugu=telugu,
            transliteration=transliteration,
            english=english,
            context=context
        )
        return jsonify({'success': True, 'message': f'Saved: {english}'})
    else:
        return jsonify({'success': False, 'error': 'Could not parse phrase'}), 400


if __name__ == '__main__':
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("Error: ANTHROPIC_API_KEY environment variable not set")
        sys.exit(1)

    if not os.getenv("CARTESIA_API_KEY"):
        print("Error: CARTESIA_API_KEY environment variable not set")
        sys.exit(1)

    Path('templates').mkdir(exist_ok=True)
    Path('static/css').mkdir(parents=True, exist_ok=True)
    Path('static/js').mkdir(parents=True, exist_ok=True)

    print("🎓 Language Learning App v2 - Research-Backed Edition")
    print("📚 Features: Adaptive difficulty, Two learning modes")
    print(f"🌍 Languages: {', '.join([l['native_name'] for l in LANGUAGES.values()])}")

    # Railway deployment: use PORT from environment, bind to 0.0.0.0
    port = int(os.getenv('PORT', 5000))
    debug = os.getenv('FLASK_ENV') == 'development'

    app.run(host='0.0.0.0', port=port, debug=debug)
