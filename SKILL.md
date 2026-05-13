---
name: emotion-workflow-builder
description: End-to-end pipeline that takes any NAI/SD emotion preset source (HTML viewer, JSON, scene-slot dump, flat array, dict) and produces both a standard preset JSON `{version, name, emotions:[{name, cases:[]}]}` and a ready-to-load ComfyUI 감정 에셋 생성 워크플로우 JSON. Use when the user provides a preset source and wants the full 감정 에셋 생성 워크플로우, or when they only want the preset JSON. The skill is source-driven — it preserves whatever emotions and variants the source contains.
---

# Emotion Workflow Builder

이 스킬은 다양한 형태의 NAI/SD 감정 프리셋 소스를 받아 두 산출물을 만든다:

1. **표준 프리셋 JSON** (`{version, name, emotions:[{name, cases:[]}]}`)
2. **ComfyUI 감정 에셋 생성 워크플로우 JSON** (`lib/workflow_prototype.json` 기반)

감정 개수와 케이스 개수는 소스마다 다르므로, 스킬은 **소스에 들어있는 그대로** 변환하는 것이 기본 동작이다.

## 표준 프리셋 포맷

```json
{
  "version": 1,
  "name": "<프리셋 이름>",
  "emotions": [
    { "name": "angry", "cases": ["sd프롬프트1", "sd프롬프트2", ...] },
    { "name": "annoyed", "cases": ["sd프롬프트1"] }
  ]
}
```

**불변 규칙:**
- `version`: 정수 (현재 `1`)
- `name`: 프리셋 식별 이름 (소스 메타에서 추출 또는 사용자에게 문의)
- `emotions[]`: 길이 가변 (소스가 결정). 빈 배열은 오류
- 각 항목의 `name`은 비어있지 않은 문자열, `cases`는 길이 1 이상의 문자열 배열
- 각 `cases[i]`는 **SD 문법** 단일 프롬프트. NAI 문법(`{}`, `[[]]`, `N::text::`) 잔존 금지

## 발동 조건

다음 중 하나에 해당하면 이 스킬 사용:
- 사용자가 새로운 NAI/SD 프리셋 소스(파일/HTML/JSON/dict 등)를 주며 변환 또는 워크플로우 생성 요청
- 기존 프리셋 JSON을 다른 소스로 재생성
- "프리셋 가져와", "워크플로우 만들어", "포맷 맞춰", "감정 에셋 만들어" 류의 표현 + 소스 자료 제시

## 자산

스킬 디렉토리:

- **`lib/nai-to-sd.js`** — 검증된 NAI → SD 변환 함수 (`convertNAItoSD`). 소스가 NAI 문법이면 **반드시 이 모듈을 재사용**. 변환 로직 재구현 금지.
- **`lib/generate_workflow.js`** — 프리셋 JSON을 받아 ComfyUI 감정 에셋 생성 워크플로우 JSON을 생성하는 CLI. **변경 금지**. CLI: `node lib/generate_workflow.js <preset.json> [out.json]`.
- **`lib/workflow_prototype.json`** — generator의 베이스 (캐릭터 설정 + 1감정 서브그래프 템플릿 + Bypasser 1개). **변경 금지**.
- **`examples/emotions_sample.json`** — 형식 학습용 데모 프리셋 (4감정).

## 변환 절차

### 1. 소스 발견 (Discovery) — 필수 첫 단계

소스를 로드한 뒤 **반드시 다음을 사용자에게 보고**한 다음에 변환 작업을 진행:

- 발견된 감정 개수
- 감정 이름 목록 (10개 초과 시 일부 + "외 N개")
- 감정당 변형(case) 개수 분포 (평균/최소/최대)
- 인식한 소스 패턴 (NAI scenes, flat array, dict 등)
- 추정한 출력 `name` 필드 (불확실하면 사용자에게 확인)

이 단계 없이 곧바로 변환·출력하지 않는다. 사용자가 "이 소스 그대로"가 아닌 다른 처리(필터, 정렬, 이름 매핑 등)를 원할 수 있다.

### 2. 처리 방식 결정

기본은 **소스 보존**: 발견된 모든 감정·모든 변형을 그대로 변환.

다음 경우에만 다르게 처리:
- 사용자가 **특정 감정만 골라달라거나 순서를 지정**하면 그에 맞춰 필터·정렬
- 소스에 **알 수 없는 감정명**(예: 한국어, 약어)이 섞여있음 → 사용자에게 매핑 또는 통과 여부 확인
- 소스 일부가 **이미 SD 포맷**임이 명확 → 해당 항목은 `convertNAItoSD` 호출하지 않고 그대로 통과

### 3. 소스 패턴별 추출

아래 표는 **자주 마주치는 패턴의 예시일 뿐**이며, 실제 소스는 형태가 얼마든지 다를 수 있다 (중첩 구조, 사용자 정의 키, 메타데이터 혼재 등). 표에 없는 형태라면 **소스 파일을 직접 분석해 구조를 파악한 뒤 상황에 맞춰 추출 로직을 구성**해야 한다. 표는 출발점일 뿐 강제 분류가 아니다.

| 패턴 | 예시 구조 | 추출 방법 |
|---|---|---|
| **NAI viewer HTML** | `let DATA = {scenes: {...}};` 인라인 | regex 추출 → `eval` → `scenes[name].slots[0][i].prompt` 순회 |
| **NAI scenes JSON** | `{scenes: {emotion: {slots: [[{prompt}]]}}}` | `JSON.parse` → `slots[0][i].prompt` |
| **Multi-slot NAI** | `slots[0..N]` 다수 | 보통 `slots[0]`만. 사용자가 합치라고 하지 않는 한 보조 슬롯 무시 |
| **flat array (1 case)** | `[{name, prompt}]` 또는 `[{name, sdPrompt}]` | name별 cases 길이 1 |
| **flat array (multi case)** | `[{name, prompts:[...]}]` | prompts 그대로 cases로 |
| **dict (string value)** | `{emotion: "prompt"}` | cases 길이 1 |
| **dict (array value)** | `{emotion: ["p1","p2"]}` | array 그대로 cases |

### 4. 변환 + 워크플로우 빌드 스크립트 골격

```js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// skill 위치를 안다면 절대 경로로. 아래는 패키지 안에서 실행하는 경우의 예.
const SKILL_LIB = '<absolute path to .claude/skills/emotion-workflow-builder/lib>';
const { convertNAItoSD } = require(path.join(SKILL_LIB, 'nai-to-sd'));

// 1) 소스 로드 (소스 형태별 분기)
const raw = /* ... */;

// 2) name → variants[] (NAI 문자열 배열) 빌드
const byName = {};
// ... 패턴별 채움 ...

// 3) 사용자 지정 순서/필터 또는 발견 순서
const order = userOrder ? userOrder : Object.keys(byName);

// 4) 변환 + preset 빌드
const preset = { version: 1, name: '<프리셋이름>', emotions: [] };
const issues = [];
for (const name of order) {
  const variants = byName[name];
  if (!variants || !variants.length) { issues.push(`${name}: 소스에 없음`); continue; }
  const cases = variants.map(convertNAItoSD).filter(s => s && s.length > 0);
  if (!cases.length) { issues.push(`${name}: 변환 후 빈 프롬프트만 남음`); continue; }
  preset.emotions.push({ name, cases });
}

// 5) preset JSON 디스크 저장
const presetPath = path.resolve(process.cwd(), `${preset.name}_preset.json`);
fs.writeFileSync(presetPath, JSON.stringify(preset, null, 2), 'utf8');

// 6) generator 호출 → workflow JSON
const workflowPath = path.resolve(process.cwd(), `${preset.name}_workflow.json`);
execFileSync('node',
  [path.join(SKILL_LIB, 'generate_workflow.js'), presetPath, workflowPath],
  { stdio: 'inherit' });
```

### 5. 검증

스크립트 실행 후 다음 항목 확인:

- [ ] **개수 일치**: preset `emotions.length`가 의도한 처리 결과와 일치
- [ ] **NAI 문법 잔존 없음**: preset에서 `\{|\}\}|::` 매치 0건. SD 가중치 `(text:1.21)` 외 잔존물 없음
- [ ] **SD 가중치 범위**: 모든 가중치 `0.1~1.5` 또는 `-1`
- [ ] **샘플 검사**: 임의 1~2개 감정의 `cases` 길이가 원본 변형 수와 일치
- [ ] **순서**: 명시 순서가 있으면 그 순서, 없으면 소스 발견 순서
- [ ] **워크플로우 산출물**: workflow.json 생성됨, generator 콘솔 출력에 그리드/Bypasser 정보 정상 표시

### 6. 보고

사용자에게 결과 보고 시 포함:
- 두 산출물 경로 (preset, workflow)
- 인식한 소스 패턴
- 처리된 감정 수 (소스 발견 / 출력 / 누락 또는 제외)
- 총 case 수, 감정당 평균
- 그리드 크기 (열 × 행)
- 이슈 목록 (있다면)

## 엣지 케이스

- **여러 slot이 있는 NAI 소스**: 기본 `slots[0]`만. 사용자 명시 시 합치기
- **빈 prompt 또는 HTML만 있는 variant**: `convertNAItoSD()`가 빈 문자열 반환 → `.filter()`로 자동 제거
- **이미 SD 포맷인 소스**: `convertNAItoSD`는 idempotent 보장이 약함. 명확히 SD인 항목은 변환 함수를 **호출하지 말고** 그대로 통과
- **감정 이름 충돌**: 다른 대소문자/공백/언더스코어 변형이 있다면 사용자에게 정규화 방침 확인
- **소스 메타에 프리셋 이름이 없음**: `name` 필드는 사용자에게 문의하거나 파일명에서 추론
- **사용자가 preset만 원하는 경우**: 6단계에서 generator 호출을 건너뛰고 preset 경로만 보고

## 변경하지 않을 것

- `lib/nai-to-sd.js`, `lib/generate_workflow.js`, `lib/workflow_prototype.json` — 검증된 자산
- 사용자 측 데이터 파일 — 명시 요청 없이는 손대지 않음
- 자매 커스텀 노드(`cream-saver/`의 `nodes.py`, `Sampler_workflow.json`) 등 skill 외부 영역
