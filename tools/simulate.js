#!/usr/bin/env node
/**
 * How fast does a deck actually reach 100 fame?
 *
 * Scores are a proxy; this plays the game. It models the rules that decide Club Cards:
 *   - one action a turn, and playing a card means you do NOT draw that turn
 *     (ClubCard.js: ClubCardEndTurn(ClubCardTurnCardPlayed == 0))
 *   - members pay out at end of turn, and money below zero cancels that turn's fame
 *   - club tiers gate what you can play and cap board size
 *   - per-turn clauses are evaluated against the board that is actually out
 *
 * It does not model card hooks, targeting, or the opponent — so treat the output as a
 * deck's clock against a goldfish, which is exactly what "wins on turn 17" measures.
 *
 *   node tools/simulate.js                        the engine's own build
 *   node tools/simulate.js --ids 7000,7001,...    a specific deck
 *   node tools/simulate.js --runs 500 --turns 20
 */
const path = require("path");
const E = require(path.join(__dirname, "..", "src", "deck-engine.js"));
const cards = require(path.join(__dirname, "..", "data", "cards.json"));

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const RUNS = Number(arg("runs", 400));
const MAX_TURNS = Number(arg("turns", 25));
const text = (c) => c.Text || "";
const byId = new Map(cards.map((c) => [c.ID, c]));

/** Fame and money a card pays this turn, given the board actually in play. */
function payout(card, board) {
	let fame = Number(card.FamePerTurn || 0);
	let money = Number(card.MoneyPerTurn || 0);
	const count = (token) => {
		const group = Object.entries({
			maid: "Maid", patient: "AsylumPatient", nurse: "AsylumNurse", baby: "ABDLBaby",
			mommy: "ABDLMommy", student: "CollegeStudent", teacher: "CollegeTeacher",
			"porn actress": "PornActress", dominant: "Dominant", mistress: "Mistress",
			submissive: "Submissive", slave: "Slave", exhibitionist: "Exhibitionist",
			latex: "Latex", pet: "Pet", owner: "Owner", kemonomimi: "Kemonomimi",
			criminal: "Criminal", police: "Police", staff: "Staff",
		}).find(([k]) => k === String(token).toLowerCase());
		if (group) return board.filter((c) => (c.Group || []).includes(group[1])).length;
		return board.filter((c) => c.Name === token).length;
	};
	for (const cl of E.parseClauses(text(card))) {
		let amount = cl.amount;
		if (cl.kind === "per") {
			amount *= count(cl.token);
			if (cl.cap != null) amount = Math.sign(amount) * Math.min(Math.abs(amount), cl.cap);
		} else if (cl.kind === "if") {
			amount = count(cl.token) > 0 ? amount : 0;
		}
		if (cl.stat === "fame") fame += amount; else money += amount;
	}
	return { fame, money };
}

function playOne(deckIds) {
	const deck = deckIds.map((id) => byId.get(id)).filter(Boolean);
	const library = deck.slice().sort(() => Math.random() - 0.5);
	const hand = library.splice(0, 5);
	hand.push(byId.get(31023));                    // the free Tips every game starts with
	const board = [], events = [];
	let fame = 0, money = 10, level = 1;

	const draw = (n = 1) => { for (let i = 0; i < n && library.length; i++) hand.push(library.shift()); };

	for (let turn = 1; turn <= MAX_TURNS; turn++) {
		let plays = 1 + [...board, ...events].reduce((s, c) => s + Number(c.ExtraPlay || 0), 0);
		let playedSomething = false;

		while (plays-- > 0) {
			const legal = hand.filter((c) => {
				if (E.tierOf(c) > level) return false;
				const isMember = (c.Type || "Member") !== "Event";
				if (isMember && board.length >= E.LEVEL_LIMIT[level]) return false;
				return true;
			});
			if (!legal.length) break;
			// Early turns buy economy because tiers compound; late turns buy fame because
			// the game is nearly over. A flat greedy-fame policy stalls economy decks at
			// tier 2 and would make the comparison unfair to them.
			const w = turn <= 6 ? 1.6 : turn <= 10 ? 0.8 : 0.3;
			legal.sort((a, b) => {
				const pa = payout(a, board), pb = payout(b, board);
				return (pb.fame + pb.money * w) - (pa.fame + pa.money * w);
			});
			const card = legal[0];
			hand.splice(hand.indexOf(card), 1);
			const shots = E.parseOneShots(text(card));
			const gate = shots.conditional ? 0.6 : 1;
			fame += shots.fame * gate;
			money += shots.money * gate;
			if (shots.draws) draw(Math.round(shots.draws * gate));
			if ((card.Type || "Member") === "Event") {
				if (card.Time) events.push({ ...card, Time: card.Time }); // lasting event
			} else board.push(card);
			playedSomething = true;
		}

		// Nothing worth doing: bank a tier, or draw and pass.
		if (!playedSomething) {
			const cost = E.LEVEL_COST[level + 1];
			if (level < 5 && cost != null && money >= cost) { money -= cost; level++; }
			else draw(1);
		} else if (level < 5) {
			// Upgrade off spare money once the board is filling up.
			const cost = E.LEVEL_COST[level + 1];
			if (cost != null && money >= cost + 8 && board.length >= E.LEVEL_LIMIT[level] - 1) {
				money -= cost; level++;
			}
		}

		const before = fame;
		for (const card of board) { const p = payout(card, board); fame += p.fame; money += p.money; }
		if (money < 0) fame = before;                       // the rule that erases turns
		for (const ev of events) ev.Time--;
		for (let i = events.length - 1; i >= 0; i--) if (events[i].Time <= 0) events.splice(i, 1);

		if (fame >= E.FAME_GOAL) return { turn, fame, money, level, played: board.length };
	}
	return { turn: null, fame, money, level, played: board.length };
}

function evaluate(name, ids) {
	const results = [];
	for (let i = 0; i < RUNS; i++) results.push(playOne(ids));
	const wins = results.filter((r) => r.turn != null);
	const turns = wins.map((r) => r.turn).sort((a, b) => a - b);
	const median = turns.length ? turns[Math.floor(turns.length / 2)] : null;
	const by17 = results.filter((r) => r.turn != null && r.turn <= 17).length / RUNS;
	const avgFame = results.reduce((s, r) => s + r.fame, 0) / RUNS;
	return {
		deck: name,
		"reaches 100": `${((wins.length / RUNS) * 100).toFixed(0)}%`,
		"median turn": median ?? "-",
		"by turn 17": `${(by17 * 100).toFixed(0)}%`,
		"avg fame": avgFame.toFixed(0),
		"avg tier": (results.reduce((s, r) => s + r.level, 0) / RUNS).toFixed(1),
		"cards played": (results.reduce((s, r) => s + r.played, 0) / RUNS).toFixed(1),
	};
}

const rows = [];
const idsArg = arg("ids", null);
if (idsArg) {
	rows.push(evaluate("given deck", idsArg.split(",").map(Number)));
} else {
	const pool = cards.filter((c) => !c.Reward);
	rows.push(evaluate("engine, T1-3, 30", E.buildDeck({ pool, size: 30, getText: text, maxTier: 3 }).ids));
	rows.push(evaluate("engine, any tier, 30", E.buildDeck({ pool, size: 30, getText: text }).ids));
	rows.push(evaluate("engine, any tier, 40", E.buildDeck({ pool, size: 40, getText: text }).ids));
	rows.push(evaluate("precon: Default", E.buildDeck({ pool, size: 30, getText: text }).ids.slice(0, 0).concat(
		[1000, 1001, 1004, 1006, 1007, 1010, 1011, 1012, 1014, 1020, 2000, 2002, 4000, 6000, 6001, 6002,
		 6003, 6004, 6006, 6008, 8000, 8002, 8003, 8004, 13001, 30000, 30014, 30016, 31000, 31004])));
}
console.table(rows);
