/**
 * Club Cards deck engine — card valuation and deck construction.
 *
 * Works both in Node (tools/build-deck.js, over data/cards.json) and in the browser
 * (bundled into the userscript, over the live ClubCardList). Card objects only need
 * ID / Name / Type / Group / RequiredLevel / MoneyPerTurn / FamePerTurn; rules text is
 * supplied by the caller through getText(card) because in-game it lives in the caption
 * file rather than on the card.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.CCEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
	"use strict";

	// ---- constants lifted from ClubCard.js / ClubCardBuilder.js (R131) -------

	const FAME_GOAL = 100;
	const LEVEL_LIMIT = [0, 5, 7, 13, 20, 40];        // members per club tier
	const LEVEL_COST = [0, 0, 10, 20, 30, 40];        // money to reach tier N
	const LIABILITY_LIMIT = [0, 1, 2, 3, 5, 8];
	const MIN_DECK = 30;
	const MAX_DECK = 40;
	// You draw one card per turn and the format is singleton, so a 30-card deck reaches any
	// given combo piece about a third sooner than a 40. Consistency beats the extra breadth,
	// which is why 30 is both the default here and what most players run.
	const DEFAULT_DECK = MIN_DECK;

	// Games are decided fast — 15 to 17 turns, rarely past 20 — so 100 fame across ~16 turns
	// means a deck has to average better than 6 fame a turn.
	const GAME_LENGTH = 16;
	// The turn a tier realistically comes online, given you must bank 10/20/30/40 to climb.
	// This is what makes high tiers expensive: a tier 5 card lands around turn 12 and pays
	// out for three turns, while a tier 1 card pays out for fourteen.
	const TIER_ONLINE = [0, 1, 3, 6, 9, 12];
	const tierLifetime = (tier) => Math.max(1, GAME_LENGTH - TIER_ONLINE[Math.min(5, tier)]);
	const DECK_SLOTS = 10;

	/** The deck builder's own tag filters, so archetypes match what the game shows. */
	const GROUP_FILTERS = {
		ABDL: (c) => hasAny(c, ["ABDLBaby", "ABDLMommy"]),
		Asylum: (c) => hasAny(c, ["AsylumPatient", "AsylumNurse"]),
		College: (c) => hasAny(c, ["CollegeStudent", "CollegeTeacher"]),
		Criminal: (c) => hasAny(c, ["Criminal"]),
		"Dominant / Mistress": (c) => hasAny(c, ["Dominant", "Mistress"]),
		Exhibitionist: (c) => hasAny(c, ["Exhibitionist"]),
		Fetishist: (c) => hasAny(c, ["Fetishist"]),
		Kemonomimi: (c) => hasAny(c, ["Kemonomimi"]),
		Latex: (c) => hasAny(c, ["Latex"]),
		Maid: (c) => hasAny(c, ["Maid"]),
		"Pet / Owner": (c) => hasAny(c, ["Pet", "Owner"]),
		Police: (c) => hasAny(c, ["Police"]),
		Porn: (c) => hasAny(c, ["PornActress", "Porn", "Video"]),
		Shibari: (c) => hasAny(c, ["Shibari", "Knot", "Sensei"]),
		Staff: (c) => hasAny(c, ["Staff"]),
		"Submissive / Slave": (c) => hasAny(c, ["Submissive", "Slave"]),
	};

	/** Nouns used in rules text -> the Group tag they refer to. */
	const NOUN_TO_GROUP = {
		maid: "Maid", patient: "AsylumPatient", nurse: "AsylumNurse",
		baby: "ABDLBaby", mommy: "ABDLMommy",
		student: "CollegeStudent", teacher: "CollegeTeacher",
		"porn actress": "PornActress", "porn member": "Porn", video: "Video",
		dominant: "Dominant", mistress: "Mistress",
		submissive: "Submissive", slave: "Slave",
		exhibitionist: "Exhibitionist", latex: "Latex",
		pet: "Pet", owner: "Owner", kemonomimi: "Kemonomimi",
		criminal: "Criminal", police: "Police", staff: "Staff",
		sensei: "Sensei", knot: "Knot", shibari: "Shibari",
		fetishist: "Fetishist", plushie: "Plushie",
	};

	const DEFAULTS = {
		board: 6,          // typical member count once the club is going
		famePoint: 1.0,    // fame is the win condition
		moneyPoint: 0.42,  // money only buys tiers and pays upkeep
		drawValue: 2.5,
		actionValue: 8.0,
		tierPenalty: 0.5,  // small: the lifetime model already prices tiers
		liabilityValue: 4.0,
		prereqPenalty: 1.5,
	};

	function hasAny(card, tags) {
		return Array.isArray(card.Group) && tags.some((t) => card.Group.includes(t));
	}

	function tierOf(card) {
		const t = Number(card.RequiredLevel || 1);
		return Number.isFinite(t) && t > 0 ? t : 1;
	}

	// ---- rules-text valuation ----------------------------------------------

	/**
	 * Pull per-turn clauses out of a card's rules text.
	 * Returns clauses of shape { stat, amount, kind, token, cap }.
	 *   kind "flat"    - unconditional
	 *   kind "per"     - scales per matching member
	 *   kind "if"      - applies only while a matching member is present
	 * `token` is a Group tag or a card Name, both of which cards condition on.
	 */
	function parseClauses(text) {
		if (!text) return [];
		const clauses = [];
		for (let sentence of String(text).split(/(?<=\.)\s+/)) {
			const capMatch = /\(max\s*\+?(-?\d+)/i.exec(sentence);
			const cap = capMatch ? Math.abs(Number(capMatch[1])) : null;
			const re = /([+-]\d+)\s*(Fame|Money)\/turn(?:\s+(per|if there's)\s+(?:a\s+|an\s+|another\s+|other\s+|\d+\+?\s+)?([A-Za-z' ]+?)\s+(?:ally|allies|rival|rivals))?/gi;
			const local = [];
			let m;
			while ((m = re.exec(sentence)) != null) {
				const amount = Number(m[1]);
				const stat = m[2].toLowerCase();
				if (!m[3]) { local.push({ stat, amount, kind: "flat", cap }); continue; }
				const kind = /^per$/i.test(m[3]) ? "per" : "if";
				local.push({ stat, amount, kind, token: m[4].trim(), cap });
			}
			// "+2 Fame/turn and -1 Money/turn per Patient ally" qualifies both halves
			const qualified = local[local.length - 1];
			if (local.length > 1 && qualified && qualified.token && /\sand\s/i.test(sentence)) {
				for (const cl of local) {
					if (cl.kind === "flat") { cl.kind = qualified.kind; cl.token = qualified.token; }
				}
			}
			for (const cl of local) clauses.push(cl);
		}
		return clauses;
	}

	/** One-shot text effects: entry bonuses, draws, extra actions. */
	function parseOneShots(text) {
		if (!text) return { fame: 0, money: 0, draws: 0, actions: 0, conditional: false, tierScaled: 0 };
		const t = String(text);
		let fame = 0, money = 0, draws = 0, actions = 0;
		// "+Fame/turn equal to club tier" and friends carry no digit to parse; clubs
		// spend most of the game around tier 3, so score them as such.
		const tierScaled = (t.match(/equal to (?:your |their )?club tier/gi) || []).length * 3;
		const conditional = /if there's|unless|if you have|per \d+ of your club tiers/i.test(t);
		let m;
		const both = /([+-]\d+)\s*Fame\s+and\s+Money/gi;
		while ((m = both.exec(t)) != null) { fame += Number(m[1]); money += Number(m[1]); }
		const single = /([+-]\d+)\s*(Fame|Money)(?!\/turn)/gi;
		while ((m = single.exec(t)) != null) {
			if (m[2].toLowerCase() === "fame") fame += Number(m[1]); else money += Number(m[1]);
		}
		const drawRe = /draw\s+(a|an|\d+)\s+(?:extra\s+)?cards?/gi;
		while ((m = drawRe.exec(t)) != null) draws += /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
		const actionRe = /([+-]\d+)\s*actions?/gi;
		while ((m = actionRe.exec(t)) != null) actions += Number(m[1]);
		return { fame, money, draws, actions, conditional, tierScaled };
	}

	/** Build a lookup of how present each Group tag / card Name is in a deck. */
	function deckContext(deckCards, opts) {
		const o = Object.assign({}, DEFAULTS, opts);
		const size = Math.max(1, deckCards.length);
		const groupCount = new Map();
		const nameSet = new Set();
		for (const c of deckCards) {
			nameSet.add(c.Name);
			for (const g of c.Group || []) groupCount.set(g, (groupCount.get(g) || 0) + 1);
		}
		return {
			opts: o,
			/** expected number of members with this token on the board */
			expected(token) {
				const group = NOUN_TO_GROUP[String(token).toLowerCase()];
				if (group) return ((groupCount.get(group) || 0) / size) * o.board;
				return nameSet.has(token) ? (1 / size) * o.board : 0;
			},
			/** probability at least one is out */
			present(token) {
				const e = this.expected(token);
				return e <= 0 ? 0 : 1 - Math.pow(1 - Math.min(0.9, e / o.board), o.board);
			},
		};
	}

	/** Estimated contribution of one card, given the deck it sits in. */
	function valueCard(card, ctx, getText) {
		const o = ctx.opts;
		const text = getText ? getText(card) : card.Text || "";
		let fame = Number(card.FamePerTurn || 0);
		let money = Number(card.MoneyPerTurn || 0);

		for (const cl of parseClauses(text)) {
			let amount = cl.amount;
			if (cl.kind === "per") {
				amount = amount * ctx.expected(cl.token);
				if (cl.cap != null) amount = Math.sign(amount) * Math.min(Math.abs(amount), cl.cap);
			} else if (cl.kind === "if") {
				amount = amount * ctx.present(cl.token);
			}
			if (cl.stat === "fame") fame += amount; else money += amount;
		}

		const shots = parseOneShots(text);
		const life = tierLifetime(tierOf(card));
		const lifetime = card.Type === "Event" ? Math.min(life, Number(card.Time || 1)) : life;

		// A bonus gated on a condition only pays when the condition holds.
		const gate = shots.conditional ? 0.5 : 1;
		fame += shots.tierScaled;

		let value = 0;
		value += fame * o.famePoint * lifetime;
		value += money * o.moneyPoint * lifetime;
		value += (shots.fame > 0 ? shots.fame * gate : shots.fame) * o.famePoint;
		value += (shots.money > 0 ? shots.money * gate : shots.money) * o.moneyPoint;
		value += shots.draws * o.drawValue * gate;
		// ExtraPlay on a member or lasting event recurs every turn; parsed "+N action"
		// text ("Enters: +1 action") fires once.
		const recurring = card.ExtraPlay != null && (card.Type !== "Event" || hasAny(card, ["TimedEvent", "ContinuousEvent"]));
		const actions = card.ExtraPlay != null ? Number(card.ExtraPlay) : shots.actions * gate;
		value += actions * o.actionValue * (recurring ? 2.5 : 1);
		value += Number(card.ExtraTime || 0) * 3;
		if (card.CanActive) value += 3;
		if (hasAny(card, ["Liability"])) value += o.liabilityValue;
		if (card.Prerequisite) value -= o.prereqPenalty;
		value -= (tierOf(card) - 1) * o.tierPenalty;
		return value;
	}

	// ---- deck construction --------------------------------------------------

	// Weighted low because the game ends before a top-heavy deck deploys. Normalised to the
	// requested deck size rather than assumed to total 40.
	const CURVE = { 1: 14, 2: 10, 3: 8, 4: 5, 5: 3 };
	const CURVE_TOTAL = Object.values(CURVE).reduce((a, b) => a + b, 0);

	function buildFor(archetype, pool, size, getText, opts) {
		const family = archetype ? pool.filter(GROUP_FILTERS[archetype]) : [];
		// The archetype core is locked in so synergy actually has a deck to work with;
		// without this every build collapses back to the same generic pile.
		const coreSize = Math.min(family.length, Math.round(size * 0.6));
		let deck = family.slice(0, coreSize);
		deck = deck.concat(pool.filter((c) => !deck.includes(c)).slice(0, size - deck.length));

		for (let pass = 0; pass < 3; pass++) {
			const ctx = deckContext(deck, opts);
			const scored = pool
				.map((c) => ({ card: c, tier: tierOf(c), score: valueCard(c, ctx, getText) }))
				.sort((a, b) => b.score - a.score);

			const picked = new Map();
			for (const e of scored) {
				if (picked.size >= coreSize) break;
				if (GROUP_FILTERS[archetype] && GROUP_FILTERS[archetype](e.card)) picked.set(e.card.ID, e);
			}
			for (const tierKey of Object.keys(CURVE)) {
				const tier = Number(tierKey);
				let quota = Math.round((CURVE[tier] / CURVE_TOTAL) * size);
				for (const e of scored) {
					if (quota <= 0 || picked.size >= size) break;
					if (e.tier !== tier || picked.has(e.card.ID)) continue;
					picked.set(e.card.ID, e);
					quota--;
				}
			}
			for (const e of scored) {
				if (picked.size >= size) break;
				if (!picked.has(e.card.ID)) picked.set(e.card.ID, e);
			}
			deck = [...picked.values()].map((e) => e.card);
		}

		const ctx = deckContext(deck, opts);
		const entries = deck
			.map((c) => ({ card: c, tier: tierOf(c), score: valueCard(c, ctx, getText) }))
			.sort((a, b) => a.tier - b.tier || b.score - a.score);
		return {
			archetype,
			entries,
			ids: entries.map((e) => e.card.ID),
			score: entries.reduce((s, e) => s + e.score, 0),
		};
	}

	/**
	 * Try every archetype (plus a no-archetype "goodstuff" build) and keep the best.
	 * @param {object} args - { pool, size, getText, opts, archetype, maxTier }
	 */
	function buildDeck(args) {
		const cap = args.maxTier || 5;
		const pool = (args.pool || [])
			.filter((c) => c && typeof c.ID === "number")
			.filter((c) => tierOf(c) <= cap);
		const size = Math.min(MAX_DECK, Math.max(MIN_DECK, args.size || DEFAULT_DECK));
		if (pool.length < size) return null;
		const names = args.archetype ? [args.archetype] : [null].concat(Object.keys(GROUP_FILTERS));
		let best = null;
		for (const name of names) {
			if (name && pool.filter(GROUP_FILTERS[name]).length < 8) continue;
			const built = buildFor(name, pool, size, args.getText, args.opts);
			if (!best || built.score > best.score) best = built;
		}
		return best;
	}

	// ---- deck encoding (matches ClubCardBuilderSaveChanges) -----------------

	const encodeDeck = (ids) => ids.map((id) => String.fromCharCode(id)).join("");

	function decodeDeck(str) {
		const ids = [];
		for (let i = 0; i < str.length; i++) ids.push(str.charCodeAt(i));
		return ids;
	}

	return {
		FAME_GOAL, LEVEL_LIMIT, LEVEL_COST, LIABILITY_LIMIT,
		MIN_DECK, MAX_DECK, DEFAULT_DECK, DECK_SLOTS, GROUP_FILTERS, DEFAULTS, CURVE,
		GAME_LENGTH, TIER_ONLINE, tierLifetime, tierOf, hasAny, parseClauses, parseOneShots, deckContext, valueCard,
		buildDeck, encodeDeck, decodeDeck,
	};
});
