"use strict";

(function attachPageAlignment(root) {
  const ANALYSIS_WIDTH = 520;
  const PATCH_RADIUS = 11;
  const MATCH_ERROR = 2.2; // Pixels in the analysis image.

  function inkMask({ data, width, height }) {
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i += 1) {
      const pixel = i * 4;
      const brightness = (data[pixel] * 3 + data[pixel + 1] * 6 + data[pixel + 2]) / 10;
      mask[i] = data[pixel + 3] > 128 && brightness < 178 ? 1 : 0;
    }
    return mask;
  }

  function sampleEvenly(points, limit) {
    if (points.length <= limit) return points;
    return Array.from({ length: limit }, (_, index) => points[Math.floor(index * points.length / limit)]);
  }

  function makePatch(mask, width, x, y) {
    const ink = [];
    const paper = [];
    let horizontalEdges = 0;
    let verticalEdges = 0;
    let occupiedQuadrants = 0;
    for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy += 1) {
      for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx += 1) {
        const index = (y + dy) * width + x + dx;
        if (mask[index]) {
          ink.push([dx, dy]);
          occupiedQuadrants |= 1 << ((dy >= 0 ? 2 : 0) + (dx >= 0 ? 1 : 0));
        } else if (!(mask[index - 1] || mask[index + 1] || mask[index - width] || mask[index + width])) {
          paper.push([dx, dy]);
        }
        horizontalEdges += mask[index] !== mask[index + 1];
        verticalEdges += mask[index] !== mask[index + width];
      }
    }
    // Reject isolated rules, empty boxes and solid fills. Require texture in at least three quadrants.
    const quadrantCount = [1, 2, 4, 8].filter((flag) => occupiedQuadrants & flag).length;
    if (ink.length < 22 || ink.length > 260 || paper.length < 36 || quadrantCount < 3) return null;
    const strength = Math.min(horizontalEdges, verticalEdges);
    if (strength < 15) return null;
    return { x, y, strength, ink: sampleEvenly(ink, 36), paper: sampleEvenly(paper, 24) };
  }

  function prepareTemplate(image) {
    const { width, height } = image;
    if (width < 120 || height < 160) return null;
    const mask = inkMask(image);
    const anchors = [];
    const columns = 4;
    const rows = 5;
    const startX = Math.floor(width * 0.08);
    const startY = Math.floor(height * 0.27); // The answer's top identity band was removed.
    const cellWidth = width * 0.84 / columns;
    const cellHeight = height * 0.66 / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        let best;
        for (let y = Math.ceil(startY + row * cellHeight); y < startY + (row + 1) * cellHeight; y += 6) {
          for (let x = Math.ceil(startX + column * cellWidth); x < startX + (column + 1) * cellWidth; x += 6) {
            if (x < PATCH_RADIUS + 1 || x >= width - PATCH_RADIUS - 1 || y >= height - PATCH_RADIUS - 1) continue;
            const patch = makePatch(mask, width, x, y);
            if (patch && (!best || patch.strength > best.strength)) best = patch;
          }
        }
        if (best) anchors.push(best);
      }
    }
    return anchors.length >= 8 ? { width, height, anchors } : null;
  }

  function softenedInk(mask, width, height) {
    const soft = new Uint8Array(mask.length);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        soft[index] = mask[index] ? 4 : mask[index - 1] || mask[index + 1] || mask[index - width] || mask[index + width] ? 2 : 0;
      }
    }
    return soft;
  }

  function patchScore(anchor, soft, width, x, y) {
    const offset = y * width + x;
    let ink = 0;
    let paper = 0;
    for (const [dx, dy] of anchor.ink) ink += soft[offset + dy * width + dx];
    for (const [dx, dy] of anchor.paper) paper += soft[offset + dy * width + dx];
    return ink / (4 * anchor.ink.length) - 0.65 * paper / (4 * anchor.paper.length);
  }

  function searchAnchor(anchor, soft, width, height) {
    const radius = Math.ceil(width * 0.095);
    const edge = PATCH_RADIUS + 2;
    const minX = Math.max(edge, anchor.x - radius);
    const maxX = Math.min(width - edge, anchor.x + radius);
    const minY = Math.max(Math.ceil(height * 0.23) + edge, anchor.y - radius);
    const maxY = Math.min(height - edge, anchor.y + radius);
    const candidates = [];
    for (let y = minY; y <= maxY; y += 2) {
      for (let x = minX; x <= maxX; x += 2) {
        const score = patchScore(anchor, soft, width, x, y);
        if (score >= 0.50) candidates.push({ x, y, score });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    let best = candidates[0];
    const seeds = candidates.slice(0, 8);
    for (const seed of seeds) {
      for (let y = Math.max(minY, seed.y - 1); y <= Math.min(maxY, seed.y + 1); y += 1) {
        for (let x = Math.max(minX, seed.x - 1); x <= Math.min(maxX, seed.x + 1); x += 1) {
          const score = patchScore(anchor, soft, width, x, y);
          if (score > best.score) best = { x, y, score };
        }
      }
    }
    const competing = candidates.find((point) => Math.hypot(point.x - best.x, point.y - best.y) >= 6);
    return best.score >= 0.64 && (!competing || best.score - competing.score >= 0.065)
      ? { x: anchor.x, y: anchor.y, targetX: best.x, targetY: best.y } : null;
  }

  function fitAffine(matches) {
    // Normal equations for the x and y affine components; solve both right-hand sides together.
    const matrix = Array.from({ length: 3 }, () => [0, 0, 0, 0, 0]);
    for (const { x, y, targetX, targetY } of matches) {
      const basis = [x, y, 1];
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) matrix[row][col] += basis[row] * basis[col];
        matrix[row][3] += basis[row] * targetX;
        matrix[row][4] += basis[row] * targetY;
      }
    }
    for (let col = 0; col < 3; col += 1) {
      let pivot = col;
      for (let row = col + 1; row < 3; row += 1) {
        if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
      }
      if (Math.abs(matrix[pivot][col]) < 1e-7) return null;
      [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
      const divisor = matrix[col][col];
      for (let j = col; j < 5; j += 1) matrix[col][j] /= divisor;
      for (let row = 0; row < 3; row += 1) {
        if (row === col) continue;
        const factor = matrix[row][col];
        for (let j = col; j < 5; j += 1) matrix[row][j] -= factor * matrix[col][j];
      }
    }
    return { a: matrix[0][3], b: matrix[0][4], c: matrix[1][3], d: matrix[1][4], e: matrix[2][3], f: matrix[2][4] };
  }

  function applyTransform({ a, b, c, d, e, f }, x, y) {
    return [a * x + c * y + e, b * x + d * y + f];
  }

  function plausibleTransform(transform, width, height) {
    if (!transform) return false;
    const { a, b, c, d } = transform;
    if (a < 0.92 || a > 1.08 || d < 0.92 || d > 1.08 || Math.abs(b) > 0.095 || Math.abs(c) > 0.095) return false;
    return [[0, 0], [width, 0], [0, height], [width, height]].every(([x, y]) => {
      const [targetX, targetY] = applyTransform(transform, x, y);
      return Math.hypot(targetX - x, targetY - y) <= width * 0.16;
    });
  }

  function residual(transform, match) {
    const [x, y] = applyTransform(transform, match.x, match.y);
    return Math.hypot(x - match.targetX, y - match.targetY);
  }

  function bestConsensus(matches, width, height) {
    let best = [];
    let bestError = Infinity;
    for (let i = 0; i < matches.length - 2; i += 1) {
      for (let j = i + 1; j < matches.length - 1; j += 1) {
        for (let k = j + 1; k < matches.length; k += 1) {
          const fit = fitAffine([matches[i], matches[j], matches[k]]);
          if (!plausibleTransform(fit, width, height)) continue;
          const inliers = matches.filter((match) => residual(fit, match) <= MATCH_ERROR);
          if (inliers.length < best.length) continue;
          const error = inliers.reduce((sum, match) => sum + residual(fit, match), 0);
          if (inliers.length > best.length || error < bestError) {
            best = inliers;
            bestError = error;
          }
        }
      }
    }
    return best;
  }

  function hasPageCoverage(anchors, width, height) {
    const x = anchors.map((anchor) => anchor.x);
    const y = anchors.map((anchor) => anchor.y);
    return Math.max(...x) - Math.min(...x) >= width * 0.32
      && Math.max(...y) - Math.min(...y) >= height * 0.37;
  }

  function transformedPatchScore(anchor, soft, width, height, transform) {
    function sample(points) {
      let sum = 0;
      for (const [dx, dy] of points) {
        const [px, py] = applyTransform(transform, anchor.x + dx, anchor.y + dy);
        const x = Math.round(px);
        const y = Math.round(py);
        if (x < 0 || x >= width || y < height * 0.23 || y >= height) return null;
        sum += soft[y * width + x];
      }
      return sum / (4 * points.length);
    }
    const inkScore = sample(anchor.ink);
    const paperInk = sample(anchor.paper);
    return inkScore === null || paperInk === null ? 0 : inkScore - 0.65 * paperInk;
  }

  function estimate(template, scanImage) {
    if (!template || template.width !== scanImage.width || template.height !== scanImage.height) return null;
    const { width, height, anchors } = template;
    const scan = inkMask(scanImage);
    const soft = softenedInk(scan, width, height);
    const matches = [];
    const holdout = [];
    anchors.forEach((anchor, index) => {
      if ((index + Math.floor(index / 4)) % 4 === 2) {
        holdout.push(anchor);
        return;
      }
      const match = searchAnchor(anchor, soft, width, height);
      if (match) matches.push(match);
    });
    if (matches.length < 6 || holdout.length < 2) return null;
    const inliers = bestConsensus(matches, width, height);
    if (inliers.length < 6 || inliers.length / matches.length < 0.55 || !hasPageCoverage(inliers, width, height)) return null;
    const transform = fitAffine(inliers);
    if (!plausibleTransform(transform, width, height)) return null;
    // Held-out patches were not searched or used to estimate the transform.
    const confirms = (anchor) => transformedPatchScore(anchor, soft, width, height, transform) >= 0.62;
    const verified = holdout.filter(confirms);
    if (verified.length < 2 || verified.length / holdout.length < 0.75) return null;
    const confirmedPatches = anchors.filter(confirms);
    if (confirmedPatches.length / anchors.length < 0.75 || !hasPageCoverage(confirmedPatches, width, height)) return null;
    const meanError = Math.sqrt(inliers.reduce((sum, match) => sum + residual(transform, match) ** 2, 0) / inliers.length);
    if (meanError > 1.4) return null;
    const maxShift = Math.max(...[[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => {
      const [targetX, targetY] = applyTransform(transform, x, y);
      return Math.hypot(targetX - x, targetY - y);
    }));
    return { transform, width, height, confirmations: confirmedPatches.length, meanError, maxShift };
  }

  function pdfMatrix({ transform: { a, b, c, d, e, f }, width, height }, referenceSize, scanSize) {
    // The matcher uses a top-left origin. PDF drawing uses a bottom-left origin.
    const px = width / referenceSize.width;
    const py = height / referenceSize.height;
    const sx = scanSize.width / width;
    const sy = scanSize.height / height;
    return [
      sx * a * px, -sy * b * px,
      -sx * c * py, sy * d * py,
      sx * (c * height + e), scanSize.height - sy * (d * height + f),
    ];
  }

  const api = { ANALYSIS_WIDTH, prepareTemplate, estimate, pdfMatrix };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChaejeomPageAlignment = api;
})(globalThis);
