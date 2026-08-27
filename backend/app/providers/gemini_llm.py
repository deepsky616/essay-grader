"""검사된 요청만 구글 제미나이 도구로 옮기는 원시 어댑터."""

from typing import Any

from google import genai
from google.genai import types

from app.providers.base import LLMOutboundRequest, LLMProvider, LLMResponse
from app.providers.gateway import OutboundRequest, TransmissionGateway

__all__ = ["create_gemini_provider"]
_MIN_RUBRIC_OUTPUT_TOKENS = 32000


class _GeminiLLMAdapter:
    """전송 관문이 검사한 불변 요청을 제미나이 형식으로 바꾼다."""

    def __init__(
        self,
        api_key: str,
        model: str | None,
        client: Any | None = None,
    ) -> None:
        self._client = client if client is not None else genai.Client(api_key=api_key)
        self._model = model

    def complete(
        self,
        request: LLMOutboundRequest,
    ) -> LLMResponse:
        if self._model is None:
            raise ValueError("사용할 모델을 먼저 선택하세요.")
        system, user_text = request.text_parts
        parts: list[types.Part] = [
            types.Part.from_bytes(data=image, mime_type="image/png")
            for image in request.image_parts
        ]
        parts.append(types.Part.from_text(text=user_text))
        config = types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=request.max_output_tokens,
            temperature=0.0,
            response_mime_type=(
                "application/json" if request.json_output else "text/plain"
            ),
        )
        response = self._client.models.generate_content(
            model=self._model,
            contents=[types.Content(role="user", parts=parts)],
            config=config,
        )
        return LLMResponse(text=response.text or "")

    def list_models(self, _request: OutboundRequest) -> list[str]:
        """목록 메타자료로 확인 가능한 컴파일 최소 조건만 통과시킨다.

        설치된 도구의 모델 자료에는 이미지 입력과 구조화 출력 지원 칸이 없다.
        그 둘은 이름이나 설명으로 추정하지 않고 첫 실제 완성 호출에서 확인한다.
        """
        names: list[str] = []
        for model in self._client.models.list():
            name = getattr(model, "name", None)
            actions = getattr(model, "supported_actions", None)
            output_limit = getattr(model, "output_token_limit", None)
            if (
                isinstance(name, str)
                and bool(name.strip())
                and isinstance(actions, list)
                and "generateContent" in actions
                and type(output_limit) is int
                and output_limit >= _MIN_RUBRIC_OUTPUT_TOKENS
            ):
                names.append(name)
        return sorted(names)


def create_gemini_provider(
    api_key: str,
    model: str | None,
    gateway: TransmissionGateway,
    client: Any | None = None,
) -> LLMProvider:
    """제미나이 원시 어댑터를 정확한 공용 실행 손잡이에 합성한다."""
    adapter = _GeminiLLMAdapter(api_key=api_key, model=model, client=client)
    return LLMProvider(
        gateway=gateway,
        complete_adapter=adapter.complete,
        list_models_adapter=adapter.list_models,
    )
