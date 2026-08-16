"""정확한 언어 모형 손잡이를 쓰는 멀티모달 인식 제공자."""

from app.providers.base import LLMProvider, LLMRequest
from app.providers.recognition import (
    CLASSIFY_SYSTEM,
    TRANSCRIBE_SYSTEM,
    build_classify_prompt,
    parse_classify_output,
    parse_transcribe_output,
)
from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)


MAX_IMAGE_BYTES = 20 * 1024 * 1024


class GeminiRecognitionProvider:
    __slots__ = ("_llm",)

    def __init__(self, llm: LLMProvider) -> None:
        if type(llm) is not LLMProvider:
            raise TypeError("정확한 언어 모형 제공자 실행 손잡이가 필요합니다.")
        object.__setattr__(self, "_llm", llm)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(f"인식 제공자 합성은 바꿀 수 없습니다: {name}")

    def _call(
        self,
        system: str,
        user_text: str,
        image: bytes,
        purpose: str,
        token: str,
        max_output_tokens: int,
    ) -> str:
        response = LLMProvider.complete(
            self._llm,
            LLMRequest(
                system=system,
                user_text=user_text,
                images=[image],
                purpose=purpose,
                anonymous_token=token,
                max_output_tokens=max_output_tokens,
            ),
        )
        return response.text

    @staticmethod
    def _valid_image(image: bytes) -> bool:
        return type(image) is bytes and 0 < len(image) <= MAX_IMAGE_BYTES

    def classify(
        self,
        image: bytes,
        candidates: list[str],
        slot_count: int = 1,
        anonymous_token: str | None = None,
    ) -> RecognizedResponse:
        if not self._valid_image(image) or anonymous_token is None:
            return RecognizedResponse(
                kind=RecognitionKind.CLASSIFY,
                status=RecognitionStatus.ERROR,
                confidence=0.0,
                note="분류 입력이 올바르지 않습니다.",
            )
        try:
            prompt = build_classify_prompt(candidates, slot_count)
            raw = self._call(
                CLASSIFY_SYSTEM,
                prompt,
                image,
                "recognize_classify",
                anonymous_token,
                4_096,
            )
        except Exception:  # noqa: BLE001 - 제공자 세부 내용은 복제하지 않는다
            return RecognizedResponse(
                kind=RecognitionKind.CLASSIFY,
                status=RecognitionStatus.ERROR,
                confidence=0.0,
                note="분류 외부 호출에 실패했습니다.",
            )
        return parse_classify_output(
            raw,
            slot_count,
            candidates=candidates,
        )

    def transcribe(
        self,
        image: bytes,
        anonymous_token: str | None = None,
    ) -> RecognizedResponse:
        if not self._valid_image(image) or anonymous_token is None:
            return RecognizedResponse(
                kind=RecognitionKind.TRANSCRIBE,
                status=RecognitionStatus.ERROR,
                confidence=0.0,
                note="전사 입력이 올바르지 않습니다.",
            )
        try:
            raw = self._call(
                TRANSCRIBE_SYSTEM,
                "이 이미지의 손글씨를 있는 그대로 옮겨 적으세요.",
                image,
                "recognize_transcribe",
                anonymous_token,
                8_192,
            )
        except Exception:  # noqa: BLE001 - 제공자 세부 내용은 복제하지 않는다
            return RecognizedResponse(
                kind=RecognitionKind.TRANSCRIBE,
                status=RecognitionStatus.ERROR,
                confidence=0.0,
                note="전사 외부 호출에 실패했습니다.",
            )
        return parse_transcribe_output(raw)
