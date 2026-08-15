"""전송 게이트웨이를 통과해 구글 제미나이를 호출하는 어댑터."""

from typing import Any

from google import genai
from google.genai import types

from app.providers.base import LLMProvider, LLMResponse
from app.providers.gateway import OutboundRequest, TransmissionGateway


class GeminiLLMProvider(LLMProvider):
    def __init__(
        self,
        api_key: str,
        model: str | None,
        gateway: TransmissionGateway,
        client: Any | None = None,
    ) -> None:
        super().__init__(gateway)
        self._client = client if client is not None else genai.Client(api_key=api_key)
        self._model = model

    def _complete(
        self,
        request: OutboundRequest,
        max_output_tokens: int,
        json_output: bool,
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
            max_output_tokens=max_output_tokens,
            temperature=0.0,
            response_mime_type="application/json" if json_output else "text/plain",
        )
        response = self._client.models.generate_content(
            model=self._model,
            contents=[types.Content(role="user", parts=parts)],
            config=config,
        )
        return LLMResponse(text=response.text or "")

    def _list_models(self, _request: OutboundRequest) -> list[str]:
        names: list[str] = []
        for model in self._client.models.list():
            actions = getattr(model, "supported_actions", None) or []
            if (not actions or "generateContent" in actions) and model.name:
                names.append(model.name)
        return sorted(names)
