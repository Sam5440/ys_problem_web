/**
 * C++ / Python 竞赛代码格式化（纯函数，node/浏览器同源，可直接单测）。
 *
 * 设计边界（别越界，越界就是语义事故）：
 * - C++：重排缩进（花括号深度 + 未闭合圆/方括号的悬挂缩进）+ 安全空格规范化
 *   （逗号/分号后、双字符运算符两侧、贴邻单字符运算符两侧）。**绝不改动 < >
 *   附近的空格**——`vector<int>`（模板）与 `i<n`（比较）在词法层无法区分；
 *   `<<`/`>>`/`::`/`->`/`<=>` 一律当不透明单元原样保留（`>>=`、`int**p` 也就
 *   不会被拆开）。预处理行（#…，含 `\` 续行）只归零缩进、不计缩进深度
 *   （`#define` 里的不配对大括号会毁掉深度跟踪）。
 * - Python：缩进是语义！绝不重排块缩进，只做语义安全操作：括号内续行悬挂
 *   缩进（括号内缩进自由）、闭括号行回退到本逻辑行起始缩进、行尾空白、
 *   纯 Tab 行首转空格、逗号后空格、顶层 `=` 加空格、实参内 `=` 去空格
 *   （black 语义，注解默认值 `x: int = 1` 除外）、字典冒号后加空格（下标
 *   切片冒号不动）、`->`/`**`/`//` 两侧空格。
 * - 字符串/字符字面量/注释（含 C++ 块注释与原始字符串、Python 三引号与
 *   f-string）内容一律原样保留；行内有未闭合字面量时整行原样保留（兜底）。
 * - 幂等：format(format(x)) === format(x)。
 */

const IDENT_RE = /[A-Za-z0-9_]/;
const CLOSERS = new Set([")", "]", "}"]);

function operandEnd(c) {
  // 「操作数结尾」：标识符/数字/右括号/成员访问/字符串结尾
  return !!c && /[A-Za-z0-9_)\].'">]/.test(c);
}
function operandStart(c) {
  // 「操作数开头」：标识符/数字/左括号/字符串/一元 !
  return !!c && /[A-Za-z0-9_('"![{]/.test(c);
}

/* ---------- 词法：按行切 parts（code=true 为代码，其余原样保留） ---------- */

/** 单行内匹配带转义的引号串；未闭合则吞到行尾并标记（外层兜底整行原样）。 */
function matchQuote(line, start, q) {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") i += 2;
    else if (line[i] === q) return { text: line.slice(start, i + 1), closed: true };
    else i++;
  }
  return { text: line.slice(start), closed: false };
}

function scanCppLine(raw, st) {
  const parts = [];
  let code = "";
  let i = 0;
  const flush = () => {
    if (code) parts.push({ text: code, code: true });
    code = "";
  };
  if (st.inRaw) {
    const tail = ")" + st.inRaw + '"';
    const end = raw.indexOf(tail);
    if (end === -1)
      return { parts: [{ text: raw, code: false, verbatim: true }], st };
    parts.push({ text: raw.slice(0, end + tail.length), code: false, verbatim: true });
    i = end + tail.length;
  } else if (st.inBlock) {
    const end = raw.indexOf("*/");
    if (end === -1)
      return { parts: [{ text: raw, code: false, comment: true, verbatim: true }], st };
    parts.push({ text: raw.slice(0, end + 2), code: false, comment: true, verbatim: true });
    i = end + 2;
  }
  for (; i < raw.length; i++) {
    const c = raw[i];
    const n = raw[i + 1];
    if (c === "/" && n === "/") {
      flush();
      parts.push({ text: raw.slice(i), code: false, comment: true });
      return { parts, st: { inBlock: false, inRaw: null } };
    }
    if (c === "/" && n === "*") {
      flush();
      const end = raw.indexOf("*/", i + 2);
      if (end === -1) {
        parts.push({ text: raw.slice(i), code: false, comment: true, verbatim: true });
        return { parts, st: { inBlock: true, inRaw: null } };
      }
      parts.push({ text: raw.slice(i, end + 2), code: false, comment: true });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const m = matchQuote(raw, i, c);
      flush();
      parts.push({ text: m.text, code: false, str: true, unterminated: !m.closed });
      i += m.text.length - 1;
      continue;
    }
    // R"del( … )del" 原始字符串（可跨行）
    if (c === "R" && n === '"' && !IDENT_RE.test(raw[i - 1] ?? "")) {
      const open = raw.indexOf("(", i + 2);
      const delim = raw.slice(i + 2, open);
      const tail = ")" + delim + '"';
      const end = raw.indexOf(tail, open + 1);
      flush();
      if (end === -1) {
        parts.push({ text: raw.slice(i), code: false, verbatim: true });
        return { parts, st: { inBlock: false, inRaw: delim } };
      }
      parts.push({ text: raw.slice(i, end + tail.length), code: false, verbatim: true });
      i = end + tail.length - 1;
      continue;
    }
    code += c;
  }
  flush();
  return { parts, st: { inBlock: false, inRaw: null } };
}

const PY_PREFIX = /[rbfuRBFU]/;

function scanPyLine(raw, st) {
  const parts = [];
  let code = "";
  let i = 0;
  const flush = () => {
    if (code) parts.push({ text: code, code: true });
    code = "";
  };
  if (st.inTriple) {
    const end = raw.indexOf(st.inTriple);
    if (end === -1)
      return { parts: [{ text: raw, code: false, verbatim: true }], st };
    parts.push({ text: raw.slice(0, end + 3), code: false, verbatim: true });
    i = end + 3;
  }
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (c === "#") {
      flush();
      parts.push({ text: raw.slice(i), code: false, comment: true });
      return { parts, st: { inTriple: null } };
    }
    if (c === '"' || c === "'") {
      // f/r/b/u 前缀挂在 code 缓冲末尾：摘出来并入字符串单元
      let plen = 0;
      while (
        plen < 2 &&
        code.length - plen > 0 &&
        PY_PREFIX.test(code[code.length - 1 - plen])
      )
        plen++;
      if (
        plen > 0 &&
        code.length - plen > 0 &&
        IDENT_RE.test(code[code.length - 1 - plen])
      )
        plen = 0; // 前缀前面还有标识符字符 → 是变量名不是字符串前缀
      const prefix = plen ? code.slice(-plen) : "";
      if (plen) code = code.slice(0, -plen);
      const q3 = raw.slice(i, i + 3);
      let part;
      if (q3 === "'''" || q3 === '"""') {
        const end = raw.indexOf(q3, i + 3);
        if (end === -1) {
          // 前缀（f 等）从 code 里摘出来了，未闭合时必须并回 part 防丢失
          flush();
          parts.push({ text: prefix + raw.slice(i), code: false, verbatim: true });
          return { parts, st: { inTriple: q3 } };
        }
        part = { text: raw.slice(i, end + 3), code: false, verbatim: true };
        i = end + 2;
      } else {
        const m = matchQuote(raw, i, c);
        part = {
          text: m.text,
          code: false,
          str: true,
          unterminated: !m.closed,
        };
        i += m.text.length - 1;
      }
      flush();
      if (prefix) parts.push({ text: prefix, code: false, str: true, prefixOnly: true });
      parts.push(part);
      continue;
    }
    code += c;
  }
  flush();
  return { parts, st: { inTriple: null } };
}

/* ---------- parts → units（符号单元 + 单元前空白量） ---------- */

function unitsOf(parts) {
  const units = [];
  const gaps = []; // gaps[i] = units[i] 前的空白字符数
  let pending = 0;
  for (const p of parts) {
    if (!p.code) {
      units.push({ text: p.text, code: false });
      gaps.push(pending);
      pending = 0;
      continue;
    }
    for (const ch of p.text) {
      if (ch === " " || ch === "\t") {
        if (units.length) pending++;
      } else {
        units.push({ text: ch, code: true });
        gaps.push(pending);
        pending = 0;
      }
    }
  }
  return { units, gaps };
}

const CPP_KEYWORDS_PAREN = new Set(["if", "else", "for", "while", "switch", "catch"]);
const PY_KEYWORDS_PAREN = new Set([
  "if", "elif", "while", "return", "yield", "assert", "raise", "del", "await",
  "lambda", "not", "and", "or", "in", "is",
]);

/**
 * 空格规范化核心：逐单元决策 sb（单元前空格 keep/force1/force0）与 sa（单元后
 * 空格），keep 尊重原始空白（多空格折叠为一个）。python 需要传入 startInCall
 * （跨行未闭合括号里，实参 = 去空格规则要生效）。
 */
function spaceWalk(units, gaps, lang, startInCall = false) {
  const isCpp = lang === "cpp";
  const ALWAYS2 = isCpp
    ? new Set(["==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="])
    : new Set(["==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "//=", "**=", "->", ":=", "**", "//"]);
  const OPAQUE2 = isCpp
    ? new Set(["<<", ">>", "::", "->"])
    : new Set(["::"]);
  const PY_ALWAYS3 = new Set(["//=", "**=", "<<=", ">>="]);
  let out = "";
  let prevLast = null; // 上一个输出的有效字符（含字符串结尾）
  let lastIdent = ""; // 上一个连续标识符（关键字-括号规则用）
  let inIdent = false;
  let suppressNext = false; // 上一单元 sa=force0：压掉本单元的 keep 空白
  let colonAtDepth = null; // python：当前深度上最近一次注解冒号（区分 kwarg 与默认值）
  const bracketStack = startInCall ? ["("] : []; // python 括号类型栈（切片冒号/实参规则）
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const gap = gaps[i] > 0;
    let next = units[i + 1] ?? null;
    let nextCh = next ? next.text[0] : null;
    if (!u.code) {
      if (out && gap && !suppressNext && out[out.length - 1] !== " ") out += " ";
      out += u.text;
      prevLast = u.text[u.text.length - 1];
      inIdent = false;
      lastIdent = "";
      suppressNext = false;
      continue;
    }
    // 两/三字符合并（三路比较 <=> 必须先于 <= 判断；Python 的 //= **= 等
    // 复合赋值必须先于二元 // ** 判断，否则会被拆成 `a // = 10` 语法错误）
    let text = u.text;
    let kind = "single"; // single | always | opaque
    let consumed = 0;
    if (next?.code && gaps[i + 1] === 0) {
      const three = u.text + next.text + (units[i + 2]?.code && gaps[i + 2] === 0 ? units[i + 2].text : "");
      if (
        isCpp &&
        u.text === "<" &&
        next.text === "=" &&
        three === "<=>"
      ) {
        text = "<=>";
        kind = "opaque";
        consumed = 2;
      } else if (!isCpp && PY_ALWAYS3.has(three)) {
        text = three;
        kind = "always";
        consumed = 2;
      } else {
        const two = u.text + next.text;
        if (ALWAYS2.has(two)) {
          text = two;
          kind = "always";
          consumed = 1;
        } else if (OPAQUE2.has(two)) {
          text = two;
          kind = "opaque";
          consumed = 1;
        }
      }
      i += consumed;
    }
    // 合并后真正的「下一个单元」与首字符（决策要基于它而非被吞进来的半截）
    next = units[i + 1] ?? null;
    nextCh = next ? next.text[0] : null;
    const c = text[0];
    let sb = "keep";
    let sa = "keep";
    const atStart = out === "";
    const hasNext = !!next;

    if (text === ",") {
      sb = "force0";
      sa = hasNext && !CLOSERS.has(nextCh) ? "force1" : "force0";
      colonAtDepth = null;
    } else if (text === ";") {
      sb = "force0";
      sa = hasNext && nextCh !== ")" ? "force1" : "force0";
      colonAtDepth = null;
    } else if (kind === "always") {
      if (!atStart) sb = "force1";
      if (hasNext) sa = "force1";
    } else if (kind === "opaque") {
      // << >> :: -> <=>：原样
    } else if (c === "=" && text.length === 1) {
      if (isCpp) {
        if (!atStart && prevLast && !"=!<>+-*/%&|^~?:".includes(prevLast)) {
          sb = "force1";
          if (hasNext) sa = "force1";
        }
      } else if (bracketStack.length > 0) {
        if (colonAtDepth === null) {
          // 实参/形参关键字默认值：去空格（f(x=1)，black 语义）
          sb = "force0";
          sa = "force0";
          suppressNext = true;
        } else {
          // 注解默认值 def f(x: int = 1)：加空格
          sb = "force1";
          if (hasNext) sa = "force1";
        }
      } else if (!atStart && operandEnd(prevLast)) {
        sb = "force1";
        if (hasNext) sa = "force1";
      }
    } else if (isCpp && (c === "<" || c === ">")) {
      // 模板/比较无法区分：绝不动
    } else if (c === ":" && text.length === 1) {
      if (isCpp) {
        // 三目/范围 for 的冒号：仅两侧贴邻时补空格（:: 已合并、行尾标签无 next）
        if (operandEnd(prevLast) && operandStart(nextCh) && !gap && !gaps[i + 1]) {
          sb = "force1";
          sa = "force1";
        }
      } else if (bracketStack[bracketStack.length - 1] !== "[") {
        // 字典/注解/lambda 冒号：前无空格、后一空格；下标切片（栈顶 [）不动
        if (!atStart) sb = "force0";
        if (hasNext) sa = "force1";
        colonAtDepth = bracketStack.length;
      }
    } else if (isCpp && c === "?" && text.length === 1) {
      if (operandEnd(prevLast) && operandStart(nextCh) && !gap && !gaps[i + 1]) {
        sb = "force1";
        sa = "force1";
      }
    } else if ("+-*/%&|^".includes(c) && text.length === 1) {
      // 单字符双目：两侧都是操作数且都贴邻时补空格（int* p / a - -1 / ++i 不动）
      // 科学计数法的指数符号（1e-9 / 2.5e+3）绝不能加空格——加了就是语法错误
      const expSign =
        (c === "-" || c === "+") &&
        /(\d\.?\d*|\.\d+)[eE]$/.test(lastIdent);
      if (
        !expSign &&
        operandEnd(prevLast) &&
        operandStart(nextCh) &&
        !gap &&
        gaps[i + 1] === 0
      ) {
        sb = "force1";
        sa = "force1";
      }
    } else if (c === "(") {
      if (!atStart && lastIdent) {
        if (isCpp) {
          if (!gap && CPP_KEYWORDS_PAREN.has(lastIdent)) sb = "force1"; // if( → if (
        } else if (PY_KEYWORDS_PAREN.has(lastIdent)) {
          sb = "force1";
        } else if (!gap) {
          sb = "force0"; // f (x) → f(x)
        }
      }
      // 调用/关键字括号内侧不留空（f( x ) → f(x)）；运算符后（2 * (x+1)）保持
      if (lastIdent) sa = "force0";
    } else if (text === ")") {
      sb = "force0"; // 括号内侧空格收窄：f( x ) → f(x)
    } else if (text === "{" && isCpp) {
      // 函数/控制语句体花括号前补空格：){ → ) {、else{ → else {
      // （括号初始化 int a[]{1} 与 x{5} 不动：prevLast 不是 ')' 也不是关键字）
      if (prevLast === ")" || lastIdent === "else" || lastIdent === "do" || lastIdent === "try")
        sb = "force1";
    }

    if ((sb === "force1" || (sb === "keep" && gap && !suppressNext)) && !atStart && out[out.length - 1] !== " ")
      out += " ";
    out += text;
    if (text === "(" || text === "[" || text === "{") {
      bracketStack.push(text);
      colonAtDepth = null;
    } else if (CLOSERS.has(text)) {
      bracketStack.pop();
      colonAtDepth = null;
    }
    prevLast = text[text.length - 1];
    if (text.length === 1 && IDENT_RE.test(c)) {
      lastIdent = inIdent ? lastIdent + c : c;
      inIdent = true;
    } else {
      inIdent = false;
      lastIdent = "";
    }
    if (sa === "force1" && next && out[out.length - 1] !== " ") out += " ";
    // suppressNext 只影响紧随其后的一个单元（上一单元 sa=force0 时压掉它的 keep 空白）
    suppressNext = sa === "force0" && next && gaps[i + 1] > 0;
  }
  return out;
}

/* ---------- C++ ---------- */

const CPP_LABEL_RE = /^(case\b|default\s*:|public\s*:|private\s*:|protected\s*:)/;

export function formatCpp(code, opts = {}) {
  const U = opts.indent ?? 4;
  if (!code) return code;
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const scanned = [];
  let st = { inBlock: false, inRaw: null };
  let preprocSplice = false;
  for (const raw of lines) {
    const r = scanCppLine(raw, st);
    st = r.st;
    const codeText = r.parts
      .filter((p) => p.code)
      .map((p) => p.text)
      .join("")
      .trim();
    const firstCode = r.parts.find((p) => p.code);
    const isPreproc = !!firstCode && /^\s*#/.test(firstCode.text);
    const splice = raw.endsWith("\\");
    scanned.push({ raw, parts: r.parts, codeText, preproc: isPreproc, splice });
    preprocSplice = (isPreproc || preprocSplice) && splice;
  }

  const out = [];
  const indents = new Array(scanned.length).fill(-1);
  let depth = 0;
  const stack = []; // 未闭合 ( [ 的所在行号
  let blankRun = 0;
  for (let i = 0; i < scanned.length; i++) {
    const L = scanned[i];
    const verbatimOnly =
      L.parts.length > 0 &&
      L.parts[0].verbatim &&
      !L.parts.some((p) => p.code);
    if (verbatimOnly || L.splice || L.preproc) {
      // 块注释/原始字符串内部、\ 续行：原样（预处理行只归零缩进）
      const text = L.preproc ? L.raw.replace(/^[ \t]+/, "") : L.raw;
      if (text.trim() === "") {
        blankRun++;
        if (blankRun > 1) continue;
        out.push("");
        indents[i] = 0;
      } else {
        blankRun = 0;
        out.push(text);
        indents[i] = L.preproc ? 0 : -1;
      }
      continue;
    }
    if (L.codeText === "") {
      // 空行 / 纯注释（或纯字符串碎片）行
      if (L.parts.some((p) => p.comment || p.str)) {
        blankRun = 0;
        const indent = indentOfCpp(depth, stack, indents, L.codeText, U);
        indents[i] = indent;
        out.push(" ".repeat(indent) + L.raw.trim());
      } else {
        blankRun++;
        if (blankRun > 1) continue;
        out.push("");
        indents[i] = 0;
      }
      continue;
    }
    blankRun = 0;
    // 行内字面量未闭合（多半是语法错误或怪异拼接）：整行原样，防改坏字符串
    if (L.parts.some((p) => p.unterminated)) {
      const indent = indentOfCpp(depth, stack, indents, L.codeText, U);
      indents[i] = indent;
      out.push(" ".repeat(indent) + L.raw.trim());
    } else {
      const indent = indentOfCpp(depth, stack, indents, L.codeText, U);
      indents[i] = indent;
      const { units, gaps } = unitsOf(L.parts);
      out.push(
        (" ".repeat(indent) + spaceWalk(units, gaps, "cpp")).replace(/[ \t]+$/, ""),
      );
      for (const u of units) {
        if (!u.code) continue;
        if (u.text === "{") depth++;
        else if (u.text === "}") depth--;
        else if (u.text === "(" || u.text === "[") stack.push(i);
        else if (u.text === ")" || u.text === "]") stack.pop();
      }
    }
  }
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function indentOfCpp(depth, stack, indents, codeText, U) {
  const t = codeText.trimStart();
  if (t.startsWith("}")) return Math.max(0, depth - 1) * U;
  if (depth > 0 && CPP_LABEL_RE.test(t)) return (depth - 1) * U;
  if (stack.length) {
    const oi = indents[stack[stack.length - 1]];
    return Math.max(0, oi) + U;
  }
  return Math.max(0, depth) * U;
}

/* ---------- Python ---------- */

export function formatPython(code, opts = {}) {
  const U = opts.indent ?? 4;
  if (!code) return code;
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const scanned = [];
  let st = { inTriple: null };
  for (const raw of lines) {
    const r = scanPyLine(raw, st);
    st = r.st;
    scanned.push({ raw, parts: r.parts, splice: raw.endsWith("\\") });
  }
  const out = [];
  const stack = []; // 未闭合括号 {indent}（跨行语句的续行缩进，语义安全）
  let blankRun = 0;
  for (const L of scanned) {
    const verbatimOnly =
      L.parts.length > 0 &&
      L.parts[0].verbatim &&
      !L.parts.some((p) => p.code);
    if (verbatimOnly || L.splice) {
      // 三引号内部 / \ 续行：一个字符都不能动（空行也不折叠——那是字符串内容）
      out.push(L.raw);
      continue;
    }
    const { units, gaps } = unitsOf(L.parts);
    const firstCode = units.find((u) => u.code);
    if (!firstCode) {
      if (!units.length) {
        blankRun++;
        if (blankRun <= 2) out.push("");
      } else {
        blankRun = 0;
        out.push(normalizePyIndent(L.raw.replace(/\s+$/, ""), U));
      }
      continue;
    }
    blankRun = 0;
    let lead = /^[ \t]*/.exec(L.raw)[0];
    if (/^\t+$/.test(lead)) lead = " ".repeat(lead.length * U);
    if (stack.length) {
      if (CLOSERS.has(firstCode.text)) {
        lead = " ".repeat(stack[0].indent); // 闭括号行回到本逻辑行起始缩进
      } else {
        lead = " ".repeat(stack[stack.length - 1].indent + U);
      }
    }
    if (L.parts.some((p) => p.unterminated)) {
      out.push(lead + L.raw.trim()); // 字面量未闭合：保守只调缩进
    } else {
      out.push((lead + spaceWalk(units, gaps, "python", stack.length > 0)).replace(/[ \t]+$/, ""));
    }
    for (const u of units) {
      if (!u.code) continue;
      if ("([{".includes(u.text)) stack.push({ indent: lead.length });
      else if (CLOSERS.has(u.text)) stack.pop();
    }
  }
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function normalizePyIndent(line, U) {
  const lead = /^[ \t]*/.exec(line)[0];
  if (/^\t+$/.test(lead))
    return " ".repeat(lead.length * U) + line.slice(lead.length);
  return line;
}

export function formatCode(lang, code, opts) {
  return lang === "python" ? formatPython(code, opts) : formatCpp(code, opts);
}
