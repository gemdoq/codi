# Codi (코디)

터미널에서 동작하는 AI 코딩 에이전트입니다.

파일 읽기/쓰기, 코드 검색, 셸 실행, Git 조작 등 15개 이상의 도구를 자율적으로 사용하여 소프트웨어 개발 작업을 도와줍니다.

## 빠른 시작

### 1. 설치

```bash
# Node.js 20 이상 필요
node --version  # v20.0.0+

# 레포 클론 및 설치
git clone https://github.com/gemdoq/codi.git
cd codi
npm install
npm run build
npm link  # 전역 명령어로 등록 (선택)
```

### 2. API 키 설정

Codi는 기본적으로 **Google Gemini 2.5 Flash** (무료)를 사용합니다.

**API 키 발급:**
1. [Google AI Studio](https://aistudio.google.com/apikey) 접속
2. Google 계정으로 로그인
3. "Create API Key" 클릭
4. 키 복사

**설정 방법 (택 1):**

```bash
# 방법 A: 환경변수 (추천 - 터미널 세션 동안 유지)
export GEMINI_API_KEY=your-api-key-here

# 방법 B: 셸 설정에 영구 등록 (zsh)
echo 'export GEMINI_API_KEY=your-api-key-here' >> ~/.zshrc
source ~/.zshrc

# 방법 C: 셸 설정에 영구 등록 (bash)
echo 'export GEMINI_API_KEY=your-api-key-here' >> ~/.bashrc
source ~/.bashrc

# 방법 D: 설정 파일
mkdir -p ~/.codi
cat > ~/.codi/settings.json << 'EOF'
{
  "apiKeys": {
    "openai": "your-api-key-here"
  }
}
EOF
```

### 3. 실행

```bash
# 대화형 세션 시작
codi

# 또는 빌드된 파일 직접 실행
node dist/cli.js

# 또는 개발 모드 (빌드 없이)
npx tsx src/cli.ts
```

## 사용법

### 대화형 모드

```bash
codi
```

프롬프트(`codi >`)가 나타나면 자연어로 요청하면 됩니다:

```
codi > 이 프로젝트의 구조를 분석해줘
codi > src/main.ts에서 버그를 찾아 고쳐줘
codi > package.json에 새 스크립트를 추가해줘
```

### 단일 프롬프트 모드

```bash
codi -p "이 디렉토리의 파일 목록을 보여줘"
codi -p "README.md를 한국어로 번역해줘"
```

### CLI 옵션

| 옵션 | 설명 |
|------|------|
| `-p <프롬프트>` | 단일 프롬프트 실행 후 종료 |
| `-m, --model <모델>` | 모델 변경 (기본: `gemini-2.5-flash`) |
| `--provider <이름>` | 프로바이더 변경 (`openai`, `anthropic`, `ollama`) |
| `-c, --continue` | 마지막 세션 이어하기 |
| `-r, --resume <id>` | 특정 세션 복원 |
| `--plan` | 플랜 모드 (읽기 전용 분석) |
| `--yolo` | 모든 권한 확인 건너뛰기 |
| `-h, --help` | 도움말 |
| `-v, --version` | 버전 표시 |

### 입력 특수 기능

| 입력 | 기능 |
|------|------|
| `\` + Enter | 멀티라인 입력 |
| `!ls -la` | 직접 셸 명령어 실행 |
| `@src/main.ts` | 파일 내용을 메시지에 첨부 |
| `/help` | 슬래시 커맨드 목록 |

### 슬래시 커맨드

대화 중 `/`로 시작하는 커맨드를 사용할 수 있습니다:

| 커맨드 | 설명 |
|--------|------|
| `/help` | 사용 가능한 커맨드 목록 |
| `/quit` `/exit` | 종료 |
| `/clear` `/reset` `/new` | 대화 초기화 |
| `/model [이름]` | 모델 전환 |
| `/compact [초점]` | 대화 압축 (컨텍스트 절약) |
| `/cost` | 토큰 사용량 및 비용 표시 |
| `/config` | 현재 설정 표시 |
| `/permissions` | 권한 규칙 확인 |
| `/save [이름]` | 세션 저장 |
| `/resume` `/continue` | 세션 복원 |
| `/fork [이름]` | 대화 분기 |
| `/plan` | 플랜 모드 전환 (읽기 전용) |
| `/memory` | 자동 메모리 확인/편집 |
| `/init` | CODI.md 초기화 |
| `/export [파일]` | 대화 내보내기 |
| `/tasks` | 태스크 목록 |
| `/status` | 시스템 상태 |
| `/context` | 컨텍스트 윈도우 사용량 |
| `/rewind` | 이전 체크포인트로 되감기 |
| `/diff` | 변경사항 diff |
| `/mcp` | MCP 서버 상태 |

## 지원 모델

### Google Gemini (기본)

```bash
export GEMINI_API_KEY=your-key
codi                                  # gemini-2.5-flash (기본)
codi --model gemini-2.5-pro           # 더 강력한 모델
```

### Anthropic Claude

```bash
export ANTHROPIC_API_KEY=your-key
codi --provider anthropic                                   # claude-sonnet
codi --provider anthropic --model claude-opus-4-20250514    # claude-opus
```

### OpenAI

```bash
export OPENAI_API_KEY=your-key
codi --provider openai --model gpt-4o
codi --provider openai --model gpt-4.1
```

### Ollama (로컬, 무료)

```bash
# Ollama 설치 후 모델 다운로드
ollama pull llama3.1

codi --provider ollama --model llama3.1
```

## 내장 도구

Codi는 다음 도구를 자동으로 사용합니다. 사용자가 도구를 직접 호출할 필요 없이, 자연어로 요청하면 적절한 도구를 선택합니다.

| 도구 | 기능 | 예시 요청 |
|------|------|----------|
| `read_file` | 파일 읽기 (텍스트, PDF, 이미지, .ipynb) | "main.ts 파일을 읽어줘" |
| `write_file` | 파일 생성 | "hello.py 파일을 만들어줘" |
| `edit_file` | 파일 수정 (정확한 문자열 치환) | "함수 이름을 바꿔줘" |
| `multi_edit` | 한 파일 다중 수정 | "이 파일에서 여러 곳을 고쳐줘" |
| `glob` | 파일 패턴 검색 | "모든 .ts 파일을 찾아줘" |
| `grep` | 코드 내용 검색 (정규식) | "TODO가 있는 파일을 찾아줘" |
| `bash` | 셸 명령어 실행 | "테스트를 실행해줘" |
| `list_dir` | 디렉토리 목록 | "src 폴더 안에 뭐가 있어?" |
| `git` | Git 작업 | "변경사항을 커밋해줘" |
| `web_fetch` | 웹 페이지 가져오기 | "이 URL의 내용을 요약해줘" |
| `web_search` | 웹 검색 | "React 18 새 기능을 검색해줘" |
| `notebook_edit` | Jupyter 노트북 편집 | "노트북에 셀을 추가해줘" |
| `sub_agent` | 서브 에이전트 실행 | "이 코드베이스를 분석해줘" |
| `task_*` | 태스크 관리 | "할 일 목록을 만들어줘" |
| `ask_user` | 사용자에게 질문 | (자동으로 확인이 필요할 때 사용) |

## 권한 시스템

파일 수정, 셸 실행 등 위험한 작업은 실행 전에 확인을 요청합니다:

```
⚠ Permission Required: bash
  command: npm install express
Allow? [Yes / no / always for this tool]
```

- `Y` 또는 Enter: 이번만 허용
- `n`: 거부
- `a`: 이 도구는 앞으로 묻지 않고 항상 허용

### 권한 규칙 설정

`~/.codi/settings.json` 또는 `.codi/settings.json`에서 설정:

```json
{
  "permissions": {
    "allow": ["read_file", "glob", "grep", "list_dir"],
    "deny": ["bash(rm -rf *)"],
    "ask": ["write_file", "edit_file", "bash"]
  }
}
```

## 프로젝트 설정 (CODI.md)

프로젝트 루트에 `CODI.md` 파일을 만들면 Codi가 프로젝트 컨텍스트를 자동으로 인식합니다:

```bash
codi
codi > /init  # CODI.md 템플릿 생성
```

```markdown
# 프로젝트: My App

## 개요
React + TypeScript 웹 애플리케이션

## 개발 규칙
- 컴포넌트는 함수형으로 작성
- CSS는 Tailwind 사용
- 테스트는 Vitest 사용

## 빌드 명령어
- `npm run dev`: 개발 서버
- `npm run build`: 프로덕션 빌드
- `npm test`: 테스트 실행
```

## 커스텀 슬래시 커맨드

자주 쓰는 프롬프트를 커맨드로 저장할 수 있습니다:

```bash
# 프로젝트용 커맨드
mkdir -p .codi/commands
cat > .codi/commands/review.md << 'EOF'
현재 git diff를 확인하고 코드 리뷰를 해주세요.
보안 취약점, 성능 이슈, 코드 스타일 문제를 중심으로 검토해주세요.
EOF

# 개인 전역 커맨드
mkdir -p ~/.codi/commands
cat > ~/.codi/commands/fix.md << 'EOF'
{{file_path}} 파일의 lint 에러를 모두 수정해주세요.
EOF
```

사용: `/review`, `/fix src/main.ts`

## MCP (Model Context Protocol) 연동

외부 도구를 MCP 서버로 연결할 수 있습니다:

```bash
cat > .codi/mcp.json << 'EOF'
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "your-token" }
    }
  }
}
EOF
```

## 훅 시스템

도구 실행 전후에 자동으로 스크립트를 실행할 수 있습니다:

```json
// .codi/settings.json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "edit_file",
      "hooks": [{
        "type": "command",
        "command": "npx eslint --fix ${file_path}"
      }]
    }]
  }
}
```

## 설정 파일

설정은 다음 순서로 병합됩니다 (아래가 우선순위 높음):

1. `~/.codi/settings.json` - 사용자 전역
2. `.codi/settings.json` - 프로젝트 (Git에 포함)
3. `.codi/settings.local.json` - 로컬 전용 (`.gitignore`에 추가 권장)

```json
{
  "provider": "openai",
  "model": "gemini-2.5-flash",
  "maxTokens": 8192,
  "apiKeys": {
    "openai": "your-gemini-key"
  },
  "permissions": {
    "allow": ["read_file", "glob", "grep"],
    "deny": [],
    "ask": ["bash", "write_file"]
  }
}
```

## 키보드 단축키

| 단축키 | 기능 |
|--------|------|
| `Ctrl+C` | 현재 작업 취소 |
| `Ctrl+D` | 종료 |
| `Ctrl+L` | 화면 지우기 |
| `Tab` | 자동 완성 (커맨드, 파일 경로) |

## 요구사항

- **Node.js** 20.0.0 이상
- **ripgrep** (`rg`) - 코드 검색 성능 향상 (선택, 없으면 grep 사용)
- **Git** - Git 관련 기능 사용 시 필요

## 문제 해결

### "Could not resolve authentication method" 에러
API 키가 설정되지 않았습니다. [API 키 설정](#2-api-키-설정) 섹션을 참고하세요.

### "429 Rate Limit" 에러
API 요청 한도를 초과했습니다. 잠시 후 다시 시도하거나, [Google AI Studio](https://aistudio.google.com)에서 할당량을 확인하세요.

### ripgrep이 없다는 경고
`grep` 도구가 시스템 grep으로 대체됩니다. 성능 향상을 위해 설치를 권장합니다:
```bash
# macOS
brew install ripgrep

# Ubuntu/Debian
sudo apt install ripgrep
```

## 라이선스

MIT
