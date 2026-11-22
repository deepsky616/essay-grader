import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "kordoc";

async function readReferencePdf(pdfPath, reportPath) {
  if (!pdfPath || !reportPath || extname(pdfPath).toLowerCase() !== ".pdf" || extname(reportPath).toLowerCase() !== ".json") {
    throw new Error("사용법: node read-kordoc.mjs 평가기준안.pdf 보조판독.json");
  }
  const source = await stat(pdfPath);
  if (!source.isFile() || source.size > 18 * 1024 * 1024) throw new Error("18MB 이하의 평가기준안 PDF를 선택해 주세요.");
  const bytes = await readFile(pdfPath);
  if (bytes.length > 18 * 1024 * 1024 || !bytes.subarray(0, 1024).includes("%PDF-")) throw new Error("올바른 PDF 파일을 선택해 주세요.");
  const result = await parse(bytes, { formulaOcr: true, ocr: false, images: false });
  if (!result.success) throw new Error(result.error?.message || result.error || "PDF를 읽지 못했습니다.");
  const formulas = (result.blocks || []).flatMap((block) => {
    const wrapped = typeof block.text === "string" ? block.text.trim().match(/^(\2)([\s\S]+)\1$/) : null;
    const latex = wrapped?.[2]?.replace(/^\$+|\$+$/g, "").trim();
    const page = block.pageNumber;
    if (!latex || latex.length > 600 || !/\\(?:d|t)?frac\s*\{/.test(latex) || !Number.isSafeInteger(page) || page < 1 || page > 1000) return [];
    const { x, y, width, height } = block.bbox || {};
    const box = [x, y, x + width, y + height];
    return [{ page, latex, box: box.every(Number.isFinite) && width > 0 && height > 0 ? box : null }];
  });
  if (formulas.length > 400) throw new Error("분수 수식이 400개를 넘습니다. 평가기준안을 나누어 읽어 주세요.");
  const report = {
    format: "essay-grader-kordoc-v1",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    formulas,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`분수 수식 ${formulas.length}개를 저장했습니다. 웹앱의 Kordoc 보조 판독에서 아래 파일을 선택하세요.\n${reportPath}`);
}

try {
  await readReferencePdf(process.argv[2], process.argv[3]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
