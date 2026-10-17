const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 20000,
  pingInterval: 10000
});

const PORT = process.env.PORT || 3000;

// Serve static mobile client files from /public
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

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

const ROLE_POOL = [
  ROLES.MAFIA,
  ROLES.DOCTOR,
  ROLES.COP,
  ROLES.CIVILIAN,
  ROLES.CIVILIAN
];

const PHASE_DURATIONS = Object.freeze({
  [PHASES.NIGHT_PHASE]: 30,
  [PHASES.DAY_PHASE]: 90
});

const MAX_PLAYERS = 5;

// ============================================================================
// AUTHORITATIVE GAME STATE
// ============================================================================

const gameState = {
  phase: PHASES.LOBBY,
  round: 0,
  timeRemaining: 0,
  timerInterval: null,
  /**
   * Keyed by private sessionId (UUID).
   * Each entry: {
   *   sessionId, publicId, socketId, name,
   *   role, isAlive, connected, investigations: {}
   * }
   */
  players: new Map(),
  nightActions: {
    killTargetPublicId: null,
    saveTargetPublicId: null,
    investigateTargetPublicId: null,
    actedSessionIds: new Set()
  },
  // Keyed by voter's private sessionId -> target's publicId
  dayVotes: new Map(),
  winner: null,
  lastAnnouncement: 'Waiting for 5 players to join the lobby.'
};

// ============================================================================
// UTILITY & HELPER FUNCTIONS
// ============================================================================

/**
 * Cryptographically shuffles an array in place using Fisher-Yates.
 */
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Finds a player record by their public targetable ID.
 */
function getPlayerByPublicId(publicId) {
  for (const player of gameState.players.values()) {
    if (player.publicId === publicId) {
      return player;
    }
  }
  return null;
}

/**
 * Finds a player record by their active socket ID.
 */
function getPlayerBySocketId(socketId) {
  for (const player of gameState.players.values()) {
    if (player.socketId === socketId) {
      return player;
    }
  }
  return null;
}

/**
 * Builds the sanitised public roster safe for broadcasting to all clients.
 * Private sessionIds and hidden roles are strictly omitted.
 */
function getPublicRoster() {
  const roster = [];
  for (const p of gameState.players.values()) {
    const entry = {
      publicId: p.publicId,
      name: p.name,
      isAlive: p.isAlive,
      connected: p.connected
    };
    // Only reveal all roles once the game has concluded
    if (gameState.phase === PHASES.GAME_OVER) {
      entry.role = p.role;
    }
    roster.push(entry);
  }
  return roster;
}

/**
 * Computes valid target publicIds for a specific player given the current phase and rules.
 */
function getValidTargetsForPlayer(player) {
  if (!player || !player.isAlive) return [];

  const livingPlayers = Array.from(gameState.players.values()).filter(p => p.isAlive);

  if (gameState.phase === PHASES.NIGHT_PHASE) {
    switch (player.role) {
      case ROLES.MAFIA:
        // Mafia can target any living non-Mafia player
        return livingPlayers
          .filter(p => p.publicId !== player.publicId)
          .map(p => ({ publicId: p.publicId, name: p.name }));

      case ROLES.DOCTOR:
        // Rule enforcement: Doctor cannot self-heal
        return livingPlayers
          .filter(p => p.publicId !== player.publicId)
          .map(p => ({ publicId: p.publicId, name: p.name }));

      case ROLES.COP:
        // Cop can investigate any living player except themselves
        return livingPlayers
          .filter(p => p.publicId !== player.publicId)
          .map(p => ({ publicId: p.publicId, name: p.name }));

      case ROLES.CIVILIAN:
      default:
        return [];
    }
  }

  if (gameState.phase === PHASES.DAY_PHASE) {
    // Living players can vote to eliminate any other living player
    return livingPlayers
      .filter(p => p.publicId !== player.publicId)
      .map(p => ({ publicId: p.publicId, name: p.name }));
  }

  return [];
}

/**
 * Summarises current Day vote counts keyed by target publicId.
 */
function getPublicVoteTally() {
  const tally = {};
  const voterMap = {};

  for (const [voterSessionId, targetPublicId] of gameState.dayVotes.entries()) {
    const voter = gameState.players.get(voterSessionId);
    if (voter && voter.isAlive) {
      tally[targetPublicId] = (tally[targetPublicId] || 0) + 1;
      voterMap[voter.publicId] = targetPublicId;
    }
  }

  return { tally, voterMap };
}

/**
 * Emits a vocal announcer cue to all clients and stores the latest message.
 */
function announce(text, priority = 'high') {
  gameState.lastAnnouncement = text;
  io.emit('announcer_speak', {
    text,
    priority,
    phase: gameState.phase,
    round: gameState.round,
    timestamp: Date.now()
  });
}

/**
 * Sends private, role-specific state to a single player's socket.
 */
function emitPrivateStateToPlayer(player) {
  if (!player.socketId) return;

  let currentSelection = null;
  if (gameState.phase === PHASES.NIGHT_PHASE) {
    if (player.role === ROLES.MAFIA) currentSelection = gameState.nightActions.killTargetPublicId;
    if (player.role === ROLES.DOCTOR) currentSelection = gameState.nightActions.saveTargetPublicId;
    if (player.role === ROLES.COP) currentSelection = gameState.nightActions.investigateTargetPublicId;
  } else if (gameState.phase === PHASES.DAY_PHASE) {
    currentSelection = gameState.dayVotes.get(player.sessionId) || null;
  }

  io.to(player.socketId).emit('private_state', {
    publicId: player.publicId,
    name: player.name,
    role: player.role,
    isAlive: player.isAlive,
    validTargets: getValidTargetsForPlayer(player),
    hasActedThisPhase:
      gameState.phase === PHASES.NIGHT_PHASE
        ? gameState.nightActions.actedSessionIds.has(player.sessionId)
        : gameState.dayVotes.has(player.sessionId),
    currentSelection,
    investigations: player.investigations
  });
}

/**
 * Broadcasts public game state to all connected sockets and pushes private state individually.
 */
function syncAllClients() {
  const publicPayload = {
    phase: gameState.phase,
    round: gameState.round,
    timeRemaining: gameState.timeRemaining,
    roster: getPublicRoster(),
    votes: gameState.phase === PHASES.DAY_PHASE ? getPublicVoteTally() : null,
    winner: gameState.winner,
    lastAnnouncement: gameState.lastAnnouncement
  };

  io.emit('game_state', publicPayload);

  for (const player of gameState.players.values()) {
    if (player.connected) {
      emitPrivateStateToPlayer(player);
    }
  }
}

// ============================================================================
// WIN CONDITION & STATE MACHINE LOGIC
// ============================================================================

/**
 * Evaluates win conditions.
 * - Village wins if Mafia count === 0.
 * - Mafia wins if living Mafia >= living Villagers.
 */
function evaluateWinCondition() {
  let livingMafia = 0;
  let livingVillagers = 0;

  for (const player of gameState.players.values()) {
    if (!player.isAlive) continue;
    if (player.role === ROLES.MAFIA) {
      livingMafia += 1;
    } else {
      livingVillagers += 1;
    }
  }

  if (livingMafia === 0) {
    return {
      isGameOver: true,
      winner: 'VILLAGE',
      reason: 'The Mafia has been eliminated. The Village wins!'
    };
  }

  if (livingMafia >= livingVillagers) {
    return {
      isGameOver: true,
      winner: 'MAFIA',
      reason: 'The Mafia now equals the living villagers in number. The Mafia wins!'
    };
  }

  return { isGameOver: false, winner: null, reason: null };
}

/**
 * Clears any active server countdown interval.
 */
function stopAuthoritativeTimer() {
  if (gameState.timerInterval) {
    clearInterval(gameState.timerInterval);
    gameState.timerInterval = null;
  }
}

/**
 * Starts the server-authoritative 1-second interval timer for the current phase.
 */
function startAuthoritativeTimer(durationSeconds, onComplete) {
  stopAuthoritativeTimer();
  gameState.timeRemaining = durationSeconds;

  // Emit initial tick immediately so clients synchronise without a 1s lag
  io.emit('time_tick', {
    timeRemaining: gameState.timeRemaining,
    phase: gameState.phase,
    round: gameState.round
  });

  gameState.timerInterval = setInterval(() => {
    gameState.timeRemaining -= 1;

    io.emit('time_tick', {
      timeRemaining: Math.max(0, gameState.timeRemaining),
      phase: gameState.phase,
      round: gameState.round
    });

    if (gameState.timeRemaining <= 0) {
      stopAuthoritativeTimer();
      onComplete();
    }
  }, 1000);
}

/**
 * Initialises roles and launches the match into Night 1.
 */
function startGame() {
  const shuffledRoles = shuffleArray(ROLE_POOL);
  let index = 0;

  for (const player of gameState.players.values()) {
    player.role = shuffledRoles[index];
    player.isAlive = true;
    player.investigations = {};
    index += 1;
  }

  gameState.round = 1;
  gameState.winner = null;

  transitionToNightPhase(true);
}

/**
 * Transitions the state machine into NIGHT_PHASE (30 seconds).
 */
function transitionToNightPhase(isFirstNight = false) {
  gameState.phase = PHASES.NIGHT_PHASE;
  gameState.nightActions = {
    killTargetPublicId: null,
    saveTargetPublicId: null,
    investigateTargetPublicId: null,
    actedSessionIds: new Set()
  };

  const introSpeech = isFirstNight
    ? `The game begins. Night 1 falls upon the town. Check your private role securely on your screen. Mafia, choose your victim. Doctor, choose someone to protect. Cop, choose a suspect to investigate.`
    : `Night ${gameState.round} falls upon the town. Living special roles, make your selections quietly.`;

  announce(introSpeech, 'high');
  syncAllClients();

  startAuthoritativeTimer(PHASE_DURATIONS[PHASES.NIGHT_PHASE], resolveNightPhase);
}

/**
 * Resolves Night actions at the end of the 30-second Night countdown.
 */
function resolveNightPhase() {
  const { killTargetPublicId, saveTargetPublicId, investigateTargetPublicId } = gameState.nightActions;

  // 1. Resolve Cop investigation privately if Cop is alive and submitted a target
  for (const player of gameState.players.values()) {
    if (player.role === ROLES.COP && player.isAlive && investigateTargetPublicId) {
      const target = getPlayerByPublicId(investigateTargetPublicId);
      if (target) {
        const alignment = target.role === ROLES.MAFIA ? 'MAFIA' : 'CLEAR';
        player.investigations[target.publicId] = {
          name: target.name,
          result: alignment,
          round: gameState.round
        };

        if (player.socketId) {
          io.to(player.socketId).emit('investigation_result', {
            targetPublicId: target.publicId,
            targetName: target.name,
            result: alignment,
            round: gameState.round
          });
        }
      }
    }
  }

  // 2. Resolve Mafia kill vs Doctor save
  let dawnMessage = `Dawn breaks on Day ${gameState.round}. `;

  if (!killTargetPublicId) {
    dawnMessage += `The night was eerily quiet. No one was attacked.`;
  } else {
    const victim = getPlayerByPublicId(killTargetPublicId);
    if (victim && victim.isAlive) {
      if (killTargetPublicId === saveTargetPublicId) {
        dawnMessage += `${victim.name} was attacked in the night, but the Doctor intervened just in time! No one died.`;
      } else {
        victim.isAlive = false;
        dawnMessage += `Tragedy strikes the village. ${victim.name} was eliminated during the night.`;
      }
    }
  }

  // 3. Check win conditions before opening Day discussion
  const winCheck = evaluateWinCondition();
  if (winCheck.isGameOver) {
    transitionToGameOver(winCheck.winner, `${dawnMessage} ${winCheck.reason}`);
    return;
  }

  transitionToDayPhase(dawnMessage);
}

/**
 * Transitions the state machine into DAY_PHASE (90 seconds).
 */
function transitionToDayPhase(dawnSummaryText) {
  gameState.phase = PHASES.DAY_PHASE;
  gameState.dayVotes.clear();

  const fullAnnouncement = `${dawnSummaryText} You have 90 seconds to deliberate and cast your vote.`;
  announce(fullAnnouncement, 'high');
  syncAllClients();

  startAuthoritativeTimer(PHASE_DURATIONS[PHASES.DAY_PHASE], resolveDayPhase);
}

/**
 * Resolves Day votes at the end of the 90-second Day countdown.
 */
function resolveDayPhase() {
  stopAuthoritativeTimer();

  const { tally } = getPublicVoteTally();
  let highestVotes = 0;
  let topTargetPublicId = null;
  let isTie = false;

  for (const [targetPublicId, count] of Object.entries(tally)) {
    if (count > highestVotes) {
      highestVotes = count;
      topTargetPublicId = targetPublicId;
      isTie = false;
    } else if (count === highestVotes) {
      isTie = true;
    }
  }

  let duskMessage = `Voting has closed for Day ${gameState.round}. `;

  if (highestVotes === 0 || isTie || !topTargetPublicId) {
    duskMessage += `The town could not reach a majority consensus. No one was eliminated today.`;
  } else {
    const eliminatedPlayer = getPlayerByPublicId(topTargetPublicId);
    if (eliminatedPlayer && eliminatedPlayer.isAlive) {
      eliminatedPlayer.isAlive = false;
      duskMessage += `By majority vote, the town has eliminated ${eliminatedPlayer.name}. `;
    }
  }

  // Evaluate win condition after the town's elimination
  const winCheck = evaluateWinCondition();
  if (winCheck.isGameOver) {
    transitionToGameOver(winCheck.winner, `${duskMessage} ${winCheck.reason}`);
    return;
  }

  // Advance to the next Night
  gameState.round += 1;
  announce(duskMessage, 'high');

  // Brief pause before Night announcement so the vocal announcer doesn't clip sentences
  setTimeout(() => {
    if (gameState.phase !== PHASES.GAME_OVER && gameState.phase !== PHASES.LOBBY) {
      transitionToNightPhase(false);
    }
  }, 4000);
}

/**
 * Transitions the state machine into GAME_OVER and reveals all roles.
 */
function transitionToGameOver(winner, finalAnnouncement) {
  stopAuthoritativeTimer();
  gameState.phase = PHASES.GAME_OVER;
  gameState.winner = winner;
  gameState.timeRemaining = 0;

  announce(finalAnnouncement, 'high');
  syncAllClients();
}

/**
 * Resets the match back to the LOBBY while preserving connected players.
 */
function resetToLobby() {
  stopAuthoritativeTimer();
  gameState.phase = PHASES.LOBBY;
  gameState.round = 0;
  gameState.timeRemaining = 0;
  gameState.winner = null;
  gameState.dayVotes.clear();
  gameState.nightActions = {
    killTargetPublicId: null,
    saveTargetPublicId: null,
    investigateTargetPublicId: null,
    actedSessionIds: new Set()
  };

  // Remove disconnected players on reset and clear role state for connected players
  for (const [sessionId, player] of gameState.players.entries()) {
    if (!player.connected) {
      gameState.players.delete(sessionId);
    } else {
      player.role = null;
      player.isAlive = true;
      player.investigations = {};
    }
  }

  announce(`Lobby reset. ${gameState.players.size} of ${MAX_PLAYERS} players ready.`, 'normal');
  syncAllClients();

  if (gameState.players.size === MAX_PLAYERS) {
    startGame();
  }
}

// ============================================================================
// SOCKET.IO CONNECTION & EVENT HANDLERS
// ============================================================================

io.on('connection', (socket) => {
  const handshakeSessionId = socket.handshake.auth?.sessionId || socket.handshake.query?.sessionId;

  // 1. Check for existing session to silently reattach dropped sockets
  if (handshakeSessionId && gameState.players.has(handshakeSessionId)) {
    const existingPlayer = gameState.players.get(handshakeSessionId);
    existingPlayer.socketId = socket.id;
    existingPlayer.connected = true;

    socket.emit('session_established', {
      sessionId: existingPlayer.sessionId,
      publicId: existingPlayer.publicId,
      name: existingPlayer.name,
      reconnected: true
    });

    syncAllClients();
  } else {
    // Push current public snapshot to unjoined spectators/new arrivals
    socket.emit('game_state', {
      phase: gameState.phase,
      round: gameState.round,
      timeRemaining: gameState.timeRemaining,
      roster: getPublicRoster(),
      votes: gameState.phase === PHASES.DAY_PHASE ? getPublicVoteTally() : null,
      winner: gameState.winner,
      lastAnnouncement: gameState.lastAnnouncement
    });
  }

  /**
   * Event: join_game
   * Payload: { name: string, sessionId?: string }
   * Handles both new lobby registrations and manual session reattachments.
   */
  socket.on('join_game', (payload = {}) => {
    const providedSessionId = payload.sessionId || handshakeSessionId;

    // Case A: Reconnecting player presenting a valid existing UUID
    if (providedSessionId && gameState.players.has(providedSessionId)) {
      const player = gameState.players.get(providedSessionId);
      player.socketId = socket.id;
      player.connected = true;

      socket.emit('session_established', {
        sessionId: player.sessionId,
        publicId: player.publicId,
        name: player.name,
        reconnected: true
      });

      syncAllClients();
      return;
    }

    // Case B: New player attempting to join
    if (gameState.phase !== PHASES.LOBBY) {
      socket.emit('ActionError', { message: 'A game is currently in progress. Please wait for the next match.' });
      return;
    }

    if (gameState.players.size >= MAX_PLAYERS) {
      socket.emit('ActionError', { message: 'The lobby is already full (5/5 players).' });
      return;
    }

    const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
    const sanitisedName = rawName.slice(0, 18) || `Player ${gameState.players.size + 1}`;

    const newSessionId = crypto.randomUUID();
    const newPublicId = `p_${crypto.randomBytes(4).toString('hex')}`;

    const newPlayer = {
      sessionId: newSessionId,
      publicId: newPublicId,
      socketId: socket.id,
      name: sanitisedName,
      role: null,
      isAlive: true,
      connected: true,
      investigations: {}
    };

    gameState.players.set(newSessionId, newPlayer);

    socket.emit('session_established', {
      sessionId: newSessionId,
      publicId: newPublicId,
      name: sanitisedName,
      reconnected: false
    });

    const currentCount = gameState.players.size;
    announce(`${sanitisedName} joined the lobby. ${currentCount} of ${MAX_PLAYERS} players connected.`, 'low');
    syncAllClients();

    // Automatically launch into Night 1 once the 5th player joins
    if (currentCount === MAX_PLAYERS) {
      setTimeout(() => {
        if (gameState.phase === PHASES.LOBBY && gameState.players.size === MAX_PLAYERS) {
          startGame();
        }
      }, 1500);
    }
  });

  /**
   * Event: night_action
   * Payload: { targetPublicId: string }
   * Validates role permissions, living status, and Doctor self-heal restrictions.
   */
  socket.on('night_action', (payload = {}) => {
    const player = getPlayerBySocketId(socket.id);
    if (!player) return;

    if (gameState.phase !== PHASES.NIGHT_PHASE) {
      socket.emit('ActionError', { message: 'Night actions can only be submitted during the Night phase.' });
      return;
    }

    if (!player.isAlive) {
      socket.emit('ActionError', { message: 'Eliminated players cannot perform night actions.' });
      return;
    }

    if (player.role === ROLES.CIVILIAN) {
      socket.emit('ActionError', { message: 'Civilians sleep through the night and have no active ability.' });
      return;
    }

    const { targetPublicId } = payload;
    const validTargets = getValidTargetsForPlayer(player);
    const isTargetValid = validTargets.some(t => t.publicId === targetPublicId);

    if (!isTargetValid) {
      if (player.role === ROLES.DOCTOR && targetPublicId === player.publicId) {
        socket.emit('ActionError', { message: 'The Doctor is not permitted to self-heal.' });
      } else {
        socket.emit('ActionError', { message: 'Invalid target selection.' });
      }
      return;
    }

    if (player.role === ROLES.MAFIA) {
      gameState.nightActions.killTargetPublicId = targetPublicId;
    } else if (player.role === ROLES.DOCTOR) {
      gameState.nightActions.saveTargetPublicId = targetPublicId;
    } else if (player.role === ROLES.COP) {
      gameState.nightActions.investigateTargetPublicId = targetPublicId;
    }

    gameState.nightActions.actedSessionIds.add(player.sessionId);
    emitPrivateStateToPlayer(player);
  });

  /**
   * Event: day_vote
   * Payload: { targetPublicId: string }
   * Registers or updates a living player's elimination vote during the Day phase.
   */
  socket.on('day_vote', (payload = {}) => {
    const player = getPlayerBySocketId(socket.id);
    if (!player) return;

    if (gameState.phase !== PHASES.DAY_PHASE) {
      socket.emit('ActionError', { message: 'Voting is only open during the Day phase.' });
      return;
    }

    if (!player.isAlive) {
      socket.emit('ActionError', { message: 'Eliminated players cannot vote.' });
      return;
    }

    const { targetPublicId } = payload;
    const validTargets = getValidTargetsForPlayer(player);
    const isTargetValid = validTargets.some(t => t.publicId === targetPublicId);

    if (!isTargetValid) {
      socket.emit('ActionError', { message: 'Invalid vote target.' });
      return;
    }

    gameState.dayVotes.set(player.sessionId, targetPublicId);
    syncAllClients();
  });

  /**
   * Event: reset_game
   * Allows players to start a fresh match after GAME_OVER.
   */
  socket.on('reset_game', () => {
    if (gameState.phase === PHASES.GAME_OVER) {
      resetToLobby();
    }
  });

  /**
   * Event: disconnect
   * Marks the player as disconnected while retaining their profile and UUID session.
   */
  socket.on('disconnect', () => {
    const player = getPlayerBySocketId(socket.id);
    if (!player) return;

    player.connected = false;
    player.socketId = null;

    // If still in the lobby and not yet started, keep their slot reserved for reconnection
    // or allow them to seamlessly resume when their mobile browser wakes up.
    syncAllClients();
  });
});

// ============================================================================
// SERVER INITIALISATION
// ============================================================================

server.listen(PORT, () => {
  console.log(`[Mafia Server] Authoritative backend running on port ${PORT}`);
});