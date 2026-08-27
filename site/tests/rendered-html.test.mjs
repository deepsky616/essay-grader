import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function render(pathname = "/") {
  const moduleUrl = new URL("../dist/server/index.js", import.meta.url);
  moduleUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
  const server = await import(moduleUrl.href);
  const request = new Request(`http://localhost${pathname}`);

  return server.default.fetch(request, {
    ASSETS: {
      fetch(assetRequest) {
        return new Response(`asset:${new URL(assetRequest.url).pathname}`);
      },
    },
  });
}

test("첫 화면이 채점결 디자인을 서버에서 바로 보여 준다", async () => {
  const response = await render("/");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(html, /채점결/);
  assert.match(html, /평가가 끝나는 순간까지/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /Your site is taking shape/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

const routes = new Map([
  ["/assessments", "평가는 쌓여도"],
  ["/assessments/new", "처음부터 차근차근"],
  ["/classes", "학생은 가까이"],
  ["/review", "백분율로 나타내기"],
  ["/feedback", "점수는 정확하게"],
]);

for (const [pathname, expectedText] of routes) {
  test(`${pathname} 경로가 오류 없이 열린다`, async () => {
    const response = await render(pathname);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, new RegExp(expectedText));
  });
}

test("임시 시작 화면과 관련 꾸러미가 남아 있지 않다", async () => {
  const [packageJson, layoutSource] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(layoutSource, /lang="ko"/);
  assert.doesNotMatch(layoutSource, /codex-preview/);
});
