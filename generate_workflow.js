// Build a ComfyUI workflow from `workflow_prototype.json` + a preset JSON.
// Preset format: { version, name, emotions: [{ name, cases: [string, ...] }] }
//
// Usage:
//   node generate_workflow.js [preset.json] [out.json]
// Defaults to the bundled example `../examples/emotions_sample.json`.
// Default output is `<basename>_workflow.json` next to the input preset.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Inputs ────────────────────────────────────────────────────────────
const DEFAULT_PRESET = path.resolve(__dirname, '..', 'examples', 'emotions_sample.json');
const presetArg = process.argv[2];
const outArg = process.argv[3];
const presetPath = presetArg
  ? path.resolve(process.cwd(), presetArg)
  : DEFAULT_PRESET;
const baseName = path.basename(presetPath, '.json');
const outputPath = outArg
  ? path.resolve(process.cwd(), outArg)
  : path.resolve(path.dirname(presetPath), `${baseName}_workflow.json`);

const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
const proto = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, 'workflow_prototype.json'), 'utf8'));

// ── Layout config ─────────────────────────────────────────────────────
const ROWS_PER_COL = 5;
const COL_W = 650;          // 600 width + 50 gap
const ROW_H = 1000;         // 930 height + 70 gap
const BASE_X = -3830;       // matches prototype's first emotion group
const BASE_Y = 310;
const GROUP_W = 600;
const GROUP_H = 930;
const GROUP_MARGIN_TOP = 60;
const INSTANCE_W = 600, INSTANCE_H = 270;
const SAVE_W = 600, SAVE_H = 570;
const INSTANCE_TO_SAVE_GAP = 30;
// Bypasser layout (independent of emotion grid; matches prototype demo)
const BYPASSER_BASE_X = -2230;
const BYPASSER_BASE_Y = 120;
const BYPASSER_STRIDE_X = 250;

// ── Helpers ───────────────────────────────────────────────────────────
const baseGroupTitles = new Set(['캐릭터 설정']);

function isInGroup(node, group) {
  const [gx, gy, gw, gh] = group.bounding;
  const [nx, ny] = node.pos;
  return nx >= gx && nx < gx + gw && ny >= gy && ny < gy + gh;
}

// ── 1. Identify base nodes (캐릭터 설정 group) ──────────────────────────
const baseGroups = proto.groups.filter(g => baseGroupTitles.has(g.title));
const baseNodeIds = new Set();
for (const node of proto.nodes) {
  if (baseGroups.some(g => isInGroup(node, g))) baseNodeIds.add(node.id);
}

// ── 2. Find subgraph templates ────────────────────────────────────────
const subgraphTypeIds = new Set((proto.definitions?.subgraphs || []).map(s => s.id));
const subgraphInstances = proto.nodes.filter(n => subgraphTypeIds.has(n.type));
if (subgraphInstances.length === 0) {
  console.error('서브그래프 인스턴스를 찾을 수 없습니다.');
  process.exit(1);
}
// Use any instance as the structural template; prefer one with a wired base_ctx.
const subgraphInstanceTemplate =
  subgraphInstances.find(n =>
    (n.inputs || []).some(i => i.name === 'base_ctx' && i.link != null)
  ) || subgraphInstances[0];
const subgraphDefTemplate = proto.definitions.subgraphs[0];
const saveImageTemplate = proto.nodes.find(n => n.type === 'SaveImageWithContext');
const bypasserTemplate = proto.nodes.find(n => n.type === 'Fast Groups Bypasser (rgthree)');

// ── 3. Auto-detect base_ctx source ────────────────────────────────────
// Find any wired base_ctx link from any subgraph instance.
let wiredBaseCtxLink = null;
for (const inst of subgraphInstances) {
  const inp = (inst.inputs || []).find(i => i.name === 'base_ctx' && i.link != null);
  if (inp) { wiredBaseCtxLink = inp.link; break; }
}
if (wiredBaseCtxLink == null) {
  console.error('어떤 서브그래프 인스턴스에도 base_ctx 링크가 연결되어 있지 않습니다.');
  process.exit(1);
}
const baseCtxInput = { link: wiredBaseCtxLink };
const baseCtxLinkRow = proto.links.find(l => l[0] === baseCtxInput.link);
// link row: [linkId, fromNodeId, fromSlot, toNodeId, toSlot, type]
const baseCtxFromNodeId = baseCtxLinkRow[1];
const baseCtxFromSlot = baseCtxLinkRow[2];
console.log(`base_ctx 출처: 노드 ${baseCtxFromNodeId} 슬롯 ${baseCtxFromSlot}`);

// ── 4. Build scaffold (deep clone proto, strip emotion-specific) ──────
const wf = JSON.parse(JSON.stringify(proto));
wf.nodes = wf.nodes.filter(n => baseNodeIds.has(n.id));
wf.links = wf.links.filter(l => baseNodeIds.has(l[1]) && baseNodeIds.has(l[3]));
wf.groups = wf.groups.filter(g => baseGroupTitles.has(g.title));
wf.definitions.subgraphs = [];

// Clear base_ctx source's outgoing links on that slot
const baseCtxFromNode = wf.nodes.find(n => n.id === baseCtxFromNodeId);
if (baseCtxFromNode && baseCtxFromNode.outputs && baseCtxFromNode.outputs[baseCtxFromSlot]) {
  baseCtxFromNode.outputs[baseCtxFromSlot].links = [];
}

// ── 5. Allocate IDs ───────────────────────────────────────────────────
let nextNodeId = Math.max(0, ...wf.nodes.map(n => n.id)) + 1;
let nextLinkId = Math.max(0, ...wf.links.map(l => l[0])) + 1;
let nextGroupId = Math.max(0, ...wf.groups.map(g => g.id || 0)) + 1;

// ── 6. Per-emotion generation ────────────────────────────────────────
function cloneSubgraphDef(template, emotionName, cases) {
  const def = JSON.parse(JSON.stringify(template));
  def.id = crypto.randomUUID();
  def.name = emotionName;

  const selector = def.nodes.find(n => n.type === 'ImpactStringSelector');
  if (!selector) throw new Error(`'${emotionName}': ImpactStringSelector를 템플릿에서 찾지 못함`);

  const stringsValue = cases.map(c => '#' + c).join('\n');
  selector.widgets_values[0] = stringsValue;
  if (selector.widgets_values.length >= 3) selector.widgets_values[2] = 0;

  return { def, selectorId: selector.id };
}

const newSubgraphDefs = [];
const newGroups = [];
const allCtxLinkIds = [];
const emotions = preset.emotions;

emotions.forEach((emo, idx) => {
  const col = Math.floor(idx / ROWS_PER_COL);
  const row = idx % ROWS_PER_COL;
  const groupX = BASE_X + col * COL_W;
  const groupY = BASE_Y + row * ROW_H;
  const instX = groupX;
  const instY = groupY + GROUP_MARGIN_TOP;
  const saveX = groupX;
  const saveY = instY + INSTANCE_H + INSTANCE_TO_SAVE_GAP;

  // Subgraph definition
  const { def, selectorId } = cloneSubgraphDef(subgraphDefTemplate, emo.name, emo.cases);
  newSubgraphDefs.push(def);

  // Allocate IDs
  const instId = nextNodeId++;
  const saveId = nextNodeId++;
  const ctxLinkId = nextLinkId++;
  const imgLinkId = nextLinkId++;
  const ctxOutLinkId = nextLinkId++;
  allCtxLinkIds.push(ctxLinkId);

  // Instance node (clone from template, override key fields)
  const instNode = JSON.parse(JSON.stringify(subgraphInstanceTemplate));
  instNode.id = instId;
  instNode.type = def.id;
  instNode.pos = [instX, instY];
  instNode.size = [INSTANCE_W, INSTANCE_H];
  instNode.title = emo.name;
  instNode.order = 17 + idx * 2;
  instNode.flags = { pinned: true };
  // Reset I/O to a clean wiring for this emotion
  instNode.inputs = [
    { dir: 3, name: 'base_ctx', type: 'RGTHREE_CONTEXT', link: ctxLinkId },
  ];
  instNode.outputs = [
    { name: 'IMAGE', type: 'IMAGE', links: [imgLinkId] },
    { name: 'CONTEXT', type: 'RGTHREE_CONTEXT', links: [ctxOutLinkId] },
  ];
  // proxyWidgets references the new selector node id (string form, as in proto)
  instNode.properties = JSON.parse(JSON.stringify(subgraphInstanceTemplate.properties || {}));
  instNode.properties.proxyWidgets = [
    [String(selectorId), 'select'],
    [String(selectorId), 'strings'],
  ];
  instNode.widgets_values = [];
  wf.nodes.push(instNode);

  // SaveImageWithContext node
  const saveNode = JSON.parse(JSON.stringify(saveImageTemplate));
  saveNode.id = saveId;
  saveNode.pos = [saveX, saveY];
  saveNode.size = [SAVE_W, SAVE_H];
  saveNode.flags = { pinned: true };
  saveNode.order = 18 + idx * 2;
  saveNode.inputs = [
    { name: 'images', type: 'IMAGE', link: imgLinkId },
    { name: 'context', type: 'RGTHREE_CONTEXT', link: ctxOutLinkId },
  ];
  saveNode.outputs = [];
  saveNode.widgets_values = [`emotion/${emo.name}`];
  wf.nodes.push(saveNode);

  // Links
  wf.links.push([ctxLinkId, baseCtxFromNodeId, baseCtxFromSlot, instId, 0, 'RGTHREE_CONTEXT']);
  wf.links.push([imgLinkId, instId, 0, saveId, 0, 'IMAGE']);
  wf.links.push([ctxOutLinkId, instId, 1, saveId, 1, 'RGTHREE_CONTEXT']);

  // Group
  newGroups.push({
    id: nextGroupId++,
    title: emo.name,
    bounding: [groupX, groupY, GROUP_W, GROUP_H],
    color: '#b58b2a',
    font_size: 24,
    flags: { pinned: true },
  });
});

wf.definitions.subgraphs = newSubgraphDefs;
wf.groups = wf.groups.concat(newGroups);

// ── 7. Update base_ctx source's outgoing links ────────────────────────
if (baseCtxFromNode && baseCtxFromNode.outputs && baseCtxFromNode.outputs[baseCtxFromSlot]) {
  baseCtxFromNode.outputs[baseCtxFromSlot].links = allCtxLinkIds.slice();
}

// ── 8. Per-column Fast Groups Bypassers ──────────────────────────────
// Bypassers form an independent horizontal row above the canvas
// (not aligned with emotion columns; stride = bypasser width).
// matchTitle uses regex with ^(...)$ anchors so e.g. "angry" doesn't
// also match "angry smile". sort=position so toggle buttons follow
// the grid's spatial order (top-to-bottom within a column).
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numCols = Math.ceil(emotions.length / ROWS_PER_COL);
for (let col = 0; col < numCols; col++) {
  const colEmotions = emotions.slice(col * ROWS_PER_COL, (col + 1) * ROWS_PER_COL);
  const matchTitle = '^(' + colEmotions.map(e => escapeRe(e.name)).join('|') + ')$';
  const node = JSON.parse(JSON.stringify(bypasserTemplate));
  node.id = nextNodeId++;
  node.pos = [BYPASSER_BASE_X + col * BYPASSER_STRIDE_X, BYPASSER_BASE_Y];
  node.flags = Object.assign({}, node.flags, { pinned: true });
  node.title = `그룹${col + 1}`;
  node.properties = JSON.parse(JSON.stringify(bypasserTemplate.properties || {}));
  node.properties.matchTitle = matchTitle;
  node.properties.sort = 'position';
  // Outputs: keep template shape but reset links
  node.outputs = (node.outputs || []).map(o => Object.assign({}, o, { links: null }));
  wf.nodes.push(node);
}

// ── 9. Update counters ───────────────────────────────────────────────
wf.last_node_id = Math.max(...wf.nodes.map(n => n.id));
wf.last_link_id = Math.max(0, ...wf.links.map(l => l[0]));

// ── 10. Write + report ───────────────────────────────────────────────
fs.writeFileSync(outputPath, JSON.stringify(wf, null, 2), 'utf8');

const totalCases = emotions.reduce((a, e) => a + e.cases.length, 0);
console.log('완료!');
console.log(`- 입력 프리셋: ${path.relative(process.cwd(), presetPath)}`);
console.log(`- 출력 워크플로우: ${path.relative(process.cwd(), outputPath)}`);
console.log(`- 감정: ${emotions.length}개 (총 ${totalCases}개 case)`);
console.log(`- 그리드: ${numCols}열 × 최대 ${ROWS_PER_COL}행`);
console.log(`- Bypasser: ${numCols}개 (열당 1개)`);
console.log(`- 노드 총 ${wf.nodes.length}개, 링크 총 ${wf.links.length}개`);
console.log(`- last_node_id=${wf.last_node_id}, last_link_id=${wf.last_link_id}`);
