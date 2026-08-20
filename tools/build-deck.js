#!/usr/bin/env node
/**
 * Offline deck builder. Runs the same engine the bot uses in-game, over data/cards.json.
 *
 *   node tools/build-deck.js                     best archetype, 40 cards
 *   node tools/build-deck.js --archetype Maid    force an archetype
 *   node tools/build-deck.js --size 30           smaller deck
 *   node tools/build-deck.js --owned 1234,5678   also allow these reward card IDs
 *   node tools/build-deck.js --all               score every archetype
 */
const path = require("path");
const engine = require(path.join(__dirname, "..", "src", "deck-engine.js"));
const cards = require(path.join(__dirname, "..", "data", "cards.json"));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf("--" + name);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes("--" + name);

const owned = new Set(String(arg("owned", "")).split(",").filter(Boolean).map(Number));
const pool = cards.filter((c) => !c.Reward || owned.has(c.ID));
const size = Number(arg("size", engine.MAX_DECK));
const getText = (c) => c.Text || "";

if (flag("all")) {
	const rows = [null, ...Object.keys(engine.GROUP_FILTERS)]
		.map((a) => {
			if (a && pool.filter(engine.GROUP_FILTERS[a]).length < 8) return null;
			const d = engine.buildDeck({ pool, size, getText, archetype: a });
			return d && { archetype: a || "(goodstuff)", score: Math.round(d.score), depth: a ? pool.filter(engine.GROUP_FILTERS[a]).length : pool.length };
		})
		.filter(Boolean)
		.sort((x, y) => y.score - x.score);
	console.table(rows);
	process.exit(0);
}

const deck = engine.buildDeck({ pool, size, getText, archetype: arg("archetype", null) });
if (!deck) { console.error("pool too small"); process.exit(1); }

console.log(`archetype : ${deck.archetype || "(goodstuff)"}`);
console.log(`cards     : ${deck.ids.length}  (legal range ${engine.MIN_DECK}-${engine.MAX_DECK})`);
console.log(`score     : ${deck.score.toFixed(1)}`);
const byTier = {};
for (const e of deck.entries) byTier[e.tier] = (byTier[e.tier] || 0) + 1;
console.log(`curve     : ${Object.entries(byTier).map(([t, n]) => `T${t}:${n}`).join("  ")}`);
console.log();
console.table(deck.entries.map((e) => ({
	id: e.card.ID, tier: e.tier, name: e.card.Title || e.card.Name,
	type: e.card.Type, fame: e.card.FamePerTurn, money: e.card.MoneyPerTurn,
	groups: (e.card.Group || []).join("/"), value: Number(e.score.toFixed(1)),
})));
console.log("\nIDs:", JSON.stringify(deck.ids));
console.log("Paste into the console to load it in-game:");
console.log(`  BCC.saveIds(${JSON.stringify(deck.ids)}, 0)`);
