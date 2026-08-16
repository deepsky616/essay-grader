"""정적 프런트 파일과 브라우저 화면 경로를 안전하게 제공한다."""

from pathlib import PurePath

from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


class SPAStaticFiles(StaticFiles):
    """실제 파일이 아닌 화면 GET만 뿌리 문서로 되돌린다."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except HTTPException as error:
            if error.status_code != 404:
                raise

        normalized = path.replace("\\", "/").lstrip("./")
        if (
            normalized == "api"
            or normalized.startswith("api/")
            or PurePath(normalized).suffix
        ):
            raise HTTPException(status_code=404)
        return await super().get_response("index.html", scope)
