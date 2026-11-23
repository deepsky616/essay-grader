"use strict";

const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");

// Use build/pdf.min.js from the official pdfjs-dist@3.11.174 npm package.
const [, , input, output] = process.argv;
if (!input || !output) throw new Error("Usage: node scripts/patch-pdfjs-render-scheduling.cjs <pdf.min.js> <output>");
const original = readFileSync(input);
const hash = createHash("sha256").update(original).digest("hex");
if (hash !== "5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946") {
  throw new Error("Expected the original PDF.js 3.11.174 release bundle.");
}

// Expose a per-render switch while preserving display intent, including screen-only annotations.
let source = original.toString("utf8");
for (const [before, after] of [
  ["printAnnotationStorage:h=null}){this._stats", "printAnnotationStorage:h=null,useRequestAnimationFrame:useFrame=true}){this._stats"],
  ["useRequestAnimationFrame:!u,pdfBug:", "useRequestAnimationFrame:!u&&useFrame,pdfBug:"],
]) {
  const position = source.indexOf(before);
  if (position < 0 || source.indexOf(before, position + before.length) >= 0) throw new Error("Unexpected PDF.js bundle layout.");
  source = source.replace(before, after);
}
writeFileSync(output, "// Modified for essay-grader: render tasks may disable animation-frame scheduling.\n" + source);
