import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../api/client";
import type { Region, RegionType, TemplateInfo } from "../types/rubric";

const MIN_REGION_SIZE = 12;

interface Point {
  x: number;
  y: number;
}

interface Draft extends Point {
  pointerId: number;
  startX: number;
  startY: number;
}

interface ImageSize {
  width: number;
  height: number;
}

function caughtMessage(caught: unknown): string {
  return caught instanceof Error
    ? caught.message
    : "요청을 처리하지 못했습니다.";
}

function intersects(left: Region, right: Region): boolean {
  return (
    left.page_no === right.page_no &&
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

export default function RegionEditor() {
  const { id } = useParams();
  const assessmentId = Number(id);
  const validId = Number.isSafeInteger(assessmentId) && assessmentId > 0;
  const imageRef = useRef<HTMLImageElement>(null);

  const [template, setTemplate] = useState<TemplateInfo | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [regions, setRegions] = useState<Region[]>([]);
  const [mode, setMode] = useState<RegionType>("response");
  const [itemNo, setItemNo] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [loading, setLoading] = useState(validId);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(
    validId ? null : "평가 번호가 올바르지 않습니다.",
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!validId) return;
    let active = true;
    setLoading(true);
    setError(null);

    api
      .createTemplate(assessmentId)
      .then(async (info) => {
        const saved = await api.getRegions(assessmentId);
        if (!active) return;
        setTemplate(info);
        setRegions(saved.regions);
        setPageNo(1);
        setDirty(false);
      })
      .catch((caught) => {
        if (active) setError(caughtMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [assessmentId, validId]);

  function toTemplateCoords(clientX: number, clientY: number): Point | null {
    const image = imageRef.current;
    if (image === null || imageSize === null) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.round(
      ((clientX - rect.left) * imageSize.width) / rect.width,
    );
    const y = Math.round(
      ((clientY - rect.top) * imageSize.height) / rect.height,
    );
    return {
      x: Math.max(0, Math.min(imageSize.width, x)),
      y: Math.max(0, Math.min(imageSize.height, y)),
    };
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || busy) return;
    const point = toTemplateCoords(event.clientX, event.clientY);
    if (point === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      ...point,
    });
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (draft === null || draft.pointerId !== event.pointerId) return;
    const point = toTemplateCoords(event.clientX, event.clientY);
    if (point !== null) setDraft({ ...draft, ...point });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (draft === null || draft.pointerId !== event.pointerId) return;
    const end = toTemplateCoords(event.clientX, event.clientY) ?? draft;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraft(null);

    const x = Math.min(draft.startX, end.x);
    const y = Math.min(draft.startY, end.y);
    const width = Math.abs(end.x - draft.startX);
    const height = Math.abs(end.y - draft.startY);
    if (width < MIN_REGION_SIZE || height < MIN_REGION_SIZE) {
      setError("너무 작은 영역은 추가하지 않았습니다.");
      return;
    }
    if (mode === "response" && (!Number.isSafeInteger(itemNo) || itemNo < 1)) {
      setError("문항 번호는 하나 이상의 정수여야 합니다.");
      return;
    }

    const next: Region = {
      region_type: mode,
      item_no: mode === "response" ? itemNo : null,
      page_no: pageNo,
      x,
      y,
      width,
      height,
    };
    if (
      next.region_type === "response" &&
      regions.some(
        (region) =>
          region.region_type === "response" && region.item_no === next.item_no,
      )
    ) {
      setError("이미 지정한 문항 번호입니다.");
      return;
    }
    if (
      next.region_type === "pii" &&
      regions.some((region) => region.region_type === "pii")
    ) {
      setError("식별정보 영역은 하나만 지정할 수 있습니다.");
      return;
    }
    if (
      regions.some(
        (region) =>
          region.region_type !== next.region_type && intersects(region, next),
      )
    ) {
      setError("응답 영역과 식별정보 영역은 겹칠 수 없습니다.");
      return;
    }

    setRegions([...regions, next]);
    if (mode === "response") setItemNo(itemNo + 1);
    setDirty(true);
    setError(null);
    setNotice("저장하지 않은 영역 변경이 있습니다.");
  }

  function removeRegion(index: number) {
    setRegions(regions.filter((_, position) => position !== index));
    setDirty(true);
    setNotice("저장하지 않은 영역 변경이 있습니다.");
    setError(null);
  }

  function clearPage() {
    setRegions(regions.filter((region) => region.page_no !== pageNo));
    setDirty(true);
    setNotice("현재 쪽의 영역을 모두 지웠습니다. 아직 저장하지 않았습니다.");
    setError(null);
  }

  async function saveRegions() {
    await api.saveRegions(assessmentId, regions);
    setDirty(false);
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      await saveRegions();
      setNotice("영역을 저장했습니다.");
    } catch (caught) {
      setError(caughtMessage(caught));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  async function handlePrintable() {
    if (!regions.some((region) => region.region_type === "response")) {
      setError("응답 영역을 하나 이상 지정하세요.");
      return;
    }
    if (!regions.some((region) => region.region_type === "pii")) {
      setError("이름과 번호가 있는 식별정보 영역을 먼저 지정하세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveRegions();
      await api.generatePrintable(assessmentId);
      setTemplate((current) =>
        current === null ? current : { ...current, printable_ready: true },
      );
      window.open(
        api.printableUrl(assessmentId),
        "_blank",
        "noopener,noreferrer",
      );
      setNotice("배부용 답안지를 만들었습니다. 내려받기 링크도 준비했습니다.");
    } catch (caught) {
      setError(caughtMessage(caught));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  if (!validId) {
    return <p role="alert">{error}</p>;
  }
  if (loading) {
    return <p aria-live="polite">답안지 템플릿을 불러오는 중입니다.</p>;
  }
  if (template === null) {
    return (
      <main>
        <p role="alert">{error ?? "답안지 템플릿을 불러오지 못했습니다."}</p>
        <Link to={`/assessments/${assessmentId}/rubric`}>루브릭으로 돌아가기</Link>
      </main>
    );
  }

  const pageRegions = regions
    .map((region, index) => ({ region, index }))
    .filter(({ region }) => region.page_no === pageNo);

  return (
    <main aria-busy={busy}>
      <div className="region-editor-heading">
        <div>
          <h1>답안 영역 지정</h1>
          <p>
            빈 답안지 위에서 끌어 응답 영역과 식별정보 영역을 지정합니다.
            이름, 학교, 학년, 반, 번호 칸은 하나의 식별정보 영역 안에 모두
            넣으세요.
          </p>
        </div>
        <Link to={`/assessments/${assessmentId}/rubric`}>루브릭으로 돌아가기</Link>
      </div>

      <section className="region-editor-toolbar" aria-label="영역 그리기 설정">
        <label>
          쪽
          <select
            value={pageNo}
            disabled={busy}
            onChange={(event) => {
              setPageNo(Number(event.target.value));
              setDraft(null);
              setImageSize(null);
            }}
          >
            {Array.from(
              { length: template.page_count },
              (_, index) => index + 1,
            ).map((number) => (
              <option key={number} value={number}>
                {number}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="radio"
            name="region-mode"
            checked={mode === "response"}
            disabled={busy}
            onChange={() => setMode("response")}
          />
          응답 영역
        </label>
        <label>
          <input
            type="radio"
            name="region-mode"
            checked={mode === "pii"}
            disabled={busy}
            onChange={() => setMode("pii")}
          />
          식별정보 영역
        </label>
        {mode === "response" && (
          <label>
            문항 번호
            <input
              type="number"
              min={1}
              step={1}
              value={itemNo}
              disabled={busy}
              onChange={(event) => setItemNo(Number(event.target.value))}
            />
          </label>
        )}
      </section>

      <p className="region-editor-help">
        파란 상자는 외부 인식 대상으로 잘릴 수 있고, 빨간 상자는 지역에서만
        처리되어 외부 전송 대상에서 빠집니다. 두 종류는 겹칠 수 없습니다.
      </p>

      <div
        className="region-board"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDraft(null)}
      >
        <img
          key={`${assessmentId}-${pageNo}`}
          ref={imageRef}
          src={api.templatePageUrl(assessmentId, pageNo)}
          alt={`${pageNo}쪽 빈 답안지`}
          draggable={false}
          onLoad={(event) =>
            setImageSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setError("답안지 쪽 이미지를 불러오지 못했습니다.")}
        />

        {imageSize !== null &&
          pageRegions.map(({ region, index }) => (
            <div
              key={`${region.region_type}-${region.item_no}-${index}`}
              className={`region-overlay region-overlay-${region.region_type}`}
              style={{
                left: `${(region.x / imageSize.width) * 100}%`,
                top: `${(region.y / imageSize.height) * 100}%`,
                width: `${(region.width / imageSize.width) * 100}%`,
                height: `${(region.height / imageSize.height) * 100}%`,
              }}
            >
              <span>
                {region.region_type === "pii"
                  ? "식별정보"
                  : `${region.item_no}번`}
              </span>
            </div>
          ))}

        {draft !== null && imageSize !== null && (
          <div
            className="region-overlay region-overlay-draft"
            style={{
              left: `${(Math.min(draft.startX, draft.x) / imageSize.width) * 100}%`,
              top: `${(Math.min(draft.startY, draft.y) / imageSize.height) * 100}%`,
              width: `${(Math.abs(draft.x - draft.startX) / imageSize.width) * 100}%`,
              height: `${(Math.abs(draft.y - draft.startY) / imageSize.height) * 100}%`,
            }}
          />
        )}
      </div>

      <section className="region-list" aria-label={`${pageNo}쪽 지정 영역`}>
        <h2>{pageNo}쪽 지정 영역</h2>
        {pageRegions.length === 0 ? (
          <p>아직 지정한 영역이 없습니다.</p>
        ) : (
          <ul>
            {pageRegions.map(({ region, index }) => (
              <li key={`list-${region.region_type}-${region.item_no}-${index}`}>
                <span>
                  {region.region_type === "pii"
                    ? "식별정보"
                    : `${region.item_no}번 응답`}
                  {` · ${region.width} × ${region.height} 화소`}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => removeRegion(index)}
                >
                  지우기
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="region-editor-actions">
        <button type="button" disabled={busy || !dirty} onClick={handleSave}>
          영역 저장
        </button>
        <button type="button" disabled={busy} onClick={handlePrintable}>
          배부용 답안지 만들기
        </button>
        <button
          type="button"
          disabled={busy || pageRegions.length === 0}
          onClick={clearPage}
        >
          이 쪽 영역 모두 지우기
        </button>
        {template.printable_ready && (
          <a
            href={api.printableUrl(assessmentId)}
            target="_blank"
            rel="noreferrer"
          >
            만든 답안지 내려받기
          </a>
        )}
      </div>

      <div aria-live="polite">
        {notice && <p className="notice-message">{notice}</p>}
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
    </main>
  );
}
