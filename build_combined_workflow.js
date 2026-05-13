#!/usr/bin/env node
// build_combined_workflow.js
// ──────────────────────────────────────────────────────────────────────────────
// Reads 9 NAI scene JSON files from the repository root, converts them to
// standard preset format, generates individual ComfyUI workflows, then merges
// all 9 into one combined_workflow.json with:
//   • Per-preset wrapper group (ComfyUI group with the preset's name)
//   • Per-preset Fast Groups Bypasser node → 1-click toggle for every preset
//   • 1 master Bypasser that toggles all 9 presets simultaneously
//
// Usage: node build_combined_workflow.js
// Output: combined_workflow.json (repo root)
// Intermediate files: build/preset_*.json, build/workflow_*.json
// ──────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT      = __dirname;
const BUILD_DIR = path.join(ROOT, 'build');

if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

const { convertNAItoSD } = require(path.join(ROOT, 'nai-to-sd'));

// Post-conversion cleanup for edge cases where convertNAItoSD leaves residual
// NAI syntax due to malformed source (e.g., unbalanced braces, colon inside braces).
// This does NOT reimplement conversion logic — it only strips characters that
// convertNAItoSD could not resolve, producing valid SD output.
function convertAndClean(prompt) {
  let r = convertNAItoSD(prompt);
  // Collapse remaining '::' (e.g., from '{{{d:}}}' → '(d::1.16)') → '(d:1.16)'
  r = r.replace(/::/g, ':');
  // Remove any remaining '{' or '}' (from unbalanced NAI braces)
  r = r.replace(/[{}]/g, '');
  // Normalize whitespace and trailing/leading commas
  r = r.replace(/\s*,\s*/g, ', ').replace(/,\s*,/g, ',')
       .replace(/^\s*,\s*/, '').replace(/\s*,\s*$/, '');
  r = r.replace(/\s+/g, ' ').trim();
  return r;
}

// ── Input file names (order preserved) ───────────────────────────────────────
const INPUT_NAMES = [
  '80종공유용2', '깍두기', '도중', '마지막',
  '묶음',        '이중',   '직전', '카메라',  '혼자',
];

// ── Layout constants (must match generate_workflow.js) ────────────────────────
const ROWS_PER_COL        = 5;
const COL_W               = 650;
const ROW_H               = 1000;
const BASE_X              = -3830;
const BASE_Y              = 310;
const GROUP_W             = 600;
const GROUP_H             = 930;
const GROUP_MARGIN_TOP    = 60;
const INSTANCE_H          = 270;
const INSTANCE_TO_SAVE_GAP = 30;
const SAVE_H              = 570;
const BYPASSER_BASE_X     = -2230;   // used for standalone workflow Bypassers

// ── Merge layout constants ───────────────────────────────────────────────────
// Vertical stride between presets (must be > max emotion grid height per preset)
// Largest preset: 82 emotions → 5 rows × ROW_H = 5 000, plus GROUP_H = 930 → ~5 240
const PRESET_Y_STRIDE     = 7000;
const WRAPPER_PADDING_X   = 100;   // extra space left/right of emotion columns
const WRAPPER_TOP_Y       = 290;   // just below all base nodes (highest base-node Y = 240)

// All Bypassers (preset + master) are placed in a row well above the canvas
const ALL_BYPASSER_Y      = -1800;
const ALL_BYPASSER_X_BASE = BASE_X;
const BYPASSER_STRIDE_X   = 270;
const BYPASSER_W          = 250;
const BYPASSER_H          = 130;

// Per-preset ID offset so emotion-node IDs never clash between presets
const NODE_OFFSET_PER_PRESET = 10000;
const LINK_OFFSET_PER_PRESET = 10000;

// ── Extra groups imported from `딸각 에셋 4 (2).json` ────────────────────────
// 1. Text2Image — standalone img-gen pipeline (10 nodes)
// 2. AssetBase  — IPAdapter image-batch accuracy correction (22 nodes)
// 3. ControlCenter — shared LoRA / checkpoint / sampler primitive controls
//    (8 nodes; 2 Bypassers inside are excluded — we use our own toggle system)
const EXTRA_SOURCE_FILE        = '딸각 에셋 4 (2).json';
const EXTRA_GROUP_TITLES       = ['1. Text2Image', '2. AssetBase', 'ControlCenter'];
const EXTRA_NODE_ID_OFFSET     = 200000;   // safely above preset offsets (≤90 000)
const EXTRA_LINK_ID_OFFSET     = 200000;
const EXTRA_X_OFFSET           = 11000;    // shift right of widest preset (~7220)
const EXTRA_Y_OFFSET           = 0;
// Exclude these node types from ControlCenter — we have our own bypasser system
const EXTRA_EXCLUDED_NODE_TYPES = new Set(['Fast Groups Bypasser (rgthree)']);

// Base node IDs (캐릭터 설정 group) — kept as-is in the merged workflow
const BASE_NODE_IDS = new Set([2, 15, 16, 17, 21, 24, 39, 527, 532]);
const BASE_CTX_FROM_NODE_ID = 532;
const BASE_CTX_FROM_SLOT    = 0;

// Regex escape helper
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1 — Extract standard presets from NAI scene JSONs
// ────────────────────────────────────────────────────────────────────────────
console.log('\n═══ PHASE 1: Extracting presets from NAI scene files ═══\n');

const presetMeta = []; // { name, numEmotions, totalCases, presetPath }

for (const name of INPUT_NAMES) {
  const srcPath = path.join(ROOT, `${name}.json`);
  const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'));

  if (!src.scenes || typeof src.scenes !== 'object') {
    console.error(`✗ ${name}: 'scenes' 필드 없음 — 건너뜁니다`);
    continue;
  }

  const emotions = [];
  for (const sceneName of Object.keys(src.scenes)) {
    const scene   = src.scenes[sceneName];
    const slots0  = Array.isArray(scene.slots?.[0]) ? scene.slots[0] : [];
    if (!slots0.length) continue;

    const cases = slots0
      .map(slot => convertAndClean(slot.prompt || ''))
      .filter(p => p && p.trim().length > 0);

    if (!cases.length) continue;
    emotions.push({ name: sceneName, cases });
  }

  if (!emotions.length) {
    console.error(`✗ ${name}: 변환 후 감정이 없음 — 건너뜁니다`);
    continue;
  }

  const preset     = { version: 1, name, emotions };
  const presetPath = path.join(BUILD_DIR, `preset_${name}.json`);
  fs.writeFileSync(presetPath, JSON.stringify(preset, null, 2), 'utf8');

  const totalCases = emotions.reduce((s, e) => s + e.cases.length, 0);
  const avgCases   = (totalCases / emotions.length).toFixed(1);
  console.log(
    `✓ ${name}: ${emotions.length}개 감정, ` +
    `총 ${totalCases}개 case (평균 ${avgCases}개/감정)`
  );
  presetMeta.push({ name, numEmotions: emotions.length, totalCases, avgCases, presetPath });
}

if (presetMeta.length !== INPUT_NAMES.length) {
  console.error('\n일부 프리셋 변환 실패. 중단합니다.');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Generate individual ComfyUI workflows via generate_workflow.js
// ────────────────────────────────────────────────────────────────────────────
console.log('\n═══ PHASE 2: Generating individual workflows ═══\n');

const individualWFs = []; // { name, wf }

for (const { name, presetPath } of presetMeta) {
  const wfPath = path.join(BUILD_DIR, `workflow_${name}.json`);
  console.log(`\n▶ ${name}`);
  execFileSync('node', [path.join(ROOT, 'generate_workflow.js'), presetPath, wfPath], {
    stdio: 'inherit',
    cwd:   ROOT,
  });
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  individualWFs.push({ name, wf });
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Merge all workflows into one combined_workflow.json
// ────────────────────────────────────────────────────────────────────────────
console.log('\n═══ PHASE 3: Merging into combined_workflow.json ═══\n');

// Start from prototype to capture all base structure
const proto    = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'workflow_prototype.json'), 'utf8')
);
const combined = JSON.parse(JSON.stringify(proto));

// Keep only base nodes, base groups, base links
const BASE_GROUP_TITLES = new Set(['캐릭터 설정']);
combined.nodes  = combined.nodes.filter(n => BASE_NODE_IDS.has(n.id));
combined.links  = combined.links.filter(
  l => BASE_NODE_IDS.has(l[1]) && BASE_NODE_IDS.has(l[3])
);
combined.groups = combined.groups.filter(g => BASE_GROUP_TITLES.has(g.title));
combined.definitions = { subgraphs: [] };

// Clear base_ctx source output links — will be rebuilt from all presets
const baseCtxNode = combined.nodes.find(n => n.id === BASE_CTX_FROM_NODE_ID);
if (baseCtxNode?.outputs?.[BASE_CTX_FROM_SLOT]) {
  baseCtxNode.outputs[BASE_CTX_FROM_SLOT].links = [];
}

const allCtxLinkIds = []; // accumulate across all presets
let nextGroupId =
  Math.max(0, ...combined.groups.map(g => g.id || 0)) + 1;

// ── Per-preset merge ─────────────────────────────────────────────────────────
individualWFs.forEach(({ name, wf }, presetIdx) => {
  const nodeOffset = (presetIdx + 1) * NODE_OFFSET_PER_PRESET;
  const linkOffset = (presetIdx + 1) * LINK_OFFSET_PER_PRESET;
  const yOffset    = presetIdx * PRESET_Y_STRIDE;

  // Number of emotion columns & rows for this preset
  const numEmotions = presetMeta[presetIdx].numEmotions;
  const numCols     = Math.ceil(numEmotions / ROWS_PER_COL);
  const numRows     = Math.min(numEmotions, ROWS_PER_COL);

  // 3-a) Append subgraph definitions (they use UUID IDs — no conflict)
  combined.definitions.subgraphs.push(...(wf.definitions?.subgraphs || []));

  // 3-b) Add emotion nodes (skip base nodes, skip per-column Bypassers)
  for (const node of wf.nodes) {
    if (BASE_NODE_IDS.has(node.id)) continue;
    if (node.type === 'Fast Groups Bypasser (rgthree)') continue; // replaced below

    const n  = JSON.parse(JSON.stringify(node));
    n.id     = node.id + nodeOffset;
    n.pos    = [node.pos[0], node.pos[1] + yOffset];

    // Remap link references in inputs
    if (n.inputs) {
      for (const inp of n.inputs) {
        if (inp.link != null) inp.link = inp.link + linkOffset;
      }
    }
    // Remap link references in outputs
    if (n.outputs) {
      for (const out of n.outputs) {
        if (Array.isArray(out.links)) {
          out.links = out.links.map(lid => lid + linkOffset);
        }
      }
    }
    combined.nodes.push(n);
  }

  // 3-c) Add emotion links with remapped IDs
  const presetCtxLinkIds = [];
  for (const link of wf.links) {
    const [lid, fromId, fromSlot, toId, toSlot, type] = link;

    // Skip base-to-base links (already in combined)
    if (BASE_NODE_IDS.has(fromId) && BASE_NODE_IDS.has(toId)) continue;

    const newLinkId = lid  + linkOffset;
    const newFromId = BASE_NODE_IDS.has(fromId) ? fromId : fromId + nodeOffset;
    const newToId   = BASE_NODE_IDS.has(toId)   ? toId   : toId   + nodeOffset;

    combined.links.push([newLinkId, newFromId, fromSlot, newToId, toSlot, type]);

    // Track base_ctx outgoing links so we can update node 532's output list
    if (fromId === BASE_CTX_FROM_NODE_ID && fromSlot === BASE_CTX_FROM_SLOT) {
      presetCtxLinkIds.push(newLinkId);
    }
  }
  allCtxLinkIds.push(...presetCtxLinkIds);

  // 3-d) Add per-emotion groups (title stays as emotion name; color inherited)
  for (const group of wf.groups) {
    if (BASE_GROUP_TITLES.has(group.title)) continue;
    const g  = JSON.parse(JSON.stringify(group));
    g.id     = nextGroupId++;
    g.bounding = [
      group.bounding[0],
      group.bounding[1] + yOffset,
      group.bounding[2],
      group.bounding[3],
    ];
    combined.groups.push(g);
  }

  // 3-e) Add PRESET-level wrapper group (encompasses all emotion nodes)
  //   X: [BASE_X - WRAPPER_PADDING_X,  BASE_X - WRAPPER_PADDING_X + numCols * COL_W + GROUP_W + WRAPPER_PADDING_X * 2]
  //   Y: [WRAPPER_TOP_Y + yOffset,      WRAPPER_TOP_Y + yOffset + numRows * ROW_H]
  const wrapX = BASE_X - WRAPPER_PADDING_X;
  const wrapY = WRAPPER_TOP_Y + yOffset;
  const wrapW = numCols * COL_W + GROUP_W + WRAPPER_PADDING_X * 2;
  const wrapH = numRows * ROW_H;

  combined.groups.push({
    id:        nextGroupId++,
    title:     name,
    bounding:  [wrapX, wrapY, wrapW, wrapH],
    color:     '#3d6b4a',
    font_size: 28,
    flags:     { pinned: true },
  });

  console.log(
    `✓ ${name}: ${numEmotions}개 감정, ${numCols}열×${numRows}행, ` +
    `node offset +${nodeOffset}, y offset +${yOffset}`
  );
});

// ── Rebuild base_ctx source output ──────────────────────────────────────────
if (baseCtxNode?.outputs?.[BASE_CTX_FROM_SLOT]) {
  baseCtxNode.outputs[BASE_CTX_FROM_SLOT].links = allCtxLinkIds.slice();
}

// ── 3-e2) Import extra groups (Text2Image / AssetBase / ControlCenter) ──────
// Source: `딸각 에셋 4 (2).json` — pulls each group's nodes (with internal +
// inter-group links) into the combined workflow so the same ComfyUI canvas
// also contains a standalone Text2Image pipeline and the AssetBase IPAdapter
// accuracy-correction subgraph. They are not auto-wired to the existing
// per-emotion subgraphs (which encapsulate model/clip/vae via base_ctx); the
// user wires AssetBase into presets manually inside ComfyUI as needed.
console.log('\n═══ PHASE 3.5: Importing extra groups from source file ═══\n');

const extraSrcPath = path.join(ROOT, EXTRA_SOURCE_FILE);
if (fs.existsSync(extraSrcPath)) {
  const extraSrc = JSON.parse(fs.readFileSync(extraSrcPath, 'utf8'));

  // Group bounding-box hit test (same convention as generate_workflow.js)
  const inG = (node, g) => {
    const [gx, gy, gw, gh] = g.bounding;
    const [nx, ny] = node.pos;
    return nx >= gx && nx <= gx + gw && ny >= gy && ny <= gy + gh;
  };

  // 1) Resolve which extra groups exist in the source
  const extraGroups = EXTRA_GROUP_TITLES
    .map(t => extraSrc.groups.find(g => g.title === t))
    .filter(Boolean);
  if (extraGroups.length !== EXTRA_GROUP_TITLES.length) {
    const missing = EXTRA_GROUP_TITLES.filter(
      t => !extraSrc.groups.some(g => g.title === t)
    );
    console.warn(`⚠ 누락된 그룹: ${missing.join(', ')}`);
  }

  // 2) Collect the node-id set we will import (across all extra groups)
  const importNodeIdSet = new Set();
  for (const g of extraGroups) {
    for (const n of extraSrc.nodes) {
      if (!inG(n, g)) continue;
      if (EXTRA_EXCLUDED_NODE_TYPES.has(n.type)) continue;
      importNodeIdSet.add(n.id);
    }
  }

  // 3) Clone nodes with offset id + shifted position
  let importedNodes = 0;
  for (const id of importNodeIdSet) {
    const src = extraSrc.nodes.find(n => n.id === id);
    if (!src) continue;
    const n = JSON.parse(JSON.stringify(src));
    n.id  = src.id + EXTRA_NODE_ID_OFFSET;
    n.pos = [src.pos[0] + EXTRA_X_OFFSET, src.pos[1] + EXTRA_Y_OFFSET];

    // Remap link IDs in inputs/outputs to the offset namespace
    if (Array.isArray(n.inputs)) {
      for (const inp of n.inputs) {
        if (inp.link != null) inp.link = inp.link + EXTRA_LINK_ID_OFFSET;
      }
    }
    if (Array.isArray(n.outputs)) {
      for (const out of n.outputs) {
        if (Array.isArray(out.links)) {
          out.links = out.links.map(lid => lid + EXTRA_LINK_ID_OFFSET);
        }
      }
    }
    combined.nodes.push(n);
    importedNodes++;
  }

  // 4) Clone links whose BOTH endpoints are inside the imported set
  //    (cross-group links between Text2Image/AssetBase/ControlCenter are kept;
  //     links to/from any other source node are dropped)
  let importedLinks = 0, droppedLinks = 0;
  for (const l of extraSrc.links) {
    const [lid, from, fs, to, ts, type] = l;
    if (importNodeIdSet.has(from) && importNodeIdSet.has(to)) {
      combined.links.push([
        lid  + EXTRA_LINK_ID_OFFSET,
        from + EXTRA_NODE_ID_OFFSET,
        fs,
        to   + EXTRA_NODE_ID_OFFSET,
        ts,
        type,
      ]);
      importedLinks++;
    } else if (importNodeIdSet.has(from) || importNodeIdSet.has(to)) {
      droppedLinks++;
    }
  }

  // After remapping link ids, some kept-node output.links arrays still reference
  // link ids that we DROPPED (because the other endpoint was outside our import
  // set). Filter those out so the workflow validates cleanly in ComfyUI.
  const importedLinkIdSet = new Set(
    combined.links
      .map(l => l[0])
      .filter(lid => lid > EXTRA_LINK_ID_OFFSET)
  );
  for (const n of combined.nodes) {
    if (n.id < EXTRA_NODE_ID_OFFSET) continue;
    if (Array.isArray(n.outputs)) {
      for (const out of n.outputs) {
        if (Array.isArray(out.links)) {
          out.links = out.links.filter(lid => importedLinkIdSet.has(lid));
          if (out.links.length === 0) out.links = null;
        }
      }
    }
    if (Array.isArray(n.inputs)) {
      for (const inp of n.inputs) {
        if (inp.link != null && !importedLinkIdSet.has(inp.link)) {
          inp.link = null;
        }
      }
    }
  }

  // 5) Clone the group rectangles themselves
  for (const g of extraGroups) {
    const gg = JSON.parse(JSON.stringify(g));
    gg.id = nextGroupId++;
    gg.bounding = [
      g.bounding[0] + EXTRA_X_OFFSET,
      g.bounding[1] + EXTRA_Y_OFFSET,
      g.bounding[2],
      g.bounding[3],
    ];
    if (!gg.flags) gg.flags = {};
    gg.flags.pinned = true;
    combined.groups.push(gg);
  }

  console.log(
    `✓ 가져온 그룹 ${extraGroups.length}개: ${extraGroups.map(g => g.title).join(', ')}\n` +
    `  노드 ${importedNodes}개, 링크 ${importedLinks}개 (외부 연결 ${droppedLinks}건은 누락)`
  );
} else {
  console.warn(`⚠ ${EXTRA_SOURCE_FILE} 없음 — 추가 그룹 가져오기 건너뜀`);
}

// ── 3-f) Allocate Bypasser nodes (all IDs above max emotion node) ──────────
let nextNodeId = Math.max(0, ...combined.nodes.map(n => n.id)) + 1;

// Build the bypasser template from prototype
const bypasserTpl = proto.nodes.find(
  n => n.type === 'Fast Groups Bypasser (rgthree)'
);

function makeBypasser(id, x, y, title, matchTitle, order) {
  return {
    id,
    type:   'Fast Groups Bypasser (rgthree)',
    pos:    [x, y],
    size:   [BYPASSER_W, BYPASSER_H],
    flags:  { pinned: true },
    order,
    mode:   0,
    inputs: [],
    outputs: [{ name: 'OPT_CONNECTION', type: '*', links: null }],
    title,
    properties: {
      matchColors:         '',
      matchTitle,
      showNav:             true,
      showAllGraphs:       false,
      sort:                'position',
      customSortAlphabet:  '',
      toggleRestriction:   'default',
      ue_properties: (bypasserTpl?.properties?.ue_properties) || {
        widget_ue_connectable:   {},
        input_ue_unconnectable:  {},
        version: '7.5.2',
      },
    },
  };
}

const bypasserNodeIds = [];

// 9 preset-level Bypassers
individualWFs.forEach(({ name }, idx) => {
  const id      = nextNodeId++;
  const x       = ALL_BYPASSER_X_BASE + idx * BYPASSER_STRIDE_X;
  const y       = ALL_BYPASSER_Y;
  const mtitle  = '^' + escapeRe(name) + '$';
  combined.nodes.push(makeBypasser(id, x, y, name, mtitle, 10 + idx));
  bypasserNodeIds.push(id);
});

// Master Bypasser — matches all 9 preset wrapper group titles + 3 extra groups
const masterMatchTitle =
  '^(' +
  INPUT_NAMES.concat(EXTRA_GROUP_TITLES).map(escapeRe).join('|') +
  ')$';
const masterId = nextNodeId++;
const masterX  = ALL_BYPASSER_X_BASE + INPUT_NAMES.length * BYPASSER_STRIDE_X;
combined.nodes.push(
  makeBypasser(masterId, masterX, ALL_BYPASSER_Y, '전체 ON/OFF', masterMatchTitle, 1)
);

// 3 extra-group Bypassers (placed in a second row below the preset row)
EXTRA_GROUP_TITLES.forEach((title, idx) => {
  const id     = nextNodeId++;
  const x      = ALL_BYPASSER_X_BASE + idx * BYPASSER_STRIDE_X;
  const y      = ALL_BYPASSER_Y + BYPASSER_H + 30;
  const mtitle = '^' + escapeRe(title) + '$';
  combined.nodes.push(makeBypasser(id, x, y, title, mtitle, 100 + idx));
});

// ── 3-g) Update counters ──────────────────────────────────────────────────
combined.last_node_id = Math.max(...combined.nodes.map(n => n.id));
combined.last_link_id = Math.max(0, ...combined.links.map(l => l[0]));

// ────────────────────────────────────────────────────────────────────────────
// PHASE 4 — Validation
// ────────────────────────────────────────────────────────────────────────────
console.log('\n═══ PHASE 4: Validation ═══\n');

let ok = true;

// 4-a) No duplicate node IDs
const nodeIdSet = new Set();
for (const n of combined.nodes) {
  if (nodeIdSet.has(n.id)) {
    console.error(`✗ 중복 노드 ID: ${n.id} (${n.type})`);
    ok = false;
  }
  nodeIdSet.add(n.id);
}
console.log(`노드 ID 고유성: ${ok ? '✓' : '✗'} (${combined.nodes.length}개)`);

// 4-b) No duplicate link IDs
const linkIdSet = new Set();
let linkOk = true;
for (const l of combined.links) {
  if (linkIdSet.has(l[0])) {
    console.error(`✗ 중복 링크 ID: ${l[0]}`);
    linkOk = false;
    ok = false;
  }
  linkIdSet.add(l[0]);
}
console.log(`링크 ID 고유성: ${linkOk ? '✓' : '✗'} (${combined.links.length}개)`);

// 4-c) Check 9 preset wrapper groups exist
const wrapperGroups = combined.groups.filter(
  g => INPUT_NAMES.includes(g.title)
);
console.log(
  `프리셋 래퍼 그룹: ${wrapperGroups.length === 9 ? '✓' : '✗'} ` +
  `(${wrapperGroups.length}/9) — ${wrapperGroups.map(g => g.title).join(', ')}`
);
if (wrapperGroups.length !== 9) ok = false;

// 4-d) Check 9 preset Bypassers + 1 master
const presetBypassers = combined.nodes.filter(
  n => n.type === 'Fast Groups Bypasser (rgthree)' && INPUT_NAMES.includes(n.title)
);
const masterBypassers = combined.nodes.filter(
  n => n.type === 'Fast Groups Bypasser (rgthree)' && n.title === '전체 ON/OFF'
);
console.log(
  `프리셋 Bypasser: ${presetBypassers.length === 9 ? '✓' : '✗'} ` +
  `(${presetBypassers.length}/9)`
);
console.log(
  `마스터 Bypasser: ${masterBypassers.length === 1 ? '✓' : '✗'} ` +
  `(${masterBypassers.length}/1)`
);
if (presetBypassers.length !== 9 || masterBypassers.length !== 1) ok = false;

// 4-d2) Check extra groups (Text2Image / AssetBase / ControlCenter) + their Bypassers
const extraImported = combined.groups.filter(g => EXTRA_GROUP_TITLES.includes(g.title));
console.log(
  `추가 그룹: ${extraImported.length === EXTRA_GROUP_TITLES.length ? '✓' : '✗'} ` +
  `(${extraImported.length}/${EXTRA_GROUP_TITLES.length}) — ${extraImported.map(g => g.title).join(', ')}`
);
if (extraImported.length !== EXTRA_GROUP_TITLES.length) ok = false;

const extraBypassers = combined.nodes.filter(
  n => n.type === 'Fast Groups Bypasser (rgthree)' && EXTRA_GROUP_TITLES.includes(n.title)
);
console.log(
  `추가 그룹 Bypasser: ${extraBypassers.length === EXTRA_GROUP_TITLES.length ? '✓' : '✗'} ` +
  `(${extraBypassers.length}/${EXTRA_GROUP_TITLES.length})`
);
if (extraBypassers.length !== EXTRA_GROUP_TITLES.length) ok = false;

// 4-e) NAI syntax check (on subgraph definitions only — node widget prompts)
let naiFound = 0;
const naiPattern = /\{[^}]|\}\}|::/;
for (const def of combined.definitions.subgraphs) {
  for (const n of (def.nodes || [])) {
    for (const wv of (n.widgets_values || [])) {
      if (typeof wv === 'string' && naiPattern.test(wv)) {
        naiFound++;
        if (naiFound <= 3)
          console.error(`  NAI 잔존: def=${def.name} node=${n.type} val=${wv.slice(0,80)}`);
      }
    }
  }
}
console.log(`NAI 문법 잔존: ${naiFound === 0 ? '✓ 없음' : `✗ ${naiFound}건`}`);
if (naiFound > 0) ok = false;

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n─── 프리셋 요약 ───');
console.log(
  `${'프리셋'.padEnd(15)} ${'감정'.padStart(4)} ${'case'.padStart(6)} ${'평균'.padStart(5)}`
);
for (const m of presetMeta) {
  console.log(
    `${m.name.padEnd(15)} ${String(m.numEmotions).padStart(4)} ` +
    `${String(m.totalCases).padStart(6)} ${String(m.avgCases).padStart(5)}`
  );
}
console.log(
  `\n총 노드: ${combined.nodes.length}  총 링크: ${combined.links.length}  ` +
  `총 그룹: ${combined.groups.length}  서브그래프 정의: ${combined.definitions.subgraphs.length}`
);

// ────────────────────────────────────────────────────────────────────────────
// PHASE 5 — Write output
// ────────────────────────────────────────────────────────────────────────────
const outputPath = path.join(ROOT, 'combined_workflow.json');
fs.writeFileSync(outputPath, JSON.stringify(combined, null, 2), 'utf8');

console.log(`\n${ok ? '✅' : '⚠️'} combined_workflow.json 저장 완료`);
console.log(`   경로: ${path.relative(process.cwd(), outputPath)}`);
console.log(`   크기: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB`);
if (!ok) {
  console.error('\n검증 실패 항목이 있습니다. 위 출력 확인 바랍니다.');
  process.exit(1);
}
