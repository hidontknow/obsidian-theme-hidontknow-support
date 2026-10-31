// 把 src/main.js 打包成 Obsidian 加载的 CommonJS main.js；obsidian 和 CodeMirror 由 Obsidian 运行时提供
import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/main.js"],
	bundle: true,
	format: "cjs",
	target: "es2022",
	outfile: "main.js",
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
	logLevel: "info",
});
