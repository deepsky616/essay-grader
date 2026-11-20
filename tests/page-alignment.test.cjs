"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const alignment = require("../web/page-alignment.js");

function fixture(seed = 741) {
  const width = 520;
  const height = 730;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  function noise() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / (2 ** 32);
  }
  function ink(x, y, shade = 30) {
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = shade;
  }
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const x = 65 + column * 110 + Math.floor(noise() * 15);
      const y = 224 + row * 96 + Math.floor(noise() * 17);
      // Different printed labels at multiple heights and across the page.
      for (let glyph = 0; glyph < 5; glyph += 1) {
        for (let dy = 0; dy < 13; dy += 2) {
          for (let dx = 0; dx < 5; dx += 1) {
            if (noise() < 0.52) {
              ink(x + glyph * 7 + dx, y + dy);
              ink(x + glyph * 7 + dx, y + dy + 1);
            }
          }
        }
      }
    }
  }
  return { width, height, data };
}

function scanOf(source, { a, b, c, d, e, f }, writeAnswers = false) {
  const { width, height } = source;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const determinant = a * d - b * c;
  for (let y = Math.ceil(height * 0.22); y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.round((d * (x - e) - c * (y - f)) / determinant);
      const sy = Math.round((-b * (x - e) + a * (y - f)) / determinant);
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
      let shade = source.data[(sy * width + sx) * 4];
      if (shade === 30) shade = 70;
      if (writeAnswers && (x + 12 * y) % 37 < 2 && y % 61 > 26 && y % 61 < 38) shade = 120;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = shade;
    }
  }
  return { width, height, data };
}

test("aligns printed features across a shifted, tilted scan with student writing and a redacted header", () => {
  const sheet = fixture();
  const template = alignment.prepareTemplate(sheet);
  assert.ok(template);
  const actual = { a: 1.018, b: 0.028, c: -0.026, d: 0.986, e: 12, f: -7 };
  const scan = scanOf(sheet, actual, true);
  const result = alignment.estimate(template, scan);
  assert.ok(result, "a small skew and scale change should be verifiable");
  assert.ok(result.confirmations >= 8);
  assert.ok(result.meanError < 1.4);
  for (const [x, y] of [[70, 240], [440, 300], [140, 640], [450, 660]]) {
    const t = result.transform;
    const deltaX = (t.a - actual.a) * x + (t.c - actual.c) * y + t.e - actual.e;
    const deltaY = (t.b - actual.b) * x + (t.d - actual.d) * y + t.f - actual.f;
    assert.ok(Math.hypot(deltaX, deltaY) <= 2.2);
  }
});

test("uses the uncorrected reference when corresponding features are missing or the layout differs", () => {
  const sheet = fixture();
  const template = alignment.prepareTemplate(sheet);
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const exact = alignment.estimate(template, scanOf(sheet, identity));
  assert.ok(exact);
  assert.ok(exact.maxShift < 1);
  const shifted = alignment.estimate(template, scanOf(sheet, { ...identity, e: 15, f: 9 }, true));
  assert.ok(shifted);
  assert.ok(Math.abs(shifted.transform.e - 15) < 1 && Math.abs(shifted.transform.f - 9) < 1);
  const blank = { width: sheet.width, height: sheet.height, data: new Uint8ClampedArray(sheet.data.length).fill(255) };
  assert.equal(alignment.prepareTemplate(blank), null);
  assert.equal(alignment.estimate(template, blank), null);
  assert.equal(alignment.estimate(template, scanOf(fixture(93284), identity, true)), null);
  assert.equal(alignment.estimate(template, scanOf(sheet, { ...identity, e: 80, f: 50 })), null);
});

test("converts pixel registration to the blank reference PDF coordinate system", () => {
  const result = { transform: { a: 1.02, b: 0.025, c: -0.025, d: 0.99, e: 12, f: -5 }, width: 520, height: 730 };
  const reference = { width: 595, height: 842 };
  const scan = { width: 608, height: 856 };
  const [a, b, c, d, e, f] = alignment.pdfMatrix(result, reference, scan);
  const refX = 162;
  const refY = 427;
  const x = refX * result.width / reference.width;
  const y = (reference.height - refY) * result.height / reference.height;
  const t = result.transform;
  const targetX = (t.a * x + t.c * y + t.e) * scan.width / result.width;
  const targetY = scan.height - (t.b * x + t.d * y + t.f) * scan.height / result.height;
  assert.ok(Math.abs((a * refX + c * refY + e) - targetX) < 1e-8);
  assert.ok(Math.abs((b * refX + d * refY + f) - targetY) < 1e-8);
});
