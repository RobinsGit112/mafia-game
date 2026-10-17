/**
 * Mafia Mobile — Client-Side Application Logic (public/app.js)
 * Handles Socket.io state synchronisation, iOS Web Speech API unlocking,
 * HTML5 Screen Wake Lock management, QR generation, and Night Phase acoustic masking.
 */

(() => {
  'use strict';

  // ==========================================================================
  // 1. CONFIGURATION & CLIENT STATE
  // ==========================================================================

  const STORAGE_KEYS = Object.freeze({
    SESSION_ID: 'mafia_session_id',
    PLAYER_NAME: 'mafia_player_name',
    IS_HOST: 'mafia_is_host'
  });

  const PHASES = Object.freeze({
    LOBBY: 'LOBBY',
    NIGHT_PHASE: 'NIGHT_PHASE',
    DAY_PHASE: 'DAY_PHASE',
    GAME_OVER: 'GAME_OVER'
  });

  const ROLES = Object.freeze({
    MAFIA: 'MAFIA',
    DOCTOR: 'DOCTOR',
    COP: 'COP',
    CIVILIAN: 'CIVILIAN'
  });

  const clientState = {
    sessionId: null,
    publicId: null,
    playerName: '',
    roomCode: 'MAFIA5',
    isHost: false,
    audioUnlocked: false,
    wakeLockSentinel: null,
    isGameActive: false,
    // Public state synced from server
    phase: PHASES.LOBBY,
    round: 0,
    timeRemaining: 0,
    roster: [],
    votes: null,
    winner: null,
    // Private state synced only to this socket
    role: null,
    isAlive: true,
    validTargets: [],
    hasActedThisPhase: false,
    currentSelection: null,
    investigations: {},
    // Acoustic masking ("Tells" fix) state for Civilians at Night
    decoyTapsCompleted: 0,
    decoyTapsRequired: 3,
    decoyPromptTimer: null
  };

  // ==========================================================================
  // 2. SESSION PERSISTENCE & URL ROOM PARSING
  // ==========================================================================

  /**
   * Generates a RFC4122 v4 UUID using Web Crypto API with a safe fallback.
   */
  function generateUUID() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const rand = (Math.random() * 16) | 0;
      const val = char === 'x' ? rand : (rand & 0x3) | 0x8;
      return val.toString(16);
    });
  }

  /**
   * Initialises or retrieves the persistent session ID from localStorage.
   */
  function initSessionId() {
    let storedId = localStorage.getItem(STORAGE_KEYS.SESSION_ID);
    if (!storedId) {
      storedId = generateUUID();
      localStorage.setItem(STORAGE_KEYS.SESSION_ID, storedId);
    }
    clientState.sessionId = storedId;
    clientState.playerName = localStorage.getItem(STORAGE_KEYS.PLAYER_NAME) || '';
    clientState.isHost = localStorage.getItem(STORAGE_KEYS.IS_HOST) === 'true';
  }

  /**
   * Extracts the room code from the URL query string (?room=XXXX) or sets default.
   */
  function initRoomCode() {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam && roomParam.trim().length > 0) {
      clientState.roomCode = roomParam.trim().toUpperCase().slice(0, 8);
    } else {
      clientState.roomCode = 'TABLE1';
      // Update URL cleanly without reloading so refreshes keep the room parameter
      const newUrl = `${window.location.origin}${window.location.pathname}?room=${clientState.roomCode}`;
      window.history.replaceState({ path: newUrl }, '', newUrl);
    }
  }

  // ==========================================================================
  // 3. DEVICE & BROWSER APIs (SPEECH, WAKE LOCK, QR CODE)
  // ==========================================================================

  /**
   * iOS Safari Constraint Fix:
   * Must be invoked synchronously inside a user tap/click handler (e.g., "Start Game").
   * Plays an empty, silent utterance to authorise the browser for automated announcements.
   */
  function unlockSpeechSynthesis() {
    if (!('speechSynthesis' in window)) {
      console.warn('[Audio] Web Speech API is not supported on this browser.');
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const silentUtterance = new SpeechSynthesisUtterance('');
      silentUtterance.volume = 0;
      silentUtterance.rate = 1;
      window.speechSynthesis.speak(silentUtterance);
      clientState.audioUnlocked = true;
      updateAudioStatusUI(true);
    } catch (err) {
      console.warn('[Audio] Failed to unlock speechSynthesis:', err);
    }
  }

  /**
   * Speaks an announcement aloud if this device is designated as the Host announcer.
   */
  function speakAnnouncement(text, priority = 'high') {
    if (!clientState.isHost || !clientState.audioUnlocked) return;
    if (!('speechSynthesis' in window) || !text) return;

    try {
      // High-priority phase transitions interrupt stale low-priority lobby chatter
      if (priority === 'high') {
        window.speechSynthesis.cancel();
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-NZ';
      utterance.rate = 0.96; // Slightly measured cadence for dramatic clarity
      utterance.pitch = 0.95;

      // Prefer a natural English voice if available on the device
      const voices = window.speechSynthesis.getVoices();
      const preferredVoice = voices.find(
        (v) => v.lang.includes('en-NZ') || v.lang.includes('en-GB') || v.lang.includes('en-AU')
      );
      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.error('[Audio] Speech playback error:', err);
    }
  }

  /**
   * Requests an HTML5 Screen Wake Lock so the Host phone does not dim or lock mid-game.
   */
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      console.info('[WakeLock] Screen Wake Lock API not supported on this browser.');
      return;
    }

    // Only hold the Wake Lock when the game is active or Host mode is enabled
    if (!clientState.isHost && !clientState.isGameActive) return;

    try {
      if (clientState.wakeLockSentinel !== null) return;

      clientState.wakeLockSentinel = await navigator.wakeLock.request('screen');
      updateWakeLockStatusUI(true);

      clientState.wakeLockSentinel.addEventListener('release', () => {
        clientState.wakeLockSentinel = null;
        updateWakeLockStatusUI(false);
      });
    } catch (err) {
      console.warn(`[WakeLock] Could not acquire screen lock: ${err.name}, ${err.message}`);
      clientState.wakeLockSentinel = null;
      updateWakeLockStatusUI(false);
    }
  }

  /**
   * Releases the Screen Wake Lock cleanly when no longer required.
   */
  async function releaseWakeLock() {
    if (clientState.wakeLockSentinel !== null) {
      try {
        await clientState.wakeLockSentinel.release();
        clientState.wakeLockSentinel = null;
      } catch (err) {
        console.warn('[WakeLock] Error releasing wake lock:', err);
      }
    }
  }

  /**
   * Reacquires the Screen Wake Lock automatically if the Host minimises Safari
   * and returns to the tab while the match is running.
   */
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && (clientState.isGameActive || clientState.isHost)) {
      await requestWakeLock();
    }
  });

  /**
   * Renders the dynamic Join Game QR Code using qrcode.min.js.
   */
  function renderJoinQRCode() {
    const qrContainer = document.getElementById('qr-code-container');
    const joinUrlLabel = document.getElementById('join-url-label');
    const joinUrl = `${window.location.origin}?room=${encodeURIComponent(clientState.roomCode)}`;

    if (joinUrlLabel) {
      joinUrlLabel.textContent = joinUrl;
    }

    if (!qrContainer) return;

    // Clear previous QR canvas/img to prevent duplicates on re-render
    qrContainer.innerHTML = '';

    if (typeof window.QRCode === 'function') {
      new window.QRCode(qrContainer, {
        text: joinUrl,
        width: 168,
        height: 168,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel ? window.QRCode.CorrectLevel.M : 0
      });
    } else {
      qrContainer.textContent = `Share link: ${joinUrl}`;
    }
  }

  // ==========================================================================
  // 4. PHYSICAL GAMEPLAY "TELLS" FIX (CIVILIAN NIGHT DECOY MECHANIC)
  // ==========================================================================

  /**
   * Resets and starts the Civilian Night Decoy cycle so Civilians tap their screens
   * with the same physical cadence as the Mafia, Doctor, and Cop.
   */
  function initCivilianNightDecoy() {
    clearCivilianNightDecoy();
    clientState.decoyTapsCompleted = 0;
    // Require 2 to 3 taps across the night to mimic browsing & confirming a target
    clientState.decoyTapsRequired = 2 + Math.floor(Math.random() * 2);
    renderCivilianDecoyUI();
  }

  function clearCivilianNightDecoy() {
    if (clientState.decoyPromptTimer) {
      clearTimeout(clientState.decoyPromptTimer);
      clientState.decoyPromptTimer = null;
    }
  }

  /**
   * Handles when a Civilian taps the "Keep Sleeping" decoy button during NIGHT_PHASE.
   */
  function handleCivilianDecoyTap() {
    if (clientState.phase !== PHASES.NIGHT_PHASE || clientState.role !== ROLES.CIVILIAN) return;
    if (!clientState.isAlive) return;

    clientState.decoyTapsCompleted += 1;

    // Trigger subtle haptic feedback on supported Android devices
    if (navigator.vibrate) {
      navigator.vibrate(15);
    }

    const decoyBtn = document.getElementById('keep-sleeping-btn');
    const decoyStatus = document.getElementById('decoy-status-text');

    if (clientState.decoyTapsCompleted < clientState.decoyTapsRequired) {
      if (decoyBtn) {
        decoyBtn.disabled = true;
        decoyBtn.textContent = 'Resting quietly...';
      }
      if (decoyStatus) {
        decoyStatus.textContent = `Acoustic cover active (${clientState.decoyTapsCompleted}/${clientState.decoyTapsRequired}). Wait for next prompt...`;
      }

      // Re-enable the button after a brief random delay (3–6s) to simulate target selection
      const nextDelayMs = 3000 + Math.floor(Math.random() * 3000);
      clientState.decoyPromptTimer = setTimeout(() => {
        if (clientState.phase === PHASES.NIGHT_PHASE && clientState.role === ROLES.CIVILIAN) {
          if (decoyBtn) {
            decoyBtn.disabled = false;
            decoyBtn.textContent = 'Tap to Keep Sleeping';
          }
          if (decoyStatus) {
            decoyStatus.textContent = 'Tap again to mask night-time screen noises in the room.';
          }
        }
      }, nextDelayMs);
    } else {
      if (decoyBtn) {
        decoyBtn.disabled = true;
        decoyBtn.textContent = 'Deep Asleep (Cover Complete)';
      }
      if (decoyStatus) {
        decoyStatus.textContent = 'Night check-in complete. Hold still until Dawn breaks.';
      }
    }
  }

  function renderCivilianDecoyUI() {
    const decoyPanel = document.getElementById('civilian-decoy-panel');
    const decoyBtn = document.getElementById('keep-sleeping-btn');
    const decoyStatus = document.getElementById('decoy-status-text');

    if (!decoyPanel) return;

    const shouldShow =
      clientState.phase === PHASES.NIGHT_PHASE &&
      clientState.role === ROLES.CIVILIAN &&
      clientState.isAlive;

    decoyPanel.hidden = !shouldShow;

    if (shouldShow && decoyBtn && decoyStatus) {
      decoyBtn.disabled = false;
      decoyBtn.textContent = 'Tap to Keep Sleeping';
      decoyStatus.textContent = `Tap ${clientState.decoyTapsRequired} times this night so nobody can tell who has an active role by listening for screen taps.`;
    }
  }

  // ==========================================================================
  // 5. SOCKET.IO INITIALISATION & EVENT LISTENERS
  // ==========================================================================

  initSessionId();
  initRoomCode();

  const socket = window.io({
    auth: {
      sessionId: clientState.sessionId,
      roomCode: clientState.roomCode
    },
    query: {
      sessionId: clientState.sessionId,
      roomCode: clientState.roomCode
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
  });

  socket.on('connect', () => {
    setConnectionBadge(true);
  });

  socket.on('disconnect', () => {
    setConnectionBadge(false);
  });

  /**
   * Triggered when the server confirms a new registration or silently reattaches a UUID.
   */
  socket.on('session_established', (data) => {
    if (data.sessionId) {
      clientState.sessionId = data.sessionId;
      localStorage.setItem(STORAGE_KEYS.SESSION_ID, data.sessionId);
    }
    if (data.publicId) {
      clientState.publicId = data.publicId;
    }
    if (data.name) {
      clientState.playerName = data.name;
      localStorage.setItem(STORAGE_KEYS.PLAYER_NAME, data.name);
    }

    if (data.reconnected) {
      showToast(`Reconnected as ${clientState.playerName}`, 'info');
    }

    renderLobbyState();
  });

  /**
   * Authoritative public game state broadcast.
   */
  socket.on('game_state', (state) => {
    const previousPhase = clientState.phase;

    clientState.phase = state.phase;
    clientState.round = state.round;
    clientState.timeRemaining = state.timeRemaining;
    clientState.roster = Array.isArray(state.roster) ? state.roster : [];
    clientState.votes = state.votes || null;
    clientState.winner = state.winner || null;

    const wasActive = clientState.isGameActive;
    clientState.isGameActive =
      state.phase === PHASES.NIGHT_PHASE || state.phase === PHASES.DAY_PHASE;

    // Acquire Wake Lock automatically once the game transitions out of LOBBY
    if (!wasActive && clientState.isGameActive) {
      requestWakeLock();
    }

    // Initialise or tear down Civilian Night decoy when entering/leaving NIGHT_PHASE
    if (previousPhase !== PHASES.NIGHT_PHASE && state.phase === PHASES.NIGHT_PHASE) {
      if (clientState.role === ROLES.CIVILIAN && clientState.isAlive) {
        initCivilianNightDecoy();
      }
    } else if (state.phase !== PHASES.NIGHT_PHASE) {
      clearCivilianNightDecoy();
    }

    if (state.lastAnnouncement) {
      updateAnnouncementBanner(state.lastAnnouncement);
    }

    renderViewForCurrentPhase();
  });

  /**
   * Private, socket-isolated role and target payload.
   */
  socket.on('private_state', (priv) => {
    const wasCivilian = clientState.role === ROLES.CIVILIAN;

    clientState.publicId = priv.publicId;
    clientState.playerName = priv.name;
    clientState.role = priv.role;
    clientState.isAlive = priv.isAlive;
    clientState.validTargets = Array.isArray(priv.validTargets) ? priv.validTargets : [];
    clientState.hasActedThisPhase = Boolean(priv.hasActedThisPhase);
    clientState.currentSelection = priv.currentSelection || null;
    clientState.investigations = priv.investigations || {};

    if (!wasCivilian && clientState.role === ROLES.CIVILIAN && clientState.phase === PHASES.NIGHT_PHASE) {
      initCivilianNightDecoy();
    }

    renderPrivateRolePanel();
    renderActionTargets();
    renderCivilianDecoyUI();
  });

  /**
   * Authoritative 1-second timer tick from server.
   */
  socket.on('time_tick', (tick) => {
    clientState.timeRemaining = tick.timeRemaining;
    clientState.phase = tick.phase;
    clientState.round = tick.round;
    updateTimerDisplay(tick.timeRemaining, tick.phase);
  });

  /**
   * Vocal announcer cue from server.
   */
  socket.on('announcer_speak', (payload) => {
    if (!payload || !payload.text) return;
    updateAnnouncementBanner(payload.text);
    speakAnnouncement(payload.text, payload.priority || 'high');
  });

  /**
   * Private Cop investigation result emitted at Dawn.
   */
  socket.on('investigation_result', (report) => {
    if (!report) return;
    const badge = report.result === 'MAFIA' ? 'MAFIA DETECTED' : 'CLEAR (VILLAGER)';
    showToast(`Investigation on ${report.targetName}: ${badge}`, report.result === 'MAFIA' ? 'danger' : 'success');
  });

  /**
   * Server-side validation or rule error handler.
   */
  socket.on('ActionError', (err) => {
    if (err && err.message) {
      showToast(err.message, 'danger');
    }
  });

  // ==========================================================================
  // 6. USER INTERACTION HANDLERS (JOIN, HOST START, TARGETING, VOTING)
  // ==========================================================================

  /**
   * Submits player name to join the 5-player lobby.
   */
  function handleJoinLobby(event) {
    if (event) event.preventDefault();

    const nameInput = document.getElementById('player-name-input');
    const hostCheckbox = document.getElementById('host-mode-checkbox');

    const enteredName = nameInput ? nameInput.value.trim() : clientState.playerName;
    if (!enteredName) {
      showToast('Please enter a display name to join.', 'warning');
      return;
    }

    if (hostCheckbox && hostCheckbox.checked) {
      clientState.isHost = true;
      localStorage.setItem(STORAGE_KEYS.IS_HOST, 'true');
    }

    // Unlock audio immediately on user gesture if Host mode is selected
    if (clientState.isHost) {
      unlockSpeechSynthesis();
      requestWakeLock();
    }

    clientState.playerName = enteredName;
    localStorage.setItem(STORAGE_KEYS.PLAYER_NAME, enteredName);

    socket.emit('join_game', {
      name: enteredName,
      sessionId: clientState.sessionId
    });
  }

  /**
   * Dedicated "Start Game / Ready Host Audio" button handler.
   * Fulfils the iOS Safari requirement by firing a silent utterance inside the tap event,
   * requests the Screen Wake Lock, and ensures the Host is joined and ready.
   */
  async function handleHostStartGameTap(event) {
    if (event) event.preventDefault();

    clientState.isHost = true;
    localStorage.setItem(STORAGE_KEYS.IS_HOST, 'true');

    // 1. Unlock iOS Safari SpeechSynthesis synchronously inside the tap gesture
    unlockSpeechSynthesis();

    // 2. Acquire HTML5 Screen Wake Lock
    await requestWakeLock();

    // 3. If the Host hasn't joined the roster yet, join them now
    if (!clientState.publicId) {
      const nameInput = document.getElementById('player-name-input');
      const hostName = (nameInput && nameInput.value.trim()) || clientState.playerName || 'Host';
      socket.emit('join_game', {
        name: hostName,
        sessionId: clientState.sessionId
      });
    }

    showToast('Host Vocal Announcer & Screen Wake Lock active!', 'success');
    renderLobbyState();
  }

  /**
   * Submits a Night action (Mafia kill, Doctor save, Cop investigate) or Day vote.
   */
  function handleTargetSelection(targetPublicId) {
    if (!targetPublicId || !clientState.isAlive) return;

    if (navigator.vibrate) {
      navigator.vibrate(15);
    }

    if (clientState.phase === PHASES.NIGHT_PHASE) {
      socket.emit('night_action', { targetPublicId });
    } else if (clientState.phase === PHASES.DAY_PHASE) {
      socket.emit('day_vote', { targetPublicId });
    }
  }

  /**
   * Resets the match back to the lobby after GAME_OVER.
   */
  function handleResetGame() {
    if (clientState.isHost) {
      unlockSpeechSynthesis();
    }
    socket.emit('reset_game');
  }

  // ==========================================================================
  // 7. DOM RENDERING & UI SYNCHRONISATION
  // ==========================================================================

  function setConnectionBadge(isOnline) {
    const badge = document.getElementById('connection-status');
    if (!badge) return;
    badge.textContent = isOnline ? 'Online' : 'Reconnecting...';
    badge.dataset.status = isOnline ? 'online' : 'offline';
  }

  function updateAudioStatusUI(unlocked) {
    const indicator = document.getElementById('audio-status-badge');
    if (!indicator) return;
    indicator.textContent = unlocked ? 'Announcer Ready' : 'Audio Muted';
    indicator.dataset.unlocked = String(unlocked);
  }

  function updateWakeLockStatusUI(active) {
    const indicator = document.getElementById('wakelock-status-badge');
    if (!indicator) return;
    indicator.textContent = active ? 'Screen Lock: Awake' : 'Screen Lock: Standard';
    indicator.dataset.active = String(active);
  }

  function updateAnnouncementBanner(text) {
    const banner = document.getElementById('announcer-log');
    if (banner) {
      banner.textContent = text;
    }
  }

  function updateTimerDisplay(seconds, phase) {
    const timerEl = document.getElementById('timer-display');
    const progressEl = document.getElementById('timer-progress-bar');

    if (timerEl) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      timerEl.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      timerEl.dataset.urgent = seconds <= 10 ? 'true' : 'false';
    }

    if (progressEl) {
      const totalDuration = phase === PHASES.NIGHT_PHASE ? 30 : phase === PHASES.DAY_PHASE ? 90 : 1;
      const percentage = Math.max(0, Math.min(100, (seconds / totalDuration) * 100));
      progressEl.style.width = `${percentage}%`;
    }
  }

  /**
   * Switches between Lobby, Active Match, and Game Over screens and updates theme classes.
   */
  function renderViewForCurrentPhase() {
    const lobbyView = document.getElementById('lobby-view');
    const gameView = document.getElementById('game-view');
    const gameOverView = document.getElementById('gameover-view');
    const phaseTitle = document.getElementById('phase-title');

    document.body.dataset.phase = clientState.phase;

    if (lobbyView) lobbyView.hidden = clientState.phase !== PHASES.LOBBY;
    if (gameView) {
      gameView.hidden =
        clientState.phase !== PHASES.NIGHT_PHASE && clientState.phase !== PHASES.DAY_PHASE;
    }
    if (gameOverView) gameOverView.hidden = clientState.phase !== PHASES.GAME_OVER;

    if (phaseTitle) {
      if (clientState.phase === PHASES.NIGHT_PHASE) {
        phaseTitle.textContent = `Night ${clientState.round}`;
      } else if (clientState.phase === PHASES.DAY_PHASE) {
        phaseTitle.textContent = `Day ${clientState.round} — Town Deliberation`;
      } else if (clientState.phase === PHASES.GAME_OVER) {
        phaseTitle.textContent = `Game Over — ${clientState.winner} Wins!`;
      } else {
        phaseTitle.textContent = `Lobby (${clientState.roster.length}/5 Players)`;
      }
    }

    updateTimerDisplay(clientState.timeRemaining, clientState.phase);
    renderLobbyState();
    renderPublicRoster();
    renderPrivateRolePanel();
    renderActionTargets();
    renderCivilianDecoyUI();

    if (clientState.phase === PHASES.GAME_OVER) {
      renderGameOverSummary();
    }
  }

  /**
   * Updates the Lobby screen player slots and Host controls.
   */
  function renderLobbyState() {
    const countEl = document.getElementById('lobby-player-count');
    const listEl = document.getElementById('lobby-player-list');
    const joinForm = document.getElementById('join-form');
    const startGameBtn = document.getElementById('start-game-btn');

    if (countEl) {
      countEl.textContent = `${clientState.roster.length} / 5 Players Joined`;
    }

    const isJoined = clientState.roster.some((p) => p.publicId === clientState.publicId);
    if (joinForm) {
      joinForm.hidden = isJoined;
    }

    if (startGameBtn) {
      startGameBtn.textContent = clientState.audioUnlocked
        ? 'Host Audio & Wake Lock Ready (Waiting for 5/5)'
        : 'Start Game / Enable Host Vocal Announcer';
      startGameBtn.dataset.ready = String(clientState.audioUnlocked);
    }

    if (!listEl) return;
    listEl.innerHTML = '';

    for (let i = 0; i < 5; i += 1) {
      const player = clientState.roster[i];
      const li = document.createElement('li');
      li.className = player ? 'lobby-slot filled' : 'lobby-slot empty';

      if (player) {
        const isMe = player.publicId === clientState.publicId;
        const statusDot = player.connected ? '●' : '○';
        li.textContent = `${statusDot} ${player.name}${isMe ? ' (You)' : ''}`;
      } else {
        li.textContent = `Slot ${i + 1}: Waiting for player...`;
      }
      listEl.appendChild(li);
    }
  }

  /**
   * Renders the living/eliminated status of all 5 players during the match.
   */
  function renderPublicRoster() {
    const rosterContainer = document.getElementById('public-roster-list');
    if (!rosterContainer) return;

    rosterContainer.innerHTML = '';
    const tally = (clientState.votes && clientState.votes.tally) || {};

    clientState.roster.forEach((player) => {
      const item = document.createElement('div');
      item.className = `roster-pill ${player.isAlive ? 'alive' : 'eliminated'}`;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'roster-name';
      const isMe = player.publicId === clientState.publicId;
      nameSpan.textContent = `${player.name}${isMe ? ' (You)' : ''}`;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'roster-meta';

      if (!player.isAlive) {
        metaSpan.textContent = 'Eliminated';
      } else if (clientState.phase === PHASES.DAY_PHASE) {
        const voteCount = tally[player.publicId] || 0;
        metaSpan.textContent = voteCount === 1 ? '1 Vote' : `${voteCount} Votes`;
      } else {
        metaSpan.textContent = player.connected ? 'Active' : 'Offline';
      }

      item.appendChild(nameSpan);
      item.appendChild(metaSpan);
      rosterContainer.appendChild(item);
    });
  }

  /**
   * Updates the player's confidential role card and Cop investigation history.
   */
  function renderPrivateRolePanel() {
    const roleBadge = document.getElementById('private-role-badge');
    const roleDesc = document.getElementById('private-role-description');
    const copLogEl = document.getElementById('cop-investigation-log');

    if (roleBadge) {
      roleBadge.textContent = clientState.role || 'UNASSIGNED';
      roleBadge.dataset.role = clientState.role || 'NONE';
    }

    if (roleDesc) {
      if (!clientState.isAlive) {
        roleDesc.textContent = 'You have been eliminated. Observe silently and do not reveal secret information.';
      } else {
        switch (clientState.role) {
          case ROLES.MAFIA:
            roleDesc.textContent = 'Eliminate one villager each night and blend in during the day.';
            break;
          case ROLES.DOCTOR:
            roleDesc.textContent = 'Choose one other player each night to protect from the Mafia. You cannot self-heal.';
            break;
          case ROLES.COP:
            roleDesc.textContent = 'Investigate one player each night to learn whether they belong to the Mafia.';
            break;
          case ROLES.CIVILIAN:
            roleDesc.textContent = 'Tap the decoy button at night to mask sounds, then root out the Mafia during the day.';
            break;
          default:
            roleDesc.textContent = 'Waiting for role assignment...';
        }
      }
    }

    if (copLogEl) {
      const entries = Object.values(clientState.investigations || {});
      copLogEl.hidden = clientState.role !== ROLES.COP || entries.length === 0;
      copLogEl.innerHTML = '';

      entries.forEach((entry) => {
        const row = document.createElement('div');
        row.className = `investigation-item ${entry.result === 'MAFIA' ? 'is-mafia' : 'is-clear'}`;
        row.textContent = `Night ${entry.round}: ${entry.name} — ${entry.result}`;
        copLogEl.appendChild(row);
      });
    }
  }

  /**
   * Renders interactive target buttons for Night abilities and Day voting.
   */
  function renderActionTargets() {
    const actionContainer = document.getElementById('action-target-list');
    const actionPrompt = document.getElementById('action-prompt-label');
    if (!actionContainer) return;

    actionContainer.innerHTML = '';

    if (!clientState.isAlive) {
      if (actionPrompt) {
        actionPrompt.textContent = 'You are eliminated and cannot perform actions or vote.';
      }
      return;
    }

    // During Night Phase, Civilians use the Decoy Panel instead of the target list
    if (clientState.phase === PHASES.NIGHT_PHASE && clientState.role === ROLES.CIVILIAN) {
      if (actionPrompt) {
        actionPrompt.textContent = 'Night Phase — Acoustic Cover Mode';
      }
      return;
    }

    if (actionPrompt) {
      if (clientState.phase === PHASES.NIGHT_PHASE) {
        const verbMap = {
          [ROLES.MAFIA]: 'Select a victim to eliminate tonight:',
          [ROLES.DOCTOR]: 'Select a player to protect tonight (cannot self-heal):',
          [ROLES.COP]: 'Select a suspect to investigate tonight:'
        };
        actionPrompt.textContent = verbMap[clientState.role] || 'Await Dawn...';
      } else if (clientState.phase === PHASES.DAY_PHASE) {
        actionPrompt.textContent = 'Cast your vote to eliminate a suspect:';
      }
    }

    const tally = (clientState.votes && clientState.votes.tally) || {};

    clientState.validTargets.forEach((target) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = clientState.currentSelection === target.publicId;
      btn.className = `target-action-btn ${isSelected ? 'selected' : ''}`;

      let labelText = target.name;
      if (clientState.phase === PHASES.DAY_PHASE) {
        const votesForTarget = tally[target.publicId] || 0;
        labelText += ` (${votesForTarget} ${votesForTarget === 1 ? 'vote' : 'votes'})`;
      }
      if (isSelected) {
        labelText += ' ✓';
      }

      btn.textContent = labelText;
      btn.addEventListener('click', () => handleTargetSelection(target.publicId));
      actionContainer.appendChild(btn);
    });
  }

  /**
   * Renders final role reveals and match outcome on the GAME_OVER view.
   */
  function renderGameOverSummary() {
    const winnerBanner = document.getElementById('gameover-winner-banner');
    const finalRosterEl = document.getElementById('gameover-roster-list');

    if (winnerBanner) {
      winnerBanner.textContent =
        clientState.winner === 'VILLAGE'
          ? 'The Village Triumphs!'
          : 'The Mafia Takes Control of the Town!';
      winnerBanner.dataset.winner = clientState.winner || '';
    }

    if (!finalRosterEl) return;
    finalRosterEl.innerHTML = '';

    clientState.roster.forEach((player) => {
      const li = document.createElement('li');
      li.className = `gameover-player-row ${player.isAlive ? 'survived' : 'fallen'}`;
      const roleLabel = player.role ? `[${player.role}]` : '';
      const statusLabel = player.isAlive ? 'Survived' : 'Eliminated';
      li.textContent = `${player.name} ${roleLabel} — ${statusLabel}`;
      finalRosterEl.appendChild(li);
    });
  }

  /**
   * Displays non-blocking mobile toast alerts for errors, reconnects, and Cop reports.
   */
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast-message toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ==========================================================================
  // 8. DOM READY INITIALISATION
  // ==========================================================================

  document.addEventListener('DOMContentLoaded', () => {
    // Pre-fill saved player name if returning
    const nameInput = document.getElementById('player-name-input');
    if (nameInput && clientState.playerName) {
      nameInput.value = clientState.playerName;
    }

    const hostCheckbox = document.getElementById('host-mode-checkbox');
    if (hostCheckbox) {
      hostCheckbox.checked = clientState.isHost;
    }

    // Bind Lobby Join Form
    const joinForm = document.getElementById('join-form');
    if (joinForm) {
      joinForm.addEventListener('submit', handleJoinLobby);
    }

    // Bind Host "Start Game / Unlock Audio & Wake Lock" Button
    const startGameBtn = document.getElementById('start-game-btn');
    if (startGameBtn) {
      startGameBtn.addEventListener('click', handleHostStartGameTap);
    }

    // Bind Civilian Night Decoy Button ("Keep Sleeping")
    const keepSleepingBtn = document.getElementById('keep-sleeping-btn');
    if (keepSleepingBtn) {
      keepSleepingBtn.addEventListener('click', handleCivilianDecoyTap);
    }

    // Bind Play Again / Reset Button on Game Over screen
    const resetGameBtn = document.getElementById('reset-game-btn');
    if (resetGameBtn) {
      resetGameBtn.addEventListener('click', handleResetGame);
    }

    // Render dynamic QR code for room joining
    renderJoinQRCode();
  });
})();