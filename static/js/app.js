// Global state
let currentSessionId = generateSessionId();
let currentScenario = null;
let currentLanguage = 'telugu';
let currentMode = 'guided'; // 'guided' or 'conversational'
let availableLanguages = {};
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let currentReviews = [];
let currentReviewIndex = 0;
let currentReviewPhrase = null;
let autoFlowEnabled = true;
let currentAudio = null;
let currentComplexity = 1;

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    loadLanguages();
    loadStats();
    showMainMenu();
    updateModeDescription();
    registerServiceWorker();
});

// Register Service Worker for PWA
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/service-worker.js')
            .then(registration => {
                console.log('Service Worker registered successfully:', registration.scope);
            })
            .catch(error => {
                console.log('Service Worker registration failed:', error);
            });
    }
}

function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Load languages
async function loadLanguages() {
    try {
        const response = await fetch('/api/languages');
        availableLanguages = await response.json();

        const select = document.getElementById('languageSelect');
        select.innerHTML = '';

        for (const [key, lang] of Object.entries(availableLanguages)) {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = `${lang.native_name} (${lang.name})`;
            select.appendChild(option);
        }

        select.value = currentLanguage;
    } catch (error) {
        console.error('Error loading languages:', error);
    }
}

// Change language
function changeLanguage() {
    const select = document.getElementById('languageSelect');
    currentLanguage = select.value;
    loadStats();
    showMainMenu();
}

// Change mode
function changeMode() {
    const select = document.getElementById('modeSelect');
    currentMode = select.value;
    updateModeDescription();
}

function updateModeDescription() {
    const desc = document.getElementById('modeDescription');
    if (currentMode === 'guided') {
        desc.innerHTML = '📚 <strong>Guided mode</strong>: Shows translations, transliterations, and helps you learn step-by-step';
        desc.className = 'mode-description guided';
    } else {
        desc.innerHTML = '💬 <strong>Conversation mode</strong>: Pure immersion - no translations, natural conversation that adapts to your level';
        desc.className = 'mode-description conversational';
    }
}

// Update status
function updateStatus(message, type = '') {
    const indicator = document.getElementById('statusIndicator');
    if (indicator) {
        indicator.textContent = message;
        indicator.className = 'status-indicator ' + type;
    }
}

// Show/hide panels
function showMainMenu() {
    hideAllPanels();
    document.getElementById('mainMenu').classList.remove('hidden');
    document.getElementById('complexityDisplay').style.display = 'none';
    loadStats();
}

function showScenarios() {
    hideAllPanels();
    document.getElementById('scenarioPanel').classList.remove('hidden');
    loadScenarios();
}

function showReview() {
    hideAllPanels();
    document.getElementById('reviewPanel').classList.remove('hidden');
    loadReviews();
}

function showVocabulary() {
    hideAllPanels();
    document.getElementById('vocabularyPanel').classList.remove('hidden');
    loadVocabulary();
}

function hideAllPanels() {
    document.getElementById('mainMenu').classList.add('hidden');
    document.getElementById('scenarioPanel').classList.add('hidden');
    document.getElementById('conversationPanel').classList.add('hidden');
    document.getElementById('reviewPanel').classList.add('hidden');
    document.getElementById('vocabularyPanel').classList.add('hidden');
}

// Load stats
async function loadStats() {
    try {
        const response = await fetch('/api/stats');
        const stats = await response.json();

        document.getElementById('totalPhrases').textContent = stats.total_phrases;
        document.getElementById('dueReviews').textContent = stats.due_for_review;
        document.getElementById('mastered').textContent = stats.mastered;
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Load scenarios
async function loadScenarios() {
    try {
        const response = await fetch('/api/scenarios');
        const scenarios = await response.json();

        const scenarioList = document.getElementById('scenarioList');
        scenarioList.innerHTML = '';

        scenarios.forEach(scenario => {
            const item = document.createElement('div');
            item.className = 'scenario-item';
            item.textContent = scenario;
            item.onclick = () => startScenario(scenario);
            scenarioList.appendChild(item);
        });
    } catch (error) {
        console.error('Error loading scenarios:', error);
    }
}

// Start scenario
async function startScenario(scenario) {
    currentScenario = scenario;
    currentSessionId = generateSessionId();

    hideAllPanels();
    document.getElementById('conversationPanel').classList.remove('hidden');
    document.getElementById('conversationTitle').textContent = scenario;
    document.getElementById('conversationContainer').innerHTML = '';
    document.getElementById('complexityDisplay').style.display = 'block';

    updateComplexityBadge(1);
    showLoading(true);

    try {
        const response = await fetch('/api/start-conversation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                scenario: scenario,
                session_id: currentSessionId,
                language: currentLanguage,
                mode: currentMode
            })
        });

        const data = await response.json();

        if (data.success) {
            currentComplexity = data.complexity || 1;
            updateComplexityBadge(currentComplexity);
            updateStatus('🎧 Listening to tutor...', 'listening');
            addMessageToConversation('tutor', data.message);
        } else {
            alert('Error starting conversation: ' + data.error);
        }
    } catch (error) {
        console.error('Error starting conversation:', error);
        alert('Failed to start conversation. Please try again.');
    } finally {
        showLoading(false);
    }
}

// Update complexity badge
function updateComplexityBadge(level) {
    const badge = document.getElementById('currentComplexity');
    const statValue = document.getElementById('complexityLevel');

    const labels = {1: 'Beginner', 2: 'Intermediate', 3: 'Advanced'};
    const colors = {1: '#51cf66', 2: '#ffd43b', 3: '#ff6b6b'};

    badge.textContent = `Level ${level}: ${labels[level]}`;
    badge.style.background = colors[level];
    statValue.textContent = level;
}

// Add message to conversation
function addMessageToConversation(sender, text) {
    const container = document.getElementById('conversationContainer');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;

    const label = document.createElement('div');
    label.className = 'message-label';

    if (currentMode === 'conversational') {
        // Conversational mode: simplified labels
        label.innerHTML = sender === 'tutor' ? '💬:' : '🎤 You:';
    } else {
        // Guided mode: detailed labels
        label.innerHTML = sender === 'tutor' ? '🗣️ TUTOR SAYS:' : '🎤 YOU SAID:';
    }

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = text;

    messageDiv.appendChild(label);
    messageDiv.appendChild(content);

    // Add buttons for tutor messages
    if (sender === 'tutor') {
        const audioBtn = document.createElement('button');
        audioBtn.className = 'audio-button';
        audioBtn.textContent = '🔊 Listen Again';
        audioBtn.onclick = () => playAudio(text, false);
        messageDiv.appendChild(audioBtn);

        // Only show Save button in guided mode
        if (currentMode === 'guided') {
            const saveBtn = document.createElement('button');
            saveBtn.className = 'save-phrase-button';
            saveBtn.textContent = '💾 Save';
            saveBtn.onclick = () => savePhrase(text);
            messageDiv.appendChild(saveBtn);
        }

        // Auto-play
        if (autoFlowEnabled) {
            playAudio(text, true);
        }
    }

    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
}

// Play audio
async function playAudio(text, autoStartRecording = false) {
    showLoading(true);

    try {
        const response = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text,
                language: currentLanguage,
                mode: currentMode
            })
        });

        if (response.ok) {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);

            if (currentAudio) {
                currentAudio.pause();
                currentAudio = null;
            }

            currentAudio = new Audio(url);

            if (autoStartRecording && autoFlowEnabled) {
                currentAudio.addEventListener('ended', () => {
                    showLoading(false);
                    setTimeout(() => {
                        updateStatus('🎤 Your turn! Speak now...', 'recording');
                        startRecording();
                    }, 500);
                });
            } else {
                currentAudio.addEventListener('ended', () => {
                    showLoading(false);
                    updateStatus('Ready', '');
                });
            }

            currentAudio.play();
        } else {
            showLoading(false);
            alert('Failed to generate audio');
        }
    } catch (error) {
        console.error('Error playing audio:', error);
        showLoading(false);
        alert('Failed to play audio');
    }
}

// Save phrase (guided mode only)
async function savePhrase(text) {
    try {
        const response = await fetch('/api/save-phrase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text,
                context: currentScenario
            })
        });

        const data = await response.json();

        if (data.success) {
            alert('✅ ' + data.message);
            loadStats();
        } else {
            alert('❌ ' + data.error);
        }
    } catch (error) {
        console.error('Error saving phrase:', error);
        alert('Failed to save phrase');
    }
}

// Recording functions
function toggleRecording() {
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
}

async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
            await transcribeAudio(audioBlob);
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        isRecording = true;

        const micButton = document.getElementById('micButton');
        micButton.classList.add('recording');
        document.getElementById('micIcon').textContent = '🔴';
        document.getElementById('micText').textContent = 'Recording... (Click to stop)';

        setTimeout(() => {
            if (isRecording) {
                updateStatus('⏱️ Time\'s up! Processing...', 'speaking');
                stopRecording();
            }
        }, 5000);

    } catch (error) {
        console.error('Error accessing microphone:', error);
        updateStatus('Microphone error. Please type instead.', '');
        alert('Could not access microphone. Please check permissions.');
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;

        const micButton = document.getElementById('micButton');
        micButton.classList.remove('recording');
        document.getElementById('micIcon').textContent = '🎤';
        document.getElementById('micText').textContent = 'Click to Speak';
    }
}

// Transcribe audio
async function transcribeAudio(audioBlob) {
    updateStatus('🔄 Understanding what you said...', 'speaking');
    showLoading(true);

    try {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.wav');
        formData.append('language', currentLanguage);

        const response = await fetch('/api/stt', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data.success && data.text) {
            addMessageToConversation('user', data.text);
            await continueConversation(data.text, true); // Mark as successful response
        } else {
            updateStatus('Could not understand. Try again or type below.', '');
            alert('Could not transcribe audio. Please try typing instead.');
        }
    } catch (error) {
        console.error('Error transcribing audio:', error);
        updateStatus('Error. Try again or type below.', '');
        alert('Failed to transcribe. Please try typing instead.');
    } finally {
        showLoading(false);
    }
}

// Send text message
async function sendTextMessage() {
    const input = document.getElementById('userInput');
    const text = input.value.trim();

    if (!text) return;

    input.value = '';
    addMessageToConversation('user', text);
    await continueConversation(text, true);
}

// Continue conversation
async function continueConversation(userText, success = true) {
    updateStatus('💭 Processing...', 'speaking');
    showLoading(true);

    try {
        const response = await fetch('/api/continue-conversation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_text: userText,
                session_id: currentSessionId,
                success: success
            })
        });

        const data = await response.json();

        if (data.success) {
            if (data.complexity) {
                currentComplexity = data.complexity;
                updateComplexityBadge(currentComplexity);
            }

            updateStatus('🎧 Listening...', 'listening');
            addMessageToConversation('tutor', data.message);
        } else {
            updateStatus('Error occurred', '');
            alert('Error: ' + data.error);
        }
    } catch (error) {
        console.error('Error continuing conversation:', error);
        updateStatus('Error occurred', '');
        alert('Failed to continue conversation');
    } finally {
        showLoading(false);
    }
}

// End conversation
function endConversation() {
    if (confirm('Are you sure you want to end this practice session?')) {
        showMainMenu();
    }
}

// Review functions (same as original)
async function loadReviews() {
    showLoading(true);

    try {
        const response = await fetch('/api/reviews/due');
        currentReviews = await response.json();
        currentReviewIndex = 0;

        if (currentReviews.length === 0) {
            document.getElementById('noReviews').classList.remove('hidden');
            document.getElementById('reviewCard').classList.add('hidden');
        } else {
            document.getElementById('noReviews').classList.add('hidden');
            document.getElementById('reviewCard').classList.remove('hidden');
            showNextReview();
        }
    } catch (error) {
        console.error('Error loading reviews:', error);
        alert('Failed to load reviews');
    } finally {
        showLoading(false);
    }
}

function showNextReview() {
    if (currentReviewIndex >= currentReviews.length) {
        alert('🎉 Review session complete!');
        showMainMenu();
        return;
    }

    currentReviewPhrase = currentReviews[currentReviewIndex];

    document.getElementById('reviewProgress').textContent =
        `Review ${currentReviewIndex + 1} of ${currentReviews.length}`;
    document.getElementById('reviewContext').textContent =
        'Context: ' + currentReviewPhrase.context;
    document.getElementById('reviewEnglish').textContent =
        currentReviewPhrase.english;
    document.getElementById('reviewTelugu').textContent =
        currentReviewPhrase.telugu;
    document.getElementById('reviewTransliteration').textContent =
        '(' + currentReviewPhrase.transliteration + ')';

    document.getElementById('reviewAnswer').classList.add('hidden');
    document.getElementById('revealButton').classList.remove('hidden');
}

function revealAnswer() {
    document.getElementById('reviewAnswer').classList.remove('hidden');
    document.getElementById('revealButton').classList.add('hidden');
}

async function playReviewAudio() {
    await playAudio(currentReviewPhrase.telugu, false);
}

async function markReview(success) {
    showLoading(true);

    try {
        await fetch('/api/reviews/mark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                telugu: currentReviewPhrase.telugu,
                success: success
            })
        });

        currentReviewIndex++;
        showNextReview();
        loadStats();
    } catch (error) {
        console.error('Error marking review:', error);
        alert('Failed to save review');
    } finally {
        showLoading(false);
    }
}

// Vocabulary (same as original)
async function loadVocabulary() {
    showLoading(true);

    try {
        const response = await fetch('/api/vocabulary');
        const vocab = await response.json();

        const container = document.getElementById('vocabularyContainer');
        container.innerHTML = '';

        if (Object.keys(vocab).length === 0) {
            document.getElementById('noVocabulary').classList.remove('hidden');
        } else {
            document.getElementById('noVocabulary').classList.add('hidden');

            for (const difficulty in vocab) {
                const section = document.createElement('div');
                section.className = 'vocabulary-section';

                const difficultyIcons = {
                    '1': '🟢',
                    '2': '🟡',
                    '3': '🔴'
                };

                const icon = difficultyIcons[difficulty] || (difficulty > 2 ? '🔴' : '🟡');

                const title = document.createElement('h3');
                title.innerHTML = `${icon} Difficulty ${difficulty} (${vocab[difficulty].length} phrases)`;
                section.appendChild(title);

                vocab[difficulty].forEach(phrase => {
                    const item = document.createElement('div');
                    item.className = 'vocab-item';

                    const telugu = document.createElement('div');
                    telugu.className = 'vocab-telugu';
                    telugu.textContent = phrase.telugu;

                    const transliteration = document.createElement('div');
                    transliteration.className = 'vocab-transliteration';
                    transliteration.textContent = `(${phrase.transliteration})`;

                    const english = document.createElement('div');
                    english.className = 'vocab-english';
                    english.textContent = phrase.english;

                    const meta = document.createElement('div');
                    meta.className = 'vocab-meta';
                    const status = phrase.reviews >= 5 ? '✓ Mastered' : `${phrase.reviews} reviews`;
                    meta.textContent = `Context: ${phrase.context} | ${status}`;

                    item.appendChild(telugu);
                    item.appendChild(transliteration);
                    item.appendChild(english);
                    item.appendChild(meta);

                    section.appendChild(item);
                });

                container.appendChild(section);
            }
        }
    } catch (error) {
        console.error('Error loading vocabulary:', error);
        alert('Failed to load vocabulary');
    } finally {
        showLoading(false);
    }
}

// Loading overlay
function showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) {
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

// Enter key handler
document.addEventListener('DOMContentLoaded', function() {
    const userInput = document.getElementById('userInput');
    if (userInput) {
        userInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                sendTextMessage();
            }
        });
    }
});
