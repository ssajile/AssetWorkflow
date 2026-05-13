// Standalone NAI → SD prompt syntax converter.
// Extracted from 프리셋/nai-preset-viewer.html (the canonical source).
//
// Usage:
//   const { convertNAItoSD } = require('./lib/nai-to-sd');
//   const sd = convertNAItoSD(naiPromptString);

function mapNAIWeightToSD(nai) {
  const n = parseFloat(nai);
  if (isNaN(n)) return 1;
  if (n > 0) {
    // Logarithmic compression into SD safe range [0.1, 1.5].
    const sd = 1 + 0.3 * Math.log(n);
    return Math.max(0.1, Math.min(1.5, Math.round(sd * 100) / 100));
  }
  // Negative NAI weights → clamp to -1 (acts like a soft negative prompt in SD).
  return -1;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `{text}` / `{{text}}` ... → `(text:1.05^depth)`
function convertBraces(text) {
  let r = text;
  for (let depth = 6; depth >= 1; depth--) {
    const open = '{'.repeat(depth);
    const close = '}'.repeat(depth);
    const w = Math.round(Math.pow(1.05, depth) * 100) / 100;
    const regex = new RegExp(escapeRegex(open) + '([^{}]+)' + escapeRegex(close), 'g');
    let safety = 0;
    while (regex.test(r) && safety++ < 20) {
      r = r.replace(regex, (_, inner) => `(${inner.trim()}:${w})`);
    }
  }
  return r;
}

// `[text]` / `[[text]]` ... → `(text:0.95^depth)`
function convertBrackets(text) {
  let r = text;
  for (let depth = 6; depth >= 1; depth--) {
    const open = '['.repeat(depth);
    const close = ']'.repeat(depth);
    const w = Math.round(Math.pow(0.95, depth) * 100) / 100;
    const regex = new RegExp(escapeRegex(open) + '([^\\[\\]]+)' + escapeRegex(close), 'g');
    let safety = 0;
    while (regex.test(r) && safety++ < 20) {
      r = r.replace(regex, (_, inner) => `(${inner.trim()}:${w})`);
    }
  }
  return r;
}

// Main converter: NAI prompt string → SD prompt string.
function convertNAItoSD(prompt) {
  if (!prompt) return '';
  let r = prompt;
  // Strip HTML tags that some NAI exports embed.
  r = r.replace(/<[^>]+>/g, '');
  const trimContent = s => s.replace(/^[\s,]+|[\s,]+$/g, '');
  // `N::text::` weight syntax (handle nested by repeated application).
  let prevR;
  do {
    prevR = r;
    r = r.replace(/([-]?\d+(?:\.\d+)?)::([\s\S]*?)::/g,
      (_, w, t) => `(${trimContent(t)}:${mapNAIWeightToSD(w)})`);
  } while (r !== prevR);
  // Unterminated `N::text` (until next weight or EOL).
  r = r.replace(/([-]?\d+(?:\.\d+)?)::([\s\S]*?)(?=,\s*[-]?\d+(?:\.\d+)?::|$)/g,
    (_, w, t) => `(${trimContent(t)}:${mapNAIWeightToSD(w)})`);
  r = r.replace(/::/g, '');
  r = convertBraces(r);
  r = convertBrackets(r);
  // Whitespace/comma cleanup.
  r = r.replace(/\s*,\s*/g, ', ').replace(/,\s*,/g, ',')
       .replace(/^\s*,\s*/, '').replace(/\s*,\s*$/, '');
  r = r.replace(/\s+/g, ' ').trim();
  return r;
}

module.exports = {
  convertNAItoSD,
  mapNAIWeightToSD,
  convertBraces,
  convertBrackets,
};
