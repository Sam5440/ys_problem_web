/**
 * 编译器补全数据层：竞赛向 C++/Python 静态补全表 + 签名提示 + hover 文档。
 *
 * 纯数据 + 纯函数（node/浏览器同源，可单测），Monaco 适配在 CodeEditor.jsx。
 * 设计参考 VS Code 的补全模型：
 *  - 补全项带 detail（右侧灰字签名摘要）与 documentation（悬浮文档）
 *  - 输入函数名后打 `(` 触发 signature help（参数高亮），`,` 切参数
 *  - 悬停标识符显示原型 + 说明（hover provider）
 *  - `#include <` 补全头文件名
 *  - `.`/`->`/`::` 成员访问：静态通用成员表即时出，clang -code-completion-at
 *    异步补精确项（CodeEditor 负责防抖与竞态丢弃）
 *
 * C++ 表全部是裸名（竞赛代码 `using namespace std;` 后的书写形态）——
 * 首版带 std:: 前缀导致输入 co 无任何补全的根因就在前缀不匹配。
 */

/* ---------------- C++ ---------------- */

// 高频函数：signature 用于补全详情/签名提示/hover，snippet 插入带参数占位
export const CPP_FUNCTIONS = [
  { label: 'sort', signature: 'void sort(RandomIt first, RandomIt last, Compare comp = {})', snippet: 'sort(${1:first}, ${2:last})', doc: '区间排序，默认升序；第三参可传 greater<>() 或 lambda 降序/自定义' },
  { label: 'stable_sort', signature: 'void stable_sort(RandomIt first, RandomIt last, Compare comp = {})', snippet: 'stable_sort(${1:first}, ${2:last})', doc: '稳定排序，相等元素保持相对顺序' },
  { label: 'max', signature: 'const T& max(const T& a, const T& b)', snippet: 'max(${1:a}, ${2:b})', doc: '二者取大；列表版 max({a, b, c}) 需 initializer_list' },
  { label: 'min', signature: 'const T& min(const T& a, const T& b)', snippet: 'min(${1:a}, ${2:b})', doc: '二者取小' },
  { label: 'max_element', signature: 'ForwardIt max_element(ForwardIt first, ForwardIt last)', snippet: 'max_element(${1:first}, ${2:last})', doc: '区间最大元素的迭代器，取值需再解引用 *' },
  { label: 'min_element', signature: 'ForwardIt min_element(ForwardIt first, ForwardIt last)', snippet: 'min_element(${1:first}, ${2:last})', doc: '区间最小元素的迭代器' },
  { label: 'lower_bound', signature: 'ForwardIt lower_bound(ForwardIt first, ForwardIt last, const T& value)', snippet: 'lower_bound(${1:first}, ${2:last}, ${3:value})', doc: '有序区间二分：第一个 >= value 的位置' },
  { label: 'upper_bound', signature: 'ForwardIt upper_bound(ForwardIt first, ForwardIt last, const T& value)', snippet: 'upper_bound(${1:first}, ${2:last}, ${3:value})', doc: '有序区间二分：第一个 > value 的位置' },
  { label: 'binary_search', signature: 'bool binary_search(ForwardIt first, ForwardIt last, const T& value)', snippet: 'binary_search(${1:first}, ${2:last}, ${3:value})', doc: '有序区间二分存在性判断' },
  { label: 'reverse', signature: 'void reverse(BidirIt first, BidirIt last)', snippet: 'reverse(${1:first}, ${2:last})', doc: '区间反转' },
  { label: 'unique', signature: 'ForwardIt unique(ForwardIt first, ForwardIt last)', snippet: 'unique(${1:first}, ${2:last})', doc: '相邻去重（需先排序），返回新尾；配合 erase 收缩' },
  { label: 'next_permutation', signature: 'bool next_permutation(BidirIt first, BidirIt last)', snippet: 'next_permutation(${1:first}, ${2:last})', doc: '字典序下一排列；已是最大排列时返回 false 并重置为最小' },
  { label: 'prev_permutation', signature: 'bool prev_permutation(BidirIt first, BidirIt last)', snippet: 'prev_permutation(${1:first}, ${2:last})', doc: '字典序上一排列' },
  { label: 'accumulate', signature: 'T accumulate(InputIt first, InputIt last, T init)', snippet: 'accumulate(${1:first}, ${2:last}, ${3:0})', doc: '区间求和/折叠（头 <numeric>），第三参初值决定返回类型' },
  { label: 'count', signature: 'ptrdiff_t count(InputIt first, InputIt last, const T& value)', snippet: 'count(${1:first}, ${2:last}, ${3:value})', doc: '区间内等于 value 的元素个数' },
  { label: 'find', signature: 'InputIt find(InputIt first, InputIt last, const T& value)', snippet: 'find(${1:first}, ${2:last}, ${3:value})', doc: '顺序查找，返回迭代器；找不到返回 last' },
  { label: 'fill', signature: 'void fill(ForwardIt first, ForwardIt last, const T& value)', snippet: 'fill(${1:first}, ${2:last}, ${3:value})', doc: '区间赋值；数组常用 fill(a, a + n, v)' },
  { label: 'swap', signature: 'void swap(T& a, T& b)', snippet: 'swap(${1:a}, ${2:b})', doc: '交换两个对象' },
  { label: 'abs', signature: 'int abs(int n)', snippet: 'abs(${1:n})', doc: '绝对值；long long 用 llabs 或 std::abs<ll> 重载' },
  { label: 'gcd', signature: 'constexpr Int gcd(Int m, Int n)', snippet: 'gcd(${1:m}, ${2:n})', doc: '最大公约数（头 <numeric>）' },
  { label: 'lcm', signature: 'constexpr Int lcm(Int m, Int n)', snippet: 'lcm(${1:m}, ${2:n})', doc: '最小公倍数（头 <numeric>）' },
  { label: 'to_string', signature: 'string to_string(int value)', snippet: 'to_string(${1:value})', doc: '数值转字符串（另有 long long/double 重载）' },
  { label: 'stoi', signature: 'int stoi(const string& str, size_t* pos = 0, int base = 10)', snippet: 'stoi(${1:str})', doc: '字符串转 int；stoll 转 long long' },
  { label: 'stoll', signature: 'long long stoll(const string& str, size_t* pos = 0, int base = 10)', snippet: 'stoll(${1:str})', doc: '字符串转 long long' },
  { label: 'getline', signature: 'istream& getline(istream& is, string& str)', snippet: 'getline(cin, ${1:s})', doc: '读一整行（含空格）；与 cin >> 混用注意吃掉换行符' },
  { label: 'make_pair', signature: 'pair<T1, T2> make_pair(T1&& t1, T2&& t2)', snippet: 'make_pair(${1:a}, ${2:b})', doc: '构造 pair（C++17 起可用花括号 {a, b} 推导）' },
  { label: 'make_tuple', signature: 'tuple<Ts...> make_tuple(Ts&&... args)', snippet: 'make_tuple(${1:a}, ${2:b})', doc: '构造 tuple' },
  { label: 'sqrt', signature: 'double sqrt(double x)', snippet: 'sqrt(${1:x})', doc: '平方根（cmath）；整数上取整小心精度，常用 while 循环' },
  { label: 'pow', signature: 'double pow(double base, double exp)', snippet: 'pow(${1:base}, ${2:exp})', doc: '幂（浮点，有精度风险）；整数快速幂建议手写' },
  { label: 'floor', signature: 'double floor(double x)', snippet: 'floor(${1:x})', doc: '向下取整；转 long long 记得显式 (long long)' },
  { label: 'ceil', signature: 'double ceil(double x)', snippet: 'ceil(${1:x})', doc: '向上取整；正整数除法上取整惯用法 (a + b - 1) / b' },
  { label: '__builtin_popcount', signature: 'int __builtin_popcount(unsigned int x)', snippet: '__builtin_popcount(${1:x})', doc: '二进制 1 的个数（unsigned long long 用 __builtin_popcountll）' },
  { label: '__builtin_popcountll', signature: 'int __builtin_popcountll(unsigned long long x)', snippet: '__builtin_popcountll(${1:x})', doc: '64 位二进制 1 的个数' },
];

// 容器/类型：kind=Class；打字时与函数一起出
export const CPP_TYPES = [
  { label: 'vector', signature: 'std::vector<T>', doc: '动态数组 vector<int> v(n, init)；二维 vector<vector<int>>' },
  { label: 'map', signature: 'std::map<K, V>', doc: '有序键值表（红黑树），[] 不存在时默认插入 0' },
  { label: 'set', signature: 'std::set<K>', doc: '有序去重集合，count/find/lower_bound 可用' },
  { label: 'unordered_map', signature: 'std::unordered_map<K, V>', doc: '哈希键值表，查询 O(1)；被卡常用 map 代替' },
  { label: 'unordered_set', signature: 'std::unordered_set<K>', doc: '哈希去重集合' },
  { label: 'multiset', signature: 'std::multiset<K>', doc: '有序可重集合；删除单元素先 find 再 erase(it)' },
  { label: 'multimap', signature: 'std::multimap<K, V>', doc: '有序键可重复键值表' },
  { label: 'priority_queue', signature: 'std::priority_queue<T, Container, Compare>', doc: '默认大根堆；小根堆 priority_queue<int, vector<int>, greater<>>' },
  { label: 'queue', signature: 'std::queue<T>', doc: 'FIFO 队列：push/front/pop' },
  { label: 'stack', signature: 'std::stack<T>', doc: 'LIFO 栈：push/top/pop' },
  { label: 'deque', signature: 'std::deque<T>', doc: '双端队列：push_back/push_front/pop_back/pop_front' },
  { label: 'pair', signature: 'std::pair<T1, T2>', doc: '二元组 first/second；默认按 first 再 second 比较' },
  { label: 'tuple', signature: 'std::tuple<Ts...>', doc: '多元组，get<i>(t) 取值' },
  { label: 'array', signature: 'std::array<T, N>', doc: '定长数组封装，带 size/begin/end' },
  { label: 'bitset', signature: 'std::bitset<N>', doc: '定长位集，count/_Find_first/_Find_next 常用于子集 DP' },
  { label: 'string', signature: 'std::string', doc: '字符串，substr/size/find/c_str' },
  { label: 'function', signature: 'std::function<R(Args...)>', doc: '通用可调用包装（递归 lambda 需它承接）' },
  { label: 'unique_ptr', signature: 'std::unique_ptr<T>', doc: '独占所有权智能指针' },
  { label: 'shared_ptr', signature: 'std::shared_ptr<T>', doc: '共享所有权智能指针' },
];

// 对象/常量：kind=Variable
export const CPP_OBJECTS = [
  { label: 'cout', signature: 'std::ostream cout', doc: '标准输出流；endl 输出换行并冲刷缓冲' },
  { label: 'cin', signature: 'std::istream cin', doc: '标准输入流；>> 跳过空白读 token' },
  { label: 'cerr', signature: 'std::ostream cerr', doc: '标准错误流（无缓冲，调试用）' },
  { label: 'endl', signature: '<换行并冲刷缓冲>', doc: ' manipulator：输出 \\n 并 flush；竞赛大量输出时用 "\\n" 更快' },
];

// 通用成员表：`.`/`->` 后即时兜底（clang 精确补全异步补充）
export const CPP_MEMBERS = [
  { label: 'size', signature: 'size_t size() const', snippet: 'size()', doc: '元素个数' },
  { label: 'empty', signature: 'bool empty() const', snippet: 'empty()', doc: '是否为空' },
  { label: 'clear', signature: 'void clear()', snippet: 'clear()', doc: '清空' },
  { label: 'push_back', signature: 'void push_back(const T& value)', snippet: 'push_back(${1:value})', doc: '尾部追加（vector/deque/list）' },
  { label: 'pop_back', signature: 'void pop_back()', snippet: 'pop_back()', doc: '删除尾部元素' },
  { label: 'emplace_back', signature: 'template<class... Args> reference emplace_back(Args&&... args)', snippet: 'emplace_back(${1:args})', doc: '原位构造尾部元素，省一次拷贝' },
  { label: 'push', signature: 'void push(const T& value)', snippet: 'push(${1:value})', doc: 'queue/stack/priority_queue 入队/入栈' },
  { label: 'pop', signature: 'void pop()', snippet: 'pop()', doc: 'queue/stack 出队/出栈（不返回值）' },
  { label: 'front', signature: 'T& front()', snippet: 'front()', doc: '首元素（queue/deque/string）' },
  { label: 'back', signature: 'T& back()', snippet: 'back()', doc: '尾元素（vector/deque/string/stack）' },
  { label: 'top', signature: 'T& top()', snippet: 'top()', doc: '栈顶/堆顶（stack/priority_queue）' },
  { label: 'begin', signature: 'iterator begin()', snippet: 'begin()', doc: '首元素迭代器（配合算法/range-for）' },
  { label: 'end', signature: 'iterator end()', snippet: 'end()', doc: '尾后迭代器' },
  { label: 'rbegin', signature: 'reverse_iterator rbegin()', snippet: 'rbegin()', doc: '反向首迭代器（倒序遍历）' },
  { label: 'rend', signature: 'reverse_iterator rend()', snippet: 'rend()', doc: '反向尾后迭代器' },
  { label: 'insert', signature: 'iterator insert(const_iterator pos, const T& value)', snippet: 'insert(${1:pos}, ${2:value})', doc: '插入；set/map 用 insert(value)' },
  { label: 'erase', signature: 'iterator erase(const_iterator pos)', snippet: 'erase(${1:pos})', doc: '删除迭代器处元素；按值删 map/set 用 erase(key)' },
  { label: 'find', signature: 'iterator find(const Key& key)', snippet: 'find(${1:key})', doc: '查找，返回迭代器；找不到返回 end()' },
  { label: 'count', signature: 'size_type count(const Key& key) const', snippet: 'count(${1:key})', doc: '键出现次数（set/map 只会是 0/1）' },
  { label: 'at', signature: 'T& at(size_type pos)', snippet: 'at(${1:pos})', doc: '带越界检查的访问（越界抛异常——本运行时异常被禁用，慎用）' },
  { label: 'substr', signature: 'string substr(size_t pos = 0, size_t count = npos) const', snippet: 'substr(${1:pos}, ${2:len})', doc: '取子串' },
  { label: 'c_str', signature: 'const char* c_str() const', snippet: 'c_str()', doc: '取 C 风格字符串（printf %s 输出 string 用）' },
  { label: 'length', signature: 'size_t length() const', snippet: 'length()', doc: '字符串长度（等价 size()）' },
  { label: 'append', signature: 'string& append(const string& str)', snippet: 'append(${1:str})', doc: '追加字符串（等价 +=）' },
  { label: 'resize', signature: 'void resize(size_t count)', snippet: 'resize(${1:n})', doc: '改变元素个数' },
  { label: 'reserve', signature: 'void reserve(size_t new_cap)', snippet: 'reserve(${1:n})', doc: '预分配容量，防 vector 扩容抖动' },
  { label: 'first', signature: 'T1 first', snippet: 'first', doc: 'pair 第一成员' },
  { label: 'second', signature: 'T2 second', snippet: 'second', doc: 'pair 第二成员' },
];

// #include < 头文件补全
export const CPP_HEADERS = [
  'bits/stdc++.h', 'iostream', 'vector', 'algorithm', 'map', 'set', 'unordered_map',
  'unordered_set', 'queue', 'stack', 'deque', 'string', 'utility', 'tuple', 'numeric',
  'functional', 'cmath', 'cstring', 'cstdio', 'cstdlib', 'climits', 'bitset', 'list',
  'array', 'random', 'chrono', 'complex', 'sstream', 'fstream',
];

/* ---------------- Python ---------------- */

// 内置函数（带签名，服务补全详情/签名提示/hover）
export const PY_FUNCTIONS = [
  { label: 'print', signature: 'print(*objects, sep=\' \', end=\'\\n\', file=sys.stdout, flush=False)', snippet: 'print(${1:x})', doc: '输出；sep 控分隔、end 控结尾（end="" 不换行）' },
  { label: 'input', signature: 'input(prompt=\'\') -> str', snippet: 'input()', doc: '读一行返回 str（含尾部去掉换行）；读数字要 int(input())' },
  { label: 'int', signature: 'int(x=0, base=10) -> int', snippet: 'int(${1:x})', doc: '转整数；int(input()) 单值、map(int, input().split()) 整行' },
  { label: 'float', signature: 'float(x=0) -> float', snippet: 'float(${1:x})', doc: '转浮点' },
  { label: 'str', signature: 'str(object=\'\') -> str', snippet: 'str(${1:x})', doc: '转字符串' },
  { label: 'bool', signature: 'bool(x=False) -> bool', snippet: 'bool(${1:x})', doc: '转布尔（0/\'\'/[]/None 为 False）' },
  { label: 'list', signature: 'list(iterable=()) -> list', snippet: 'list(${1:iterable})', doc: '转列表' },
  { label: 'dict', signature: 'dict(**kwargs) -> dict', snippet: 'dict(${1:kw})', doc: '建字典；也可用字面量 {}' },
  { label: 'set', signature: 'set(iterable=()) -> set', snippet: 'set(${1:iterable})', doc: '转集合（去重）' },
  { label: 'tuple', signature: 'tuple(iterable=()) -> tuple', snippet: 'tuple(${1:iterable})', doc: '转元组' },
  { label: 'len', signature: 'len(obj) -> int', snippet: 'len(${1:obj})', doc: '长度' },
  { label: 'range', signature: 'range(start, stop[, step]) -> range', snippet: 'range(${1:n})', doc: '左闭右开区间；range(n)/range(a, b)/range(a, b, -1) 倒序' },
  { label: 'sum', signature: 'sum(iterable, start=0) -> number', snippet: 'sum(${1:iterable})', doc: '求和；sum(x, []) 可展平二维列表' },
  { label: 'min', signature: 'min(iterable, *, key=None, default=...) -> value', snippet: 'min(${1:iterable})', doc: '最小值；min(a, b, c) 多参也行，key 定比较键' },
  { label: 'max', signature: 'max(iterable, *, key=None, default=...) -> value', snippet: 'max(${1:iterable})', doc: '最大值' },
  { label: 'abs', signature: 'abs(x) -> number', snippet: 'abs(${1:x})', doc: '绝对值' },
  { label: 'sorted', signature: 'sorted(iterable, *, key=None, reverse=False) -> list', snippet: 'sorted(${1:iterable})', doc: '返回新列表；多键排序 key=lambda x: (x[0], -x[1])' },
  { label: 'reversed', signature: 'reversed(seq) -> iterator', snippet: 'reversed(${1:seq})', doc: '反向迭代器；列表倒序 sorted(a, reverse=True) 或 a[::-1]' },
  { label: 'enumerate', signature: 'enumerate(iterable, start=0) -> iterator', snippet: 'enumerate(${1:iterable})', doc: '带下标遍历 for i, x in enumerate(a)' },
  { label: 'zip', signature: 'zip(*iterables) -> iterator', snippet: 'zip(${1:a}, ${2:b})', doc: '并行遍历多序列 for x, y in zip(a, b)' },
  { label: 'map', signature: 'map(function, *iterables) -> iterator', snippet: 'map(${1:int}, ${2:input().split()})', doc: '映射；读多值惯用法 a, b = map(int, input().split())' },
  { label: 'filter', signature: 'filter(function, iterable) -> iterator', snippet: 'filter(${1:func}, ${2:iterable})', doc: '过滤（function 返回真则保留）' },
  { label: 'any', signature: 'any(iterable) -> bool', snippet: 'any(${1:iterable})', doc: '任一为真' },
  { label: 'all', signature: 'all(iterable) -> bool', snippet: 'all(${1:iterable})', doc: '全部为真' },
  { label: 'divmod', signature: 'divmod(a, b) -> (a // b, a % b)', snippet: 'divmod(${1:a}, ${2:b})', doc: '同时得商和余' },
  { label: 'round', signature: 'round(number, ndigits=None) -> number', snippet: 'round(${1:x}, ${2:n})', doc: '银行家舍入（.5 向偶），格式化输出建议用 f-string' },
  { label: 'pow', signature: 'pow(base, exp[, mod]) -> number', snippet: 'pow(${1:base}, ${2:exp}, ${3:mod})', doc: '三参形式即快速幂取模' },
  { label: 'isinstance', signature: 'isinstance(obj, class_or_tuple) -> bool', snippet: 'isinstance(${1:x}, ${2:int})', doc: '类型判断' },
  { label: 'bin', signature: 'bin(x) -> str', snippet: 'bin(${1:x})', doc: '二进制字符串（带 0b 前缀）' },
  { label: 'hex', signature: 'hex(x) -> str', snippet: 'hex(${1:x})', doc: '十六进制字符串' },
  { label: 'oct', signature: 'oct(x) -> str', snippet: 'oct(${1:x})', doc: '八进制字符串' },
  { label: 'ord', signature: 'ord(c) -> int', snippet: 'ord(${1:c})', doc: '字符转码点' },
  { label: 'chr', signature: 'chr(i) -> str', snippet: 'chr(${1:i})', doc: '码点转字符' },
  { label: 'open', signature: 'open(file, mode=\'r\', encoding=None)', snippet: 'open(${1:path})', doc: '打开文件（竞赛读文件题用）' },
  { label: 'format', signature: 'format(value, format_spec=\'\') -> str', snippet: 'format(${1:value}, ${2:spec})', doc: '格式化；平时更常用 f-string' },
  { label: 'iter', signature: 'iter(iterable) -> iterator', snippet: 'iter(${1:iterable})', doc: '取迭代器' },
  { label: 'next', signature: 'next(iterator[, default])', snippet: 'next(${1:it})', doc: '迭代器取下一项' },
];

// 模块成员：`模块名.` 前缀补全（键含尾点）
export const PY_MEMBER_TABLES = {
  'sys.': [
    { label: 'stdin', signature: 'sys.stdin', doc: '标准输入：sys.stdin.readline() 读行（保留换行，常配 .strip()）' },
    { label: 'stdout', signature: 'sys.stdout', doc: '标准输出；大量输出用 sys.stdout.write' },
    { label: 'stderr', signature: 'sys.stderr', doc: '标准错误' },
    { label: 'setrecursionlimit', signature: 'sys.setrecursionlimit(limit)', snippet: 'setrecursionlimit(${1:300000})', doc: '调大递归上限（默认 1000，深递归必设）' },
    { label: 'exit', signature: 'sys.exit(status=0)', snippet: 'exit(${1:0})', doc: '退出程序' },
    { label: 'maxsize', signature: 'int', doc: '最大 int 值（当正无穷用）' },
    { label: 'version', signature: 'str', doc: 'Python 版本字符串' },
  ],
  'math.': [
    { label: 'sqrt', signature: 'math.sqrt(x) -> float', snippet: 'sqrt(${1:x})', doc: '平方根；整数平方根用 math.isqrt' },
    { label: 'isqrt', signature: 'math.isqrt(n) -> int', snippet: 'isqrt(${1:n})', doc: '整数平方根（向下取整，无浮点误差）' },
    { label: 'floor', signature: 'math.floor(x) -> int', snippet: 'floor(${1:x})', doc: '向下取整（返回 int）' },
    { label: 'ceil', signature: 'math.ceil(x) -> int', snippet: 'ceil(${1:x})', doc: '向上取整（返回 int）' },
    { label: 'gcd', signature: 'math.gcd(*ints) -> int', snippet: 'gcd(${1:a}, ${2:b})', doc: '最大公约数；Python 3.9+ 支持多参' },
    { label: 'lcm', signature: 'math.lcm(*ints) -> int', snippet: 'lcm(${1:a}, ${2:b})', doc: '最小公倍数' },
    { label: 'factorial', signature: 'math.factorial(n) -> int', snippet: 'factorial(${1:n})', doc: '阶乘' },
    { label: 'comb', signature: 'math.comb(n, k) -> int', snippet: 'comb(${1:n}, ${2:k})', doc: '组合数 C(n, k)' },
    { label: 'perm', signature: 'math.perm(n, k=None) -> int', snippet: 'perm(${1:n}, ${2:k})', doc: '排列数 P(n, k)' },
    { label: 'log', signature: 'math.log(x[, base]) -> float', snippet: 'log(${1:x}, ${2:base})', doc: '对数（默认自然对数）' },
    { label: 'log2', signature: 'math.log2(x) -> float', snippet: 'log2(${1:x})', doc: '以 2 为底对数' },
    { label: 'inf', signature: 'float', doc: '正无穷' },
    { label: 'pi', signature: 'float', doc: '圆周率' },
    { label: 'e', signature: 'float', doc: '自然常数' },
  ],
  'collections.': [
    { label: 'deque', signature: 'collections.deque(iterable=(), maxlen=None)', snippet: 'deque(${1:iterable})', doc: '双端队列：append/popleft O(1)，BFS 标配' },
    { label: 'Counter', signature: 'collections.Counter(iterable=None)', snippet: 'Counter(${1:iterable})', doc: '计数器：Counter(s).most_common(k)' },
    { label: 'defaultdict', signature: 'collections.defaultdict(default_factory)', snippet: 'defaultdict(${1:int})', doc: '带默认值字典：defaultdict(int)/defaultdict(list)' },
    { label: 'OrderedDict', signature: 'collections.OrderedDict()', snippet: 'OrderedDict()', doc: '保持插入序字典（3.7+ 普通 dict 已有序）' },
  ],
  'heapq.': [
    { label: 'heapify', signature: 'heapq.heapify(x)', snippet: 'heapify(${1:list})', doc: '原地把列表变成小根堆' },
    { label: 'heappush', signature: 'heapq.heappush(heap, item)', snippet: 'heappush(${1:heap}, ${2:item})', doc: '入堆（小根堆；大根堆存负数）' },
    { label: 'heappop', signature: 'heapq.heappop(heap) -> item', snippet: 'heappop(${1:heap})', doc: '弹出堆顶（最小值）' },
    { label: 'heapreplace', signature: 'heapq.heapreplace(heap, item) -> item', snippet: 'heapreplace(${1:heap}, ${2:item})', doc: '先弹再入，比 heappop+heappush 快' },
    { label: 'heappushpop', signature: 'heapq.heappushpop(heap, item) -> item', snippet: 'heappushpop(${1:heap}, ${2:item})', doc: '先入再弹' },
    { label: 'nlargest', signature: 'heapq.nlargest(n, iterable, key=None) -> list', snippet: 'nlargest(${1:n}, ${2:iterable})', doc: '前 n 大' },
    { label: 'nsmallest', signature: 'heapq.nsmallest(n, iterable, key=None) -> list', snippet: 'nsmallest(${1:n}, ${2:iterable})', doc: '前 n 小' },
  ],
  'bisect.': [
    { label: 'bisect_left', signature: 'bisect.bisect_left(a, x) -> int', snippet: 'bisect_left(${1:a}, ${2:x})', doc: '第一个 >= x 的插入点' },
    { label: 'bisect_right', signature: 'bisect.bisect_right(a, x) -> int', snippet: 'bisect_right(${1:a}, ${2:x})', doc: '第一个 > x 的插入点（别名 bisect）' },
    { label: 'insort_left', signature: 'bisect.insort_left(a, x)', snippet: 'insort_left(${1:a}, ${2:x})', doc: '有序插入（左端）' },
    { label: 'insort_right', signature: 'bisect.insort_right(a, x)', snippet: 'insort_right(${1:a}, ${2:x})', doc: '有序插入（右端）' },
  ],
  'itertools.': [
    { label: 'permutations', signature: 'itertools.permutations(iterable, r=None)', snippet: 'permutations(${1:iterable})', doc: '全排列' },
    { label: 'combinations', signature: 'itertools.combinations(iterable, r)', snippet: 'combinations(${1:iterable}, ${2:r})', doc: '组合' },
    { label: 'product', signature: 'itertools.product(*iterables, repeat=1)', snippet: 'product(${1:a}, ${2:b})', doc: '笛卡尔积（多重循环替代）' },
    { label: 'accumulate', signature: 'itertools.accumulate(iterable[, func])', snippet: 'accumulate(${1:iterable})', doc: '前缀和/累积' },
    { label: 'groupby', signature: 'itertools.groupby(iterable, key=None)', snippet: 'groupby(${1:iterable})', doc: '相邻分组（先排序再用）' },
    { label: 'chain', signature: 'itertools.chain(*iterables)', snippet: 'chain(${1:a}, ${2:b})', doc: '串联多个可迭代对象' },
  ],
  'functools.': [
    { label: 'lru_cache', signature: 'functools.lru_cache(maxsize=128)', snippet: '@lru_cache(maxsize=None)\n', doc: '记忆化装饰器；递归 DP 标配（放 def 上一行）' },
    { label: 'cache', signature: 'functools.cache', snippet: '@cache\n', doc: 'lru_cache(maxsize=None) 简写' },
    { label: 'reduce', signature: 'functools.reduce(function, iterable[, initial])', snippet: 'reduce(${1:func}, ${2:iterable})', doc: '折叠归约' },
    { label: 'cmp_to_key', signature: 'functools.cmp_to_key(func)', snippet: 'cmp_to_key(${1:func})', doc: '把比较函数转 sorted 的 key' },
  ],
  'string.': [
    { label: 'ascii_lowercase', signature: 'str', doc: "'abcdefghijklmnopqrstuvwxyz'" },
    { label: 'ascii_uppercase', signature: 'str', doc: '大写字母表' },
    { label: 'ascii_letters', signature: 'str', doc: '大小写合并' },
    { label: 'digits', signature: 'str', doc: "'0123456789'" },
  ],
  'random.': [
    { label: 'randint', signature: 'random.randint(a, b) -> int', snippet: 'randint(${1:a}, ${2:b})', doc: '[a, b] 闭区间随机整数' },
    { label: 'shuffle', signature: 'random.shuffle(x)', snippet: 'shuffle(${1:x})', doc: '原位打乱' },
    { label: 'choice', signature: 'random.choice(seq)', snippet: 'choice(${1:seq})', doc: '随机取一个' },
    { label: 'sample', signature: 'random.sample(population, k)', snippet: 'sample(${1:population}, ${2:k})', doc: '不重复抽样 k 个' },
    { label: 'seed', signature: 'random.seed(a=None)', snippet: 'seed(${1:n})', doc: '固定随机种子（对拍/可复现）' },
  ],
  're.': [
    { label: 'findall', signature: 're.findall(pattern, string) -> list', snippet: 'findall(${1:pattern}, ${2:s})', doc: '找全部匹配' },
    { label: 'sub', signature: 're.sub(pattern, repl, string, count=0)', snippet: 'sub(${1:pattern}, ${2:repl}, ${3:s})', doc: '替换' },
    { label: 'match', signature: 're.match(pattern, string)', snippet: 'match(${1:pattern}, ${2:s})', doc: '从头匹配' },
    { label: 'fullmatch', signature: 're.fullmatch(pattern, string)', snippet: 'fullmatch(${1:pattern}, ${2:s})', doc: '整串匹配' },
    { label: 'split', signature: 're.split(pattern, string, maxsplit=0)', snippet: 'split(${1:pattern}, ${2:s})', doc: '正则切分' },
  ],
  'json.': [
    { label: 'loads', signature: 'json.loads(s) -> object', snippet: 'loads(${1:s})', doc: 'JSON 字符串解析' },
    { label: 'dumps', signature: 'json.dumps(obj) -> str', snippet: 'dumps(${1:obj})', doc: '序列化为 JSON 字符串' },
  ],
  'fractions.': [
    { label: 'Fraction', signature: 'fractions.Fraction(numerator=0, denominator=1)', snippet: 'Fraction(${1:a}, ${2:b})', doc: '精确分数运算' },
  ],
  'decimal.': [
    { label: 'Decimal', signature: 'decimal.Decimal(value)', snippet: 'Decimal(${1:s})', doc: '十进制精确浮点（传字符串初始化）' },
  ],
  'statistics.': [
    { label: 'mean', signature: 'statistics.mean(data)', snippet: 'mean(${1:data})', doc: '平均数' },
    { label: 'median', signature: 'statistics.median(data)', snippet: 'median(${1:data})', doc: '中位数' },
    { label: 'mode', signature: 'statistics.mode(data)', snippet: 'mode(${1:data})', doc: '众数' },
  ],
};

// 变量 `.` 通用方法兜底（str/list/dict/set 方法并集，按使用频率）
export const PY_TYPE_MEMBERS = [
  { label: 'split', signature: 'str.split(sep=None, maxsplit=-1) -> list', snippet: 'split()', doc: '切分；split() 按任意空白且吞空串' },
  { label: 'join', signature: 'str.join(iterable) -> str', snippet: 'join(${1:iterable})', doc: '拼接；"-".join(list)' },
  { label: 'strip', signature: 'str.strip(chars=None) -> str', snippet: 'strip()', doc: '去两端空白（读 stdin 常配）' },
  { label: 'lstrip', signature: 'str.lstrip(chars=None) -> str', snippet: 'lstrip()', doc: '去左端空白' },
  { label: 'rstrip', signature: 'str.rstrip(chars=None) -> str', snippet: 'rstrip()', doc: '去右端空白' },
  { label: 'replace', signature: 'str.replace(old, new, count=-1) -> str', snippet: 'replace(${1:old}, ${2:new})', doc: '替换子串' },
  { label: 'find', signature: 'str.find(sub[, start[, end]]) -> int', snippet: 'find(${1:sub})', doc: '子串下标，找不到返回 -1' },
  { label: 'rfind', signature: 'str.rfind(sub[, start[, end]]) -> int', snippet: 'rfind(${1:sub})', doc: '从右找子串' },
  { label: 'count', signature: 'count(value) -> int', snippet: 'count(${1:value})', doc: '计数（list/tuple/str）' },
  { label: 'lower', signature: 'str.lower() -> str', snippet: 'lower()', doc: '转小写' },
  { label: 'upper', signature: 'str.upper() -> str', snippet: 'upper()', doc: '转大写' },
  { label: 'startswith', signature: 'str.startswith(prefix[, start[, end]]) -> bool', snippet: 'startswith(${1:prefix})', doc: '前缀判断' },
  { label: 'endswith', signature: 'str.endswith(suffix[, start[, end]]) -> bool', snippet: 'endswith(${1:suffix})', doc: '后缀判断' },
  { label: 'isdigit', signature: 'str.isdigit() -> bool', snippet: 'isdigit()', doc: '是否全数字' },
  { label: 'isalpha', signature: 'str.isalpha() -> bool', snippet: 'isalpha()', doc: '是否全字母' },
  { label: 'zfill', signature: 'str.zfill(width) -> str', snippet: 'zfill(${1:width})', doc: '左侧补零' },
  { label: 'encode', signature: 'str.encode(encoding="utf-8") -> bytes', snippet: 'encode()', doc: '编码为字节串' },
  { label: 'append', signature: 'list.append(object)', snippet: 'append(${1:x})', doc: '尾部追加' },
  { label: 'extend', signature: 'list.extend(iterable)', snippet: 'extend(${1:iterable})', doc: '合并可迭代对象（等价 +=）' },
  { label: 'insert', signature: 'list.insert(index, object)', snippet: 'insert(${1:i}, ${2:x})', doc: '指定位置插入' },
  { label: 'remove', signature: 'list.remove(value)', snippet: 'remove(${1:x})', doc: '按值删除第一个匹配' },
  { label: 'pop', signature: 'pop(index=-1) -> item', snippet: 'pop(${1:i})', doc: '弹出（默认末尾；stack 用 pop()，queue 用 popleft）' },
  { label: 'popleft', signature: 'deque.popleft() -> item', snippet: 'popleft()', doc: 'deque 左端弹出（BFS）' },
  { label: 'index', signature: 'index(value[, start[, stop]]) -> int', snippet: 'index(${1:x})', doc: '值的位置，不存在抛 ValueError' },
  { label: 'sort', signature: 'list.sort(*, key=None, reverse=False)', snippet: 'sort(key=${1:None}, reverse=${2:False})', doc: '原位排序（无返回值）；多键 key=lambda x: (x[0], -x[1])' },
  { label: 'reverse', signature: 'list.reverse()', snippet: 'reverse()', doc: '原位反转' },
  { label: 'copy', signature: 'copy() -> shallow copy', snippet: 'copy()', doc: '浅拷贝' },
  { label: 'clear', signature: 'clear() -> None', snippet: 'clear()', doc: '清空' },
  { label: 'keys', signature: 'dict.keys() -> KeysView', snippet: 'keys()', doc: '键视图（可迭代）' },
  { label: 'values', signature: 'dict.values() -> ValuesView', snippet: 'values()', doc: '值视图' },
  { label: 'items', signature: 'dict.items() -> ItemsView', snippet: 'items()', doc: '键值对视图 for k, v in d.items()' },
  { label: 'get', signature: 'dict.get(key, default=None) -> value', snippet: 'get(${1:key}, ${2:default})', doc: '带默认值取值（不存在不报错）' },
  { label: 'setdefault', signature: 'dict.setdefault(key, default=None) -> value', snippet: 'setdefault(${1:key}, ${2:default})', doc: '不存在则设默认并返回' },
  { label: 'update', signature: 'dict.update(other)', snippet: 'update(${1:other})', doc: '批量合并' },
  { label: 'add', signature: 'set.add(element)', snippet: 'add(${1:x})', doc: '集合加元素' },
  { label: 'discard', signature: 'set.discard(element)', snippet: 'discard(${1:x})', doc: '删除元素（不存在不报错）' },
  { label: 'union', signature: 'set.union(*others) -> set', snippet: 'union(${1:other})', doc: '并集 |' },
  { label: 'intersection', signature: 'set.intersection(*others) -> set', snippet: 'intersection(${1:other})', doc: '交集 &' },
  { label: 'difference', signature: 'set.difference(*others) -> set', snippet: 'difference(${1:other})', doc: '差集 -' },
  { label: 'issubset', signature: 'set.issubset(other) -> bool', snippet: 'issubset(${1:other})', doc: '子集判断 <=' },
  { label: 'issuperset', signature: 'set.issuperset(other) -> bool', snippet: 'issuperset(${1:other})', doc: '超集判断 >=' },
];

/* ---------------- 关键词与代码片段 ---------------- */

export const CPP_KEYWORDS = [
  'alignas', 'alignof', 'and', 'asm', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class',
  'const', 'consteval', 'constexpr', 'constinit', 'const_cast', 'continue', 'co_await', 'co_return',
  'co_yield', 'decltype', 'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum',
  'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int',
  'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'nullptr', 'operator', 'or', 'private',
  'protected', 'public', 'register', 'reinterpret_cast', 'requires', 'return', 'short', 'signed',
  'sizeof', 'static', 'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this',
  'thread_local', 'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned',
  'using', 'virtual', 'void', 'volatile', 'wchar_t', 'while',
];

export const PY_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'False', 'try', 'while',
  'with', 'yield', 'match', 'case',
];

export const CPP_SNIPPETS = [
  { label: 'main', detail: '代码骨架（万能头 + 快速 IO）', body: ['#include <bits/stdc++.h>', 'using namespace std;', '', 'int main() {', '    ios::sync_with_stdio(false);', '    cin.tie(nullptr);', '    ${1}', '    return 0;', '}'].join('\n') },
  { label: 'for0', detail: 'for (int i = 0; i < n; i++)', body: 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n    ${3}\n}' },
  { label: 'forll', detail: 'for (ll i = 0; i < n; i++)', body: 'for (ll ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n    ${3}\n}' },
];

export const PY_SNIPPETS = [
  { label: 'main', detail: '代码骨架', body: ['def main():', '    ${1}', '', '', 'if __name__ == "__main__":', '    main()'].join('\n') },
  { label: 'forr', detail: 'for i in range(n)', body: 'for ${1:i} in range(${2:n}):\n    ${3}' },
];

/* ---------------- 纯函数 ---------------- */

/** 一条补全描述 → Monaco suggestion（mon 参数仅为取 kind 常量与 snippet 规则）。 */
export function toSuggestion(mon, item, kind, { sortBoost = null, lang = 'cpp', range = null } = {}) {
  const isSnippet = typeof item.snippet === 'string';
  return {
    label: item.label,
    detail: item.signature ?? '',
    documentation: item.doc
      ? { value: (item.signature ? '```' + lang + '\n' + item.signature + '\n```\n' : '') + item.doc }
      : undefined,
    kind,
    range: range ?? undefined,
    insertText: isSnippet ? item.snippet : item.label,
    insertTextRules: isSnippet ? mon.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    sortText: sortBoost ? sortBoost + item.label : undefined,
  };
}

/** 关键词 → suggestion。 */
export function keywordSuggestion(mon, label, range = null) {
  return {
    label,
    kind: mon.languages.CompletionItemKind.Keyword,
    range: range ?? undefined,
    insertText: label,
  };
}

/**
 * 签名提示：从光标前文本里找最近的未闭合 `(` 前的函数名，查表返回签名。
 * 返回 { match, signatures, activeParameter } | null。纯字符串处理，可单测。
 */
export function signatureLookup(textBeforeCursor, tables) {
  // 找最后一个未闭合的 '('
  let depth = 0;
  let openIdx = -1;
  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    const ch = textBeforeCursor[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth === 0) { openIdx = i; break; }
      depth--;
    }
  }
  if (openIdx < 0) return null;
  // 括号前是函数名（支持 obj.method / ns::func）
  let nameEnd = openIdx;
  while (nameEnd > 0 && /[\w.>:]/.test(textBeforeCursor[nameEnd - 1])) nameEnd--;
  const callee = textBeforeCursor.slice(nameEnd, openIdx);
  if (!callee) return null;
  // 括号内光标前的顶层逗号数 = activeParameter
  let commas = 0;
  let d = 0;
  let quote = null;
  for (let i = openIdx + 1; i < textBeforeCursor.length; i++) {
    const ch = textBeforeCursor[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') { if (d === 0) break; d--; }
    else if (d === 0 && ch === ',') commas++;
  }
  for (const table of tables) {
    // `v.sort(` 的 callee 是 `v.sort`，表按裸名组织——同时试全名与尾段
    const candidates = [callee, callee.replace(/^.*[.:>]/, '')];
    const hit = table.find((f) => f.signature && candidates.includes(f.label));
    if (hit) {
      return { match: hit, activeParameter: commas };
    }
  }
  return null;
}

/**
 * 把签名切成 Monaco SignatureInformation 需要的片段：只切参数表括号内的
 * 顶层逗号（模板尖括号 <> 与引号内的逗号不切）。参数 label 必须是签名
 * label 的子串（Monaco 约定），所以重组 label = namePart + 参数 + endPart。
 */
export function splitSignatureParams(signature) {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close <= open) {
    return { namePart: signature, endPart: '', params: [] };
  }
  const namePart = signature.slice(0, open + 1);
  const endPart = signature.slice(close);
  const inside = signature.slice(open + 1, close);
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < inside.length; i++) {
    const ch = inside[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') depth--;
    else if (depth === 0 && ch === ',') { parts.push(inside.slice(start, i)); start = i + 1; }
  }
  parts.push(inside.slice(start));
  const params = parts.map((p) => p.trim()).filter(Boolean).map((p) => ({ label: p }));
  return { namePart, endPart, params };
}

/** `#include` 行判断：返回 '<' | '"' | null（决定头文件补全形态）。 */
export function includeContext(lineText) {
  const m = lineText.match(/^\s*#\s*include\s*(<[^>]*|"[^"]*)?$/);
  if (!m) return null;
  if (m[1]?.startsWith('"')) return '"';
  return '<';
}

/** C++ 光标是否处于成员访问上下文（`.` `->` `::`；`case 1:` 的单冒号不算）。
 * 判断前剥掉光标前正在打的部分词：Monaco 逐键重发 provider，只看紧邻字符
 * 会把 v.p 误判回普通表，push_back 从候选里消失（VS Code 对 v.pu 仍按成员
 * 过滤）。'.' 前的词元必须是标识符（字母/下划线开头），浮点字面量 1.5 不算。 */
export function isCppMemberAccess(lineText, column) {
  const before = lineText.slice(0, Math.max(0, column - 1)).replace(/[A-Za-z0-9_]+$/, '');
  if (/->$|::$/.test(before)) return true;
  if (!/[.]$/.test(before)) return false;
  const stem = before.slice(0, -1).match(/[A-Za-z0-9_]*$/)[0];
  return /^[A-Za-z_]/.test(stem);
}

/** Python 前缀路径：光标前如 `heapq.` 返回 'heapq.'，普通词返回 ''。 */
export function pyPrefixPath(lineText, wordStartColumn) {
  const before = lineText.slice(0, Math.max(0, wordStartColumn - 1));
  const m = before.match(/([A-Za-z_][\w]*)\.\s*$/);
  return m ? m[1] + '.' : '';
}
