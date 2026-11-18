# 논술형 자동채점

교사 컴퓨터에서 평가 저작, 답안지 처리, 채점 검토, 피드백과 성적표 내보내기를
수행하는 지역 우선 앱이다. 학생 실명과 원본 스캔은 지역 저장소에 두고, 허용된
익명 자료만 외부 모형 전송 관문을 통과한다.

## 빠른 실행

필요한 도구는 Python 3.12 이상, `uv`, Node.js와 `npm`이다.

```bash
./run-local.sh
```

제품 화면 빌드와 파이썬 의존성 동기화가 끝나면 다음 주소를 연다.

```text
http://127.0.0.1:8000
```

다른 포트가 필요하면 다음처럼 실행한다.

```bash
ESSAY_GRADER_PORT=8080 ./run-local.sh
```

종료할 때는 실행한 터미널에서 `Ctrl+C`를 누른다. 지역 자료는 기본적으로
`~/essay-grader-data`에 저장된다.

## 배포 방식

이 앱은 FastAPI, SQLite, 지역 업로드 파일, 운영체제 키 저장소와 뒤 작업을 한
프로세스에서 사용한다. 버셀 정적 사이트나 수명이 짧은 서버리스 함수 배포는 지원
대상이 아니다. 버셀 주소가 404를 반환하더라도 지역 실행에는 문제가 없으며, 위의
지역 주소로 사용해야 한다.

## 검사

```bash
cd backend
uv sync --extra dev
uv run pytest tests/ -q

cd ../frontend
npm ci
npm run build
npm audit --audit-level=high
```

각 단계의 구현 계획과 현장 확인 절차는 `docs/plans`와 `docs/verification`에 있다.
