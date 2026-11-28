/**
 * 样例对拍纯函数（node --test 可测，禁止 import 浏览器 API）。
 *
 * 判题归一化与常见 OJ 一致：行尾空白忽略、文末空行忽略、\r 归一。
 */

/** 展示用截断。 */
export function truncate(s, max = 4000) {
  const str = String(s ?? '');
  return str.length <= max ? str : `${str.slice(0, max)}\n…（截断，共 ${str.length} 字符）`;
}

/** 归一化：去 \r、去每行行尾空白、去文末空行。 */
export function normalizeOutput(s) {
  const lines = String(s ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 对拍。
 * @returns {{verdict:'AC'|'WA', diff: {line:number, expected:string, actual:string}|null, expected:string, actual:string}}
 */
export function judgeCase(expected, actual) {
  const e = normalizeOutput(expected);
  const a = normalizeOutput(actual);
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i++) {
    if (e[i] !== a[i]) {
      return {
        verdict: 'WA',
        diff: { line: i + 1, expected: e[i] ?? '<无输出>', actual: a[i] ?? '<无输出>' },
        expected: e.join('\n'),
        actual: a.join('\n'),
      };
    }
  }
  return { verdict: 'AC', diff: null, expected: e.join('\n'), actual: a.join('\n') };
}
