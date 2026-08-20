#!/usr/bin/env node
/**
 * Ask Claude to build a Club Cards deck.
 *
 * The local engine parses rules text mechanically, which means it cannot see drawbacks,
 * unquantified effects, or two-card combos. A model reading the same 301 cards can. This
 * sends the whole card list plus the engine's own scores, asks for a deck and the reasoning
 * behind it, then validates the answer against the game's real deck rules.
 *
 *   npm install @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=...        # or: ant auth login
 *   node tools/llm-deck.js
 *   node tools/llm-deck.js --owned all --brief "beat a fast Maid deck"
 *
 * Roughly 15k input tokens per run.
 */
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const engine = require(path.join(__dirname, "..", "src", "deck-engine.js"));
const cards = require(path.join(__dirname, "..", "data", "cards.json"));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf("--" + name);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const ownedArg = arg("owned", "");
const owned = ownedArg === "all"
	? new Set(cards.filter((c) => c.Reward).map((c) => c.ID))
	: new Set(String(ownedArg).split(",").filter(Boolean).map(Number));
const pool = cards.filter((c) => !c.Reward || owned.has(c.ID));
const size = Number(arg("size", engine.DEFAULT_DECK));
const brief = arg("brief", "Build the strongest general-purpose deck.");

// The engine's own read, handed over as a starting point rather than an answer.
const ctx = engine.deckContext(pool.slice(0, 40), {});
const scored = new Map(pool.map((c) => [c.ID, engine.valueCard(c, ctx, (x) => x.Text || "")]));
const engineDeck = engine.buildDeck({ pool, size, getText: (c) => c.Text || "" });

const table = pool
	.slice()
	.sort((a, b) => a.RequiredLevel - b.RequiredLevel || a.ID - b.ID)
	.map((c) => [
		c.ID, `T${c.RequiredLevel}`, c.Type === "Event" ? "event" : "member",
		`${c.FamePerTurn > 0 ? "+" : ""}${c.FamePerTurn}f/${c.MoneyPerTurn > 0 ? "+" : ""}${c.MoneyPerTurn}$`,
		(c.Group || []).join("|") || "-",
		`score ${scored.get(c.ID).toFixed(0)}`,
		c.Title, c.Text ? `— ${c.Text}` : "— (no rules text)",
	].join("  "))
	.join("\n");

const RULES = `Club Cards is the two-player deckbuilding minigame inside Bondage Club (R131).
These rules are read from the game's source, not from memory:

- Both players build a deck of ${engine.MIN_DECK}-${engine.MAX_DECK} cards. Singleton: no duplicates.
- Start at $10, 0 fame, club tier 1. First to 100 fame wins.
- Club tiers cost and hold: T1 Apartment free/5 members, T2 Cottage $10/7, T3 House $20/13,
  T4 Mansion $30/20, T5 Manor $40/40. Liability slots per tier: 1/2/3/5/8.
- A card's RequiredLevel is the club tier needed to play it at all.
- One action per turn by default. A turn is: play one card, OR use one activated ability,
  OR upgrade the club, OR draw a card and pass. Cards granting ExtraPlay add actions.
- You draw only one card per turn unless a card says otherwise, so card draw is scarce.
- At end of turn every member on your board pays out its fame and money.
- CRITICAL: if your money is below zero when the turn ends, that turn's fame gain is
  cancelled entirely. Upkeep-heavy boards do not merely slow you down, they erase turns.
- Liability cards are played into the OPPONENT's club, taking their slots.
- Events without the TimedEvent or ContinuousEvent group are discarded at end of turn.
- The 'streets' is the discard pile; some cards care about it.

Tempo decides games. Real games finish in 15-17 turns and rarely reach 20, so 100 fame in
about 16 turns means averaging better than 6 fame per turn. A card only pays out for the turns
left after you can afford to play it: climbing to tier 5 costs 100 money in total, so tier 5
cards land around turn 12 and earn for roughly three turns, while a tier 1 card earns for
fourteen. Expensive cards must therefore be dramatically better, not slightly better, and a
deck that only comes together at tier 4 has already lost to a deck that curved out at tier 2.

Decks that stop at tier 3 are proven — a tier 1-3 build reaching 100 fame in 17 turns beats a
deck still assembling its tier 5 payoff. Reach past tier 3 only for a card that genuinely wins
the game, not for a better statline.

Deck size is a real decision, not a formality. You draw one card per turn and no card appears
twice, so a 30-card deck reaches any particular card about a third sooner than a 40-card one.
Most competitive players run 30. Build at 30 unless the deck genuinely needs the extra breadth,
and if a win condition depends on specific cards, run the minimum so you find them in time.`;

const SYSTEM = `You are an expert constructed-format deckbuilder. You are given every card in the
game with its printed statline and full rules text.

A local heuristic engine has scored each card by parsing its rules text for per-turn clauses.
That engine is blind to three things, and this is exactly where your judgement is needed:
 1. Drawbacks. "Leaves if..." or "You Play A Non-Latex Member: Leaves" is invisible to it, so
    cards with good statlines and crippling text are scored far too highly.
 2. Effects with no numbers, like "+Fame equal to club tier", which it flattens to a guess.
 3. Two-card combos and named synergies, which it only sees when a card names another card.

Treat the scores as a prior to argue with, not an answer. Build a deck that actually wins:
a curve you can cast on time, an economy that never ends a turn below zero money, and a
fame engine that closes to 100 before the opponent does.`;

const schema = {
	type: "object",
	properties: {
		archetype: { type: "string", description: "Short name for the deck's plan" },
		strategy: { type: "string", description: "How the deck wins, in 3-5 sentences" },
		ids: { type: "array", items: { type: "integer" }, description: `Exactly ${size} unique card IDs` },
		keyCards: {
			type: "array",
			description: "The 5-8 cards the deck is actually built around",
			items: {
				type: "object",
				properties: { id: { type: "integer" }, why: { type: "string" } },
				required: ["id", "why"], additionalProperties: false,
			},
		},
		overrides: {
			type: "array",
			description: "Cards where you disagree with the engine's score, and why",
			items: {
				type: "object",
				properties: {
					id: { type: "integer" },
					direction: { type: "string", enum: ["engine too high", "engine too low"] },
					why: { type: "string" },
				},
				required: ["id", "direction", "why"], additionalProperties: false,
			},
		},
	},
	required: ["archetype", "strategy", "ids", "keyCards", "overrides"],
	additionalProperties: false,
};

(async () => {
	const client = new Anthropic();
	const prompt = `${RULES}

Brief: ${brief}

Deck size: exactly ${size} cards, all unique.${size > engine.MIN_DECK ? `
(Note: ${size} was requested explicitly. ${engine.MIN_DECK} would be more consistent — say so in the
strategy if you think the extra ${size - engine.MIN_DECK} cards are hurting this deck.)` : ""}

For reference, the heuristic engine's own build (archetype "${engineDeck.archetype || "goodstuff"}",
total score ${engineDeck.score.toFixed(0)}) is: ${engineDeck.ids.join(", ")}

Every legal card, as "ID  tier  type  fame/money  groups  engine-score  Title — rules text":

${table}`;

	process.stderr.write("Asking Claude...\n");
	const stream = client.messages.stream({
		model: "claude-opus-5",
		max_tokens: 64000,
		system: SYSTEM,
		thinking: { type: "adaptive" },
		output_config: { effort: "high", format: { type: "json_schema", schema } },
		messages: [{ role: "user", content: prompt }],
	});
	const response = await stream.finalMessage();

	if (response.stop_reason === "refusal") {
		console.error("Request was declined:", response.stop_details);
		process.exit(1);
	}
	const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
	let deck;
	try { deck = JSON.parse(text); }
	catch (e) { console.error("Could not parse the response as JSON:\n" + text); process.exit(1); }

	// --- validate against the game's real rules, not the model's word for it
	const byId = new Map(cards.map((c) => [c.ID, c]));
	const problems = [];
	const unknown = deck.ids.filter((id) => !byId.has(id));
	const unowned = deck.ids.filter((id) => byId.get(id) && byId.get(id).Reward && !owned.has(id));
	if (unknown.length) problems.push(`card IDs that do not exist: ${unknown.join(", ")}`);
	if (unowned.length) problems.push(`reward cards you do not own: ${unowned.map((i) => byId.get(i).Title).join(", ")}`);
	if (new Set(deck.ids).size !== deck.ids.length) problems.push("deck contains duplicates");
	if (deck.ids.length < engine.MIN_DECK || deck.ids.length > engine.MAX_DECK) {
		problems.push(`deck has ${deck.ids.length} cards, legal range is ${engine.MIN_DECK}-${engine.MAX_DECK}`);
	}

	const picked = deck.ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
	const deckCtx = engine.deckContext(picked, {});
	const total = picked.reduce((s, c) => s + engine.valueCard(c, deckCtx, (x) => x.Text || ""), 0);
	const curve = [1, 2, 3, 4, 5].map((t) => picked.filter((c) => c.RequiredLevel === t).length);
	const money = picked.reduce((s, c) => s + (c.MoneyPerTurn || 0), 0);
	const fame = picked.reduce((s, c) => s + (c.FamePerTurn || 0), 0);

	console.log(`\n${deck.archetype}\n${"=".repeat(deck.archetype.length)}\n`);
	console.log(deck.strategy + "\n");
	console.log(`cards   : ${deck.ids.length}`);
	console.log(`curve   : ${curve.map((n, i) => `T${i + 1}:${n}`).join("  ")}`);
	console.log(`printed : ${fame > 0 ? "+" : ""}${fame} fame/turn, ${money > 0 ? "+" : ""}${money} money/turn`);
	console.log(`engine  : ${total.toFixed(0)}  (its own build scored ${engineDeck.score.toFixed(0)})`);
	console.log(`overlap : ${deck.ids.filter((id) => engineDeck.ids.includes(id)).length} of ${size} cards shared with the engine's build`);

	console.log("\nBuilt around:");
	for (const k of deck.keyCards) console.log(`  ${(byId.get(k.id) || {}).Title || k.id} — ${k.why}`);
	if (deck.overrides.length) {
		console.log("\nWhere it disagrees with the engine:");
		for (const o of deck.overrides) console.log(`  ${(byId.get(o.id) || {}).Title || o.id} [${o.direction}] — ${o.why}`);
	}

	if (problems.length) {
		console.log("\nPROBLEMS — do not use this deck as-is:");
		for (const p of problems) console.log("  - " + p);
		process.exitCode = 1;
	} else {
		console.log(`\nValid. Load it with:\n  BCC.saveIds(${JSON.stringify(deck.ids)})`);
	}
	const usage = response.usage;
	process.stderr.write(`\ntokens: ${usage.input_tokens} in, ${usage.output_tokens} out\n`);
})();
