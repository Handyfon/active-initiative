const MODULE_ID = "active-initiative";
const STATE_FLAG = "state";
const STATE_PATH = `flags.${MODULE_ID}.${STATE_FLAG}`;

const pendingActorDamage = new Map();
const pendingTokenDamage = new Map();
const PENDING_DAMAGE_TTL = 5000;

// TEMP tracing for the turn-handoff issue. Set to false once it's resolved.
// Logs the whole path on BOTH the acting client and the GM, so we can see
// exactly where a give/interrupt request stops.
let AI_DEBUG = false;
const aiLog = (...args) => { if (AI_DEBUG) console.log("Active Initiative |", ...args); };

Hooks.once("init", () => {
  console.log("ActiveInitiative | Registering settings...");

  game.settings.register(MODULE_ID, "damagePath", {
    name: game.i18n.localize("ActiveInitiative.Settings.damagePath.Text"),
    hint: game.i18n.localize("ActiveInitiative.Settings.damagePath.Hint"),
    scope: "world",
    config: true,
    default: "system.attributes.hp.value",
    type: String
  });
  game.settings.register(MODULE_ID, "stealOnDamage", {
    name: game.i18n.localize("ActiveInitiative.Settings.stealOnDamage.Text"),
    hint: game.i18n.localize("ActiveInitiative.Settings.stealOnDamage.Hint"),
    scope: "world",
    config: true,
    default: true,
    type: Boolean
  });
  game.settings.register(MODULE_ID, "damageOnIncrease", {
    name: game.i18n.localize("ActiveInitiative.Settings.damageOnIncrease.Text"),
    hint: game.i18n.localize("ActiveInitiative.Settings.damageOnIncrease.Hint"),
    scope: "world",
    config: true,
    default: false,
    type: Boolean
  });
  game.settings.register(MODULE_ID, "hasSeenRecommendation", {
    scope: "world",
    config: false,
    default: false,
    type: Boolean
  });
});

Hooks.once("ready", () => {
  globalThis.ActiveInitiative = {
    dump: () => debugSnapshot(game.combat),
    responsibleGM: () => game.users?.activeGM?.id ?? null
  };
  // Carriers that were posted while no GM was around never got handled and just
  // sit invisible in the chat log forever, sweep them out on login
  if (isResponsibleGM()) {
    const stale = game.messages?.filter(m => m.getFlag(MODULE_ID, "ai")) ?? [];
    if (stale.length) ChatMessage.deleteDocuments(stale.map(m => m.id)).catch(() => {});
  }
});

// Player <-> GM messaging rides on whispered, flag-only chat messages instead of
// game.socket. Core document creation is ALWAYS relayed to every client, so this
// needs no "socket": true manifest flag and works the moment the script reloads.
// Each carrier is deleted as soon as it is handled. `ai.t` is the transport tag
// (request / result / damage) - deliberately not named "kind" because a damage
// report carries its own kind (actor / token).
Hooks.on("createChatMessage", async (message, options, userId) => {
  const ai = message?.getFlag?.(MODULE_ID, "ai");
  if (!ai) return;
  const authorId = chatMessageAuthorId(message, userId);
  aiLog("carrier RECV", ai.t, "| author:", authorId, "| isResponsibleGM:", isResponsibleGM(), "| isGM:", game.user?.isGM);

  // result carriers (GM -> player): the addressed player shows the toast, the
  // responsible GM (which authored it) removes the carrier
  if (ai.t === "result") {
    const author = authorId ? game.users?.get(authorId) : null;
    if (author?.isGM && ai.userId === game.user?.id) showRequestResult(ai);
    if (isResponsibleGM()) message.delete?.().catch(() => {});
    return;
  }

  // requests and damage reports are handled by the single responsible GM
  if (!isResponsibleGM()) return;
  message.delete?.().catch(() => {}); // clear the carrier out of chat

  if (!authorId || authorId !== ai.userId) {
    console.warn("ActiveInitiative | Ignoring carrier with mismatched author.", { authorId, claimedUserId: ai.userId, type: ai.t });
    return;
  }

  if (ai.t === "damage") { await onDamageReport(ai, authorId); return; }

  if (ai.t === "request") {
    // We never trust a claimed GM sender - real GMs act locally, never via carrier
    const requester = game.users?.get(authorId);
    if (!requester || requester.isGM || !requester.active) {
      console.warn("ActiveInitiative | Ignoring a turn request from an unknown or inactive user.", authorId);
      return;
    }
    const combat = (ai.combatId ? game.combats?.get(ai.combatId) : null) ?? game.combat;
    if (!combat?.started) {
      notifyUser(requester.id, game.i18n.localize("ActiveInitiative.Notify.NoCombat"), "warn");
      return;
    }
    const options = { requestedBy: requester.id, trusted: false, combat };
    try {
      if (ai.steal) await reserveInterrupt(ai.combatantId, options);
      else await giveTurn(ai.combatantId, options);
    } catch (error) {
      console.error("ActiveInitiative | Failed to process a turn request.", error);
      notifyUser(requester.id, game.i18n.localize("ActiveInitiative.Notify.RequestFailed"), "error");
    }
  }
});

// Carriers still flash an empty card until the handler deletes them, so we tag them for the CSS to hide
Hooks.on("renderChatMessageHTML", (message, html) => {
  if (message?.getFlag?.(MODULE_ID, "ai")) html.classList.add("ai-carrier");
});

Hooks.once("ready", async () => {
  if (!game.user.isGM) return;
  if (game.settings.get(MODULE_ID, "hasSeenRecommendation") || game.system.id === "dnd5e") return;

  const systemPresets = await loadSystemPresets();
  // Fetch failed - keep the recommendation for the next launch instead of burning it
  if (!systemPresets) return;
  const preset = systemPresets[game.system.id] || null;
  if (!preset) {
    ui.notifications.warn("Active Initiative | " + game.i18n.format("ActiveInitiative.Recommend.NoPreset", { system: game.system.id }));
    await game.settings.set(MODULE_ID, "hasSeenRecommendation", true);
    return;
  }

  // Heartbeat marks wound based systems through its invert settings, those count up for us
  const countsUp = !!(preset.settings?.["heartbeat.wounds"] || preset.settings?.["partywatch.wounds"]);
  const currentPath = game.settings.get(MODULE_ID, "damagePath");
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("ActiveInitiative.Recommend.Title") },
    content: `
      <p>${game.i18n.format("ActiveInitiative.Recommend.Detected", { name: preset.name })}</p>
      <p>${game.i18n.localize("ActiveInitiative.Recommend.ApplyQuestion")}</p>
      <hr>
      <p><strong>${game.i18n.localize("ActiveInitiative.Recommend.CurrentPath")}</strong></p>
      <p>${currentPath} &rarr; <strong>${preset.hpPath}</strong></p>
      ${countsUp ? `<p>${game.i18n.localize("ActiveInitiative.Recommend.CountsUp")}</p>` : ""}`,
    buttons: [
      { action: "apply", label: game.i18n.localize("ActiveInitiative.Recommend.ApplyButton"), default: true },
      { action: "skip", label: game.i18n.localize("ActiveInitiative.Recommend.SkipButton") }
    ],
    rejectClose: false
  });

  if (choice === "apply") {
    await game.settings.set(MODULE_ID, "damagePath", preset.hpPath);
    await game.settings.set(MODULE_ID, "damageOnIncrease", countsUp);
    await game.settings.set(MODULE_ID, "hasSeenRecommendation", true);
    ui.notifications.info(game.i18n.format("ActiveInitiative.Recommend.Applied", { name: preset.name }));
  } else if (choice === "skip") {
    await game.settings.set(MODULE_ID, "hasSeenRecommendation", true);
    ui.notifications.warn(game.i18n.localize("ActiveInitiative.Recommend.Skipped"));
  } else {
    await game.settings.set(MODULE_ID, "hasSeenRecommendation", true);
  }
});

Hooks.on("preUpdateActor", (actor, changed) => {
  if (!game.settings.get(MODULE_ID, "stealOnDamage")) return;
  const path = game.settings.get(MODULE_ID, "damagePath");
  const next = foundry.utils.getProperty(changed, path);
  if (typeof next !== "number") return;
  const prev = foundry.utils.getProperty(actor, path);
  if (damageTaken(prev, next) == null) return;
  prunePendingDamage(pendingActorDamage);
  pendingActorDamage.set(actor.uuid ?? actor.id, { prev, at: Date.now() });
});

Hooks.on("updateActor", async actor => {
  const damageKey = actor.uuid ?? actor.id;
  const pending = pendingActorDamage.get(damageKey);
  if (!pending) return;
  pendingActorDamage.delete(damageKey);
  // Recompute from the value that actually landed - the update preUpdate saw could
  // have been canceled by another module or clamped by the system in between
  const path = game.settings.get(MODULE_ID, "damagePath");
  const amount = damageTaken(pending.prev, foundry.utils.getProperty(actor, path));
  if (amount == null) return;
  const combat = game.combat;
  if (!combat?.started) return;
  const combatants = findCombatantsForActor(combat, actor);
  await sendDamageReport(combat, combatants, amount, {
    kind: "actor",
    actorId: actor.id,
    actorUuid: actor.uuid
  });
});

Hooks.on("preUpdateToken", (token, changed) => {
  if (!game.settings.get(MODULE_ID, "stealOnDamage")) return;
  const path = game.settings.get(MODULE_ID, "damagePath");
  const next = getTokenHPChange(changed, path);
  if (typeof next !== "number") return;
  const prev = foundry.utils.getProperty(token.actor, path);
  if (damageTaken(prev, next) == null) return;
  prunePendingDamage(pendingTokenDamage);
  pendingTokenDamage.set(token.uuid ?? token.id, { prev, at: Date.now() });
});

Hooks.on("updateToken", async token => {
  const damageKey = token.uuid ?? token.id;
  const pending = pendingTokenDamage.get(damageKey);
  if (!pending) return;
  pendingTokenDamage.delete(damageKey);
  const path = game.settings.get(MODULE_ID, "damagePath");
  const amount = damageTaken(pending.prev, foundry.utils.getProperty(token.actor, path));
  if (amount == null) return;
  const combat = game.combat;
  if (!combat?.started) return;
  const combatants = getTokenCombatants(combat, token);
  await sendDamageReport(combat, combatants, amount, {
    kind: "token",
    actorId: token.actor?.id,
    actorUuid: token.actor?.uuid,
    tokenId: token.id,
    tokenUuid: token.uuid,
    sceneId: token.parent?.id
  });
});

Hooks.on("createCombat", async combat => {
  if (!isResponsibleGM()) return;
  await resetRoundState(combat);
});

// preUpdate only fires on the client that clicked, so we stamp the outgoing
// combatant onto the options for the responsible GM to pick up after the update
Hooks.on("preUpdateCombat", (combat, changed, options) => {
  if (!Object.prototype.hasOwnProperty.call(changed, "turn")) return;
  options.activeInitiativePriorCombatant = combat.combatant?.id ?? null;
});

Hooks.on("updateCombat", async (combat, changed, options) => {
  if (!isResponsibleGM()) return;
  if (Object.prototype.hasOwnProperty.call(changed, "round")) {
    // Our own round advances already reset the state in the same update
    if (options?.activeInitiativeRoundAdvance) return;
    await resetRoundState(combat);
    return;
  }
  // Turn changes from the core next/previous buttons skip our handoff logic, so we
  // catch up here: forward marks the old combatant as acted, backwards clears the
  // mark on the one we rewound to. Steal eligibility ends either way.
  if (!Object.prototype.hasOwnProperty.call(changed, "turn")) return;
  if (!combat.started) return;
  if (options?.activeInitiativeTurn) return;
  if (options?.turnEvents === false) return; // core is just reindexing after combatant changes
  const state = readTurnState(combat);
  const currentId = combat.combatant?.id;
  const priorId = options?.activeInitiativePriorCombatant;
  if (options?.direction === -1) {
    if (currentId) delete state.acted[currentId];
  } else if (priorId && priorId !== currentId) {
    state.acted[priorId] = true;
  }
  state.steal = {};
  state.queue = state.queue.filter(id => id !== currentId);
  await updateTurnState(combat, state);
});

Hooks.on("renderCombatTracker", (app, html) => {
  const root = globalThis.jQuery && html instanceof globalThis.jQuery ? html[0] : html;
  refreshTracker(root);
});

//RUNTIME HELPERS

function isResponsibleGM() {
  return !!game.user?.isGM && game.users?.activeGM === game.user;
}
function chatMessageAuthorId(message, hookUserId) {
  const messageUser = message?.user;
  return hookUserId
    || (typeof messageUser === "string" ? messageUser : messageUser?.id)
    || message?.userId
    || message?.author?.id
    || message?._source?.user
    || null;
}

async function loadSystemPresets() {
  // Shared with the heartbeat module, no need to maintain the same list twice
  const githubURL = "https://raw.githubusercontent.com/Handyfon/heartbeat/master/systemSettings.json";

  try {
    const response = await fetch(githubURL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

    const json = await response.json();
    console.log("ActiveInitiative | Loaded system presets from GitHub.");
    return json;
  } catch (error) {
    console.warn("ActiveInitiative | Failed to load system presets from GitHub, will try again next launch.", error);
    return null;
  }
}

function showRequestResult(payload) {
  if (payload?.userId !== game.user?.id) return;
  const message = typeof payload.message === "string" ? payload.message : "";
  if (!message) return;
  const level = ["info", "warn", "error"].includes(payload.level) ? payload.level : "warn";
  const notify = ui.notifications?.[level] ?? ui.notifications?.warn;
  notify?.call(ui.notifications, message);
}

function notifyUser(userId, message, level = "warn") {
  const text = "Active Initiative | " + message;
  if (!userId || userId === game.user?.id) {
    const notify = ui.notifications?.[level] ?? ui.notifications?.warn;
    notify?.call(ui.notifications, text);
    return;
  }
  if (!isResponsibleGM()) return;
  aiPostCarrier([userId], { t: "result", userId, level, message: text });
}

// Whisper a hidden, flag-only carrier to specific user ids - the transport for
// every player<->GM exchange (see the createChatMessage handler above).
async function aiPostCarrier(recipientIds, ai) {
  const whisper = (Array.isArray(recipientIds) ? recipientIds : [recipientIds]).filter(Boolean);
  if (!whisper.length) return;
  try {
    await ChatMessage.create({ content: "", whisper, flags: { [MODULE_ID]: { ai } } });
  } catch (error) {
    console.error("ActiveInitiative | Failed to post a carrier message.", error);
  }
}

function activeGMIds() {
  return (game.users?.filter?.(user => user.isGM && user.active) ?? []).map(user => user.id);
}

//TURN STATE
// The state is saved as arrays because foundry merges flag objects and old keys would never get removed

function makeTurnState({ round = 1, acted = {}, steal = {}, queue = [] } = {}) {
  return { round, acted, steal, queue: [...queue] };
}

function cloneObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return foundry.utils.deepClone(value);
}

function objectFromIds(value) {
  if (Array.isArray(value)) return Object.fromEntries(value.map(id => [id, true]));
  return cloneObject(value);
}

function objectFromEntries(value) {
  if (Array.isArray(value)) return Object.fromEntries(value);
  return cloneObject(value);
}

function readTurnState(combat) {
  const round = combat.round ?? 1;
  const state = combat.getFlag(MODULE_ID, STATE_FLAG);
  if (!state || typeof state !== "object" || Array.isArray(state)) return makeTurnState({ round });
  if (state.round !== round) return makeTurnState({ round });
  return makeTurnState({
    round,
    acted: objectFromIds(state.acted),
    steal: objectFromEntries(state.steal),
    queue: Array.isArray(state.queue) ? state.queue.filter(id => typeof id === "string") : []
  });
}

function serializeTurnState(state) {
  return {
    round: state.round ?? 1,
    acted: Object.keys(cloneObject(state.acted)),
    steal: Object.entries(cloneObject(state.steal)),
    queue: Array.isArray(state.queue) ? [...state.queue] : []
  };
}

async function resetRoundState(combat, round = combat.round ?? 1) {
  await combat.update({
    [STATE_PATH]: serializeTurnState(makeTurnState({ round }))
  });
}

async function updateTurnState(combat, state, extra = {}) {
  const round = state.round ?? combat.round ?? 1;
  // The option marks this as one of our own turn moves so updateCombat leaves it alone
  await combat.update({
    ...extra,
    [STATE_PATH]: serializeTurnState(makeTurnState({ round, acted: state.acted, steal: state.steal, queue: state.queue }))
  }, { activeInitiativeTurn: true });
}

//TURN FLOW

async function SendTurnRequest(combatantId, { steal = false } = {}) {
  aiLog("SendTurnRequest", { combatantId, steal, isGM: game.user.isGM, activeGM: game.users?.activeGM?.name ?? null, combatId: game.combat?.id });
  if (game.user.isGM) {
    aiLog("SendTurnRequest -> acting locally as GM");
    const options = { requestedBy: game.user.id, trusted: true };
    if (steal) await reserveInterrupt(combatantId, options);
    else await giveTurn(combatantId, options);
    return;
  }
  const gmIds = activeGMIds();
  if (!gmIds.length) {
    aiLog("SendTurnRequest -> no GM online, aborting");
    notifyUser(game.user.id, game.i18n.localize("ActiveInitiative.Notify.NoGM"));
    return;
  }
  aiLog("SendTurnRequest -> whispering request carrier to GM", gmIds);
  await aiPostCarrier(gmIds, { t: "request", steal, combatantId, combatId: game.combat?.id, userId: game.user.id });
}

async function giveTurn(combatantId, { requestedBy = game.user.id, trusted = false, combat = game.combat } = {}) {
  aiLog("giveTurn ENTER", { combatantId, requestedBy, trusted, started: combat?.started, currentId: combat?.combatant?.id });
  if (!combat?.started) { aiLog("giveTurn ABORT: combat not started"); return; }
  const requestUser = game.users?.get(requestedBy) ?? game.user;
  const privileged = trusted && !!requestUser?.isGM;
  const state = readTurnState(combat);
  const current = combat.combatant;
  const currentId = current?.id;

  // Players can only hand the turn off during their own combatants turn
  if (!privileged && (!current || !ownsCombatant(current, requestUser))) {
    aiLog("giveTurn REJECT: not requester's turn", { currentId, owns: current ? ownsCombatant(current, requestUser) : null, requester: requestUser?.name });
    notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.NotYourTurn"));
    return;
  }

  // Remove queue entries that are dead, removed, already acted or got set active by the GM
  state.queue = state.queue.filter(id => {
    const c = combat.combatants.get(id);
    return c && id !== currentId && !isCombatantDefeated(c) && !state.acted[id];
  });

  // A queued interrupt takes priority over the requested target
  const forced = state.queue.length > 0;
  const targetId = forced ? state.queue[0] : combatantId;
  const target = combat.combatants.get(targetId);
  if (!target) { aiLog("giveTurn ABORT: target combatant not found", targetId); return; }
  const turn = combat.turns.findIndex(c => c.id === targetId);
  if (turn < 0) { aiLog("giveTurn ABORT: target not in combat.turns", targetId); return; }

  if (isCombatantDefeated(target)) {
    notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.DefeatedReceive"));
    return;
  }
  if (targetId === currentId) {
    notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.TargetIsActive"));
    return;
  }
  if (forced && targetId !== combatantId) {
    notifyUser(requestedBy, game.i18n.format("ActiveInitiative.Notify.InterruptPriority", { name: target.name }), "info");
  }

  const nextActed = foundry.utils.deepClone(state.acted);
  if (currentId && currentId !== targetId) nextActed[currentId] = true;
  const roundComplete = !forced && allAbleCombatantsActed(combat, nextActed);

  if (!forced && state.acted[targetId] && !roundComplete) {
    notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.AlreadyActed"));
    return;
  }

  const queue = forced ? state.queue.slice(1) : state.queue;

  aiLog("giveTurn APPLY: moving turn", { targetId, turn, targetName: target.name, roundComplete, forced });
  if (roundComplete) {
    await advanceRoundToTurn(combat, turn);
  } else {
    // Steal eligibility ends when the turn changes, queued interrupts stay
    await updateTurnState(combat, { round: combat.round ?? 1, acted: nextActed, steal: {}, queue }, { turn });
  }
  aiLog("giveTurn DONE: combat.turn now", combat.turn, "current", combat.combatant?.name);
  ui.combat?.render(false);
}

// Queues a combatant to act after the current turn ends
async function reserveInterrupt(combatantId, { requestedBy = game.user.id, trusted = false, combat = game.combat } = {}) {
  aiLog("reserveInterrupt ENTER", { combatantId, requestedBy, trusted, started: combat?.started });
  if (!combat?.started) { aiLog("reserveInterrupt ABORT: combat not started"); return; }
  const target = combat.combatants.get(combatantId);
  if (!target) { aiLog("reserveInterrupt ABORT: target not found", combatantId); return; }
  const requestUser = game.users?.get(requestedBy) ?? game.user;
  const privileged = trusted && !!requestUser?.isGM;
  const state = readTurnState(combat);
  const current = combat.combatant;

  if (isCombatantDefeated(target)) return notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.DefeatedInterrupt"));
  if (combatantId === current?.id) return notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.ActiveInterrupt"));
  if (state.acted[combatantId]) return notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.ActedInterrupt"));
  if (state.queue.includes(combatantId)) return notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.AlreadyQueued"));
  if (!state.steal[combatantId]) return notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.NotEligible"));
  if (!privileged && !ownsCombatant(target, requestUser)) return notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.NotOwner"));
  //TODO: setting to allow interrupting allies?
  if (!privileged && areAllies(target, current)) return notifyUser(requestedBy, game.i18n.localize("ActiveInitiative.Notify.AllyInterrupt"));

  state.queue.push(combatantId);
  delete state.steal[combatantId];
  aiLog("reserveInterrupt QUEUED", { combatantId, name: target.name, queue: state.queue, note: "acts when the CURRENT turn is handed off" });
  await updateTurnState(combat, state);
  ui.combat?.render(false);
}

async function setActiveCombatant(combatantId) {
  const combat = game.combat;
  if (!combat?.started || !game.user.isGM) return;
  const turn = combat.turns.findIndex(c => c.id === combatantId);
  if (turn < 0) return;
  const state = readTurnState(combat);
  const currentId = combat.combatant?.id;
  const nextActed = foundry.utils.deepClone(state.acted);
  if (currentId && currentId !== combatantId) nextActed[currentId] = true;
  // Remove the new active combatant from the queue, otherwise later handoffs get stuck on it
  const queue = state.queue.filter(id => id !== combatantId);
  const roundComplete = currentId && currentId !== combatantId && allAbleCombatantsActed(combat, nextActed);
  if (roundComplete) {
    await advanceRoundToTurn(combat, turn);
  } else {
    await updateTurnState(combat, { ...state, acted: nextActed, steal: {}, queue }, { turn });
  }
  ui.combat?.render(false);
}

async function advanceRoundToTurn(combat, turn) {
  const nextRound = (combat.round ?? 1) + 1;
  // The option gets sent along with the update and tells the updateCombat hook not to reset again
  await combat.update({
    round: nextRound,
    turn,
    [STATE_PATH]: serializeTurnState(makeTurnState({ round: nextRound }))
  }, { activeInitiativeRoundAdvance: true });
}

function isFinalHandoff(combat, acted) {
  const currentId = combat.combatant?.id;
  if (!currentId) return false;
  const nextActed = foundry.utils.deepClone(acted);
  nextActed[currentId] = true;
  return allAbleCombatantsActed(combat, nextActed);
}

function allAbleCombatantsActed(combat, acted) {
  return combat.combatants.every(combatant => isCombatantDefeated(combatant) || acted[combatant.id]);
}

function isCombatantDefeated(combatant) {
  // isDefeated also covers the dead status condition, not just the tracker toggle
  return !!(combatant?.isDefeated ?? combatant?.defeated);
}

function ownsCombatant(combatant, user = game.user) {
  if (user?.isGM) return true;
  return !!combatant.actor?.testUserPermission?.(user, "OWNER");
}

function areAllies(a, b) {
  const aDisposition = a?.token?.disposition;
  const bDisposition = b?.token?.disposition;
  return aDisposition != null && bDisposition != null && aDisposition === bDisposition;
}

//DAMAGE DETECTION

// Returns the damage taken or null (flipped when the value counts up instead of down)
function damageTaken(current, next) {
  if (typeof current !== "number" || typeof next !== "number") return null;
  const delta = game.settings.get(MODULE_ID, "damageOnIncrease") ? next - current : current - next;
  return delta > 0 ? delta : null;
}

function prunePendingDamage(map, maxAgeMs = PENDING_DAMAGE_TTL) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, value] of map) if (value.at < cutoff) map.delete(key);
}

function getTokenHPChange(changed, path) {
  const delta = foundry.utils.getProperty(changed, `delta.${path}`);
  return typeof delta === "number" ? delta : undefined;
}

async function sendDamageReport(combat, combatants, amount, report) {
  if (isResponsibleGM()) {
    await markStealEligible(combat, combatants);
    return;
  }
  const gmIds = activeGMIds();
  if (!gmIds.length) return;
  await aiPostCarrier(gmIds, {
    t: "damage",
    combatId: combat.id,
    userId: game.user?.id,
    ...report,
    combatantIds: combatants.map(combatant => combatant.id),
    amount
  });
}

async function onDamageReport(payload, authorId = payload?.userId) {
  if (!game.settings.get(MODULE_ID, "stealOnDamage")) return;
  // resolve by id too, so damage-steal works when the GM is on another scene
  const combat = (payload?.combatId ? game.combats?.get(payload.combatId) : null) ?? game.combat;
  if (!combat?.started) return;
  if (!authorId || payload.userId !== authorId) return;
  const reporter = game.users?.get(authorId);
  if (!reporter?.active) return;
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const combatants = matchReportedCombatants(combat, payload)
    .filter(combatant => ownsCombatant(combatant, reporter));
  if (!combatants.length) {
    console.warn("ActiveInitiative | Ignoring damage report for combatants not owned by the author.", { authorId, payload });
    return;
  }
  await markStealEligible(combat, combatants);
}

function matchReportedCombatants(combat, payload) {
  const reportedIds = Array.isArray(payload.combatantIds) ? payload.combatantIds : [];
  const reportedCombatants = reportedIds
    .map(id => combat.combatants.get(id))
    .filter(combatant => combatant && matchesDamageReport(combatant, payload));
  if (reportedCombatants.length) return reportedCombatants;

  if (payload.kind === "token" && payload.tokenId) {
    return combat.combatants.filter(combatant => matchesDamageReport(combatant, payload));
  }

  const actorMatches = combat.combatants.filter(combatant => matchesDamageReport(combatant, payload));
  return actorMatches.length <= 1 ? actorMatches : [];
}

function matchesDamageReport(combatant, payload) {
  if (payload.kind === "token") {
    const sceneMatches = !payload.sceneId || !combatant.sceneId || combatant.sceneId === payload.sceneId;
    return sceneMatches && combatant.tokenId === payload.tokenId;
  }
  if (payload.actorUuid && combatant.actor?.uuid === payload.actorUuid) return true;
  return !!payload.actorId && combatant.actor?.id === payload.actorId;
}

// If an actor has several unlinked tokens we try targeted/selected tokens to find the right one
function findCombatantsForActor(combat, actor) {
  const tokenId = actor.token?.id;
  if (tokenId) return combat.combatants.filter(c => c.tokenId === tokenId);

  const matches = combat.combatants.filter(c => c.actor?.id === actor.id);
  if (matches.length <= 1) return matches;

  const targeted = matches.filter(c => isCombatantTargeted(c));
  if (targeted.length === 1) return targeted;

  const controlled = matches.filter(c => isCombatantControlled(c));
  if (controlled.length === 1) return controlled;

  return [];
}

function getTokenCombatants(combat, token) {
  return combat.combatants.filter(c => c.tokenId === token.id && (!c.sceneId || !token.parent?.id || c.sceneId === token.parent.id));
}

function isCombatantTargeted(combatant) {
  return [...(game.user?.targets ?? [])].some(token => token.document?.id === combatant.tokenId && (!combatant.sceneId || token.document?.parent?.id === combatant.sceneId));
}

function isCombatantControlled(combatant) {
  return (globalThis.canvas?.tokens?.controlled ?? []).some(token => token.document?.id === combatant.tokenId && (!combatant.sceneId || token.document?.parent?.id === combatant.sceneId));
}

async function markStealEligible(combat, combatants) {
  if (!isResponsibleGM() || !combatants.length) return;
  const state = readTurnState(combat);
  let changed = false;
  for (const combatant of combatants) {
    if (combatant.id === combat.combatant?.id || state.acted[combatant.id] || state.queue.includes(combatant.id)) continue;
    if (state.steal[combatant.id]) continue; // already eligible, nothing to do
    state.steal[combatant.id] = true;
    changed = true;
  }
  if (!changed) return;
  await updateTurnState(combat, state);
  ui.combat?.render(false);
}

//COMBAT TRACKER UI

function refreshTracker(root) {
  const combat = game.combat;
  if (!root || !combat?.started) return;
  if (root.dataset.activeInitiativeWired !== "true") {
    root.dataset.activeInitiativeWired = "true";
    root.addEventListener("click", onTrackerClick);
  }

  const state = readTurnState(combat);
  //console.log("ActiveInitiative | refreshTracker", state);
  const currentId = combat.combatant?.id;
  addTrackerBanner(root);
  for (const row of getCombatantRows(root, combat)) {
    const combatantId = row.dataset.combatantId;
    const combatant = combat.combatants.get(combatantId);
    if (!combatant) continue;
    const isCurrent = combatantId === currentId;
    const isQueued = state.queue.includes(combatantId);
    const hasActed = !!state.acted[combatantId];
    const canSteal = !!state.steal[combatantId] && !hasActed && !isQueued;
    row.classList.toggle("ai-active", isCurrent);
    row.classList.toggle("ai-acted", hasActed);
    row.classList.toggle("ai-can-steal", canSteal);
    row.classList.toggle("ai-queued", isQueued);
    row.classList.toggle("ai-ready", !isCurrent && !hasActed && !isQueued && !canSteal);
    row.dataset.aiState = isCurrent ? "active" : isQueued ? "queued" : canSteal ? "steal" : hasActed ? "acted" : "ready";
    buildCombatantPanel(row, combatant, state);
  }
}

function addTrackerBanner(root) {
  root.querySelector(".ai-tracker-banner")?.remove();
  const banner = document.createElement("div");
  banner.className = "ai-tracker-banner";
  const title = document.createElement("strong");
  title.textContent = "Active Initiative";
  banner.append(title);
  root.prepend(banner);
}

function getCombatantRows(root, combat) {
  return [...root.querySelectorAll("[data-combatant-id]")].filter(element => {
    if (element.closest(".ai-combatant-panel")) return false;
    if (element.matches("[data-ai-action]") || element.closest("[data-ai-action]")) return false;
    return !!combat.combatants.get(element.dataset.combatantId);
  });
}

function buildCombatantPanel(row, combatant, state) {
  row.querySelectorAll(".ai-combatant-panel").forEach(panel => panel.remove());
  const combat = game.combat;
  const isCurrent = combatant.id === combat.combatant?.id;
  const hasActed = !!state.acted[combatant.id];
  const isQueued = state.queue.includes(combatant.id);
  const queuePending = state.queue.length > 0;
  const canReceiveTurn = !isCombatantDefeated(combatant);
  const canStartNextRound = canReceiveTurn && !isCurrent && isFinalHandoff(combat, state.acted);
  // Players only get the give turn button while its their own combatants turn
  const myTurn = game.user.isGM || (!!combat.combatant && ownsCombatant(combat.combatant));
  // While an interrupt is queued only the next interrupter can receive the turn
  const canGiveTurn = myTurn && canReceiveTurn && !isCurrent && (!hasActed || canStartNextRound)
    && (!queuePending || combatant.id === state.queue[0]);
  // Keep this in sync with the checks in reserveInterrupt
  const canInterrupt = canReceiveTurn && !!state.steal[combatant.id] && !hasActed && !isQueued && !isCurrent
    && ownsCombatant(combatant)
    && (game.user.isGM || !areAllies(combatant, combat.combatant));
  const canSetActive = game.user.isGM && canReceiveTurn && !isCurrent;
  // GM-only: undo an "acted" mark so the combatant can act again this round
  const canClearActed = game.user.isGM && hasActed;
  const stateLabel = isQueued ? game.i18n.localize("ActiveInitiative.States.Queued")
    : isCurrent ? game.i18n.localize("ActiveInitiative.States.Active")
    : canInterrupt ? game.i18n.localize("ActiveInitiative.States.CanInterrupt")
    : hasActed ? game.i18n.localize("ActiveInitiative.States.Acted")
    : game.i18n.localize("ActiveInitiative.States.Ready");

  const panel = document.createElement("div");
  panel.className = "ai-combatant-panel";
  panel.innerHTML = `
    <span class="ai-state-marker" title="${stateLabel}" aria-label="${stateLabel}"></span>
    <div class="ai-combatant-actions">
      ${canSetActive ? `<button type="button" class="ai-set-btn" data-ai-action="set-active" data-ai-combatant-id="${combatant.id}" title="${game.i18n.localize("ActiveInitiative.Buttons.SetActiveTitle")}" aria-label="${game.i18n.localize("ActiveInitiative.Buttons.SetActive")}"><i class="fas fa-crosshairs"></i></button>` : ""}
      ${canGiveTurn ? `<button type="button" class="ai-turn-btn" data-ai-action="give" data-ai-combatant-id="${combatant.id}" title="${game.i18n.localize("ActiveInitiative.Buttons.GiveTurnTitle")}" aria-label="${game.i18n.localize("ActiveInitiative.Buttons.GiveTurn")}"><i class="fas fa-share"></i></button>` : ""}
      ${canInterrupt ? `<button type="button" class="ai-steal-btn" data-ai-action="steal" data-ai-combatant-id="${combatant.id}" title="${game.i18n.localize("ActiveInitiative.Buttons.InterruptTitle")}" aria-label="${game.i18n.localize("ActiveInitiative.Buttons.Interrupt")}"><i class="fas fa-bolt"></i></button>` : ""}
      ${canClearActed ? `<button type="button" class="ai-unact-btn" data-ai-action="unact" data-ai-combatant-id="${combatant.id}" title="${game.i18n.localize("ActiveInitiative.Buttons.ClearActedTitle")}" aria-label="${game.i18n.localize("ActiveInitiative.Buttons.ClearActed")}"><i class="fas fa-rotate-left"></i></button>` : ""}
    </div>
  `;

  row.append(panel);
}

async function onTrackerClick(event) {
  const button = event.target.closest("[data-ai-action]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const combatantId = button.dataset.aiCombatantId;
  aiLog("tracker CLICK", { action: button.dataset.aiAction, combatantId, isGM: game.user.isGM });
  if (!combatantId) return;
  if (button.dataset.aiAction === "set-active") await setActiveCombatant(combatantId);
  if (button.dataset.aiAction === "give") await SendTurnRequest(combatantId);
  if (button.dataset.aiAction === "steal") await SendTurnRequest(combatantId, { steal: true });
  if (button.dataset.aiAction === "unact") await clearActed(combatantId);
}

// GM-only: clear a combatant's "acted" mark so they count as ready again this
// round. Runs locally - the GM can update the combat directly, no carrier needed.
async function clearActed(combatantId) {
  const combat = game.combat;
  if (!combat?.started || !game.user.isGM) return;
  const state = readTurnState(combat);
  if (!state.acted[combatantId]) return;
  delete state.acted[combatantId];
  aiLog("clearActed", { combatantId });
  await updateTurnState(combat, state);
  ui.combat?.render(false);
}

//DEBUG

function debugSnapshot(combat = game.combat) {
  if (!combat) return undefined;
  const state = readTurnState(combat);
  const snapshot = {
    round: combat.round,
    turn: combat.turn,
    current: combat.combatant?.name,
    currentId: combat.combatant?.id,
    queue: state.queue,
    rawState: combat.getFlag(MODULE_ID, STATE_FLAG),
    state,
    combatants: combat.turns.map(combatant => ({
      id: combatant.id,
      name: combatant.name,
      defeated: isCombatantDefeated(combatant),
      acted: !!state.acted[combatant.id],
      steal: !!state.steal[combatant.id],
      queued: state.queue.includes(combatant.id)
    }))
  };
  console.log(`${MODULE_ID} | snapshot`, snapshot);
  return snapshot;
}
