// Hidontknow Support：补上 Hidontknow 主题用 CSS 做不到的部分，让实时预览与阅读模式一致
const { Plugin, editorLivePreviewField, loadPrism } = require("obsidian");
const { StateEffect, StateField } = require("@codemirror/state");
const { Decoration, EditorView, WidgetType } = require("@codemirror/view");
const { syntaxTree } = require("@codemirror/language");

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
const FN_DEF = /^\[\^([^\]]+)\]:[ \t]?/;

// —— 代码高亮：编辑器也用阅读模式的 Prism 切分，token 加上与阅读模式相同的类，配色完全一致 ——
const prismCache = new Map();
function prismClasses(code, lang) {
	const Prism = window.Prism;
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

const refresh = StateEffect.define();

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
		if (!m[3]) {
			stack[level - 1] = { ul: true };
			continue;
		}
		const prev = stack[level - 1];
		const num = prev && !prev.ul && prev.delim === m[4] ? prev.num + 1 : +m[3];
		stack[level - 1] = { num, delim: m[4] };
		const from = line.from + m[1].length, to = from + m[3].length;
		// 用标记而非替换，序号仍留在 Obsidian 的列表标记元素里，缩进照常计算
		if (num !== +m[3] && !touches(state, from, to)) decos.push(Decoration.mark({ class: "hd-ol-renum", attributes: { "data-n": String(num) } }).range(from, to));
	}

	// —— 引用里的列表：编辑器只当普通引用文字，这里补上圆点、序号、复选框和列表间距 ——
	const isQuote = (i) => i >= 1 && i <= doc.lines && info[i].includes("HyperMD-quote") && !info[i].includes("HyperMD-codeblock");
	const quoteItem = (i) => (isQuote(i) ? QUOTE_LIST.exec(lineText(i)) : null);
	const isContent = (i) => isQuote(i) && /^(?:[ \t]*>[ \t]?)+\S/.test(lineText(i));
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
		groups[level] = start ? { kind, num: parseInt(m[3]) || 0 } : { kind, num: g.num + 1 };
		const next = quoteItem(i + 1);
		const cls = ["hd-ql"];
		// 只有顶层列表与引用里的段落之间留 1em；嵌套列表的间距由主题按编辑模式补齐
		if (level === 0 && start && isContent(i - 1) && !(quoteItem(i - 1) && levelOf(quoteItem(i - 1)[2]) > 0)) cls.push("hd-ql-start");
		if (isContent(i + 1) && !next) cls.push("hd-ql-end");
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
				widget("qb", () => {
					// 零宽字符让标记区有正常的行框，圆点按行顶定位，与阅读模式相同
					const span = el("span", "hd-ql-marker", "\u200b");
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
const changed = (tr) => tr.docChanged || tr.effects.some((e) => e.is(refresh)) || syntaxTree(tr.state) !== syntaxTree(tr.startState) || live(tr.state) !== live(tr.startState);

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

module.exports = class HidontknowSupport extends Plugin {
	onload() {
		this.registerEditorExtension([codeField, field]);
		// Obsidian 按需加载 Prism；加载好后让已打开的编辑器重新上色
		if (!window.Prism) {
			loadPrism().then(() => {
				this.app.workspace.iterateAllLeaves((leaf) => {
					const cm = leaf.view && leaf.view.editor && leaf.view.editor.cm;
					if (cm) cm.dispatch({ effects: refresh.of(null) });
				});
			});
		}
	}
};
