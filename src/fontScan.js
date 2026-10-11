'use strict';
// Scans system fonts via fontconfig and builds the payload Figma's font agent protocol expects.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let fontkit = null;
try {
  fontkit = require('fontkit');
} catch {
  // Variation axes are optional; fonts still work without them.
}

const SUPPORTED_EXT = new Set(['.ttf', '.otf', '.ttc', '.otc']);
const FC_FORMAT =
  '%{file}\\t%{index}\\t%{family[0]}\\t%{style[0]}\\t%{postscriptname}\\t%{weight}\\t%{width}\\t%{slant}\\t%{variable}\\n';

// fontconfig weight -> CSS weight
const WEIGHTS = [
  [0, 100], [40, 200], [50, 300], [80, 400], [100, 500],
  [180, 600], [200, 700], [205, 800], [210, 900],
];
// fontconfig width -> OS/2 usWidthClass (1..9)
const WIDTHS = [50, 63, 75, 87, 100, 113, 125, 150, 200];

const HOME = os.homedir();

function nearest(list, value, key = (x) => x) {
  let best = list[0];
  for (const item of list) {
    if (Math.abs(key(item) - value) < Math.abs(key(best) - value)) best = item;
  }
  return best;
}

// fontconfig prints ranges for variable faces, e.g. "[50 210]"; use the first number.
function parseNumber(raw, fallback) {
  const nums = String(raw).match(/-?\d+(\.\d+)?/g);
  if (!nums) return fallback;
  return Number(nums[0]);
}

function cssWeight(fcWeight) {
  return nearest(WEIGHTS, fcWeight, (w) => w[0])[1];
}

function cssStretch(fcWidth) {
  return WIDTHS.indexOf(nearest(WIDTHS, fcWidth)) + 1;
}

function runFcList() {
  return new Promise((resolve, reject) => {
    execFile('fc-list', ['--format', FC_FORMAT], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

const axesCache = new Map();

// Returns { axes: [...], named: { styleName: { tag: value } } } for a variable font file, or null.
function readVariation(file) {
  if (!fontkit) return null;
  if (axesCache.has(file)) return axesCache.get(file);
  let result = null;
  try {
    let font = fontkit.openSync(file);
    if (font.fonts) font = font.fonts[0]; // collection
    const axes = font.variationAxes || {};
    const tags = Object.keys(axes);
    if (tags.length) {
      result = {
        axes: tags.map((tag) => ({
          tag,
          name: axes[tag].name || tag,
          min: axes[tag].min,
          max: axes[tag].max,
          default: axes[tag].default,
        })),
        named: font.namedVariations || {},
      };
    }
  } catch {
    result = null;
  }
  axesCache.set(file, result);
  return result;
}

function variationAxesFor(variation, style) {
  const coords = variation.named[style] || {};
  return variation.axes.map((a) => ({
    tag: a.tag,
    name: a.name,
    value: coords[a.tag] ?? a.default,
    min: a.min,
    max: a.max,
    default: a.default,
    hidden: false,
  }));
}

async function scanFonts() {
  const stdout = await runFcList();
  const entries = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [file, index, family, style, postscript, weight, width, slant, variable] = line.split('\t');
    if (!file || !family) continue;
    if (!SUPPORTED_EXT.has(path.extname(file).toLowerCase())) continue;
    entries.push({
      file,
      index: Number(index) || 0,
      family,
      style: style || 'Regular',
      postscript: postscript || '',
      weight: parseNumber(weight, 80),
      width: parseNumber(width, 100),
      slant: parseNumber(slant, 0),
      variable: variable === 'True',
    });
  }

  // Variable fonts appear once as the variable face plus once per named instance.
  // Prefer the named instances; keep the bare variable face only if it has none.
  const filesWithInstances = new Set(entries.filter((e) => e.index >= 0x10000).map((e) => e.file));

  const fontFiles = {};
  const seen = new Set();
  const mtimes = new Map();
  for (const e of entries) {
    if (e.variable && filesWithInstances.has(e.file)) continue;
    const key = `${e.file}\0${e.postscript}\0${e.style}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!mtimes.has(e.file)) {
      try {
        mtimes.set(e.file, Math.floor(fs.statSync(e.file).mtimeMs / 1000));
      } catch {
        mtimes.set(e.file, null);
      }
    }
    const mtime = mtimes.get(e.file);
    if (mtime === null) continue;

    const payload = {
      family: e.family,
      style: e.style,
      postscript: e.postscript,
      weight: cssWeight(e.weight),
      stretch: cssStretch(e.width),
      italic: e.slant > 0,
      modified_at: mtime,
      user_installed: e.file.startsWith(HOME + path.sep),
    };

    if (e.variable || e.index >= 0x10000) {
      const variation = readVariation(e.file);
      if (variation) payload.variationAxes = variationAxesFor(variation, e.style);
    }

    (fontFiles[e.file] ||= []).push(payload);
  }
  return fontFiles;
}

// Font directories whose mtime changes when fonts are added/removed.
function fontDirs() {
  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(HOME, '.local/share/fonts'),
    path.join(HOME, '.fonts'),
  ].filter((d) => fs.existsSync(d));
}

function dirsSignature() {
  const parts = [];
  const walk = (dir, depth) => {
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      return;
    }
    parts.push(`${dir}:${st.mtimeMs}`);
    if (depth === 0) return;
    let children = [];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const c of children) if (c.isDirectory()) walk(path.join(dir, c.name), depth - 1);
  };
  for (const d of fontDirs()) walk(d, 3);
  return parts.join('|');
}

let cache = null;
let cacheSig = null;
let pending = null;

// Returns cached scan, rescanning when any font directory changed.
async function getFontFiles() {
  const sig = dirsSignature();
  if (cache && sig === cacheSig) return cache;
  if (!pending) {
    pending = scanFonts()
      .then((files) => {
        cache = files;
        cacheSig = sig;
        return files;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

module.exports = { getFontFiles, scanFonts };
