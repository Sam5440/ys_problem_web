/**
 * lib/compiler/format.js 单测：C++ / Python 安全格式化器。
 *
 * 重点钉三类不变式：
 * 1. 语义安全：模板尖括号、`<=>`/`>>=`、Python 块缩进、字符串与注释内容
 *    一律不被改写；
 * 2. 修复行为：缩进重排、逗号/分号空格、kwarg= 与顶层 = 的 black 语义、
 *    续行悬挂缩进；
 * 3. 幂等：format(format(x)) === format(x)。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { formatCpp, formatPython, formatCode } from "../../lib/compiler/format.js";

const cpp = (src) => formatCpp(src);
const py = (src) => formatPython(src);

/* ---------------- C++ ---------------- */

test("C++ 缩进重排 + 花括号深度", () => {
  const got = cpp(`int main(){
int x=1;
if(x){
cout<<"a"<<endl;
}
}`);
  assert.equal(
    got,
    `int main() {
    int x = 1;
    if (x) {
        cout<<"a"<<endl;
    }
}
`,
  );
});

test("C++ 模板尖括号绝不加空格", () => {
  const src = `vector<vector<int>>v;map<int,int>mp;auto f=a<b<c>(d);`;
  const got = cpp(src);
  assert.ok(!got.includes("vector <"), got);
  assert.ok(!got.includes("int >"), got);
  assert.ok(got.includes("vector<vector<int>>v;"), got);
  // 模板内逗号加空格合法且 clang-format 同款；关键字在 <> 空格上绝不动
  assert.ok(got.includes("map<int, int>mp;"), got);
  assert.ok(got.includes("a<b<c>(d)"), got);
});

test("C++ 三路比较 <=> 与 >>= 不被拆开", () => {
  const got = cpp(`auto c=a<=>b;int x;x>>=2;cout<<(a<=>b==0);`);
  assert.ok(got.includes("a<=>b"), got);
  assert.ok(got.includes(">>="), got);
  assert.ok(!got.includes("< ="), got);
  assert.ok(!got.includes("> >"), got);
});

test("C++ 字符串内容原样（含 == 与多余空格）", () => {
  const got = cpp(`cout<<"a  ==  b, c"<<'d';`);
  assert.ok(got.includes(`"a  ==  b, c"`), got);
  assert.ok(got.includes("'d'"), got);
});

test("C++ case/default 标签缩进（LLVM 风格：与 switch 同列）", () => {
  const got = cpp(`int main(){
switch(x){
case 1:
break;
default:
break;
}
}`);
  assert.equal(
    got,
    `int main() {
    switch (x) {
    case 1:
        break;
    default:
        break;
    }
}
`,
  );
});

test("C++ 预处理行归零缩进、不参与深度跟踪", () => {
  const got = cpp(`    #include <bits/stdc++.h>
    #define REP(i) for(int i=0;i<3;i++){
int main(){
}`);
  assert.ok(got.startsWith("#include <bits/stdc++.h>\n#define"), got);
  assert.equal(got, `#include <bits/stdc++.h>
#define REP(i) for(int i=0;i<3;i++){
int main() {
}
`);
});

test("C++ 逗号/分号空格（for 头部）", () => {
  const got = cpp(`for(int i=0;i<n;++i)g(a,b,c);`);
  assert.ok(got.includes("for (int i = 0; i<n; ++i)g(a, b, c);"), got);
});

test("C++ 关键字后补空格 if( → if (", () => {
  const got = cpp(`if(x){while(y--){}}`);
  assert.ok(got.includes("if (x)"), got);
  assert.ok(got.includes("while (y--)"), got);
});

test("C++ 连续空行折叠为一、文末单个换行", () => {
  const got = cpp(`int a;



int b;   `);
  assert.equal(got, "int a;\n\nint b;\n");
});

test("C++ 贴邻双目运算符补空格，已有空格的不动", () => {
  const got = cpp(`int x=a+b*c;int y = a - b;int*p;int* q;int *r;`);
  assert.ok(got.includes("a + b * c"), got);
  assert.ok(got.includes("a - b"), got);
  assert.ok(got.includes("int*p;") || got.includes("int * p;"), got); // 指针声明只是美观问题，不崩即可
});

test("科学计数法指数符号绝不加空格（C++/Python）", () => {
  assert.equal(py(`l,r=1e-9,1e9`), "l, r = 1e-9, 1e9\n");
  assert.equal(py(`x=2.5e+3`), "x = 2.5e+3\n");
  assert.ok(cpp(`double x=1e-9;`).includes("x = 1e-9"), "");
  // 标识符结尾的 e 仍按减号处理
  assert.equal(py(`he=9\ny=he-2`), "he = 9\ny = he - 2\n");
});

test("C++ 括号悬挂缩进（未闭合圆括号续行）", () => {
  const got = cpp(`int x=foo(a,
b,c);`);
  assert.equal(
    got,
    `int x = foo(a,
    b, c);
`,
  );
});

test("C++ 块注释跨行原样保留", () => {
  const got = cpp(`int a;/*
  注释里的   空格 与 {
*/int b;`);
  assert.ok(got.includes("  注释里的   空格 与 {"), got);
  assert.ok(got.includes("*/int b;") || got.includes("*/ int b;"), got);
});

test("C++ 原始字符串 R\"(...)\" 原样保留", () => {
  const got = cpp(`auto s=R"(a,b == c)";cout<<s;`);
  assert.ok(got.includes('R"(a,b == c)"'), got);
});

test("C++ << 不加空格（模板歧义防御，贴题习惯 cin>>x 保留）", () => {
  const got = cpp(`cin>>x;cout<<y;`);
  assert.ok(got.includes("cin>>x"), got);
  assert.ok(got.includes("cout<<y"), got);
});

/* ---------------- Python ---------------- */

test("Python 逗号/列表空格", () => {
  assert.equal(py(`a=[1,2,3]`), "a = [1, 2, 3]\n");
  assert.equal(py(`f( a , b )`), "f(a, b)\n");
});

test("Python 实参内 = 去空格、顶层 = 加空格（black 语义）", () => {
  assert.equal(py(`f(x = 1)`), "f(x=1)\n");
  assert.equal(py(`x=1`), "x = 1\n");
  assert.equal(py(`def f(x: int = 1):\n    pass`), "def f(x: int = 1):\n    pass\n");
});

test("Python 字典冒号加空格、下标切片不动", () => {
  assert.equal(py(`d={"a":1,"b":2}`), 'd = {"a": 1, "b": 2}\n');
  assert.equal(py(`x=a[1:2]`), "x = a[1:2]\n");
  assert.equal(py(`y=s[::2]`), "y = s[::2]\n");
});

test("Python 块缩进绝不重排", () => {
  const src = `def f():
x = 1
    return x`;
  // 这段是非法 Python（缩进错误），格式化只动空格不动缩进结构
  assert.equal(py(src), "def f():\nx = 1\n    return x\n");
});

test("Python 括号续行悬挂缩进 + 闭括号回退", () => {
  const got = py(`x = foo(
a, b)
y = [
  1,
   2,
]`);
  assert.equal(
    got,
    `x = foo(
    a, b)
y = [
    1,
    2,
]
`,
  );
});

test("Python 三引号字符串内容逐字保留（含空行与缩进）", () => {
  const src = `s = """
  a,  b = c


""";`;
  assert.equal(py(src), src.replace(/;\n?$/, ";") + "\n");
});

test("Python f-string 与注解箭头", () => {
  assert.equal(py(`print(f"{x=}")`), 'print(f"{x=}")\n');
  assert.equal(py(`def g(x:int)->int:return x`), "def g(x: int) -> int: return x\n");
});

test("Python 海象运算符与 ** //", () => {
  assert.equal(py(`if(n:=len(a))>0:pass`), "if (n := len(a))>0: pass\n");
  assert.equal(py(`b=a**2//3`), "b = a ** 2 // 3\n");
  // 复合赋值 //= **= <<= >>= 绝不能拆成 `a // = 10`（真机语料回归）
  assert.equal(py(`a//=10`), "a //= 10\n");
  assert.equal(py(`b**=2`), "b **= 2\n");
  assert.equal(py(`c<<=1`), "c <<= 1\n");
});

test("Python 纯 Tab 行首转空格、行尾空白去除", () => {
  assert.equal(py("if x:\n\tpass\t\n"), "if x:\n    pass\n");
});

test("Python 注释内容原样", () => {
  assert.equal(py(`x=1  #  注释   空格 `), "x = 1 #  注释   空格\n");
});

/* ---------------- 通用 ---------------- */

test("幂等：二次格式化不再改动", () => {
  const cppSrc = `#include <bits/stdc++.h>
using namespace std;
int main(){int n;cin>>n;vector<int>a(n);for(auto&x:a)cin>>x;sort(a.begin(),a.end());for(int i=0;i<n;++i)cout<<a[i]<<" \n"[i+1==n];}
`;
  const pySrc = `import sys
def main():
 n,k=map(int,sys.stdin.readline().split())
 print(f"{n=}", [i**2 for i in range(n) if i%2==0])
main()
`;
  for (const [lang, src] of [
    ["cpp", cppSrc],
    ["python", pySrc],
  ]) {
    const once = formatCode(lang, src);
    const twice = formatCode(lang, once);
    assert.equal(twice, once, `${lang} 二次格式化仍有改动:\n${once}\n->\n${twice}`);
  }
});

test("空输入直通", () => {
  assert.equal(formatCpp(""), "");
  assert.equal(formatPython(""), "");
});
