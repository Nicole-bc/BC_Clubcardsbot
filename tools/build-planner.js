#!/usr/bin/env node
/** Assembles dist/deck-planner.html from the template, the engine and the card data. */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const html = read("src/planner.tpl.html")
	.replace("/*ENGINE*/", () => read("src/deck-engine.js"))
	.replace("/*CARDS*/", () => read("data/cards.json"));

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "deck-planner.html"), html);
console.log(`dist/deck-planner.html  (${(html.length / 1024).toFixed(0)} KB)`);
