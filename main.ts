// main.ts is mend, the CLI SPEC.md specifies. It implements all of SPEC.md: the command line,
// the output and exit codes, safe paths, format detection, line matching at three tiers
// (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep them, and keep runner.ts as it is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function trimEndST(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimST(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

interface Occ {
  tier: number;
  positions: number[];
}

/** Occurrences of O in lines at/after start, at the first tier with at least one. */
function occurrences(lines: string[], o: string[], start: number, strict: boolean): Occ | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = start; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (!lineEq(lines[i + j]!, o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a pattern: context (in O and N), deleted (O only), added (N only). */
interface PItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  oIdx: number;
}

function oTexts(items: PItem[]): string[] {
  return items.filter((it) => it.kind !== 'add').map((it) => it.text);
}

/** The lines that replace a matched occurrence: context lines as the file has them, added
 *  lines re-indented at tier 2, deleted lines dropped. */
function buildN(items: PItem[], fileLines: string[], pos: number, tier: number): string[] {
  const o = oTexts(items);
  const f = tier === 2 && o.length > 0 ? leading(fileLines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leading(o[0]!) : '';
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'del') continue;
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + it.oIdx]!);
    } else if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(p)) {
      out.push(f + it.text.slice(p.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read
 *  from disk. Moves are recorded so the output can print R lines. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Unified diffs (section 6) ----------

interface Hunk {
  a: number;
  items: PItem[];
  backslashAfterLastCtxOrAdd: boolean;
  backslashAfterLastPlus: boolean;
}

function parseHunkBody(raw: string[]): { items: PItem[]; backslashAfterLastCtxOrAdd: boolean; backslashAfterLastPlus: boolean } {
  const items: PItem[] = [];
  let oIdx = 0;
  let lastCtxAdd = -1;
  let lastPlus = -1;
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k]!;
    if (l === '' || l[0] === ' ') {
      items.push({ kind: 'ctx', text: l === '' ? '' : l.slice(1), oIdx: oIdx++ });
      lastCtxAdd = k;
    } else if (l[0] === '-') {
      items.push({ kind: 'del', text: l.slice(1), oIdx: oIdx++ });
    } else if (l[0] === '+') {
      items.push({ kind: 'add', text: l.slice(1), oIdx: -1 });
      lastCtxAdd = k;
      lastPlus = k;
    }
  }
  const after = (idx: number): boolean => idx >= 0 && idx + 1 < raw.length && raw[idx + 1]![0] === '\\';
  return { items, backslashAfterLastCtxOrAdd: after(lastCtxAdd), backslashAfterLastPlus: after(lastPlus) };
}

interface Section {
  pairOld?: string | null;
  pairNew?: string | null;
  diffOld?: string;
  diffNew?: string;
  renameFrom?: string;
  renameTo?: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` header line, or null for /dev/null. */
function headerPath(s: string): string | null {
  let t = s.split('\t')[0]!;
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree: Tree): void => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    const oldS = oldP === undefined ? newP : oldP;
    const newS = newP === undefined ? oldP : newP;
    if (typeof oldS === 'string' && !safe(oldS)) throw new Fail('unsafe', oldS);
    if (typeof newS === 'string' && newS !== oldS && !safe(newS)) throw new Fail('unsafe', newS);
    if (oldS === null || sec.isCreate) {
      if (typeof newS !== 'string') return;
      if (tree.get(newS) !== null) throw new Fail('exists', newS);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'add') plus.push(it.text);
      let text = '';
      if (plus.length > 0) {
        let noBreak = false;
        for (let k = sec.hunks.length - 1; k >= 0; k--) {
          const h = sec.hunks[k]!;
          if (h.items.some((it) => it.kind === 'add')) {
            noBreak = h.backslashAfterLastPlus;
            break;
          }
        }
        text = plus.join('\n') + (noBreak ? '' : '\n');
      }
      tree.now.set(newS, text);
      return;
    }
    if (newS === null || sec.isDelete) {
      if (typeof oldS !== 'string') return;
      if (tree.get(oldS) === null) throw new Fail('missing', oldS);
      tree.now.set(oldS, null);
      return;
    }
    const op = oldS as string;
    const np = newS as string;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (np !== op && tree.get(np) !== null) throw new Fail('exists', np);
    const st = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const o = oTexts(h.items);
      if (o.length === 0) {
        const addLines = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const insertPos = Math.max(0, Math.min(h.a + d, st.lines.length));
        const atEnd = insertPos === st.lines.length;
        st.lines.splice(insertPos, 0, ...addLines);
        if (atEnd) st.final = !h.backslashAfterLastCtxOrAdd;
        d += addLines.length;
      } else {
        const occ = occurrences(st.lines, o, 0, strict);
        if (occ === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let pos = occ.positions[0]!;
        let best = Math.abs(pos - target);
        for (const p of occ.positions) {
          const dist = Math.abs(p - target);
          if (dist < best) {
            best = dist;
            pos = p;
          }
        }
        const matchedToEnd = pos + o.length === st.lines.length;
        const newSeg = buildN(h.items, st.lines, pos, occ.tier);
        st.lines.splice(pos, o.length, ...newSeg);
        if (matchedToEnd) st.final = !h.backslashAfterLastCtxOrAdd;
        d += newSeg.length - o.length;
      }
    }
    const text = joinFile(st);
    if (np !== op) {
      tree.now.set(op, null);
      tree.now.set(np, text);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  let phase: 'none' | 'header' | 'after' = 'none';
  let headerPair = false;
  let i = 0;
  const startSection = (s: Section): void => {
    secs.push(s);
    cur = s;
    phase = 'header';
    headerPair = false;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)$/.exec(line.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection({ diffOld: m[1], diffNew: m[2], isCreate: false, isDelete: false, hunks: [] });
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line.slice(4));
      const newP = headerPath(lines[i + 1]!.slice(4));
      if (cur === null || phase !== 'header' || headerPair) {
        startSection({ pairOld: oldP, pairNew: newP, isCreate: false, isDelete: false, hunks: [] });
        headerPair = true;
      } else {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        headerPair = true;
      }
      i += 2;
      continue;
    }
    if (phase === 'header' && cur !== null && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      const raw: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        // The body ends at a `diff --git ` line and at a `--- ` line followed by
        // a `+++ ` line, even though those start with body characters.
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          raw.push(l);
          i++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const parsed = parseHunkBody(raw);
      cur.hunks.push({ a: parseInt(m[1]!, 10), items: parsed.items, backslashAfterLastCtxOrAdd: parsed.backslashAfterLastCtxOrAdd, backslashAfterLastPlus: parsed.backslashAfterLastPlus });
      phase = 'after';
      continue;
    }
    if (phase === 'header' && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  return secs.map((s) => unifiedEdit(s, strict));
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const occ = occurrences(st.lines, oldLines, 0, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = occ.positions[0]!;
    const items: PItem[] = [
      ...oldLines.map((t, k): PItem => ({ kind: 'del', text: t, oIdx: k })),
      ...newLines.map((t): PItem => ({ kind: 'add', text: t, oIdx: -1 })),
    ];
    const newSeg = buildN(items, st.lines, pos, occ.tier);
    st.lines.splice(pos, oldLines.length, ...newSeg);
    tree.now.set(path, joinFile(st));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplaceEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- V4A patches (section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: PItem[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
  updateLine: number;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree: Tree): void => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const np = sec.moveTo;
    if (np !== null && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (np !== null && tree.get(np) !== null) throw new Fail('exists', np);
    const st = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < st.lines.length; k++) {
            if (lineEq(st.lines[k]!, ch.anchor, tier)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const o = oTexts(ch.items);
      if (o.length === 0) {
        const addLines = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const at = ch.eof ? st.lines.length : cursor;
        st.lines.splice(at, 0, ...addLines);
        cursor = at + addLines.length;
      } else if (ch.eof) {
        const occ = occurrences(st.lines, o, cursor, strict);
        if (occ === null) throw new Fail('no-match', p);
        let pos = -1;
        for (const q of occ.positions) {
          if (q + o.length === st.lines.length) {
            pos = q;
            break;
          }
        }
        if (pos < 0) throw new Fail('no-match', p);
        const newSeg = buildN(ch.items, st.lines, pos, occ.tier);
        st.lines.splice(pos, o.length, ...newSeg);
        cursor = pos + newSeg.length;
      } else {
        const occ = occurrences(st.lines, o, cursor, strict);
        if (occ === null) throw new Fail('no-match', p);
        const pos = occ.positions[0]!;
        const newSeg = buildN(ch.items, st.lines, pos, occ.tier);
        st.lines.splice(pos, o.length, ...newSeg);
        cursor = pos + newSeg.length;
      }
    }
    const text = joinFile(st);
    if (np !== null) {
      tree.now.set(p, null);
      tree.now.set(np, text);
      tree.moves.push([p, np]);
    } else {
      tree.now.set(p, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice(13).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice(16).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice(16).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSection = { kind, path, lines: [], moveTo: null, chunks: [], updateLine: i + 1 };
    i++;
    if (kind === 'add') {
      // Only raw blank ("") lines at the end of the section are dropped (SPEC
      // section 8: blank lines at the end of a section are not part of it).
      // A "+" line is not blank: it is a real empty line of the file.
      const rawAdd: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l === '' || l[0] === '+') {
          sec.lines.push(l === '' ? '' : l.slice(1));
          rawAdd.push(l);
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (sec.lines.length > 0 && rawAdd[rawAdd.length - 1] === '') {
        sec.lines.pop();
        rawAdd.pop();
      }
    } else if (kind === 'delete') {
      while (i < last && !isSectionStart(lines[i]!)) {
        if (blank(lines[i]!)) {
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
    } else {
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        sec.moveTo = lines[i]!.slice(12).trim();
        i++;
      }
      let cur: VChunk | null = null;
      const startChunk = (anchor: string | null): VChunk => {
        const c: VChunk = { anchor, eof: false, items: [] };
        sec.chunks.push(c);
        return c;
      };
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i++;
        } else if (l.startsWith('@@')) {
          cur = startChunk(l.slice(2).trim() === '' ? null : l.slice(2).trim());
          i++;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = startChunk(null);
          }
          if (l === '') cur.items.push({ kind: 'ctx', text: '', oIdx: -1 });
          else if (l[0] === ' ') cur.items.push({ kind: 'ctx', text: l.slice(1), oIdx: -1 });
          else if (l[0] === '-') cur.items.push({ kind: 'del', text: l.slice(1), oIdx: -1 });
          else cur.items.push({ kind: 'add', text: l.slice(1), oIdx: -1 });
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      const lastChunk = sec.chunks[sec.chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.items.length > 0) {
          const it = lastChunk.items[lastChunk.items.length - 1]!;
          if (it.kind === 'ctx' && it.text === '') lastChunk.items.pop();
          else break;
        }
      }
      for (const c of sec.chunks) {
        let oIdx = 0;
        for (const it of c.items) {
          if (it.kind !== 'add') {
            it.oIdx = oIdx++;
          }
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
    }
    edits.push(v4aEdit(sec, strict));
  }
  return edits;
}

// ---------- Run ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const deleted = new Set<string>();
  const added = new Set<string>();
  const modified = new Set<string>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) added.add(p);
    else if (now === null) deleted.add(p);
    else modified.add(p);
  }
  const rows: { key: string; line: string }[] = [];
  const moveMap = new Map<string, string>(tree.moves);
  for (const d of [...deleted]) {
    let cur = d;
    const seen = new Set<string>([d]);
    while (moveMap.has(cur) && !seen.has(moveMap.get(cur)!)) {
      cur = moveMap.get(cur)!;
      seen.add(cur);
    }
    if (cur !== d && added.has(cur)) {
      rows.push({ key: cur, line: `R ${d} -> ${cur}` });
      deleted.delete(d);
      added.delete(cur);
    }
  }
  for (const p of deleted) rows.push({ key: p, line: `D ${p}` });
  for (const p of added) rows.push({ key: p, line: `A ${p}` });
  for (const p of modified) rows.push({ key: p, line: `M ${p}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Write in byte order of the paths, as the kit's starter does.
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
