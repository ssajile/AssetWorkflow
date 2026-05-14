# AssetWorkflow

ComfyUI 감정 에셋 생성 워크플로우 — 9개 프리셋 통합 버전

## 산출물

| 파일 | 설명 |
|------|------|
| `combined_workflow.json` | ComfyUI에서 바로 로드하는 **통합 워크플로우** (9개 프리셋, 1클릭 토글) |
| `build_combined_workflow.js` | 통합 워크플로우를 재생성하는 빌더 스크립트 |

## 통합 워크플로우 재생성

```bash
node build_combined_workflow.js
```

- 9개 입력 JSON → `build/preset_*.json` (표준 프리셋) → `build/workflow_*.json` (개별 워크플로우) → `combined_workflow.json`
- 중간 산출물(`build/`)은 `.gitignore`에 등록되어 있어 커밋되지 않음

## ComfyUI에서 사용하는 법

### 1. 워크플로우 로드

ComfyUI 캔버스에 `combined_workflow.json`을 드래그&드롭하거나, **Load** 버튼으로 불러옵니다.

### 2. 프리셋 1클릭 ON/OFF

캔버스 상단(-1800 y 위치)에 10개의 **Fast Groups Bypasser** 노드가 있습니다.

| Bypasser 이름 | 역할 |
|--------------|------|
| `80종공유용2` | 해당 프리셋 전체 ON/OFF |
| `깍두기` | 해당 프리셋 전체 ON/OFF |
| `도중` | 해당 프리셋 전체 ON/OFF |
| `마지막` | 해당 프리셋 전체 ON/OFF |
| `묶음` | 해당 프리셋 전체 ON/OFF |
| `이중` | 해당 프리셋 전체 ON/OFF |
| `직전` | 해당 프리셋 전체 ON/OFF |
| `카메라` | 해당 프리셋 전체 ON/OFF |
| `혼자` | 해당 프리셋 전체 ON/OFF |
| `전체 ON/OFF` | **모든 프리셋 + 추가 그룹** 동시 ON/OFF (마스터 토글) |
| `1. Text2Image` | 독립 Text2Image 파이프라인 ON/OFF |
| `2. AssetBase` | IPAdapter 기반 정확도 보정 그룹 ON/OFF |
| `ControlCenter` | 공통 체크포인트 / VAE / 샘플러 / LoRA 프리미티브 그룹 ON/OFF |

Bypasser 노드에서 **각 감정 이름 왼쪽의 토글 버튼**을 클릭하면 해당 감정 서브그래프 및 저장 노드가 mute/bypass 됩니다.  
프리셋 이름 버튼 하나를 클릭하면 그 프리셋 안의 **모든 감정이 한 번에** 켜지거나 꺼집니다.

### 3. 프리셋 구조

각 프리셋은 ComfyUI 캔버스에 **수직으로 배치**됩니다 (y 간격 7 000px):

```
y = 0       → 80종공유용2  (82개 감정, 17열×5행)
y = 7 000   → 깍두기        (55개 감정, 11열×5행)
y = 14 000  → 도중          (48개 감정, 10열×5행)
y = 21 000  → 마지막        (17개 감정,  4열×5행)
y = 28 000  → 묶음          ( 9개 감정,  2열×5행)
y = 35 000  → 이중          (25개 감정,  5열×5행)
y = 42 000  → 직전          (17개 감정,  4열×5행)
y = 49 000  → 카메라        (16개 감정,  4열×5행)
y = 56 000  → 혼자          (52개 감정, 11열×5행)
```

### 4. 추가 그룹 (`딸각 에셋 4 (2).json` 에서 가져옴)

캔버스 우측(x ≈ +8 000 영역, y ≈ 1 600 ~ 4 400)에 3개의 그룹이 함께 들어 있습니다:

| 그룹 | 노드 수 | 용도 |
|------|---------|------|
| `1. Text2Image` | 10 | 독립 Text2Image 파이프라인 (Efficient Loader → KSampler → SaveImage, 자체 프롬프트) |
| `2. AssetBase` | 22 | IPAdapter Tiled Batch 기반 정확도 보정 (8개 감정 LoadImage → ImageBatch → IPAdapter MODEL + 공통 Text Prompt) |
| `ControlCenter` | 8 | 공통 Checkpoint / VAE / Sampler / Scheduler / Steps / CFG / LoRA / SDXL Resolutions 프리미티브 (1·2 그룹이 참조) |

내부 wiring과 그룹 간 연결(ControlCenter → Text2Image / AssetBase)은 그대로 보존되어 import 됩니다.  
**감정 서브그래프와의 자동 연결은 포함되지 않습니다** — 감정 워크플로우는 `base_ctx` (RGTHREE_CONTEXT) 묶음 구조라 외부 직접 연결을 받지 않습니다. AssetBase 출력을 프리셋에서 쓰려면 ComfyUI에서 수동으로 wiring 하세요.

## 프리셋 요약

| 프리셋 | 감정 수 | 총 case 수 | 평균 case |
|--------|---------|------------|-----------|
| 80종공유용2 | 82 | 287 | 3.5 |
| 깍두기 | 55 | 55 | 1.0 |
| 도중 | 48 | 48 | 1.0 |
| 마지막 | 17 | 17 | 1.0 |
| 묶음 | 9 | 9 | 1.0 |
| 이중 | 25 | 25 | 1.0 |
| 직전 | 17 | 17 | 1.0 |
| 카메라 | 16 | 16 | 1.0 |
| 혼자 | 52 | 52 | 1.0 |
| **합계** | **321** | **523** | **1.6** |

## 파일 구조

```
AssetWorkflow/
├── combined_workflow.json      # ← ComfyUI에 로드할 통합 워크플로우
├── build_combined_workflow.js  # ← 빌더 스크립트
├── generate_workflow.js        # 개별 워크플로우 생성기 (변경 금지)
├── workflow_prototype.json     # 베이스 템플릿 (변경 금지)
├── nai-to-sd.js               # NAI→SD 변환기 (변경 금지)
├── SKILL.md                    # 스킬 규칙 (변경 금지)
├── 80종공유용2.json             # 입력 프리셋 (변경 금지)
├── 깍두기.json                  # 입력 프리셋 (변경 금지)
├── 도중.json                    # 입력 프리셋 (변경 금지)
├── 마지막.json                  # 입력 프리셋 (변경 금지)
├── 묶음.json                    # 입력 프리셋 (변경 금지)
├── 이중.json                    # 입력 프리셋 (변경 금지)
├── 직전.json                    # 입력 프리셋 (변경 금지)
├── 카메라.json                  # 입력 프리셋 (변경 금지)
├── 혼자.json                    # 입력 프리셋 (변경 금지)
└── 딸각 에셋 4 (2).json         # 추가 그룹(Text2Image / AssetBase / ControlCenter) 소스 (변경 금지)
```