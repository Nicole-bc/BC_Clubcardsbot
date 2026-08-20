#!/usr/bin/env node
/**
 * Loads a real ClubCard.js in a sandbox and checks that a generated deck is one the
 * game would accept: legal size, unique IDs, every ID resolvable, and byte-identical
 * after the builder's encode/decode round trip.
 *
 *   node tools/verify-deck.js /path/to/BondageClub/Screens/MiniGame/ClubCard/ClubCard.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const engine = require(path.join(__dirname, "..", "src", "deck-engine.js"));
const cards = require(path.join(__dirname, "..", "data", "cards.json"));

const src = process.argv[2];
if (!src) { console.error("usage: node tools/verify-deck.js <path to ClubCard.js>"); process.exit(2); }

const ctx = vm.createContext({ performance: { now: () => Date.now() } });
const code = fs.readFileSync(src, "utf8");
for (let i = 0; i < 200; i++) {
	try { vm.runInContext(code, ctx, { filename: "ClubCard.js" }); break; }
	catch (e) {
		const m = /^(\w+) is not defined$/.exec(e.message || "");
		if (!m) { console.error("load error:", e.message); process.exit(1); }
		vm.runInContext(`var ${m[1]} = function(){};`, ctx);
	}
}

const deck = engine.buildDeck({ pool: cards.filter((c) => !c.Reward), size: 40, getText: (c) => c.Text || "" });
const encoded = engine.encodeDeck(deck.ids);
const checks = [];
const check = (name, ok, detail) => checks.push({ check: name, ok, detail });

check("size within 30-40", encoded.length >= engine.MIN_DECK && encoded.length <= engine.MAX_DECK, encoded.length);
check("no duplicate cards", new Set(deck.ids).size === deck.ids.length, new Set(deck.ids).size);
check("encode/decode round trip", JSON.stringify(engine.decodeDeck(encoded)) === JSON.stringify(deck.ids), "");
const loaded = ctx.ClubCardLoadDeck(engine.decodeDeck(encoded));
check("game resolves every card", loaded.length === deck.ids.length, `${loaded.length}/${deck.ids.length}`);
check("no card above tier 5", deck.entries.every((e) => e.tier <= 5), "");
check("tables match engine", JSON.stringify(ctx.ClubCardLevelLimit) === JSON.stringify(engine.LEVEL_LIMIT)
	&& JSON.stringify(ctx.ClubCardLevelCost) === JSON.stringify(engine.LEVEL_COST)
	&& ctx.ClubCardFameGoal === engine.FAME_GOAL, "");
check("card data matches live list", cards.length === ctx.ClubCardList.length, `${cards.length} vs ${ctx.ClubCardList.length}`);

console.table(checks);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
