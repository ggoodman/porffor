import { underline, bold, log } from './log.js';
import parse from './parse.js';
import codeGen from './codeGen.js';
import opt from './opt.js';
import assemble from './assemble.js';
import decompile from './decompile.js';
import toc from './2c.js';
import Prefs from './prefs.js';

globalThis.decompile = decompile;

const logFuncs = (funcs, globals, exceptions) => {
  console.log('\n' + underline(bold('funcs')));

  const startIndex = funcs.sort((a, b) => a.index - b.index)[0].index;
  for (const f of funcs) {
    console.log(`${underline(f.name)} (${f.index - startIndex})`);

    console.log(`params: ${f.params.map((_, i) => Object.keys(f.locals)[Object.values(f.locals).indexOf(Object.values(f.locals).find(x => x.idx === i))]).join(', ')}`);
    console.log(`returns: ${f.returns.length > 0 ? true : false}`);
    console.log(`locals: ${Object.keys(f.locals).sort((a, b) => f.locals[a].idx - f.locals[b].idx).map(x => `${x} (${f.locals[x].idx})`).join(', ')}`);
    console.log();
    console.log(decompile(f.wasm, f.name, f.index, f.locals, f.params, f.returns, funcs, globals, exceptions));
  }

  console.log();
};

const writeFileSync = (typeof process?.version !== 'undefined' ? (await import('node:fs')).writeFileSync : undefined);
const execSync = (typeof process?.version !== 'undefined' ? (await import('node:child_process')).execSync : undefined);

export default (code, flags) => {
  const t0 = performance.now();
  const program = parse(code, flags);
  if (Prefs.profileCompiler) console.log(`1. parsed in ${(performance.now() - t0).toFixed(2)}ms`);

  const t1 = performance.now();
  const { funcs, globals, tags, exceptions, pages, data } = codeGen(program);
  if (Prefs.profileCompiler) console.log(`2. generated code in ${(performance.now() - t1).toFixed(2)}ms`);

  if (Prefs.funcs) logFuncs(funcs, globals, exceptions);

  const t2 = performance.now();
  opt(funcs, globals, pages, tags, exceptions);
  if (Prefs.profileCompiler) console.log(`3. optimized in ${(performance.now() - t2).toFixed(2)}ms`);

  if (Prefs.optFuncs) logFuncs(funcs, globals, exceptions);

  const t3 = performance.now();
  const wasm = assemble(funcs, globals, tags, pages, data, flags);
  if (Prefs.profileCompiler) console.log(`4. assembled in ${(performance.now() - t3).toFixed(2)}ms`);

  if (Prefs.allocLog) {
    const wasmPages = Math.ceil((pages.size * pageSize) / 65536);
    const bytes = wasmPages * 65536;
    log('alloc', `\x1B[1mallocated ${bytes / 1024}KiB\x1B[0m for ${pages.size} things using ${wasmPages} Wasm page${wasmPages === 1 ? '' : 's'}`);
    console.log([...pages.keys()].map(x => `\x1B[36m - ${x}\x1B[0m`).join('\n') + '\n');
  }

  const out = { wasm, funcs, globals, tags, exceptions, pages, data };

  const target = Prefs.target ?? 'wasm';
  const outFile = Prefs.o;

  if (target === 'wasm' && outFile) {
    writeFileSync(outFile, Buffer.from(wasm));

    if (process.version) process.exit();
  }

  if (target === 'c') {
    const c = toc(out);
    out.c = c;

    if (outFile) {
      writeFileSync(outFile, c);
    } else {
      console.log(c);
    }

    if (process.version) process.exit();
  }

  if (target === 'native') {
    let compiler = Prefs.compiler ?? 'clang';
    const cO = Prefs._cO ?? 'Ofast';

    if (compiler === 'zig') compiler = [ 'zig', 'cc' ];
      else compiler = [ compiler ];

    const tmpfile = 'tmp.c';
    // const args = [ compiler, tmpfile, '-o', outFile ?? (process.platform === 'win32' ? 'out.exe' : 'out'), '-' + cO, '-march=native', '-s', '-fno-unwind-tables', '-fno-asynchronous-unwind-tables', '-ffunction-sections', '-fdata-sections', '-Wl', '-fno-ident', '-fno-exceptions', '-ffast-math' ];
    // const args = [ ...compiler, tmpfile, '-o', outFile ?? (process.platform === 'win32' ? 'out.exe' : 'out'), '-' + cO, '-march=native', '-s', '-ffast-math', '-fno-exceptions', '-target', 'x86_64-linux' ];
    const args = [ ...compiler, tmpfile, '-o', outFile ?? (process.platform === 'win32' ? 'out.exe' : 'out'), '-' + cO, '-march=native', '-s', '-ffast-math', '-fno-exceptions' ];

    const c = toc(out);
    writeFileSync(tmpfile, c);

    // obvious command escape is obvious
    execSync(args.join(' '), { stdio: 'inherit' });

    if (process.version) process.exit();
  }

  return out;
};