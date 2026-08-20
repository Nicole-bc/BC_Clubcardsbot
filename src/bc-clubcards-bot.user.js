// ==UserScript==
// @name         BC Club Cards Bot
// @namespace    https://github.com/Nicole-bc/BC_Clubcardsbot
// @version      0.1.0
// @description  Builds a meta Club Cards deck from the live card pool and plays it automatically.
// @match        https://*.bondageprojects.elementfx.com/*
// @match        https://*.bondage-europe.com/*
// @match        https://*.bondageprojects.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Console API (window.BCC):
 *   BCC.probe()          - dump the live Club Cards API surface and card pool stats
 *   BCC.build()          - compute a deck, return it, print it (does not save)
 *   BCC.save(slot)       - compute and persist the deck into a deck slot
 *   BCC.start()          - enable autoplay
 *   BCC.stop()           - disable autoplay
 *   BCC.config           - live-editable settings
 *
 * Safety defaults: dryRun = true (decides and logs, never acts) and allowOnline = false
 * (never acts in a game against another human). Flip both deliberately.
 */

(function () {
	"use strict";

	const CONFIG = {
		dryRun: true,
		allowOnline: false,
		autoplay: false,
		deckSlot: 0,
		deckSize: null,          // null => ClubCardBuilderMaxDeckSize, else fixed
		deckSeparator: ",",
		archetype: null,         // null => auto-detect the deepest group in your pool
		tickMs: 700,
		actionDelayMs: [900, 1900],
		curve: { 1: 16, 2: 12, 3: 8, 4: 4 },   // cards per tier (RequiredLevel)
		weights: {
			fame: 3.0,
			money: 1.6,
			extraPlay: 6.0,
			extraTime: 2.0,
			activeAbility: 2.0,
			specialEffect: 1.5,
			synergy: 3.5,
			liability: 2.5,
			tierPenalty: 1.4,
			prereqPenalty: 2.0,
			temporaryPenalty: 0.8,
		},
		verbose: true,
	};

	const META_TAGS = new Set(["All Cards", "Selected Cards", "Event Cards", "Ungrouped", "Reward Cards"]);

	let timer = null;
	let nextActionAt = 0;
	let lastBlockReason = "";

	const log = (...a) => CONFIG.verbose && console.log("%c[BCC]", "color:#c58af9", ...a);
	const warn = (...a) => console.warn("[BCC]", ...a);
	const rnd = ([lo, hi]) => lo + Math.random() * (hi - lo);

	// ---------------------------------------------------------------- helpers

	const has = (name) => typeof window[name] !== "undefined";
	const fn = (name) => (typeof window[name] === "function" ? window[name] : null);

	function gameReady() {
		return Array.isArray(window.ClubCardList) && window.ClubCardList.length > 0 && !!window.Player;
	}

	function mySeat() {
		if (!Array.isArray(window.ClubCardPlayer) || !window.ClubCardPlayer.length) return null;
		const idx = fn("ClubCardGetPlayerIndex") ? ClubCardGetPlayerIndex() : -1;
		if (idx >= 0 && window.ClubCardPlayer[idx]) return window.ClubCardPlayer[idx];
		return window.ClubCardPlayer.find((p) => p && p.Control === "Player") || null;
	}

	function opponentSeat(me) {
		if (fn("ClubCardGetOpponent")) {
			try { return ClubCardGetOpponent(me); } catch (e) { /* fall through */ }
		}
		return (window.ClubCardPlayer || []).find((p) => p && p !== me) || null;
	}

	function isMyTurn(me) {
		return !!me && window.ClubCardPlayer && window.ClubCardPlayer[window.ClubCardTurnIndex] === me;
	}

	function tierOf(card) {
		const lvl = Number(card.RequiredLevel || 1);
		return Number.isFinite(lvl) && lvl > 0 ? lvl : 1;
	}

	function memberLimit(seat) {
		const table = window.ClubCardLevelLimit;
		if (!Array.isArray(table)) return Infinity;
		return table[seat.Level] ?? table[seat.Level - 1] ?? Infinity;
	}

	function boardFull(seat) {
		const limit = memberLimit(seat);
		return Number.isFinite(limit) && (seat.Board || []).length >= limit;
	}

	function isLiability(card) {
		if (fn("ClubCardIsLiability")) {
			try { return !!ClubCardIsLiability(card); } catch (e) { /* fall through */ }
		}
		return Array.isArray(card.Group) && card.Group.includes("Liability");
	}

	// ------------------------------------------------------------ deck building

	function ownedRewardIds() {
		const raw = window.Player && Player.Game && Player.Game.ClubCard && Player.Game.ClubCard.Reward;
		const ids = new Set();
		if (typeof raw === "string") (raw.match(/\d+/g) || []).forEach((n) => ids.add(Number(n)));
		else if (Array.isArray(raw)) raw.forEach((n) => ids.add(Number(n)));
		return ids;
	}

	/** Cards this account is actually allowed to put in a deck. */
	function cardPool() {
		if (Array.isArray(window.ClubCardBuilderList) && ClubCardBuilderList.length) {
			return ClubCardBuilderList.slice();
		}
		const owned = ownedRewardIds();
		return (window.ClubCardList || []).filter((c) => !c.Reward || owned.has(c.ID));
	}

	function groupsOf(card) {
		return (card.Group || []).filter((g) => !META_TAGS.has(g));
	}

	/** Pick the archetype with the deepest, strongest pool. */
	function detectArchetype(pool) {
		if (CONFIG.archetype) return CONFIG.archetype;
		const tally = new Map();
		for (const card of pool) {
			const s = Math.max(0, rawScore(card, null));
			for (const g of groupsOf(card)) tally.set(g, (tally.get(g) || 0) + s);
		}
		let best = null, bestVal = -Infinity;
		for (const [g, v] of tally) if (v > bestVal) { best = g; bestVal = v; }
		return best;
	}

	/** Archetype-independent card value. */
	function rawScore(card, archetype) {
		const W = CONFIG.weights;
		const tier = tierOf(card);
		let s = 0;
		s += W.fame * Number(card.FamePerTurn || 0);
		s += W.money * Number(card.MoneyPerTurn || 0);
		s += W.extraPlay * Number(card.ExtraPlay || 0);
		s += W.extraTime * Number(card.ExtraTime || 0);
		if (card.CanActive) s += W.activeAbility;
		if (card.EffectType || card.Negating) s += W.specialEffect;
		if (isLiability(card)) s += W.liability;
		if (card.Time) s -= W.temporaryPenalty;          // events expire
		if (card.Prerequisite) s -= W.prereqPenalty;      // conditional, can brick
		s -= W.tierPenalty * (tier - 1);
		if (archetype && groupsOf(card).includes(archetype)) s += W.synergy;
		return s;
	}

	function targetDeckSize() {
		if (CONFIG.deckSize) return CONFIG.deckSize;
		if (typeof window.ClubCardBuilderMaxDeckSize === "number") return ClubCardBuilderMaxDeckSize;
		return 40;
	}

	/**
	 * Greedy build: fill the mana-curve quotas tier by tier, then top up with the best
	 * remaining cards. Deck is unique by ID, which the game requires anyway.
	 */
	function buildDeck() {
		if (!gameReady()) { warn("Game not loaded yet."); return null; }
		const pool = cardPool();
		if (!pool.length) { warn("Empty card pool - open the deck builder once, then retry."); return null; }

		const archetype = detectArchetype(pool);
		const size = targetDeckSize();
		const scored = pool
			.map((c) => ({ card: c, score: rawScore(c, archetype), tier: tierOf(c) }))
			.sort((a, b) => b.score - a.score);

		const picked = new Map();
		for (const [tierKey, quota] of Object.entries(CONFIG.curve)) {
			const tier = Number(tierKey);
			let n = 0;
			for (const e of scored) {
				if (n >= quota || picked.size >= size) break;
				const inBucket = tier >= 4 ? e.tier >= 4 : e.tier === tier;
				if (!inBucket || picked.has(e.card.ID)) continue;
				picked.set(e.card.ID, e);
				n++;
			}
		}
		for (const e of scored) {
			if (picked.size >= size) break;
			if (!picked.has(e.card.ID)) picked.set(e.card.ID, e);
		}

		const entries = [...picked.values()].sort((a, b) => a.tier - b.tier || b.score - a.score);
		const deck = {
			archetype,
			size: entries.length,
			ids: entries.map((e) => e.card.ID),
			cards: entries.map((e) => ({
				id: e.card.ID, name: e.card.Name, tier: e.tier,
				fame: e.card.FamePerTurn || 0, money: e.card.MoneyPerTurn || 0,
				groups: groupsOf(e.card), score: Number(e.score.toFixed(2)),
			})),
		};
		if (deck.size < size) warn(`Only ${deck.size}/${size} cards available in your pool.`);
		log(`Built "${archetype}" deck (${deck.size} cards)`);
		console.table(deck.cards);
		return deck;
	}

	function saveDeck(slot = CONFIG.deckSlot) {
		const deck = buildDeck();
		if (!deck) return null;
		if (CONFIG.dryRun) { log("dryRun: not saving. Set BCC.config.dryRun = false to persist."); return deck; }

		Player.Game = Player.Game || {};
		Player.Game.ClubCard = Player.Game.ClubCard || {};
		const cc = Player.Game.ClubCard;
		cc.Deck = Array.isArray(cc.Deck) ? cc.Deck : [];
		cc.DeckName = Array.isArray(cc.DeckName) ? cc.DeckName : [];
		while (cc.Deck.length <= slot) cc.Deck.push("");
		while (cc.DeckName.length <= slot) cc.DeckName.push("");
		cc.Deck[slot] = deck.ids.join(CONFIG.deckSeparator);
		cc.DeckName[slot] = `Meta ${deck.archetype || ""}`.trim().slice(0, 20);

		if (window.ServerAccountUpdate && typeof ServerAccountUpdate.QueueData === "function") {
			ServerAccountUpdate.QueueData({ Game: Player.Game });
			log(`Saved deck to slot ${slot} and queued a server update.`);
		} else {
			warn("ServerAccountUpdate unavailable - deck set locally only.");
		}
		return deck;
	}

	// ------------------------------------------------------------- play engine

	function sync() {
		if (fn("GameClubCardSyncOnlineData") && fn("ClubCardIsOnline") && ClubCardIsOnline()) {
			try { GameClubCardSyncOnlineData("Action"); } catch (e) { warn("sync failed", e); }
		}
	}

	/** In-game value of playing this card right now. */
	function playScore(card, me, opp) {
		let s = rawScore(card, currentArchetype(me));
		const fameGoal = Number(window.ClubCardFameGoal || 0);
		if (fameGoal > 0) {
			const remaining = fameGoal - Number(me.Fame || 0);
			if (remaining <= 8) s += CONFIG.weights.fame * Number(card.FamePerTurn || 0); // double down on fame
		}
		if (boardFull(me) && !isLiability(card) && !card.Time) s -= 4; // no room for another member
		if (isLiability(card) && opp && (opp.Board || []).length >= 3) s += 2;
		if (card.Prerequisite && fn("ClubCardCanPlayCard")) s += 1; // legality already checked
		return s;
	}

	let archetypeCache = null;
	function currentArchetype(me) {
		if (archetypeCache) return archetypeCache;
		const cards = [...(me.FullDeck || []), ...(me.Deck || []), ...(me.Hand || [])];
		const tally = new Map();
		for (const c of cards) for (const g of groupsOf(c)) tally.set(g, (tally.get(g) || 0) + 1);
		let best = null, bestVal = 0;
		for (const [g, v] of tally) if (v > bestVal) { best = g; bestVal = v; }
		archetypeCache = best;
		return best;
	}

	/** A card asked us to pick a target; mirror the AI's selection test. */
	function resolveSelection(me) {
		const pending = window.ClubCardPending || window.ClubCardSelection;
		if (!pending || !fn("ClubCardSelectCard")) return false;
		const pools = [me.Hand, me.Board, me.Event, (opponentSeat(me) || {}).Board].filter(Array.isArray);
		const candidates = [];
		for (const pool of pools) {
			for (const card of pool) {
				let ok = false;
				try {
					ok = fn("ClubCardCardsSelectConditions")
						? ClubCardCardsSelectConditions(card, me, pending)
						: fn("ClubCardCanSelectCard") && ClubCardCanSelectCard(me, card);
				} catch (e) { ok = false; }
				if (ok) candidates.push(card);
			}
		}
		if (!candidates.length) return false;
		candidates.sort((a, b) => rawScore(b, currentArchetype(me)) - rawScore(a, currentArchetype(me)));
		const pick = candidates[0];
		log("select target:", pick.Name);
		if (!CONFIG.dryRun) { ClubCardSelectCard(pick); sync(); }
		return true;
	}

	/** Decide and perform exactly one action. Returns a label or null. */
	function step() {
		const me = mySeat();
		if (!me || !isMyTurn(me)) return null;

		if (resolveSelection(me)) return "select";

		// 1. free value: activated abilities already on board
		if (fn("ClubCardCanActiveEffect") && fn("ClubCardActiveEffect")) {
			for (const card of me.Board || []) {
				let usable = false;
				try { usable = !!card.CanActive && ClubCardCanActiveEffect(me, card); } catch (e) { usable = false; }
				if (usable) {
					log("activate:", card.Name);
					if (!CONFIG.dryRun) { ClubCardActiveEffect(me, card); sync(); }
					return "activate";
				}
			}
		}

		// 2. play the best legal card while plays remain
		const maxPlays = fn("ClubCardTurnPlayableCardCount") ? ClubCardTurnPlayableCardCount(me) : 1;
		const played = Number(window.ClubCardTurnCardPlayed || 0);
		if (played < maxPlays) {
			const opp = opponentSeat(me);
			const legal = (me.Hand || []).filter((c) => {
				try { return fn("ClubCardCanPlayCard") ? ClubCardCanPlayCard(me, c) : true; } catch (e) { return false; }
			});
			if (legal.length) {
				legal.sort((a, b) => playScore(b, me, opp) - playScore(a, me, opp));
				const best = legal[0];
				if (playScore(best, me, opp) > 0) {
					log("play:", best.Name, `(${played + 1}/${maxPlays})`);
					if (!CONFIG.dryRun) { ClubCardPlayCard(me, best, true); sync(); }
					return "play";
				}
			}
		}

		// 3. bank the money into a bigger building when the club is full
		if (fn("ClubCardCalculateLevelCost") && fn("ClubCardUpgradeLevel")) {
			let cost = Infinity;
			try { cost = ClubCardCalculateLevelCost(me); } catch (e) { /* keep Infinity */ }
			if (Number(me.Money || 0) >= cost && boardFull(me)) {
				log("level up for", cost);
				if (!CONFIG.dryRun) { ClubCardUpgradeLevel(me); sync(); }
				return "level";
			}
		}

		// 4. draw and pass
		if (fn("ClubCardEndTurn")) {
			log("draw + end turn");
			if (!CONFIG.dryRun) { ClubCardEndTurn(true); sync(); }
			return "end";
		}
		return null;
	}

	function blocked() {
		if (!gameReady()) return "game not loaded";
		if (!fn("ClubCardIsPlaying") || !ClubCardIsPlaying()) return "not in a game";
		if (window.ClubCardGameEnded) return "game ended";
		if (fn("ClubCardIsOnline") && ClubCardIsOnline() && !CONFIG.allowOnline) {
			return "online game (set BCC.config.allowOnline = true to play it)";
		}
		return null;
	}

	function tick() {
		if (!CONFIG.autoplay) return;
		const reason = blocked();
		if (reason) {
			if (reason !== lastBlockReason) { log("idle:", reason); lastBlockReason = reason; }
			archetypeCache = null;
			return;
		}
		lastBlockReason = "";
		if (Date.now() < nextActionAt) return;
		try {
			if (step()) nextActionAt = Date.now() + rnd(CONFIG.actionDelayMs);
		} catch (e) {
			warn("step failed, pausing autoplay:", e);
			CONFIG.autoplay = false;
		}
	}

	// ------------------------------------------------------------------ probe

	function probe() {
		const names = [
			"ClubCardList", "ClubCardBuilderList", "ClubCardPlayer", "ClubCardTurnIndex",
			"ClubCardFameGoal", "ClubCardLevelCost", "ClubCardLevelLimit", "ClubCardLiabilityLimit",
			"ClubCardBuilderMinDeckSize", "ClubCardBuilderMaxDeckSize", "ClubCardBuilderDefaultDecksList",
			"ClubCardPlayCard", "ClubCardCanPlayCard", "ClubCardEndTurn", "ClubCardUpgradeLevel",
			"ClubCardActiveEffect", "ClubCardSelectCard", "ClubCardCardsSelectConditions",
			"ClubCardAIPlay", "GameClubCardSyncOnlineData", "ServerAccountUpdate",
		];
		const surface = {};
		for (const n of names) surface[n] = has(n) ? (typeof window[n] === "function" ? "fn" : window[n]) : "MISSING";

		const pool = cardPool();
		const tags = new Map();
		for (const c of pool) for (const g of groupsOf(c)) tags.set(g, (tags.get(g) || 0) + 1);

		const report = {
			cardsTotal: (window.ClubCardList || []).length,
			poolSize: pool.length,
			poolSource: (window.ClubCardBuilderList || []).length ? "ClubCardBuilderList" : "ClubCardList+Reward filter",
			deckSize: targetDeckSize(),
			levelCost: window.ClubCardLevelCost,
			levelLimit: window.ClubCardLevelLimit,
			liabilityLimit: window.ClubCardLiabilityLimit,
			rewardField: window.Player && Player.Game && Player.Game.ClubCard && Player.Game.ClubCard.Reward,
			savedDecks: window.Player && Player.Game && Player.Game.ClubCard && Player.Game.ClubCard.Deck,
			groups: Object.fromEntries([...tags.entries()].sort((a, b) => b[1] - a[1])),
			surface,
			sampleCard: (window.ClubCardList || [])[0],
		};
		console.log(report);
		try { navigator.clipboard.writeText(JSON.stringify(report, null, 2)); log("probe copied to clipboard"); }
		catch (e) { /* clipboard needs a user gesture; the console object is enough */ }
		return report;
	}

	// ------------------------------------------------------------------- boot

	window.BCC = {
		config: CONFIG,
		probe,
		build: buildDeck,
		save: saveDeck,
		step,
		start() {
			CONFIG.autoplay = true;
			if (!timer) timer = setInterval(tick, CONFIG.tickMs);
			log(`autoplay ON (dryRun=${CONFIG.dryRun}, allowOnline=${CONFIG.allowOnline})`);
		},
		stop() { CONFIG.autoplay = false; log("autoplay OFF"); },
	};

	const boot = setInterval(() => {
		if (!gameReady()) return;
		clearInterval(boot);
		timer = setInterval(tick, CONFIG.tickMs);
		log(`ready - ${ClubCardList.length} cards known. Try BCC.probe(), BCC.build(), BCC.start().`);
	}, 1500);
})();
