/**
 * Club Cards bot — deck building and autoplay, driven through the game's own
 * turn-action entry points (ClubCardStartTurn / ClubCardSelectCard), so every move
 * takes exactly the path a mouse click would.
 */
(function () {
	"use strict";

	const E = typeof CCEngine !== "undefined" ? CCEngine : require("./deck-engine.js");

	const CONFIG = {
		dryRun: true,
		allowOnline: false,
		autoplay: false,
		deckSlot: 0,
		deckSize: 40,
		archetype: null,
		autoPickDeck: true,       // answer the deck-selection popup at game start
		tickMs: 700,
		actionDelayMs: [900, 1900],
		upgradeSlack: 0,          // extra money to keep in hand before upgrading
		verbose: true,
	};

	const TURN = { PLAY: "PlayCard", DRAW: "DrawAndEndTurn", BANKRUPT: "Bankrupt", UPGRADE: "UpgradeLevel", END: "EndTurn" };

	let timer = null;
	let nextActionAt = 0;
	let lastIdle = "";

	const log = (...a) => CONFIG.verbose && console.log("%c[BCC]", "color:#c58af9", ...a);
	const warn = (...a) => console.warn("[BCC]", ...a);
	const fn = (n) => (typeof window[n] === "function" ? window[n] : null);
	const rnd = ([lo, hi]) => lo + Math.random() * (hi - lo);

	const ready = () => Array.isArray(window.ClubCardList) && ClubCardList.length > 0 && !!window.Player;
	const getText = (card) => (fn("ClubCardTextGet") ? ClubCardTextGet("Text " + card.Name) : card.Text || "");

	function seat() {
		if (!Array.isArray(window.ClubCardPlayer) || !ClubCardPlayer.length) return null;
		const i = fn("ClubCardGetPlayerIndex") ? ClubCardGetPlayerIndex() : -1;
		return (i >= 0 && ClubCardPlayer[i]) || ClubCardPlayer.find((p) => p && p.Control === "Player") || null;
	}
	const foe = (me) => (fn("ClubCardGetOpponent") ? ClubCardGetOpponent(me) : ClubCardPlayer.find((p) => p !== me));
	const myTurn = (me) => !!me && ClubCardPlayer[ClubCardTurnIndex] === me;
	const handLocation = (me) => (me.Index === 0 ? "PlayerHand" : "OpponentHand");

	// ------------------------------------------------------------ deck building

	/** Cards this account may legally deck, mirroring ClubCardBuilderFilterLoad. */
	function cardPool() {
		const reward = (Player.Game && Player.Game.ClubCard && Player.Game.ClubCard.Reward) || "";
		return ClubCardList.filter((c) => !c.Reward || reward.indexOf(String.fromCharCode(c.ID)) >= 0);
	}

	function buildDeck() {
		if (!ready()) { warn("game not loaded"); return null; }
		const deck = E.buildDeck({
			pool: cardPool(), size: CONFIG.deckSize, getText, archetype: CONFIG.archetype,
		});
		if (!deck) { warn("card pool too small"); return null; }
		log(`built "${deck.archetype || "goodstuff"}" deck — ${deck.ids.length} cards, score ${deck.score.toFixed(1)}`);
		console.table(deck.entries.map((e) => ({
			id: e.card.ID, tier: e.tier, name: ClubCardTextGet("Title " + e.card.Name),
			type: e.card.Type || "Member", fame: e.card.FamePerTurn || 0, money: e.card.MoneyPerTurn || 0,
			value: Number(e.score.toFixed(1)),
		})));
		return deck;
	}

	/** Persist card IDs into a deck slot, using the builder's own encoding. */
	function saveIds(ids, slot = CONFIG.deckSlot) {
		if (!Array.isArray(ids) || ids.length < E.MIN_DECK || ids.length > E.MAX_DECK) {
			warn(`deck must hold ${E.MIN_DECK}-${E.MAX_DECK} cards, got ${ids && ids.length}`);
			return null;
		}
		if (new Set(ids).size !== ids.length) { warn("deck contains duplicates"); return null; }
		if (CONFIG.dryRun) { log("dryRun: not saving. Set BCC.config.dryRun = false first."); return ids; }

		const cc = Player.Game.ClubCard;
		cc.Deck = Array.isArray(cc.Deck) ? cc.Deck : [];
		while (cc.Deck.length <= E.DECK_SLOTS) cc.Deck.push("");
		cc.Deck[slot] = E.encodeDeck(ids);
		if (!Array.isArray(cc.DeckName)) cc.DeckName = [];
		while (cc.DeckName.length <= E.DECK_SLOTS) cc.DeckName.push("");
		cc.DeckName[slot] = "Bot deck";
		ServerAccountUpdate.QueueData({ Game: Player.Game }, true);
		log(`saved ${ids.length} cards to deck slot ${slot}`);
		return ids;
	}

	const saveDeck = (slot) => { const d = buildDeck(); return d && saveIds(d.ids, slot); };

	// ---------------------------------------------------------------- valuation

	function context(me) {
		const known = [...(me.FullDeck || []), ...(me.Board || []), ...(me.Hand || [])];
		return E.deckContext(known.length ? known : ClubCardList.slice(0, 40), {});
	}

	/** How much we want this card on the table right now. */
	function playValue(card, me, opp, ctx) {
		let v = E.valueCard(card, ctx, getText);
		const toGoal = E.FAME_GOAL - Number(me.Fame || 0);

		// Closing games are won on fame, not on economy.
		if (toGoal <= 20) v += Number(card.FamePerTurn || 0) * 4 - Number(card.MoneyPerTurn || 0) * 0.5;

		// Ending a turn with negative money cancels that turn's fame gain entirely
		// (see the Money < 0 branch of ClubCardEndTurn), so upkeep matters when poor.
		const income = Number(me.LastMoneyPerTurn || 0);
		if (Number(me.Money || 0) + income < 8) v += Number(card.MoneyPerTurn || 0) * 2;

		// Liabilities are only worth it while the opponent still has room for them.
		if (E.hasAny(card, ["Liability"])) {
			const room = E.LIABILITY_LIMIT[opp.Level] - (opp.Board || []).filter((c) => E.hasAny(c, ["Liability"])).length;
			if (room <= 0) v -= 100;
		}
		return v;
	}

	// ------------------------------------------------------------------ popups

	/** Answer whatever modal the game is waiting on. Returns true if we acted. */
	function handlePopup(me) {
		const popup = window.ClubCardPopup;
		if (!popup || !popup.Mode) return false;

		if (popup.Mode === "DECK") {
			if (!CONFIG.autoPickDeck) return false;
			log("selecting deck slot", CONFIG.deckSlot);
			if (!CONFIG.dryRun) ClubCardLoadDeckNumber(CONFIG.deckSlot);
			return true;
		}
		if (popup.Mode === "TEXT") {
			log("dismissing popup");
			if (!CONFIG.dryRun) CommonDynamicFunction(popup.Function1);
			return true;
		}
		if (popup.Mode === "TIERSELECTION") {
			// Deny the opponent the tier they can actually deploy from hand.
			const tier = Math.min(5, Math.max(1, (foe(me).Level || 1)));
			log("selecting tier", tier);
			if (!CONFIG.dryRun) { ClubCardTierSelection = tier; ClubCardDestroyPopup(); ClubCardClickPlayCard(false); }
			return true;
		}
		if (popup.Mode === "SEARCH") {
			const pool = (popup.CardsPool || []).filter((c) => ClubCardCanSelectCard(me, c));
			if (!pool.length) return false;
			const ctx = context(me);
			pool.sort((a, b) => playValue(b, me, foe(me), ctx) - playValue(a, me, foe(me), ctx));
			log("search pick:", pool[0].Name);
			if (!CONFIG.dryRun) {
				if (ClubCardPending && ClubCardPending.Name === "Clare") { ClubCardClareSelection(me, pool[0]); ClubCardDestroyPopup(); }
				else { ClubCardDestroyPopup(); ClubCardFocus = pool[0]; ClubCardClickPlayCard(true); }
			}
			return true;
		}
		return false;
	}

	/** A card is mid-play and wants a target. */
	function handlePending(me) {
		if (!window.ClubCardPending || !fn("ClubCardCanSelectCard")) return false;
		const opp = foe(me);
		const pools = [me.Hand, me.Board, me.Event, opp.Board, opp.Event].filter(Array.isArray);
		const candidates = [];
		for (const pool of pools) for (const card of pool) {
			try { if (ClubCardCanSelectCard(me, card)) candidates.push(card); } catch (e) { /* not selectable */ }
		}
		if (!candidates.length) return false;

		const ctx = context(me);
		const pending = window.ClubCardPending;
		const text = getText(pending) || "";
		const sacrifices = /remove|return to the deck|discard|send to your streets/i.test(text);
		const mine = (card) => (me.Board || []).includes(card) || (me.Hand || []).includes(card) || (me.Event || []).includes(card);
		const value = (card) => E.valueCard(card, ctx, getText);

		// Removal points at their best card; a sacrifice gives up our worst; a buff
		// goes on our best. Prefer our own side or theirs accordingly, then rank.
		const wantsTheirs = pending.Prerequisite === "SelectOpponentMember"
			|| (pending.Prerequisite === "SelectAnyMember" && sacrifices);
		const ranked = candidates.slice().sort((a, b) => {
			const side = (wantsTheirs ? (mine(a) ? 1 : 0) - (mine(b) ? 1 : 0) : (mine(a) ? 0 : 1) - (mine(b) ? 0 : 1));
			if (side !== 0) return side;
			const giveUp = sacrifices && !wantsTheirs;
			return giveUp ? value(a) - value(b) : value(b) - value(a);
		});
		const pick = ranked[0];
		log("target:", pick.Name, wantsTheirs ? "(theirs)" : sacrifices ? "(sacrifice)" : "(ours)");
		if (!CONFIG.dryRun) ClubCardSelectCard(pick);
		return true;
	}

	// ------------------------------------------------------------------- policy

	/** Decide and take one action. Returns a label, or null if it wasn't our move. */
	function step() {
		const me = seat();
		if (!me) return null;
		if (handlePopup(me)) return "popup";
		if (!myTurn(me)) return null;
		if (handlePending(me)) return "target";

		const opp = foe(me);
		const ctx = context(me);
		const playsLeft = ClubCardTurnPlayableCardCount(me) - Number(window.ClubCardTurnCardPlayed || 0);
		const cost = ClubCardCalculateLevelCost(me);
		const canUpgrade = me.Level < E.LEVEL_COST.length - 1 && me.Money >= cost + CONFIG.upgradeSlack
			&& !ClubCardEventNameIsInEvents(me, "Homeroom") && !ClubCardEventNameIsInEvents(opp, "Homeroom");
		const boardFull = (me.Board || []).length >= E.LEVEL_LIMIT[me.Level];

		let best = null;
		if (playsLeft > 0) {
			for (const card of me.Hand || []) {
				// The render loop tags hand cards with their Location and ClubCardCanPlayCard
				// requires it; only fill it in if it is missing, never overwrite the game's value.
				if (card.Location == null) card.Location = handLocation(me);
				let legal = false;
				try { legal = ClubCardCanPlayCard(me, card); } catch (e) { legal = false; }
				if (!legal) continue;
				const value = playValue(card, me, opp, ctx);
				if (!best || value > best.value) best = { card, value };
			}
			for (const card of me.Board || []) {
				let usable = false;
				try { usable = ClubCardCanActiveEffect(me, card); } catch (e) { usable = false; }
				// Activating spends an action just like playing a card, so it competes.
				if (usable && (!best || 6 > best.value)) best = { card, value: 6, activate: true };
			}
		}

		// A full board or a dead hand means the money is better spent on the building.
		if (canUpgrade && (boardFull || !best || best.value < 4)) {
			log(`upgrade to tier ${me.Level + 1} for ${cost}`);
			if (!CONFIG.dryRun) ClubCardStartTurn(TURN.UPGRADE);
			return "upgrade";
		}

		if (best && best.value > 0) {
			if (best.activate) {
				log("activate:", best.card.Name);
				if (!CONFIG.dryRun) ClubCardActiveEffect(me, best.card);
			} else {
				log(`play: ${best.card.Name} (value ${best.value.toFixed(1)}, ${playsLeft} play${playsLeft === 1 ? "" : "s"} left)`);
				if (!CONFIG.dryRun) { ClubCardFocus = best.card; ClubCardStartTurn(TURN.PLAY); }
			}
			return "play";
		}

		log("draw + end turn");
		if (!CONFIG.dryRun) ClubCardStartTurn(TURN.DRAW);
		return "end";
	}

	function idleReason() {
		if (!ready()) return "game not loaded";
		if (!fn("ClubCardIsPlaying") || !ClubCardIsPlaying()) return "not in a game";
		if (window.ClubCardGameEnded || window.MiniGameEnded) return "game over";
		if (ClubCardIsOnline() && !CONFIG.allowOnline) return "online game (BCC.config.allowOnline = true to play it)";
		return null;
	}

	function tick() {
		if (!CONFIG.autoplay) return;
		const idle = idleReason();
		if (idle) { if (idle !== lastIdle) { log("idle:", idle); lastIdle = idle; } return; }
		lastIdle = "";
		if (Date.now() < nextActionAt) return;
		try { if (step()) nextActionAt = Date.now() + rnd(CONFIG.actionDelayMs); }
		catch (e) { warn("step failed, autoplay off:", e); CONFIG.autoplay = false; }
	}

	// -------------------------------------------------------------------- probe

	function probe() {
		const me = seat();
		const pool = ready() ? cardPool() : [];
		const report = {
			cards: ready() ? ClubCardList.length : 0,
			legalPool: pool.length,
			rewardsOwned: pool.filter((c) => c.Reward).length,
			fameGoal: window.ClubCardFameGoal,
			levelCost: window.ClubCardLevelCost,
			levelLimit: window.ClubCardLevelLimit,
			liabilityLimit: window.ClubCardLiabilityLimit,
			deckSizes: (Player.Game && Player.Game.ClubCard && Player.Game.ClubCard.Deck || []).map((d) => d.length),
			inGame: fn("ClubCardIsPlaying") ? ClubCardIsPlaying() : false,
			online: fn("ClubCardIsOnline") ? ClubCardIsOnline() : false,
			seat: me && { control: me.Control, level: me.Level, fame: me.Fame, money: me.Money, hand: (me.Hand || []).length },
			myTurn: myTurn(me),
			popup: window.ClubCardPopup && window.ClubCardPopup.Mode,
		};
		console.log(report);
		return report;
	}

	window.BCC = {
		config: CONFIG, probe, build: buildDeck, save: saveDeck, saveIds, step, engine: E,
		start() {
			CONFIG.autoplay = true;
			if (!timer) timer = setInterval(tick, CONFIG.tickMs);
			log(`autoplay ON (dryRun=${CONFIG.dryRun}, allowOnline=${CONFIG.allowOnline})`);
		},
		stop() { CONFIG.autoplay = false; log("autoplay OFF"); },
	};

	const boot = setInterval(() => {
		if (!ready()) return;
		clearInterval(boot);
		timer = setInterval(tick, CONFIG.tickMs);
		log(`ready — ${ClubCardList.length} cards. Try BCC.probe(), BCC.build(), BCC.start().`);
	}, 1500);
})();
