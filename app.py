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


# Initialize Flask
app = Flask(__name__)

# Initialize API clients
anthropic_client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
cartesia_client = Cartesia(api_key=os.getenv("CARTESIA_API_KEY"))

# Initialize SRS
srs = SpacedRepetitionSystem()

# Conversation state
conversation_state = {}


class PerformanceTracker:
    """Tracks user performance to adapt difficulty"""

    def __init__(self):
        self.exchanges = 0
        self.successful = 0
        self.struggled = 0
        self.current_complexity = 1  # Start at beginner

    def record_exchange(self, success: bool):
        """Record an exchange and update complexity"""
        self.exchanges += 1

        if success:
            self.successful += 1
        else:
            self.struggled += 1

        # Evaluate every 5 exchanges
        if self.exchanges % 5 == 0:
            self._adjust_complexity()

    def _adjust_complexity(self):
        """Adjust complexity based on success rate"""
        if self.exchanges == 0:
            return

        success_rate = self.successful / self.exchanges

        if success_rate > 0.8 and self.current_complexity < 3:
            # Too easy - increase complexity
            self.current_complexity += 1
            print(f"📈 Increasing complexity to level {self.current_complexity}")
        elif success_rate < 0.5 and self.current_complexity > 1:
            # Too hard - decrease complexity
            self.current_complexity -= 1
            print(f"📉 Decreasing complexity to level {self.current_complexity}")
        # else: maintain current complexity (50-80% is ideal i+1 zone)

    def get_complexity_instruction(self):
        """Get instructions for current complexity level"""
        return COMPLEXITY_INSTRUCTIONS.get(self.current_complexity, COMPLEXITY_INSTRUCTIONS[1])

    def get_stats(self):
        """Get performance statistics"""
        return {
            'exchanges': self.exchanges,
            'successful': self.successful,
            'struggled': self.struggled,
            'complexity': self.current_complexity,
            'success_rate': self.successful / self.exchanges if self.exchanges > 0 else 0
        }


def generate_guided_prompt(language_name: str, scenario: str, complexity_tracker: PerformanceTracker):
    """Generate prompt for guided immersion mode"""
    complexity_instruction = complexity_tracker.get_complexity_instruction()

    return f"""You are a friendly {language_name} tutor helping a learner practice in a "{scenario}" situation.

PEDAGOGICAL PRINCIPLES:
1. COMPREHENSIBLE INPUT (i+1): Match complexity to user's level
2. VOCABULARY RECYCLING: Reuse words across turns - introduce new words gradually
3. IMPLICIT CORRECTION: When user makes errors, naturally model the correct form in your response
4. STRATEGIC L1: Use English explanations ONLY when user is clearly stuck
5. MEANINGFUL INTERACTION: Ask follow-up questions that require substantive responses

CURRENT COMPLEXITY LEVEL: {complexity_tracker.current_complexity}
{complexity_instruction}

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

COMPLEXITY ADJUSTMENT: Level {complexity_tracker.current_complexity}
{complexity_instruction}

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
    return jsonify(SCENARIOS)


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

    # Initialize performance tracker
    tracker = PerformanceTracker()

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

    # Update system prompt if complexity changed
    if tracker.exchanges % 5 == 0:
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
