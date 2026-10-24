/**
 * 移动端编程键盘的键位布局（按语言区分，模块级常量供 KbKey memo 生效）。
 *
 * 布局依据（2026-10 统计，方法：剥离字符串/注释后逐字符 + 多字符操作符计数）：
 *  - Python：本仓库存量题解代码块 1625 段（约 129 万字符）的真实竞赛语料；
 *  - C++：仓库竞赛测试矩阵 + E2E 的 94 段竞赛向 C++（上游题解是 Python，无 C++ 语料）。
 *
 * 单字符频率（次）与设计取舍：
 *  - C++：< 827 · ; 509 · ( ) 501 · \ 436（"\n" 转义）· " 310 · , 264 · . 260 ·
 *    > 212 · { } 205 · + 195 · = 151 —— 主页常驻 ; , . ( ) < > "（" 比 . 高，
 *    空格位从 3 缩到 2 腾出第六个符号槽）；
 *  - Python：( ) 28.7k · = 28.1k · [ ] 24k · : 14.7k · , 11.7k · _ 6.2k ·
 *    * 6.1k · . 6k · ' 5.4k（" 仅 46，单引号占绝对主流）· ; 全语料仅 4 次 ——
 *    主页用 : _ [ ] , 换掉 C++ 布局的 ; ,（语言感知，随面板语言切换）。
 *
 * 符号页按频率排序（行优先、高频在左上），第三行整行放**组合符一击键**
 * （<< == += 等，一键插完双字符，省去双击合并的节奏等待）：
 *  - C++ 组合符频率：<< 319 · ++ 80 · >> 26 · += 14 · == 11 · :: 10 · <= 6 · != 5；
 *  - Python 组合符频率：+= 873 · == 854 · -= 345 · <= 230 · != 223 · ** 218 ·
 *    >= 205 · << 131 · >> 29（// 为整除常用键补入）。
 *
 * Shift+数字行 = !@#$%^&*()（NUM_SHIFT），符号页不再重复这些符号（C++ 保留 # 与
 * ! 的直达键——#include/#define/!= 的输入流里翻页代价高）。
 */

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((ch) => ({
  ch,
}));
const LETTERS = (row) => row.map((ch) => ({ ch }));

const SHIFT_KEY = { action: "shift", title: "大写（双击锁定）" };
const BACKSPACE_KEY = {
  action: "backspace",
  title: "退格（长按连删）",
  hold: true,
};
const ENTER_KEY = { action: "enter", title: "回车" };
const SPACE = (span) => ({ ch: " ", span, title: "空格" });
const SYM_PAGE_KEY = { page: "sym", label: "#+=", title: "符号页" };
const ABC_PAGE_KEY = { page: "abc", label: "ABC", title: "字母页" };
const KEY = (ch) => ({ ch });

export const KB_LAYOUTS = {
  cpp: {
    label: "C++",
    abc: [
      DIGITS,
      LETTERS("qwertyuiop".split("")),
      [...LETTERS("asdfghjkl".split("")), KEY(";")],
      [SHIFT_KEY, ...LETTERS("zxcvbnm".split("")), KEY(","), BACKSPACE_KEY],
    ],
    sym: [
      ["{", "}", "=", "+", "-", "*", "/", "%", "_", "\\"].map(KEY),
      ["[", "]", ":", "#", "&", "|", "'", "~", "?", "!"].map(KEY),
      ["<<", ">>", "==", "!=", "<=", ">=", "&&", "||", "->", "::"].map(KEY),
    ],
    bottom: {
      // ( ) < > " . ：C++ 高频符号前六（; , 已在字母行）
      abc: [
        SYM_PAGE_KEY,
        KEY("("),
        KEY(")"),
        KEY("<"),
        KEY(">"),
        KEY('"'),
        KEY("."),
        SPACE(2),
        ENTER_KEY,
      ],
      sym: [
        ABC_PAGE_KEY,
        KEY(";"),
        KEY("."),
        SPACE(5),
        BACKSPACE_KEY,
        ENTER_KEY,
      ],
    },
  },
  python: {
    label: "Python",
    abc: [
      DIGITS,
      LETTERS("qwertyuiop".split("")),
      [...LETTERS("asdfghjkl".split("")), KEY(":")],
      [SHIFT_KEY, ...LETTERS("zxcvbnm".split("")), KEY("_"), BACKSPACE_KEY],
    ],
    sym: [
      ["=", "+", "-", "*", "/", "'", '"', "%", "\\", "!"].map(KEY),
      ["{", "}", "<", ">", "#", "&", "|", "^", "~", "?"].map(KEY),
      ["+=", "==", "-=", "<=", "!=", "**", ">=", "<<", ">>", "//"].map(KEY),
    ],
    bottom: {
      // , ( ) [ ] . ：Python 高频符号前六（: _ 已在字母行）
      abc: [
        SYM_PAGE_KEY,
        KEY(","),
        KEY("("),
        KEY(")"),
        KEY("["),
        KEY("]"),
        KEY("."),
        SPACE(2),
        ENTER_KEY,
      ],
      sym: [
        ABC_PAGE_KEY,
        KEY(","),
        KEY("."),
        SPACE(5),
        BACKSPACE_KEY,
        ENTER_KEY,
      ],
    },
  },
};

export function kbLayout(lang) {
  return KB_LAYOUTS[lang] ?? KB_LAYOUTS.cpp;
}
