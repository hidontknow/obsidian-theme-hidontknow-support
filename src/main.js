// Hidontknow Support：补上 Hidontknow 主题用 CSS 做不到的部分，让实时预览与阅读模式一致
import { Plugin, editorLivePreviewField, loadPrism } from "obsidian";
import { EditorState, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

class HtmlWidget extends WidgetType {
	constructor(key, make, interactive = false) {
		super();
		this.key = key;
		this.make = make;
		this.interactive = interactive;
	}
	eq(other) {
		return other.key === this.key;
	}
	toDOM(view) {
		return this.make(view);
	}
	// 复选框、返回箭头自己处理点击；其余交给编辑器，点击后光标落进去显示源码
	ignoreEvent() {
		return this.interactive;
	}
}

const el = (tag, cls, text) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
};

const widget = (key, make, interactive) => Decoration.replace({ widget: new HtmlWidget(key, make, interactive) });
const hide = Decoration.replace({});

// 选区碰到 [from, to] 时显示源码，和 Obsidian 处理自己的 Markdown 标记一样
const touches = (state, from, to) => state.selection.ranges.some((r) => r.from <= to && r.to >= from);

const QUOTE_LIST = /^((?:[ \t]*>[ \t]?)+)([ \t]*)([-*+]|\d+[.)])( \[(.)\])?(?: |$)/;
const LIST_ITEM = /^([ \t]*)([-*+]|(\d+)([.)]))( |$)/;
// 不同的列表符号显示成不同样式："-" 实心圆点（默认）、"*" 空心圆、"+" 方块、"1)" 带右括号的序号
const QUOTE_PREFIX = /^(?:[ \t]*>[ \t]?)+/;
const MARKER_CLASS = { "*": "hd-marker-star", "+": "hd-marker-plus", ")": "hd-marker-paren" };
const FN_DEF = /^\[\^([^\]]+)\]:[ \t]?/;

// —— 代码高亮：编辑器也用阅读模式的 Prism 切分，token 加上与阅读模式相同的类，配色完全一致 ——
let Prism = null; // 插件加载时由 loadPrism() 取得，与阅读模式是同一份
const prismCache = new Map();
function prismClasses(code, lang) {
	const grammar = Prism && Prism.languages[lang];
	if (!grammar) return null;
	const key = lang + "\u0000" + code;
	if (prismCache.has(key)) return prismCache.get(key);
	const spans = [];
	const walk = (stream, pos) => {
		for (const t of stream) {
			if (typeof t === "string") {
				pos += t.length;
				continue;
			}
			const content = Array.isArray(t.content) ? t.content : [t.content];
			const len = textLength(content);
			// 和阅读模式一样经过 Prism 的 wrap 钩子，拿到最终的类名
			const env = { type: t.type, content: "", tag: "span", classes: ["token", t.type], attributes: {}, language: lang };
			if (t.alias) env.classes.push(...(Array.isArray(t.alias) ? t.alias : [t.alias]));
			Prism.hooks.run("wrap", env);
			spans.push({ from: pos, to: pos + len, cls: env.classes.join(" ") });
			walk(content, pos);
			pos += len;
		}
		return pos;
	};
	walk(Prism.tokenize(code, grammar), 0);
	if (prismCache.size > 300) prismCache.delete(prismCache.keys().next().value);
	prismCache.set(key, spans);
	return spans;
}
const textLength = (stream) => stream.reduce((n, t) => n + (typeof t === "string" ? t.length : textLength(Array.isArray(t.content) ? t.content : [t.content])), 0);

// shortcut: 改动后整块重新切分（按代码文本缓存，未改的块不重算）；几百行的代码块里打字每次约多 10ms，需要时改成增量切分
function highlightCode(doc, info, decos) {
	for (let i = 1; i <= doc.lines; i++) {
		if (!info[i].includes("HyperMD-codeblock-begin")) continue;
		const begin = doc.line(i);
		const fence = /^([ \t]*)(?:`{3,}|~{3,})[ \t]*([^\s`{]*)/.exec(begin.text);
		let j = i + 1;
		while (j <= doc.lines && info[j].includes("HyperMD-codeblock") && !info[j].includes("HyperMD-codeblock-end")) j++;
		const lang = fence && fence[2].toLowerCase();
		const indent = fence && info[i].includes("HyperMD-list-line") ? fence[1] : "";
		const lines = [];
		for (let k = i + 1; k < j; k++) {
			const line = doc.line(k);
			const cut = line.text.startsWith(indent) ? indent.length : 0;
			lines.push({ from: line.from + cut, text: line.text.slice(cut), lineFrom: line.from });
		}
		i = j;
		const spans = lang && lines.length ? prismClasses(lines.map((l) => l.text).join("\n"), lang) : null;
		if (!spans) continue;
		const starts = [];
		let off = 0;
		for (const l of lines) {
			starts.push(off);
			off += l.text.length + 1;
			decos.push(Decoration.line({ class: "hd-prism language-" + lang }).range(l.lineFrom));
		}
		// 按行拆开每个 token，跨行的字符串、注释在每行各自带上类
		for (const sp of spans) {
			let lo = 0, hi = lines.length - 1;
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1;
				if (starts[mid] <= sp.from) lo = mid;
				else hi = mid - 1;
			}
			for (let k = lo; k < lines.length && starts[k] < sp.to; k++) {
				const a = Math.max(sp.from, starts[k]), b = Math.min(sp.to, starts[k] + lines[k].text.length);
				if (a < b) decos.push(Decoration.mark({ class: sp.cls }).range(lines[k].from + a - starts[k], lines[k].from + b - starts[k]));
			}
		}
	}
}

// shortcut: 每次文档、选区或语法树变化都扫描全文；笔记上万行时可能变慢，届时改成只处理可视区域
function build(state, code) {
	if (!state.field(editorLivePreviewField, false)) return Decoration.none;
	const doc = state.doc;
	const tree = syntaxTree(state);
	const info = new Array(doc.lines + 1).fill("");
	const footrefs = [];
	const comments = [];
	tree.iterate({
		enter(n) {
			const name = n.name;
			if (name === "Document") return;
			const ln = doc.lineAt(n.from).number;
			info[ln] += " " + name;
			if (name.includes("footref") && name.includes("formatting-link-start")) footrefs.push({ from: n.from });
			else if (name.includes("inline-footnote-start")) footrefs.push({ from: n.from, inline: true });
			else if (name.includes("inline-footnote-end") && footrefs.length && footrefs[footrefs.length - 1].inline) footrefs[footrefs.length - 1].to = n.to;
			else if (name.includes("comment-start")) comments.push({ from: n.from });
			else if (name.includes("comment-end") && comments.length && comments[comments.length - 1].to == null) comments[comments.length - 1].to = n.to;
		},
	});
	const decos = [];
	if (code) {
		highlightCode(doc, info, decos);
		return Decoration.set(decos, true);
	}
	const lineText = (i) => doc.line(i).text;
	const isBlank = (i) => !/\S/.test(lineText(i));
	// 缩进层级：Tab 算一层，空格按「Tab 缩进宽度」折算
	const levelOf = (ind) => Math.round([...ind].reduce((n, ch) => n + (ch === "\t" ? 1 : 1 / state.tabSize), 0));

	// —— 脚注：编号按首次引用的顺序，与阅读模式相同 ——
	const defs = new Map();
	for (let i = 1; i <= doc.lines; i++) {
		if (!info[i].includes("HyperMD-footnote")) continue;
		const m = FN_DEF.exec(lineText(i));
		if (m && !defs.has(m[1])) defs.set(m[1], i);
	}
	const fnNum = new Map();
	const refPos = new Map();
	let fnCount = 0;
	for (const r of footrefs) {
		const from = r.from;
		let to, n;
		if (r.inline) {
			// 行内脚注 ^[…] 和 [^…] 共用一套编号
			if (r.to == null) continue;
			to = r.to;
			n = ++fnCount;
		} else {
			const m = /^\[\^([^\]]+)\]/.exec(doc.sliceString(from, from + 200));
			if (!m || !defs.has(m[1])) continue;
			if (!fnNum.has(m[1])) {
				fnNum.set(m[1], ++fnCount);
				refPos.set(m[1], from);
			}
			to = from + m[0].length;
			n = fnNum.get(m[1]);
		}
		if (touches(state, from, to)) continue;
		decos.push(
			widget("fnref" + n, () => {
				const sup = el("sup", "footnote-ref hd-fn-ref");
				sup.appendChild(el("a", "footnote-link", `[${n}]`));
				return sup;
			}).range(from, to),
		);
	}
	// 文末连续的脚注定义按阅读模式的脚注区显示：上方分割线、序号、返回箭头
	// shortcut: 只处理文末的定义且按源码顺序显示；定义写在文中，或顺序与首次引用不同时仍和阅读模式不一致
	let tail = doc.lines;
	while (tail > 0 && isBlank(tail)) tail--;
	let first = 0;
	for (let i = tail; i > 0 && (isBlank(i) || info[i].includes("HyperMD-footnote")); i--) if (!isBlank(i)) first = i;
	for (let i = first; first && i <= tail; i++) {
		if (isBlank(i)) continue;
		const line = doc.line(i);
		const m = FN_DEF.exec(line.text);
		const n = m && fnNum.get(m[1]);
		if (!n) continue;
		if (i === first) {
			decos.push(
				Decoration.widget({
					widget: new HtmlWidget("fnsep", () => {
						const d = el("div", "hd-fn-sep hr");
						d.appendChild(el("hr"));
						return d;
					}),
					block: true,
					side: -1,
				}).range(line.from),
			);
		}
		decos.push(Decoration.line({ class: "hd-fn-def" }).range(line.from));
		if (!touches(state, line.from, line.from + m[0].length)) {
			decos.push(widget("fnnum" + n, () => el("span", "hd-fn-num", `${n}.`)).range(line.from, line.from + m[0].length));
		}
		const ref = refPos.get(m[1]);
		decos.push(
			Decoration.widget({
				widget: new HtmlWidget("fnback" + ref, (view) => {
					const a = el("a", "footnote-backref footnote-link", "↩︎");
					a.addEventListener("mousedown", (e) => {
						e.preventDefault();
						view.dispatch({ selection: { anchor: ref }, scrollIntoView: true });
					});
					return a;
				}, true),
				side: 1,
			}).range(line.to),
		);
	}

	// —— 注释 %%…%%：阅读模式不显示，编辑模式在光标不在里面时也隐藏 ——
	for (const c of comments) {
		if (c.to == null || touches(state, c.from, c.to)) continue;
		const a = doc.lineAt(c.from), b = doc.lineAt(c.to);
		if (a.number !== b.number && c.from === a.from && c.to === b.to) {
			// 整行的块注释：连同其后的空行一起隐藏，前后段落之间只剩一个空行，与阅读模式的块间距相同
			let end = b.number;
			if (a.number === 1 || isBlank(a.number - 1)) while (end < doc.lines && isBlank(end + 1)) end++;
			decos.push(Decoration.replace({ block: true }).range(a.from, doc.line(end).to));
		} else {
			decos.push(hide.range(c.from, c.to));
		}
	}

	// —— 列表：有序编号按阅读模式重排；列表里的代码块缩进到列表文字处 ——
	const stack = [];
	let codeIndent = null;
	for (let i = 1; i <= doc.lines; i++) {
		const s = info[i];
		const line = doc.line(i);
		if (s.includes("HyperMD-codeblock")) {
			if (s.includes("HyperMD-codeblock-begin")) {
				const ind = /^[ \t]*/.exec(line.text)[0];
				codeIndent = s.includes("HyperMD-list-line") && ind ? ind : null;
			}
			if (codeIndent) {
				decos.push(Decoration.line({ class: "hd-list-code", attributes: { style: `--hd-list-code-level: ${levelOf(codeIndent)}` } }).range(line.from));
				if (line.text.startsWith(codeIndent)) decos.push(hide.range(line.from, line.from + codeIndent.length));
			} else {
				stack.length = 0; // 列表外的代码块会结束列表，之后的有序列表重新起号
			}
			if (s.includes("HyperMD-codeblock-end")) codeIndent = null;
			continue;
		}
		const lv = /HyperMD-list-line-(\d+)/.exec(s);
		if (!lv) {
			if (!isBlank(i) && !s.includes("HyperMD-list-line-nobullet")) stack.length = 0;
			continue;
		}
		const level = +lv[1];
		stack.length = Math.min(stack.length, level);
		const m = LIST_ITEM.exec(line.text);
		if (!m) continue;
		const markerCls = MARKER_CLASS[m[2].slice(-1)];
		if (markerCls) decos.push(Decoration.line({ class: markerCls }).range(line.from));
		// 任务项复选框后的空格固定为 0.275em，与主题给复选框标签留的宽度正好抵消，换行后的行与首行文字对齐
		if (/^\[.\] /.test(line.text.slice(m[0].length))) {
			const sp = line.from + m[0].length + 3;
			decos.push(Decoration.line({ class: "hd-task" }).range(line.from), Decoration.mark({ class: "hd-task-space" }).range(sp, sp + 1));
		}
		if (!m[3]) {
			stack[level - 1] = { ul: true };
			continue;
		}
		const prev = stack[level - 1];
		// 同类型接着编号；紧跟在另一种列表（无序或另一种分隔符）后面的有序列表从 1 重新编号；其余从第一项写的数字开始
		const num = !prev ? +m[3] : !prev.ul && prev.delim === m[4] ? prev.num + 1 : 1;
		stack[level - 1] = { num, delim: m[4] };
		const from = line.from + m[1].length, to = from + m[3].length;
		// 用标记而非替换，序号仍留在 Obsidian 的列表标记元素里，缩进照常计算
		if (num !== +m[3] && !touches(state, from, to)) decos.push(Decoration.mark({ class: "hd-ol-renum", attributes: { "data-n": String(num) } }).range(from, to));
	}

	// —— 引用里的列表：编辑器只当普通引用文字，这里补上圆点、序号、复选框和列表间距 ——
	const isQuote = (i) => i >= 1 && i <= doc.lines && info[i].includes("HyperMD-quote") && !info[i].includes("HyperMD-codeblock");
	const quoteItem = (i) => (isQuote(i) ? QUOTE_LIST.exec(lineText(i)) : null);
	const isContent = (i) => isQuote(i) && /^(?:[ \t]*>)+[ \t]*\S/.test(lineText(i));
	const groups = [];
	for (let i = 1; i <= doc.lines; i++) {
		const m = quoteItem(i);
		if (!m) {
			groups.length = 0;
			continue;
		}
		const line = doc.line(i);
		const level = levelOf(m[2]);
		groups.length = Math.min(groups.length, level + 1);
		const kind = /\d/.test(m[3]) ? "ol" + m[3].slice(-1) : "ul";
		const g = groups[level];
		const start = !g || g.kind !== kind;
		groups[level] = !g ? { kind, num: parseInt(m[3]) || 0 } : start ? { kind, num: 1 } : { kind, num: g.num + 1 };
		const next = quoteItem(i + 1);
		const cls = ["hd-ql"];
		// 顶层列表开始时（前面是段落，或换了列表类型）留 1em，与阅读模式的列表外边距相同；嵌套列表的间距由主题补齐
		if (level === 0 && start && isContent(i - 1)) cls.push("hd-ql-start");
		if (isContent(i + 1) && !next) cls.push("hd-ql-end");
		if (level > 0) cls.push("hd-ql-nested");
		if (!isQuote(i - 1)) cls.push("hd-ql-first");
		if (!isQuote(i + 1)) cls.push("hd-ql-last");
		decos.push(Decoration.line({ class: cls.join(" "), attributes: { style: `--hd-ql-level: ${level}` } }).range(line.from));
		const from = line.from + m[1].length, to = line.from + m[0].length;
		if (touches(state, line.from, to)) continue;
		if (m[4]) {
			const box = to - 3;
			const checked = m[5] !== " ";
			decos.push(
				widget("qt" + checked + box, (view) => {
					const span = el("span", "hd-ql-marker hd-ql-task");
					const input = el("input", "task-list-item-checkbox");
					input.type = "checkbox";
					input.checked = checked;
					input.addEventListener("mousedown", (e) => {
						e.preventDefault();
						view.dispatch({ changes: { from: box, to: box + 1, insert: checked ? " " : "x" } });
					});
					span.appendChild(input);
					return span;
				}, true).range(from, to),
			);
			if (checked) decos.push(Decoration.line({ class: "hd-ql-done" }).range(line.from));
		} else if (kind === "ul") {
			decos.push(
				widget("qb" + m[3], () => {
					// 零宽字符让标记区有正常的行框，圆点按行顶定位，与阅读模式相同
					const span = el("span", "hd-ql-marker " + (MARKER_CLASS[m[3]] || ""), "\u200b");
					span.appendChild(el("span", "hd-ql-bullet"));
					return span;
				}).range(from, to),
			);
		} else {
			const text = groups[level].num + m[3].slice(-1) + " ";
			decos.push(widget("qn" + text, () => el("span", "hd-ql-marker hd-ql-num", text)).range(from, to));
		}
	}
	return Decoration.set(decos, true);
}

const live = (s) => s.field(editorLivePreviewField, false);
const changed = (tr) => tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) || live(tr.state) !== live(tr.startState);

// 代码高亮只随文档变化重建；其余装饰还要随选区变化（光标碰到时显示源码），分开后移动光标不必重算整块代码
const codeField = StateField.define({
	create: (state) => build(state, true),
	update: (value, tr) => (changed(tr) ? build(tr.state, true) : value),
	provide: (f) => EditorView.decorations.from(f),
});

const field = StateField.define({
	create: (state) => build(state, false),
	update: (value, tr) => (changed(tr) || tr.selection ? build(tr.state, false) : value),
	provide: (f) => EditorView.decorations.from(f),
});

// —— 列表项换了层级（回车退出空项、Tab、Shift+Tab）时，符号改成新层级里上一个同级项的类型并接着编号 ——
// 只在缩进发生变化时改；手动输入别的符号（缩进不变）表示要另起一种列表，不动
const followSiblingMarker = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged) return tr;
	const doc = tr.newDoc, old = tr.startState.doc, back = tr.changes.invert(old);
	const fixes = [], seen = new Set();
	tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
		for (let pos = fromB; pos <= Math.min(toB, doc.length); ) {
			const line = doc.lineAt(pos);
			if (!seen.has(line.number)) {
				seen.add(line.number);
				const fix = siblingFix(doc, old, back, line);
				if (fix) fixes.push(...fix);
			}
			pos = line.to + 1;
		}
	});
	return fixes.length ? [tr, { changes: fixes, sequential: true }] : tr;
});

// —— 输入或修改有序列表后，把源码序号改成显示的序号（编号规则与上面 build 里的相同）——
// 只处理用户输入/删除，且只改这次编辑所在的列表；撤销、打开或外部同步文件、源码模式都不动
// shortcut: 按缩进和空行从纯文本判断列表范围，不读语法树；遇到 HTML 块等特殊写法可能判断不准
const renumberOrdered = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete")) || !live(tr.startState)) return tr;
	const doc = tr.newDoc;
	const touched = new Set();
	tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
		for (let n = doc.lineAt(fromB).number; n <= doc.lineAt(toB).number; n++) touched.add(n);
	});
	const fixes = [], hit = new Set(), pending = [];
	let stack = [], region = 0;
	const reset = () => {
		stack = [];
		region++;
	};
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n), t = line.text;
		if (touched.has(n)) hit.add(region);
		if (!/\S/.test(t)) continue;
		const fence = /^([ \t]*)(`{3,}|~{3,})/.exec(t);
		if (fence) {
			if (!fence[1]) reset(); // 列表外的代码块结束列表
			while (n < doc.lines && !doc.line(n + 1).text.trimStart().startsWith(fence[2])) n++;
			n++;
			continue;
		}
		const m = LIST_ITEM.exec(t);
		if (!m) {
			if (!/^[ \t]/.test(t)) reset(); // 不缩进的段落结束列表；缩进的是列表项的续行
			continue;
		}
		const ind = m[1].length;
		while (stack.length && stack[stack.length - 1].ind > ind) stack.pop();
		const top = stack[stack.length - 1];
		const prev = top && top.ind === ind ? stack.pop() : null;
		if (!m[3]) {
			stack.push({ ind, ul: true });
			continue;
		}
		const num = !prev ? +m[3] : !prev.ul && prev.delim === m[4] ? prev.num + 1 : 1;
		stack.push({ ind, num, delim: m[4] });
		if (num !== +m[3]) pending.push({ region, from: line.from + ind, to: line.from + ind + m[3].length, insert: String(num) });
	}
	for (const f of pending) if (hit.has(f.region)) fixes.push({ from: f.from, to: f.to, insert: f.insert });
	return fixes.length ? [tr, { changes: fixes, sequential: true }] : tr;
});

// 同一缩进、同一列表里的相邻项：dir = -1 往上找，1 往下找；跳过空行、更深的嵌套项和续行，到上一级或列表外就停
function sibling(doc, n, indent, dir) {
	for (n += dir; n >= 1 && n <= doc.lines; n += dir) {
		const t = doc.line(n).text;
		if (!/\S/.test(t)) continue;
		const p = LIST_ITEM.exec(t);
		const ind = (p ? p[1] : /^[ \t]*/.exec(t)[0]).length;
		if (ind > indent) continue;
		return p && ind === indent ? { n, m: p } : null;
	}
	return null;
}

const sameKind = (a, b) => (a[3] ? b[3] && a[4] === b[4] : !b[3] && a[2] === b[2]);

function siblingFix(doc, old, back, line) {
	const m = LIST_ITEM.exec(line.text);
	if (!m) return null;
	const before = LIST_ITEM.exec(old.lineAt(back.mapPos(line.from, 1)).text);
	if (!before || before[1] === m[1]) return null; // 原来不是列表项（手动输入的新符号），或缩进没变
	const indent = m[1].length;
	const prev = sibling(doc, line.number, indent, -1), next = sibling(doc, line.number, indent, 1);
	const ref = prev || next; // 上面没有同级项时（新层级的第一项），跟下面的同级项一致
	if (!ref || sameKind(ref.m, m)) return null;
	const fixes = [];
	const set = (ln, mm, marker) => {
		const from = doc.line(ln).from + mm[1].length;
		if (mm[2] !== marker) fixes.push({ from, to: from + mm[2].length, insert: marker });
	};
	if (!ref.m[3]) {
		set(line.number, m, ref.m[2]);
		return fixes;
	}
	// 有序：接着上一项编号（上面没有同级项时从 1 开始），并把后面紧接的同类项顺延
	let num = prev ? +prev.m[3] + 1 : 1;
	set(line.number, m, num + ref.m[4]);
	for (let s = next; s && sameKind(s.m, ref.m); s = sibling(doc, s.n, indent, 1)) set(s.n, s.m, ++num + ref.m[4]);
	return fixes;
}

// —— 阅读模式：按源码还原编辑模式的空行和列表符号 ——
// 第 i 行前面连续的空行数；前面已是文首时返回 -1
const blankBefore = (lines, i) => {
	let n = 0;
	while (i - 1 - n >= 0 && !/\S/.test(lines[i - 1 - n])) n++;
	return i - n > 0 ? n : -1;
};
function matchSourceSpacing(el, ctx) {
	const info = ctx.getSectionInfo(el);
	// 文末脚注区由阅读模式自己排版，插件在编辑模式里已按它画出脚注区，这里不动
	if (!info || el.querySelector("section.footnotes")) return;
	const lines = info.text.split("\n");
	// 块与块之间：编辑模式里隔几个空行就是几行高，没有空行就紧挨着；阅读模式默认一律隔一行
	const n = blankBefore(lines, info.lineStart);
	if (n >= 0 && n !== 1) {
		el.addClass("hd-gap");
		el.style.setProperty("--hd-blank-lines", String(n));
	}
	const item = (i) => LIST_ITEM.exec((lines[i] || "").replace(QUOTE_PREFIX, ""));
	for (const ol of el.querySelectorAll("ol")) {
		const first = ol.querySelector(":scope > li[data-line]");
		if (!first) continue;
		const i = info.lineStart + Number(first.getAttribute("data-line"));
		const m = item(i);
		if (!m) continue;
		// 往上找同一缩进的上一个列表项（跳过空行和更深的嵌套项）：是另一种列表就从 1 重新编号，与编辑模式相同
		for (let j = i - 1; j >= 0; j--) {
			const t = (lines[j] || "").replace(QUOTE_PREFIX, "");
			if (!/\S/.test(t)) continue;
			const p = item(j);
			if (p && p[1].length > m[1].length) continue;
			if (p && p[1].length === m[1].length && (!p[3] || p[4] !== m[4])) ol.setAttribute("start", "1");
			break;
		}
	}
	for (const li of el.querySelectorAll("li[data-line]")) {
		const i = info.lineStart + Number(li.getAttribute("data-line"));
		const m = item(i);
		if (!m) continue;
		const cls = MARKER_CLASS[m[2].slice(-1)];
		if (cls) (cls === "hd-marker-paren" ? li.parentElement : li).addClass(cls);
		// 列表项之间的空行（松散列表）：阅读模式不显示，按空行数补上间距
		const gap = blankBefore(lines, i);
		if (gap > 0 && li.previousElementSibling) {
			li.addClass("hd-gap");
			li.style.setProperty("--hd-blank-lines", String(gap));
		}
	}
}

export default class HidontknowSupport extends Plugin {
	async onload() {
		// Obsidian 按需加载 Prism；先加载好再注册，编辑器一打开就能按 Prism 上色
		Prism = await loadPrism();
		this.registerEditorExtension([codeField, field, followSiblingMarker, renumberOrdered]);
		this.registerMarkdownPostProcessor((el, ctx) => matchSourceSpacing(el, ctx));
	}
}
