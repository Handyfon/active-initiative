const MODULE_ID = "active-initiative";
const SOCKET = `module.${MODULE_ID}`;
const STATE_FLAG = "state";
const STATE_PATH = `flags.${MODULE_ID}.${STATE_FLAG}`;

const pendingActorDamage = new Map();
const pendingTokenDamage = new Map();
const PENDING_DAMAGE_TTL = 5000;

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
    responsibleGM: () => getResponsibleGM()?.id
  };
  game.socket.on(SOCKET, async payload => {
    if (payload?.type === "requestResult") {
      showRequestResult(payload);
      return;
    }
    if (!isResponsibleGM()) return;
    if (payload?.combatId && game.combat?.id !== payload.combatId) return;
    if (payload?.type === "damageTaken") {
      await onDamageReport(payload);
      return;
    }
    if (payload?.type !== "giveTurn") return;
    // Socket messages can fake their sender id, so we never trust GM claims from the socket (real GMs act locally)
    const requester = game.users?.get(payload.userId);
    if (!requester || requester.isGM || !requester.active) return;
    const options = { requestedBy: requester.id, trusted: false };
    if (payload.steal) await reserveInterrupt(payload.combatantId, options);
    else await giveTurn(payload.combatantId, options);
  });
});

Hooks.once("ready", async () => {
  if (!game.user.isGM) return;
  if (game.settings.get(MODULE_ID, "hasSeenRecommendation") || game.system.id === "dnd5e") return;

  const systemPresets = await loadSystemPresets();
  const preset = systemPresets[game.system.id] || null;
  if (!preset) {
    ui.notifications.warn("Active Initiative | Your system (" + game.system.id + ") has no recommended preset, please set the HP Damage Path in the module settings.");
    await game.settings.set(MODULE_ID, "hasSeenRecommendation", true);
    return;
  }

  // Heartbeat marks wound based systems through its invert settings, those count up for us
  const countsUp = !!(preset.settings?.["heartbeat.wounds"] || preset.settings?.["partywatch.wounds"]);
  const currentPath = game.settings.get(MODULE_ID, "damagePath");
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: "Active Initiative Configuration" },
    content: `
      <p>The detected system (<strong>${preset.name}</strong>) has a recommended configuration.</p>
      <p>Would you like to apply it?</p>
      <hr>
      <p><strong>Current HP Damage Path:</strong></p>
      <p>${currentPath} &rarr; <strong>${preset.hpPath}</strong></p>
      ${countsUp ? "<p>This system counts damage up, so <strong>Increasing Value Means Damage</strong> gets enabled as well.</p>" : ""}`,
    buttons: [
      { action: "apply", label: "Apply Settings", default: true },
      { action: "skip", label: "Don't ask again" }
    ],
    rejectClose: false
  });

  if (choice === "apply") {
    await game.settings.set(MODULE_ID, "damagePath", preset.hpPath);
    await game.settings.set(MODULE_ID, "damageOnIncrease", countsUp);
    await game.settings.set(MODULE_ID, "hasSeenRecommendation", true);
    ui.notifications.info(`Applied settings for ${preset.name}.`);
  } else if (choice === "skip") {
    await game.settings.set(MODULE_ID, "hasSeenRecommendation", true);
    ui.notifications.warn("Default settings remain. Configure manually in module settings if needed.");
  }
});

Hooks.on("preUpdateActor", (actor, changed) => {
  if (!game.settings.get(MODULE_ID, "stealOnDamage")) return;
  const path = game.settings.get(MODULE_ID, "damagePath");
  const next = foundry.utils.getProperty(changed, path);
  if (typeof next !== "number") return;
  const amount = damageTaken(foundry.utils.getProperty(actor, path), next);
  if (amount == null) return;
  prunePendingDamage(pendingActorDamage);
  pendingActorDamage.set(actor.uuid ?? actor.id, { amount, at: Date.now() });
});

Hooks.on("updateActor", async actor => {
  const damageKey = actor.uuid ?? actor.id;
  const damage = pendingActorDamage.get(damageKey);
  if (!damage) return;
  pendingActorDamage.delete(damageKey);
  const combat = game.combat;
  if (!combat?.started) return;
  const combatants = findCombatantsForActor(combat, actor);
  await sendDamageReport(combat, combatants, damage, {
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
  const amount = damageTaken(foundry.utils.getProperty(token.actor, path), next);
  if (amount == null) return;
  prunePendingDamage(pendingTokenDamage);
  pendingTokenDamage.set(token.uuid ?? token.id, { amount, at: Date.now() });
});

Hooks.on("updateToken", async token => {
  const damageKey = token.uuid ?? token.id;
  const damage = pendingTokenDamage.get(damageKey);
  if (!damage) return;
  pendingTokenDamage.delete(damageKey);
  const combat = game.combat;
  if (!combat?.started) return;
  const combatants = getTokenCombatants(combat, token);
  await sendDamageReport(combat, combatants, damage, {
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

Hooks.on("updateCombat", async (combat, changed, options) => {
  if (!isResponsibleGM()) return;
  if (!Object.prototype.hasOwnProperty.call(changed, "round")) return;
  // Our own round advances already reset the state in the same update
  if (options?.activeInitiativeRoundAdvance) return;
  await resetRoundState(combat);
});

Hooks.on("renderCombatTracker", (app, html) => {
  const root = globalThis.jQuery && html instanceof globalThis.jQuery ? html[0] : html;
  refreshTracker(root);
});

//RUNTIME HELPERS

function getResponsibleGM() {
  return game.users?.activeGM ?? null;
}

function isResponsibleGM() {
  return !!game.user?.isGM && game.users?.activeGM === game.user;
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
    console.warn("ActiveInitiative | Failed to load system presets from GitHub. Defaulting to unsupported system behavior.", error);
    return {};
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
  game.socket.emit(SOCKET, { type: "requestResult", userId, level, message: text });
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
  await combat.update({
    ...extra,
    [STATE_PATH]: serializeTurnState(makeTurnState({ round, acted: state.acted, steal: state.steal, queue: state.queue }))
  });
}

//TURN FLOW

async function SendTurnRequest(combatantId, { steal = false } = {}) {
  if (game.user.isGM) {
    const options = { requestedBy: game.user.id, trusted: true };
    if (steal) await reserveInterrupt(combatantId, options);
    else await giveTurn(combatantId, options);
    return;
  }
  if (!getResponsibleGM()) {
    notifyUser(game.user.id, game.i18n.localize("ActiveInitiative.Notify.NoGM"));
    return;
  }
  game.socket.emit(SOCKET, {
    type: "giveTurn",
    combatId: game.combat?.id,
    combatantId,
    steal,
    userId: game.user.id
  });
}

async function giveTurn(combatantId, { requestedBy = game.user.id, trusted = false } = {}) {
  const combat = game.combat;
  if (!combat?.started) return;
  const requestUser = game.users?.get(requestedBy) ?? game.user;
  const privileged = trusted && !!requestUser?.isGM;
  const state = readTurnState(combat);
  const current = combat.combatant;
  const currentId = current?.id;

  // Players can only hand the turn off during their own combatants turn
  if (!privileged && (!current || !ownsCombatant(current, requestUser))) {
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
  if (!target) return;
  const turn = combat.turns.findIndex(c => c.id === targetId);
  if (turn < 0) return;

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

  if (roundComplete) {
    await advanceRoundToTurn(combat, turn);
  } else {
    // Steal eligibility ends when the turn changes, queued interrupts stay
    await updateTurnState(combat, { round: combat.round ?? 1, acted: nextActed, steal: {}, queue }, { turn });
  }
  ui.combat?.render(false);
}

// Queues a combatant to act after the current turn ends
async function reserveInterrupt(combatantId, { requestedBy = game.user.id, trusted = false } = {}) {
  const combat = game.combat;
  if (!combat?.started) return;
  const target = combat.combatants.get(combatantId);
  if (!target) return;
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

async function sendDamageReport(combat, combatants, damage, report) {
  if (isResponsibleGM()) {
    await markStealEligible(combat, combatants, damage);
    return;
  }
  game.socket.emit(SOCKET, {
    type: "damageTaken",
    combatId: combat.id,
    userId: game.user?.id,
    ...report,
    combatantIds: combatants.map(combatant => combatant.id),
    amount: damage.amount,
    at: damage.at
  });
}

async function onDamageReport(payload) {
  if (!game.settings.get(MODULE_ID, "stealOnDamage")) return;
  const combat = game.combat;
  if (!combat?.started) return;
  if (payload?.combatId && combat.id !== payload.combatId) return;
  const reporter = payload.userId ? game.users?.get(payload.userId) : null;
  if (payload.userId && !reporter?.active) return;
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const at = Number(payload.at);
  const damage = { amount, at: Number.isFinite(at) ? at : Date.now() };
  await markStealEligible(combat, matchReportedCombatants(combat, payload), damage);
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

async function markStealEligible(combat, combatants, damage) {
  if (!isResponsibleGM() || !combatants.length) return;
  const state = readTurnState(combat);
  let changed = false;
  for (const combatant of combatants) {
    if (combatant.id === combat.combatant?.id || state.acted[combatant.id] || state.queue.includes(combatant.id)) continue;
    if (state.steal[combatant.id]) continue; // already eligible, nothing to do
    state.steal[combatant.id] = { amount: damage.amount, round: combat.round, at: damage.at };
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
  if (!combatantId) return;
  if (button.dataset.aiAction === "set-active") await setActiveCombatant(combatantId);
  if (button.dataset.aiAction === "give") await SendTurnRequest(combatantId);
  if (button.dataset.aiAction === "steal") await SendTurnRequest(combatantId, { steal: true });
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
