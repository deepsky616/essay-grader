from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class LLMRequest:
    system: str
    user_text: str
    images: list[bytes] = field(default_factory=list)
    max_output_tokens: int = 32000
    json_output: bool = True
    purpose: str = "rubric_compile"


@dataclass
class LLMResponse:
    text: str


class LLMProvider(Protocol):
    def complete(self, request: LLMRequest) -> LLMResponse: ...

    def list_models(self) -> list[str]: ...
