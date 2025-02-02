#!/usr/bin/env node

import compile from '../compiler/wrap.js';
import fs from 'node:fs';

const start = performance.now();

if (process.argv.includes('-compile-hints')) {
  const v8 = await import('node:v8');
  v8.setFlagsFromString(`--experimental-wasm-compilation-hints`);

  // see also these flags:
  // --experimental-wasm-branch-hinting
  // --experimental-wasm-extended-const
  // --experimental-wasm-inlining (?)
  // --experimental-wasm-js-inlining (?)
  // --experimental-wasm-return-call (on by default)
}

let file = process.argv.slice(2).find(x => x[0] !== '-');
if (['run', 'wasm', 'native', 'c', 'profile', 'debug', 'debug-wasm'].includes(file)) {
  if (file === 'profile') {
    process.argv.splice(process.argv.indexOf(file), 1);
    await import('./profiler.js');
    await new Promise(() => {}); // do nothing for the rest of this file
  }

  if (['wasm', 'native', 'c'].includes(file)) {
    process.argv.push(`-target=${file}`);
  }

  if (file === 'debug-wasm') {
    process.argv.push('-asur', '-wasm-debug');
  }

  if (file === 'debug') {
    process.argv.splice(process.argv.indexOf(file), 1);
    await import('./debug.js');
    await new Promise(() => {}); // do nothing for the rest of this file
  }

  file = process.argv.slice(process.argv.indexOf(file) + 1).find(x => x[0] !== '-');

  const nonOptOutFile = process.argv.slice(process.argv.indexOf(file) + 1).find(x => x[0] !== '-');
  if (nonOptOutFile) {
    process.argv.push(`-o=${nonOptOutFile}`);
  }
}

if (!file) {
  if (process.argv.includes('-v') || process.argv.includes('--version')) {
    // just print version
    console.log((await import('./version.js')).default);
    process.exit(0);
  }

  // run repl if no file given
  await import('./repl.js');
  await new Promise(() => {}); // do nothing for the rest of this file
}

const source = fs.readFileSync(file, 'utf8');

let cache = '';
const print = str => {
  /* cache += str;

  if (str === '\n') {
    process.stdout.write(cache);
    cache = '';
  } */

  process.stdout.write(str);
};

try {
  if (process.argv.includes('-b')) {
    const { wasm, exports } = await compile(source, process.argv.includes('--module') ? [ 'module' ] : [], {}, print);

    if (!process.argv.includes('-no-run')) exports.main();

    console.log(`\n\nwasm size: ${wasm.byteLength} bytes`);
  } else {
    const { exports } = await compile(source, process.argv.includes('--module') ? [ 'module' ] : [], {}, print);

    if (!process.argv.includes('-no-run')) exports.main();
  }
  // if (cache) process.stdout.write(cache);
} catch (e) {
  // if (cache) process.stdout.write(cache);
  console.error(process.argv.includes('-i') ? e : `${e.constructor.name}: ${e.message}`);
}

if (process.argv.includes('-t')) console.log(`${process.argv.includes('-b') ? '' : '\n\n'}total time: ${(performance.now() - start).toFixed(2)}ms`);